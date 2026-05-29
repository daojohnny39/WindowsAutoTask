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
      * The app is killed and relaunched - unsaved state is lost.
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
    orphaned renderer children). On by default - pass -Kill:$false to skip.

.PARAMETER Enable
    Persistent CDP toggle ON. Restarts all running Electron apps with CDP,
    saves their exe paths, and registers a logon scheduled task to restore
    CDP after reboot.

.PARAMETER Disable
    Persistent CDP toggle OFF. Restarts tracked apps without CDP, clears
    saved state, and removes the logon scheduled task.

.PARAMETER Restore
    Internal. Called by the logon scheduled task. Waits for tracked apps
    to appear, then restarts them with CDP. Legacy one-shot poll; -Watch
    is the current mechanism.

.PARAMETER Watch
    Internal. Resident, event-driven watcher started by the logon task.
    Subscribes to process-creation events and, whenever a tracked app's
    main process starts WITHOUT --remote-debugging-port, relaunches it with
    the flag. Catches every launch (boot, Start menu, manual) with no time
    window. Matches tracked apps by exe basename so it survives self-update
    path changes; relaunches using the live exe path. Single-instance via a
    named mutex. Runs in the user session so the relaunched window is visible.

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
    [switch]$Watch,
    [switch]$Status
)

$StatePath = Join-Path $PSScriptRoot "cdp-state.json"
$TaskName = "ElectronCDP-Persistent"

# Standalone Chromium browsers ignore --remote-debugging-port on their DEFAULT
# user-data-dir (Chromium 136+ hardening), so the debug port never opens. They
# need a dedicated --user-data-dir. Electron apps must NOT get this flag (it
# would wipe their logged-in profile), so gate strictly to browser exes.
$BrowserExes = @('chrome.exe','msedge.exe','brave.exe','opera.exe','vivaldi.exe','chromium.exe')

function Test-IsBrowser {
    param([string]$ExePath)
    return ($BrowserExes -contains [IO.Path]::GetFileName($ExePath).ToLower())
}

function Get-CdpSeedDir {
    param([string]$ExePath)
    $profile = [IO.Path]::GetFileNameWithoutExtension($ExePath).ToLower()
    return (Join-Path $env:LOCALAPPDATA "WindowsAutobot\cdp-profiles\$profile")
}

