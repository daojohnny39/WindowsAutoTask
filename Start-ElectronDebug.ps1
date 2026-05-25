<#
.SYNOPSIS
    Enable Chrome DevTools Protocol on running (or specified) Electron apps,
    with optional persistent toggle that survives reboots.

.DESCRIPTION
    CDP can only be enabled at launch via --remote-debugging-port=N, so this
    script restarts target apps with the flag set. It auto-detects Electron
    apps by looking for processes whose group includes a --type=renderer child.

    Persistent mode (-Enable / -Disable) saves state to cdp-state.json and
    registers a logon scheduled task that re-applies CDP to tracked apps
    after reboot.

    Caveats:
      * The app is killed and relaunched — unsaved state is lost.
      * Some production builds (Slack, Teams, signed Microsoft Electron apps)
        strip or block --remote-debugging-port and will silently ignore it.
      * Each app gets its own port; CDP traffic is per-app, not shared.
      * The logon task waits up to 90 seconds for tracked apps to appear
        before restarting them with CDP.

.PARAMETER List
    Show running Electron apps without restarting anything. Default if no
    other action flag is given.

.PARAMETER All
    Restart every detected Electron app with CDP enabled (one-shot).

.PARAMETER Name
    Substring match against the exe path/name. Restarts matching apps only.

.PARAMETER Path
    Explicit exe path to launch with CDP. Works even if the app isn't running.

.PARAMETER StartPort
    First port to assign. Auto-increments and skips in-use ports. Default 9222.

.PARAMETER Kill
    When restarting, force-kill all processes sharing the exe path (including
    orphaned renderer children). On by default — pass -Kill:$false to skip.

.PARAMETER Enable
    Persistent CDP toggle ON. Restarts all running Electron apps with CDP,
    saves their exe paths, and registers a logon scheduled task to restore
    CDP after reboot.

.PARAMETER Disable
    Persistent CDP toggle OFF. Restarts tracked apps without CDP, clears
    saved state, and removes the logon scheduled task.

.PARAMETER Restore
    Internal. Called by the logon scheduled task. Waits for tracked apps
    to appear, then restarts them with CDP.

.PARAMETER Status
    Show whether persistent CDP is enabled and which apps are tracked.

.EXAMPLE
    .\Start-ElectronDebug.ps1 -Enable
    Restarts all running Electron apps with CDP and persists across reboots.

.EXAMPLE
    .\Start-ElectronDebug.ps1 -Disable
    Turns off persistent CDP and restarts tracked apps normally.

.EXAMPLE
    .\Start-ElectronDebug.ps1 -Status
    Shows current CDP toggle state and tracked apps.
#>
param(
    [switch]$List,
    [switch]$All,
    [string]$Name,
    [string]$Path,
    [int]$StartPort = 9222,
    [switch]$Kill = $true,
    [switch]$Enable,
    [switch]$Disable,
    [switch]$Restore,
    [switch]$Status
)

$StatePath = Join-Path $PSScriptRoot "cdp-state.json"
$TaskName = "ElectronCDP-Persistent"

function Find-RunningElectronApps {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath }

    $apps = @()
    foreach ($group in ($procs | Group-Object ExecutablePath)) {
        $hasRenderer = $group.Group | Where-Object { $_.CommandLine -match '--type=renderer' }
        if (-not $hasRenderer) { continue }

        $main = $group.Group |
            Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
            Select-Object -First 1
        if (-not $main) { continue }

        $alreadyDebug = $false
        $debugPort = $null
        if ($main.CommandLine -match '--remote-debugging-port=(\d+)') {
            $alreadyDebug = $true
            $debugPort = [int]$Matches[1]
        }

        $apps += [PSCustomObject]@{
            Name         = [IO.Path]::GetFileNameWithoutExtension($group.Name)
            Exe          = $group.Name
            MainPid      = [int]$main.ProcessId
            ProcessCount = $group.Count
            DebugEnabled = $alreadyDebug
            DebugPort    = $debugPort
        }
    }
    return $apps
}

function Get-NextFreePort {
    param([int]$Start)
    $port = $Start
    while ($port -lt 65535) {
        $inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        if (-not $inUse) { return $port }
        $port++
    }
    throw "No free port found above $Start"
}

function Stop-AppByExe {
    param([string]$ExePath)
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -eq $ExePath } catch { $false }
    }
    if (-not $procs) { return 0 }
    $count = $procs.Count
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
        $still = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -eq $ExePath } catch { $false }
        }
        if (-not $still) { break }
        Start-Sleep -Milliseconds 200
    }
    return $count
}

function Start-AppWithCdp {
    param([string]$ExePath, [int]$Port)
    $name = [IO.Path]::GetFileNameWithoutExtension($ExePath)

    if ($Kill) {
        $killed = Stop-AppByExe -ExePath $ExePath
        if ($killed -gt 0) { Write-Host "  Stopped $killed process(es) for $name" }
    }

    Write-Host "  Launching $name with --remote-debugging-port=$Port"
    Start-Process -FilePath $ExePath -ArgumentList "--remote-debugging-port=$Port"

    return [PSCustomObject]@{
        App      = $name
        Exe      = $ExePath
        Port     = $Port
        JsonUrl  = "http://localhost:$Port/json"
        DevTools = "http://localhost:$Port"
    }
}

function Start-AppNormally {
    param([string]$ExePath)
    $name = [IO.Path]::GetFileNameWithoutExtension($ExePath)

    $killed = Stop-AppByExe -ExePath $ExePath
    if ($killed -gt 0) { Write-Host "  Stopped $killed process(es) for $name" }

    Write-Host "  Launching $name normally (no CDP)"
    Start-Process -FilePath $ExePath
}

function Get-CdpState {
    if (Test-Path $StatePath) {
        return Get-Content $StatePath -Raw | ConvertFrom-Json
    }
    return $null
}

function Save-CdpState {
    param([bool]$Enabled, [array]$Apps)
    $state = @{
        enabled   = $Enabled
        startPort = $StartPort
        apps      = @($Apps | ForEach-Object {
            @{ name = $_.Name; exe = $_.Exe; port = $_.Port }
        })
        updatedAt = (Get-Date -Format 'o')
    }
    $state | ConvertTo-Json -Depth 3 | Set-Content $StatePath -Encoding utf8
}

function Register-CdpLogonTask {
    $scriptPath = $PSCommandPath
    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Restore"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
    } else {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Settings $settings -Description "Restart Electron apps with CDP after logon" | Out-Null
    }
    Write-Host "  Logon task '$TaskName' registered."
}

function Unregister-CdpLogonTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  Logon task '$TaskName' removed."
    }
}

# ---------- Status ----------
if ($Status) {
    $state = Get-CdpState
    if (-not $state -or -not $state.enabled) {
        Write-Host "CDP persistent mode: OFF"
    } else {
        Write-Host "CDP persistent mode: ON"
        Write-Host "Tracked apps:"
        foreach ($app in $state.apps) {
            Write-Host "  $($app.name) -> port $($app.port)"
            Write-Host "    $($app.exe)"
        }
        Write-Host "Last updated: $($state.updatedAt)"
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "Logon task: $($task.State)"
    } else {
        Write-Host "Logon task: not registered"
    }
    return
}

# ---------- Enable ----------
if ($Enable) {
    $running = Find-RunningElectronApps
    if (-not $running) {
        Write-Host "No running Electron apps detected. Nothing to enable."
        Write-Host "Start some Electron apps first, then run -Enable again."
        return
    }

    Write-Host "Enabling persistent CDP for $($running.Count) app(s)..."

    $results = @()
    $port = $StartPort
    foreach ($app in $running) {
        $port = Get-NextFreePort -Start $port
        Write-Host ""
        Write-Host "[$($app.Name)]"

        if ($app.DebugEnabled) {
            Write-Host "  Already has CDP on port $($app.DebugPort) — keeping as-is"
            $results += [PSCustomObject]@{
                Name = $app.Name
                Exe  = $app.Exe
                Port = $app.DebugPort
            }
        } else {
            $r = Start-AppWithCdp -ExePath $app.Exe -Port $port
            $results += [PSCustomObject]@{
                Name = $r.App
                Exe  = $r.Exe
                Port = $r.Port
            }
        }
        $port++
    }

    Save-CdpState -Enabled $true -Apps $results
    Write-Host ""
    Register-CdpLogonTask

    Write-Host ""
    Write-Host "CDP persistent mode: ON"
    Write-Host "CDP endpoints:"
    $results | ForEach-Object {
        Write-Host "  $($_.Name): http://localhost:$($_.Port)/json"
    }
    Write-Host ""
    Write-Host "Apps will be restarted with CDP after every logon."
    Write-Host "Run -Disable to turn off, -Status to check state."
    return
}

# ---------- Disable ----------
if ($Disable) {
    $state = Get-CdpState
    if (-not $state -or -not $state.enabled) {
        Write-Host "CDP persistent mode is already OFF."
        Unregister-CdpLogonTask
        return
    }

    Write-Host "Disabling persistent CDP..."

    foreach ($app in $state.apps) {
        $isRunning = Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -eq $app.exe } catch { $false }
        }
        if ($isRunning) {
            Write-Host ""
            Write-Host "[$($app.name)]"
            Start-AppNormally -ExePath $app.exe
        }
    }

    Save-CdpState -Enabled $false -Apps @()
    Unregister-CdpLogonTask

    Write-Host ""
    Write-Host "CDP persistent mode: OFF"
    Write-Host "All tracked apps restarted without CDP."
    return
}