# Detect the user's currently-open profile dir from a running browser process.
# The main process started by double-click does not carry --user-data-dir, but
# its children (crashpad/renderer/gpu) do, so scan all instances. Call this
# BEFORE killing the browser. Falls back to the known default location.
function Get-BrowserSourceUserData {
    param([string]$ExePath)
    $bn = [IO.Path]::GetFileName($ExePath).ToLower()
    $procs = Get-CimInstance Win32_Process -Filter "name='$bn'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        $cl = $p.CommandLine
        if (-not $cl) { continue }
        if ($cl -match '"--user-data-dir=([^"]+)"') { return $matches[1] }
        elseif ($cl -match '--user-data-dir=([^"\s]+)') { return $matches[1] }
    }
    switch ($bn) {
        'chrome.exe' { return (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data') }
        'msedge.exe' { return (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data') }
        'brave.exe'  { return (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data') }
        default      { return $null }
    }
}

# Seed the dedicated automation profile ONCE from the user's real profile so the
# debug port (blocked on the default dir by Chromium 136+) opens while still
# carrying logins / bookmarks / extensions. Must run AFTER the browser is killed
# (profile unlocked) but with $SrcDir detected BEFORE the kill. Idempotent via a
# marker file; delete the seed dir to force a re-seed.
function Initialize-CdpBrowserProfile {
    param([string]$ExePath, [string]$SrcDir)
    $seedDir = Get-CdpSeedDir -ExePath $ExePath
    $marker = Join-Path $seedDir '.autobot-seeded'
    if (Test-Path $marker) { return $seedDir }
    if (Test-Path $seedDir) { Remove-Item -Recurse -Force $seedDir -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $seedDir | Out-Null
    if ($SrcDir -and (Test-Path $SrcDir)) {
        Write-Host "  Seeding automation profile from $SrcDir (first run; copies logins/bookmarks, skips caches)..."
        $excludeDirs  = @('Cache','Code Cache','GPUCache','ShaderCache','GrShaderCache','Service Worker','Crashpad','Snapshots','component_crx_cache','Crowd Deny','Subresource Filter')
        $excludeFiles = @('lockfile','SingletonLock','SingletonCookie','SingletonSocket','DevToolsActivePort')
        $roboArgs = @("$SrcDir","$seedDir",'/E','/R:0','/W:0','/NFL','/NDL','/NJH','/NJS','/NP','/XJ','/XD') + $excludeDirs + @('/XF') + $excludeFiles
        & robocopy.exe @roboArgs | Out-Null
        # robocopy uses exit codes 0-7 for success; clear it so callers do not
        # mistake a successful copy for a failure.
        if ($LASTEXITCODE -lt 8) { cmd /c "exit 0" }
    }
    Set-Content -Path $marker -Value (Get-Date -Format 'o') -ErrorAction SilentlyContinue
    return $seedDir
}

function Get-CdpLaunchArgs {
    param([string]$ExePath, [int]$Port)
    $cdpArgs = "--remote-debugging-port=$Port"
    if (Test-IsBrowser -ExePath $ExePath) {
        $dir = Get-CdpSeedDir -ExePath $ExePath
        $cdpArgs += " --user-data-dir=`"$dir`" --no-first-run --no-default-browser-check"
    }
    return $cdpArgs
}

# --- External link redirect into the CDP sandbox profile ----------------------
# When CDP is on, the user's working browser is the dedicated sandbox profile
# (the only one with a debug port). An external link click (Discord etc.) is
# opened by Windows through the browser's URL-handler ProgId, whose command runs
# chrome.exe WITHOUT --user-data-dir => it targets the DEFAULT profile, spawning
# a throwaway window that the watcher then kills and re-forwards into the sandbox
# - the user sees the link flash in a stray window for a moment first. Pointing
# that ProgId command at the sandbox profile makes the link route straight into
# the running sandbox singleton (new tab in the last-focused window), so no
# default window is ever created and there is no flash. The override lives in
# HKCU\Software\Classes (per-user, wins over the machine HKLM command) and is
# fully reversible by deleting the key, so the default profile is restored the
# moment CDP is turned off.

# Map a browser exe to the URL-handler ProgId Windows runs for http/https links.
# Only browsers with a known ProgId are redirected; others fall back to the
# watcher's consolidation path (still correct, just with the brief flash).
function Get-BrowserUrlProgId {
    param([string]$ExePath)
    switch ([IO.Path]::GetFileName($ExePath).ToLower()) {
        'chrome.exe' { return 'ChromeHTML' }
        'msedge.exe' { return 'MSEdgeHTM' }
        'brave.exe'  { return 'BraveHTML' }
        default      { return $null }
    }
}

function Set-BrowserLinkRedirect {
    param([string]$ExePath)
    $progId = Get-BrowserUrlProgId -ExePath $ExePath
    if (-not $progId) { return }
    $seed = Get-CdpSeedDir -ExePath $ExePath
    # --single-argument must stay last; it consumes %1 as one literal URL token.
    $cmd = '"' + $ExePath + '" --user-data-dir="' + $seed + '" --single-argument %1'
    $key = "HKCU:\Software\Classes\$progId\shell\open\command"
    if (Test-Path $key) {
        $cur = (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)'
        if ($cur -eq $cmd) { return }   # already current - skip redundant write
    }
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $cmd
    Write-Host "  Link redirect ON: $progId -> sandbox profile"
}

function Remove-BrowserLinkRedirect {
    param([string]$ExePath)
    $progId = Get-BrowserUrlProgId -ExePath $ExePath
    if (-not $progId) { return }
    $cmdKey = "HKCU:\Software\Classes\$progId\shell\open\command"
    if (-not (Test-Path $cmdKey)) { return }
    # The command key is always ours (we created it) - remove it outright, then
    # prune the ancestor keys we created, stopping at the first one that still
    # has children or values so we never delete a ProgId key with other data.
    Remove-Item -Path $cmdKey -Force -ErrorAction SilentlyContinue
    foreach ($k in @(
        "HKCU:\Software\Classes\$progId\shell\open",
        "HKCU:\Software\Classes\$progId\shell",
        "HKCU:\Software\Classes\$progId"
    )) {
        if (-not (Test-Path $k)) { continue }
        $children = @(Get-ChildItem $k -ErrorAction SilentlyContinue).Count
        $values = @((Get-Item $k -ErrorAction SilentlyContinue).Property).Count
        if ($children -eq 0 -and $values -eq 0) {
            Remove-Item -Path $k -Force -ErrorAction SilentlyContinue
        } else { break }
    }
    Write-Host "  Link redirect OFF: $progId (restored default profile)"
}

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

    # Capture the user's currently-open profile dir before we kill the browser.
    $srcDir = $null
    if (Test-IsBrowser -ExePath $ExePath) { $srcDir = Get-BrowserSourceUserData -ExePath $ExePath }

    if ($Kill) {
        $killed = Stop-AppByExe -ExePath $ExePath
        if ($killed -gt 0) { Write-Host "  Stopped $killed process(es) for $name" }
    }

    if (Test-IsBrowser -ExePath $ExePath) { Initialize-CdpBrowserProfile -ExePath $ExePath -SrcDir $srcDir | Out-Null }

    $launchArgs = Get-CdpLaunchArgs -ExePath $ExePath -Port $Port
    Write-Host "  Launching $name with $launchArgs"
    Start-Process -FilePath $ExePath -ArgumentList $launchArgs

    # Route external link clicks straight into this sandbox profile (no flash).
    if (Test-IsBrowser -ExePath $ExePath) { Set-BrowserLinkRedirect -ExePath $ExePath }

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

    # Restore default-profile link handling (undo the sandbox redirect).
    if (Test-IsBrowser -ExePath $ExePath) { Remove-BrowserLinkRedirect -ExePath $ExePath }

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

$VbsLauncherPath = Join-Path $PSScriptRoot "cdp-watch-launch.vbs"

function Write-VbsLauncher {
    # Task Scheduler runs the logon task in the interactive session, so
    # `powershell.exe -WindowStyle Hidden` still allocates a visible console
    # window before PowerShell can hide it - and the resident -Watch loop never
    # exits, so that window stays up (with the relaunched Discord's Chromium logs
    # attaching to it). Launching through wscript + WshShell.Run(..., 0, False)
    # creates the console already hidden, so no window ever appears.
    $q = '""'   # doubled quote = one literal quote inside a VBS string
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $q$PSCommandPath$q -Watch"
    $vbs = @"
' Auto-generated by Start-ElectronDebug.ps1. Launches the resident CDP watcher
' with an already-hidden console so no PowerShell window appears at logon.
CreateObject("WScript.Shell").Run "powershell.exe $psArgs", 0, False
"@
    Set-Content -Path $VbsLauncherPath -Value $vbs -Encoding ascii
    return $VbsLauncherPath
}

function Register-CdpLogonTask {
    $vbsPath = Write-VbsLauncher
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbsPath + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    # ExecutionTimeLimit 0 = no limit; the watcher is meant to run for the whole session.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero)

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
    } else {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Settings $settings -Description "Run hidden Electron CDP watcher after logon" | Out-Null
    }
    Write-Host "  Logon task '$TaskName' registered (hidden watcher via $vbsPath)."
}

function Unregister-CdpLogonTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  Logon task '$TaskName' removed."
    }
    if (Test-Path $VbsLauncherPath) {
        Remove-Item $VbsLauncherPath -Force -ErrorAction SilentlyContinue
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
            Write-Host "  Already has CDP on port $($app.DebugPort) - keeping as-is"
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

    # Ensure link redirect is on for every tracked browser (covers the
    # already-had-CDP branch that skips Start-AppWithCdp).
    foreach ($r in $results) { if (Test-IsBrowser -ExePath $r.Exe) { Set-BrowserLinkRedirect -ExePath $r.Exe } }

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
        # Always undo the link redirect, even if the browser isn't running now
        # (Start-AppNormally only runs for live apps).
        if (Test-IsBrowser -ExePath $app.exe) { Remove-BrowserLinkRedirect -ExePath $app.exe }

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

# ---------- Watch (resident, event-driven) ----------
if ($Watch) {
    # Single-instance guard so re-running the logon task / on-demand starts
    # don't stack multiple watchers.
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, 'Global\ElectronCdpWatcher', [ref]$createdNew)
    if (-not $createdNew) {
        Write-Host "Watcher already running. Exiting."
        return
    }

    # Tracked-app basenames (lowercase) from current state. Re-read each event
    # so newly selected/deselected apps are picked up without a restart.
    function Get-TrackedBasenames {
        $st = Get-CdpState
        if (-not $st -or -not $st.enabled) { return @{} }
        $map = @{}
        foreach ($a in $st.apps) {
            $bn = [IO.Path]::GetFileName($a.exe)
            if ($bn) { $map[$bn.ToLower()] = $true }
        }
        return $map
    }

    # Persist live path + port (replace any prior entry with same basename).
    function Save-ReflagState {
        param([string]$ExePath, [string]$Name, [int]$Port)
        $st = Get-CdpState
        if (-not $st) { return }
        $bn = [IO.Path]::GetFileName($ExePath)
        $kept = @($st.apps | Where-Object { [IO.Path]::GetFileName($_.exe) -ne $bn })
        $newApps = @()
        foreach ($k in $kept) { $newApps += @{ name = $k.name; exe = $k.exe; port = $k.port } }
        $newApps += @{ name = $Name; exe = $ExePath; port = $Port }
        $out = @{
            enabled   = $true
            startPort = $StartPort
            apps      = $newApps
            updatedAt = (Get-Date -Format 'o')
        }
        $out | ConvertTo-Json -Depth 3 | Set-Content $StatePath -Encoding utf8
    }

    # Browser process groups, split by which --user-data-dir they carry. The
    # sandbox group is the dedicated automation profile autobot drives (CDP port
    # open); the default group is every other window (the user's normal profile),
    # which CANNOT expose a debug port on Chromium 136+ and so is invisible to
    # the app. ALL children of a browser carry --user-data-dir, so absence of the
    # seed path reliably identifies a default-profile process.
    function Get-SandboxBrowserProcs {
        param([string]$ExePath)
        $bn = [IO.Path]::GetFileName($ExePath).ToLower()
        $seed = [Regex]::Escape((Get-CdpSeedDir -ExePath $ExePath))
        return @(Get-CimInstance Win32_Process -Filter "name='$bn'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $seed })
    }
    function Get-DefaultBrowserProcs {
        param([string]$ExePath)
        $bn = [IO.Path]::GetFileName($ExePath).ToLower()
        $seed = [Regex]::Escape((Get-CdpSeedDir -ExePath $ExePath))
        return @(Get-CimInstance Win32_Process -Filter "name='$bn'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -notmatch $seed })
    }

    # Pull the URL/file launch args out of a browser command line so we can carry
    # them over when we relaunch the window into the sandbox profile.
    function Get-BrowserUrlArgs {
        param([string]$Cmd)
        if (-not $Cmd) { return @() }
        $tail = $Cmd
        if ($Cmd -match '^\s*"[^"]+"\s*(.*)$') { $tail = $matches[1] }
        elseif ($Cmd -match '^\s*\S+\s+(.*)$') { $tail = $matches[1] }
        $urls = @()
        foreach ($m in [Regex]::Matches($tail, '(?:https?|file|chrome)://\S+')) {
            $u = $m.Value.Trim('"')
            if ($u -notmatch 'remote-debugging' -and $u -notmatch '^chrome://newtab') { $urls += $u }
        }
        return $urls
    }

    # Consolidate a browser: route the user's default-profile window(s) into the
    # debug-enabled sandbox profile so the app can see and drive them. Chromium's
    # per-profile singleton means launching the SAME exe with --user-data-dir=seed
    # forwards the URLs into the already-running sandbox process as a new window
    # on its existing debug port - no second process, fully detectable. We then
    # kill ONLY the default-profile tree; the sandbox process autobot is driving
    # is never touched (we match it by the seed path).
    #
    # Limitation: a URL is only recoverable if it sits in a process command line.
    # The first window the user opens does (its launch created the default main),
    # so the common single-window case is fully preserved. But once a default
    # process is live, further windows/tabs FORWARD into it and their launchers
    # exit, leaving their URLs in no command line and unreadable (the default
    # profile has no debug port - that is the whole reason for the sandbox). Those
    # extra URLs are lost on consolidation. In steady state the watcher consolidates
    # each launch within ~3s, so a fresh default main (URL intact) is the norm.
    function Invoke-BrowserConsolidate {
        param([string]$ExePath, [string]$TriggerCmd)
        $name = [IO.Path]::GetFileNameWithoutExtension($ExePath)
        $seedDir = Get-CdpSeedDir -ExePath $ExePath

        $default = Get-DefaultBrowserProcs -ExePath $ExePath
        $sandbox = Get-SandboxBrowserProcs -ExePath $ExePath
        $sandboxRunning = $sandbox.Count -gt 0

        # Our own forwarder relaunch (sandbox dir, no debug port yet) can fire the
        # creation event - nothing to consolidate then.
        if ($default.Count -eq 0) { return }

        # Gather URLs to carry over: the trigger command line plus every default-
        # profile main about to be killed (covers several windows opened inside
        # one anti-thrash window, where only one fired the trigger). Deduped.
        $urls = @()
        $urls += Get-BrowserUrlArgs -Cmd $TriggerCmd
        foreach ($p in ($default | Where-Object { $_.CommandLine -notmatch '--type=' })) {
            $urls += Get-BrowserUrlArgs -Cmd $p.CommandLine
        }
        $urls = @($urls | Select-Object -Unique)

        # Did the user actually ask for a separate window? Chromium passes
        # --new-window only for Ctrl+N / "New window" launches; an external link
        # click (Discord -> chrome.exe "<url>") carries no such flag and Chrome's
        # default is to open it as a new TAB in the last-focused window. Detect
        # the user's intent from the trigger + default-main command lines so we
        # reproduce that default instead of always spawning a new window.
        $srcCmds = @($TriggerCmd) + @($default | ForEach-Object { $_.CommandLine })
        $wantsNewWindow = @($srcCmds | Where-Object { $_ -and $_ -match '--new-window' }).Count -gt 0

        $port = $null
        foreach ($p in $sandbox) { if ($p.CommandLine -match 'remote-debugging-port=(\d+)') { $port = [int]$matches[1]; break } }

        $defRenderers = @($default | Where-Object { $_.CommandLine -match '--type=renderer' }).Count
        if ($defRenderers -gt 1 -and $urls.Count -eq 0) {
            Write-Host "Consolidating $name default profile (~$defRenderers renderers) with no URL args - existing tabs cannot be recovered."
        }

        # Capture the on-disk source profile BEFORE killing, in case we need to seed.
        $srcDir = $null
        if (-not $sandboxRunning) { $srcDir = Get-BrowserSourceUserData -ExePath $ExePath }

        $default | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            if ((Get-DefaultBrowserProcs -ExePath $ExePath).Count -eq 0) { break }
            Start-Sleep -Milliseconds 200
        }

        if ($sandboxRunning) {
            # Forward into the live sandbox process (singleton routes there).
            # Only carry --new-window through when the user's original launch
            # asked for it; otherwise omit it so the URL forwards as a new TAB in
            # the sandbox's last-focused window - matching Chrome's normal "open
            # in my last window" behavior for external link clicks. When the user
            # did want separate windows, launch one --new-window per URL so several
            # rapid windows don't collapse into one.
            $winFlag = if ($wantsNewWindow) { ' --new-window' } else { '' }
            $base = "--user-data-dir=`"$seedDir`" --no-first-run --no-default-browser-check$winFlag"
            Write-Host "Consolidating $name into sandbox profile (port $port, newWindow=$wantsNewWindow): $($urls -join ' ')"
            if ($urls.Count -eq 0) {
                Start-Process -FilePath $ExePath -ArgumentList $base
            } elseif ($wantsNewWindow) {
                foreach ($u in $urls) { Start-Process -FilePath $ExePath -ArgumentList "$base $u" }
            } else {
                # Tab mode: forward all URLs in one launch; each becomes a tab in
                # the last-focused window.
                Start-Process -FilePath $ExePath -ArgumentList "$base $($urls -join ' ')"
            }
        } else {
            # No sandbox process yet - start one with the debug port.
            Initialize-CdpBrowserProfile -ExePath $ExePath -SrcDir $srcDir | Out-Null
            $port = Get-NextFreePort -Start $StartPort
            $argList = "--remote-debugging-port=$port --user-data-dir=`"$seedDir`" --no-first-run --no-default-browser-check"
            if ($urls.Count -gt 0) { $argList += ' ' + ($urls -join ' ') }
            Write-Host "Starting $name sandbox profile on port ${port}: $($urls -join ' ')"
            Start-Process -FilePath $ExePath -ArgumentList $argList
            Save-ReflagState -ExePath $ExePath -Name $name -Port $port
        }
    }

    # Kill the exe's whole process group and relaunch it with CDP on a free
    # port, then record the live path + port in state. Uses the live path so
    # self-update folder changes are absorbed automatically. Browsers route
    # through Invoke-BrowserConsolidate (profile-scoped, non-destructive to the
    # sandbox process); Electron apps keep the original kill-by-path behavior.
    $script:lastReflag = @{}
    function Invoke-Reflag {
        param([string]$ExePath, [string]$TriggerCmd)
        if (-not $ExePath) { return }
        $key = $ExePath.ToLower()
        # Anti-thrash: skip if we just relaunched this exe.
        if ($script:lastReflag.ContainsKey($key)) {
            if (((Get-Date) - $script:lastReflag[$key]).TotalSeconds -lt 10) { return }
        }
        $script:lastReflag[$key] = Get-Date

        if (Test-IsBrowser -ExePath $ExePath) {
            Invoke-BrowserConsolidate -ExePath $ExePath -TriggerCmd $TriggerCmd
            return
        }

        $name = [IO.Path]::GetFileNameWithoutExtension($ExePath)

        Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -eq $ExePath } catch { $false }
        } | Stop-Process -Force -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            $still = Get-Process -ErrorAction SilentlyContinue | Where-Object {
                try { $_.Path -eq $ExePath } catch { $false }
            }
            if (-not $still) { break }
            Start-Sleep -Milliseconds 200
        }

        $port = Get-NextFreePort -Start $StartPort
        $launchArgs = Get-CdpLaunchArgs -ExePath $ExePath -Port $port
        Write-Host "Re-flagging $name -> $launchArgs"
        Start-Process -FilePath $ExePath -ArgumentList $launchArgs
        Save-ReflagState -ExePath $ExePath -Name $name -Port $port
    }

    # Decide whether a Win32_Process snapshot is a tracked MAIN process that
    # is missing the CDP flag (so a child renderer or an already-flagged main
    # is ignored - that is the loop guard). For browsers, any process already on
    # the sandbox profile is ours (debug port open or our own forwarder) and must
    # be skipped; only default-profile mains need consolidating.
    function Test-NeedsReflag {
        param($Proc, $Tracked)
        if (-not $Proc) { return $false }
        $exe = $Proc.ExecutablePath
        if (-not $exe) { return $false }
        $bn = [IO.Path]::GetFileName($exe).ToLower()
        if (-not $Tracked.ContainsKey($bn)) { return $false }
        $cmd = $Proc.CommandLine
        if ($cmd -and $cmd -match '--type=') { return $false }              # child process
        if (Test-IsBrowser -ExePath $exe) {
            $seed = [Regex]::Escape((Get-CdpSeedDir -ExePath $exe))
            if ($cmd -and $cmd -match $seed) { return $false }              # sandbox profile - ours
            return $true                                                    # default profile - consolidate
        }
        if ($cmd -and $cmd -match '--remote-debugging-port') { return $false } # already flagged
        return $true
    }

    # Periodic reliability sweep: WMI WITHIN-3 indications miss short-lived
    # forwarder processes and windows opened inside an already-running browser
    # (no fresh main spawns). Re-scanning live processes each tick catches a
    # default-profile browser however it appeared, and any un-flagged Electron
    # main. Browser groups collapse default+sandbox under one exe path, so we
    # inspect command lines directly rather than trusting Find-RunningElectronApps.
    function Invoke-Sweep {
        param($Tracked)
        foreach ($bn in $Tracked.Keys) {
            $procs = @(Get-CimInstance Win32_Process -Filter "name='$bn'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine })
            if ($procs.Count -eq 0) { continue }
            $exe = ($procs | Where-Object { $_.ExecutablePath } | Select-Object -First 1).ExecutablePath
            if (-not $exe) { continue }
            if (Test-IsBrowser -ExePath $exe) {
                # Keep the link redirect asserted (Chrome can rewrite its
                # registration on update/launch); cheap - skips redundant writes.
                Set-BrowserLinkRedirect -ExePath $exe
                $seed = [Regex]::Escape((Get-CdpSeedDir -ExePath $exe))
                $defMain = @($procs | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch $seed })
                if ($defMain.Count -gt 0) { Invoke-Reflag -ExePath $exe -TriggerCmd $defMain[0].CommandLine }
            } else {
                $unflagged = @($procs | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--remote-debugging-port' })
                if ($unflagged.Count -gt 0) { Invoke-Reflag -ExePath $exe }
            }
        }
    }

    Write-Host "ElectronCDP watcher starting..."

    # Initial sweep: any tracked main already running without the flag (default-
    # profile browser window, un-flagged Electron app) gets consolidated now.
    Invoke-Sweep -Tracked (Get-TrackedBasenames)

    $query = "SELECT * FROM __InstanceCreationEvent WITHIN 3 WHERE TargetInstance ISA 'Win32_Process'"
    Register-CimIndicationEvent -Query $query -SourceIdentifier 'ElectronCdpProcWatch' | Out-Null
    Write-Host "Watching for tracked Electron app launches."

    try {
        while ($true) {
            # Wake on a creation event (fast path) OR every 3s (reliability sweep).
            $evt = Wait-Event -SourceIdentifier 'ElectronCdpProcWatch' -Timeout 3
            $tracked = Get-TrackedBasenames
            if ($tracked.Count -gt 0) {
                if ($evt) {
                    try {
                        $proc = $evt.SourceEventArgs.NewEvent.TargetInstance
                        if (Test-NeedsReflag -Proc $proc -Tracked $tracked) {
                            Invoke-Reflag -ExePath $proc.ExecutablePath -TriggerCmd $proc.CommandLine
                        }
                    } catch {
                        Write-Host "Watch handler error: $($_.Exception.Message)"
                    }
                }
                # Periodic sweep catches launches the WITHIN-3 indication missed
                # (short-lived forwarders, new windows in an already-running browser).
                try { Invoke-Sweep -Tracked $tracked } catch { Write-Host "Sweep error: $($_.Exception.Message)" }
            }
            if ($evt) { Remove-Event -EventIdentifier $evt.EventIdentifier -ErrorAction SilentlyContinue }
        }
    } finally {
        Unregister-Event -SourceIdentifier 'ElectronCdpProcWatch' -ErrorAction SilentlyContinue
        $mutex.ReleaseMutex()
    }
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