# ---------- Restore (logon task) ----------
if ($Restore) {
    $state = Get-CdpState
    if (-not $state -or -not $state.enabled) { return }

    $exeSet = @{}
    foreach ($app in $state.apps) { $exeSet[$app.exe] = $app }

    $timeout = 90
    $interval = 5
    $elapsed = 0
    $found = @{}

    Write-Host "Waiting for tracked Electron apps to start (up to ${timeout}s)..."
    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds $interval
        $elapsed += $interval

        $running = Find-RunningElectronApps
        foreach ($r in $running) {
            if ($exeSet.ContainsKey($r.Exe) -and -not $found.ContainsKey($r.Exe)) {
                $found[$r.Exe] = $r
            }
        }

        if ($found.Count -ge $exeSet.Count) { break }
    }

    if ($found.Count -eq 0) {
        Write-Host "No tracked apps detected after ${timeout}s. Skipping."
        return
    }

    Write-Host "Restarting $($found.Count) app(s) with CDP..."
    $results = @()
    $port = $state.startPort
    foreach ($exe in $found.Keys) {
        $port = Get-NextFreePort -Start $port
        $savedApp = $exeSet[$exe]
        Write-Host ""
        Write-Host "[$($savedApp.name)]"
        $r = Start-AppWithCdp -ExePath $exe -Port $port
        $results += [PSCustomObject]@{
            Name = $r.App
            Exe  = $r.Exe
            Port = $r.Port
        }
        $port++
    }

    Save-CdpState -Enabled $true -Apps $results
    Write-Host ""
    Write-Host "CDP restored for $($results.Count) app(s) after logon."
    return
}

# ---------- One-shot modes (original behavior) ----------
$running = Find-RunningElectronApps

# Default action when no flags: list
if (-not $All -and -not $Name -and -not $Path) {
    $List = $true
}

if ($List) {
    $state = Get-CdpState
    $persistLabel = if ($state -and $state.enabled) { " [persistent CDP: ON]" } else { "" }

    if (-not $running) {
        Write-Host "No running Electron apps detected.$persistLabel"
    } else {
        Write-Host "Detected Electron apps:$persistLabel"
        $running | Format-Table Name, ProcessCount, DebugEnabled, DebugPort, Exe -AutoSize
    }
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  .\Start-ElectronDebug.ps1 -All              # restart all with CDP (one-shot)"
    Write-Host "  .\Start-ElectronDebug.ps1 -Name Discord     # restart matching apps"
    Write-Host "  .\Start-ElectronDebug.ps1 -Path '<exe>'     # launch specific exe"
    Write-Host "  .\Start-ElectronDebug.ps1 -Enable           # persistent CDP (survives reboot)"
    Write-Host "  .\Start-ElectronDebug.ps1 -Disable          # turn off persistent CDP"
    Write-Host "  .\Start-ElectronDebug.ps1 -Status           # show toggle state"
    return
}

# Build target list
$targets = @()
if ($Path) {
    if (-not (Test-Path $Path)) {
        Write-Error "Path not found: $Path"
        return
    }
    $targets += [PSCustomObject]@{ Exe = (Resolve-Path $Path).Path; Name = [IO.Path]::GetFileNameWithoutExtension($Path) }
}
if ($All) {
    $targets += $running | ForEach-Object { [PSCustomObject]@{ Exe = $_.Exe; Name = $_.Name } }
}
if ($Name) {
    $matched = $running | Where-Object { $_.Exe -like "*$Name*" -or $_.Name -like "*$Name*" }
    if (-not $matched) {
        Write-Error "No running Electron app matches '$Name'. Run with no args to see the list."
        return
    }
    $targets += $matched | ForEach-Object { [PSCustomObject]@{ Exe = $_.Exe; Name = $_.Name } }
}

# Dedupe by exe path
$targets = $targets | Group-Object Exe | ForEach-Object { $_.Group | Select-Object -First 1 }

if (-not $targets) {
    Write-Host "Nothing to do."
    return
}

$results = @()
$port = $StartPort
foreach ($t in $targets) {
    $port = Get-NextFreePort -Start $port
    Write-Host ""
    Write-Host "[$($t.Name)]"
    $results += Start-AppWithCdp -ExePath $t.Exe -Port $port
    $port++
}

Write-Host ""
Write-Host "CDP endpoints:"
$results | Format-Table App, Port, JsonUrl -AutoSize
Write-Host "Inspect a target:  Invoke-RestMethod http://localhost:<port>/json | Select title, url"
