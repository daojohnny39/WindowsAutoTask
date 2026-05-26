const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile: _rawExecFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

// execFile wrapper with transient-spawn-failure retry.
//
// On Windows, `execFile('powershell.exe', ...)` periodically fails with
// `spawn EPERM` (also seen: EBUSY, EAGAIN, EMFILE, ENFILE, ETXTBSY). The
// root cause is environmental: Defender / EDR scanning the binary, parent
// process handle pressure, or transient file-lock contention on the
// powershell.exe image. The child process never starts, so there is no
// stdout/stderr — only an error from libuv's `uv_spawn`.
//
// Every CDP / UIA / detection tool in this app shells out to PowerShell,
// so a single transient EPERM aborts whichever step is unlucky (e.g. step
// 9 of a 15-step automation). The fix is to retry the spawn itself a
// small number of times with exponential backoff. Once the OS releases
// the contention, the retry succeeds and the caller sees a normal result.
//
// Signature matches `child_process.execFile(file, args, options, callback)`
// so the 14+ existing call sites need no change. Only `spawn`-stage errors
// are retried — failures from the spawned process (non-zero exit, stderr
// content, timeouts) are returned to the caller unchanged.
const TRANSIENT_SPAWN_CODES = new Set(['EPERM', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY']);
const MAX_SPAWN_RETRIES = 4;
function execFile(cmd, args, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = undefined; }
  let attempt = 0;
  const handleErr = (err) => {
    if (err && err.syscall === 'spawn' && TRANSIENT_SPAWN_CODES.has(err.code) && attempt < MAX_SPAWN_RETRIES) {
      attempt++;
      const delay = 80 * Math.pow(2, attempt - 1); // 80, 160, 320, 640 ms
      try { debugLog(`[execFile retry ${attempt}/${MAX_SPAWN_RETRIES}] ${cmd} ${err.code} delay=${delay}ms`); } catch {}
      setTimeout(tryOnce, delay);
      return true;
    }
    return false;
  };
  const tryOnce = () => {
    // `_rawExecFile` can fail in two ways on Windows under AV / handle pressure:
    //   - asynchronously via the callback (the documented path)
    //   - synchronously by THROWING from libuv's `uv_spawn` (less documented;
    //     happens when CreateProcessW returns ERROR_ACCESS_DENIED immediately).
    // Both must route through the same retry path.
    let child;
    try {
      child = _rawExecFile(cmd, args, opts || {}, (err, stdout, stderr) => {
        if (err && handleErr(err)) return;
        if (cb) cb(err, stdout, stderr);
      });
    } catch (err) {
      if (handleErr(err)) return null;
      try { debugLog(`[execFile sync-throw] ${cmd} code=${err.code} syscall=${err.syscall} msg=${(err.message||'').slice(0,160)}`); } catch {}
      if (cb) setImmediate(() => cb(err, '', ''));
      return null;
    }
    return child;
  };
  return tryOnce();
}

const STATE_PATH = path.join(__dirname, '..', 'cdp-state.json');
const PS_SCRIPT_PATH = path.join(__dirname, '..', 'Start-ElectronDebug.ps1');
const TASK_NAME = 'ElectronCDP-Persistent';
const AGENT_DIR = path.join(__dirname, '..', 'app-agents');
const AGENT_USER_HEADING = '## User notes';
const SNAPSHOT_ELEMENT_CAP = 500;
const AUTOMATIONS_DIR = path.join(__dirname, '..', 'automations');
const AUTOMATION_TOOLS_CDP = new Set([
  'cdp_find', 'cdp_click', 'cdp_type', 'cdp_paste', 'cdp_press_key',
  'cdp_get_text', 'cdp_get_tree', 'cdp_get_messages',
  'cdp_scroll_to_message', 'cdp_scroll_messages',
  'cdp_scroll',
  'cdp_get_search_results', 'cdp_set_search_sort', 'cdp_jump_to_search_result',
]);
const AUTOMATION_TOOLS_UIA = new Set([
  'uia_invoke', 'uia_set_value', 'uia_get_tree',
]);

const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const CODEX_BIN = process.platform === 'win32' ? 'codex.cmd' : 'codex';
let codexLoginProc = null;

const DETECT_SCRIPT = `
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
    $alreadyDebug = $false; $debugPort = $null
    if ($main.CommandLine -match '--remote-debugging-port=(\\d+)') {
        $alreadyDebug = $true; $debugPort = [int]$Matches[1]
    }
    $apps += @{
        Name         = [IO.Path]::GetFileNameWithoutExtension($group.Name)
        Exe          = $group.Name
        MainPid      = [int]$main.ProcessId
        ProcessCount = $group.Count
        DebugEnabled = $alreadyDebug
        DebugPort    = $debugPort
    }
}
if ($apps.Count -eq 0) { Write-Output '[]' }
elseif ($apps.Count -eq 1) { Write-Output ('[' + ($apps | ConvertTo-Json -Compress) + ']') }
else { $apps | ConvertTo-Json -Compress }
`;

const DETECT_UIA_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)

$excludePid = ${process.pid}
$apps = @{}
$trueCond = [System.Windows.Automation.Condition]::TrueCondition

foreach ($win in $windows) {
    try {
        $wpid = $win.Current.ProcessId
        if ($wpid -le 0 -or $wpid -eq $excludePid) { continue }

        $proc = Get-Process -Id $wpid -ErrorAction SilentlyContinue
        if (-not $proc -or -not $proc.Path) { continue }

        $exe = $proc.Path

        if ($apps.ContainsKey($exe)) {
            $apps[$exe].WindowCount++
            continue
        }

        $title = $win.Current.Name
        if (-not $title) { $title = $proc.ProcessName }

        $children = $win.FindAll([System.Windows.Automation.TreeScope]::Children, $trueCond)
        $aidCount = 0

        foreach ($child in $children) {
            try {
                $aid = $child.Current.AutomationId
                if ($aid) { $aidCount++ }
            } catch {}
        }

        $apps[$exe] = @{
            Name              = [IO.Path]::GetFileNameWithoutExtension($exe)
            Exe               = $exe
            WindowTitle       = $title
            Pid               = [int]$wpid
            WindowCount       = 1
            ElementCount      = [int]$children.Count
            AutomationIdCount = $aidCount
        }
    } catch { continue }
}

$result = @($apps.Values)
if ($result.Count -eq 0) { Write-Output '[]' }
elseif ($result.Count -eq 1) { Write-Output ('[' + ($result | ConvertTo-Json -Compress) + ']') }
else { $result | ConvertTo-Json -Compress }
`;

function loadCdpState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {}
  return { enabled: false, startPort: 9222, apps: [], updatedAt: null };
}

function saveCdpState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function registerLogonTask() {
  return new Promise((resolve) => {
    const scriptPath = PS_SCRIPT_PATH.replace(/'/g, "''");
    const cmd = `
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '${scriptPath}' -Restore"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$existing = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
if ($existing) {
    Set-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings | Out-Null
} else {
    Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Description "Restart Electron apps with CDP after logon" | Out-Null
}`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { timeout: 15000 }, () => resolve());
  });
}

function unregisterLogonTask() {
  return new Promise((resolve) => {
    const cmd = `
$existing = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { timeout: 15000 }, () => resolve());
  });
}

function detectElectronApps() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', DETECT_SCRIPT
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        const apps = JSON.parse(stdout.trim());
        resolve(apps);
      } catch (e) {
        resolve([]);
      }
    });
  });
}

function detectUiaApps() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', DETECT_UIA_SCRIPT
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve([]);
      }
    });
  });
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
}

function buildSingleAppCdpScript(exe, enable) {
  const pid = process.pid;
  return `
$myPid = ${pid}
$targetExe = '${exe.replace(/'/g, "''")}'
Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $targetExe -and $_.Id -ne $myPid } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    $still = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -eq $targetExe -and $_.Id -ne $myPid } catch { $false }
    }
    if (-not $still) { break }
    Start-Sleep -Milliseconds 200
}
${enable ? `
$port = 9222
while ($port -lt 65535) {
    $inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if (-not $inUse) { break }
    $port++
}
Start-Process -FilePath $targetExe -ArgumentList "--remote-debugging-port=$port"
` : `
Start-Process -FilePath $targetExe
`}
Start-Sleep -Seconds 3
`;
}

function restartSingleApp(exe, enable) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', buildSingleAppCdpScript(exe, enable)
    ], { timeout: 30000 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function buildInspectScript(pid) {
  return `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$targetPid = ${pid}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $pidCond)

$elements = [System.Collections.ArrayList]@()
$trueCond = [System.Windows.Automation.Condition]::TrueCondition
$max = 500

foreach ($win in $windows) {
    try {
        $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $trueCond)
        foreach ($el in $all) {
            if ($elements.Count -ge $max) { break }
            try {
                $ct = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
                $name = $el.Current.Name
                $aid = $el.Current.AutomationId
                $cls = $el.Current.ClassName
                if (-not $name -and -not $aid) { continue }
                [void]$elements.Add(@{
                    Type = $ct
                    Name = "$name"
                    AutomationId = "$aid"
                    ClassName = "$cls"
                })
            } catch { continue }
        }
    } catch { continue }
    if ($elements.Count -ge $max) { break }
}

$result = @($elements)
if ($result.Count -eq 0) { Write-Output '[]' }
elseif ($result.Count -eq 1) { Write-Output ('[' + ($result[0] | ConvertTo-Json -Compress) + ']') }
else { $result | ConvertTo-Json -Compress }
`;
}

function inspectAppElements(pid) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', buildInspectScript(pid)
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve([]);
      }
    });
  });
}

function escapePs(s) {
  return String(s || '').replace(/'/g, "''");
}

function buildUiaActionScript(action, args) {
  const pid = parseInt(args.pid, 10);
  const aid = escapePs(args.automationId || '');
  const name = escapePs(args.name || '');
  const ctrl = escapePs(args.controlType || '');
  const text = escapePs(args.text || '');

  const finder = `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$pidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${pid})
$el = $null
if ('${aid}' -ne '') {
    $aidCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '${aid}')
    $cond = New-Object System.Windows.Automation.AndCondition($pidCond, $aidCond)
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
if (-not $el -and '${name}' -ne '') {
    $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${name}')
    $cond = New-Object System.Windows.Automation.AndCondition($pidCond, $nameCond)
    $matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ('${ctrl}' -ne '') {
        foreach ($m in $matches) {
            try {
                $ct = $m.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
                if ($ct -eq '${ctrl}') { $el = $m; break }
            } catch {}
        }
    }
    if (-not $el -and $matches.Count -gt 0) { $el = $matches[0] }
}
if (-not $el) { Write-Output '{"error":"element_not_found"}'; exit }
`;

  if (action === 'invoke') {
    return `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${finder}
try {
    $invoke = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        Write-Output '{"ok":true,"mode":"invoke"}'
        exit
    }
    $toggle = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
        $toggle.Toggle()
        Write-Output '{"ok":true,"mode":"toggle"}'
        exit
    }
    $select = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$select)) {
        $select.Select()
        Write-Output '{"ok":true,"mode":"select"}'
        exit
    }
    $expand = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
        $expand.Expand()
        Write-Output '{"ok":true,"mode":"expand"}'
        exit
    }
    Write-Output '{"error":"no_actionable_pattern"}'
} catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}`;
  }

  if (action === 'setValue') {
    return `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
${finder}
try {
    $value = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
        if ($value.Current.IsReadOnly) { Write-Output '{"error":"read_only"}'; exit }
        $value.SetValue('${text}')
        Write-Output '{"ok":true,"mode":"value_pattern"}'
        exit
    }
    $el.SetFocus()
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    Start-Sleep -Milliseconds 50
    $escaped = '${text}'.Replace('+','{+}').Replace('^','{^}').Replace('%','{%}').Replace('~','{~}').Replace('(','{(}').Replace(')','{)}').Replace('{','{{}').Replace('}','{}}')
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
    Write-Output '{"ok":true,"mode":"sendkeys"}'
} catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}`;
  }

  throw new Error(`Unknown UIA action: ${action}`);
}

function uiaAction(action, args) {
  return new Promise((resolve, reject) => {
    let script;
    try { script = buildUiaActionScript(action, args); }
    catch (e) { return reject(e); }
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) { debugLog(`[uiaAction err] ${err.message}`); return reject(err); }
      const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      try { resolve(JSON.parse(line || '{}')); }
      catch { resolve({ error: 'parse_failed', raw: stdout.slice(0, 200) }); }
    });
  });
}

function buildScrollToMessageExpr(messageId) {
  const idJson = JSON.stringify(String(messageId || ''));
  return `(function(){var raw=${idJson};if(!raw)return JSON.stringify({error:'no_id'});var el=document.getElementById(raw);if(!el){try{var safe=raw.replace(/[^a-zA-Z0-9_:.\\\\-]/g,'');if(safe)el=document.querySelector('li[id$="-'+safe+'"]')||document.querySelector('[id$="-'+safe+'"]');}catch(e){}}if(!el)return JSON.stringify({error:'message_not_found',id:raw});try{el.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});}catch(e){}var r=el.getBoundingClientRect();var prev=el.style.outline;var prevTr=el.style.transition;try{el.style.transition='outline-color 0.6s ease-out';el.style.outline='2px solid #5865F2';setTimeout(function(){try{el.style.outline=prev||'';el.style.transition=prevTr||'';}catch(e){}},1800);}catch(e){}return JSON.stringify({ok:true,id:el.id,top:Math.round(r.top),left:Math.round(r.left),height:Math.round(r.height),visible:r.top>=0&&r.bottom<=window.innerHeight,innerHeight:window.innerHeight});})()`;
}

// Discord search-results panel scraping ──────────────────────────────────────
//
// cdp_get_tree against [aria-label="Search Results"] is unreliable because:
//   (a) result rows are <li role="listitem"> and the snapshot filter drops
//       role=listitem to suppress chat-log noise — so the model never sees
//       the row ids it needs to jump,
//   (b) the "Jump" button on each row is hover-revealed (Discord toggles
//       visibility via CSS on :hover) — it is in the DOM with zero pointer-
//       events until hover, so even a click attempt fails.
//
// buildSearchResultsExpr returns structured per-row data so the model can
// pick a target without needing a snapshot ref, and buildJumpRowCoordsExpr /
// buildJumpButtonCoordsExpr feed cdpJumpSearchResultReal which hovers the
// row at CDP layer (real native-mouse :hover) before clicking Jump.
function buildSearchResultsExpr(limit) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  return `(function(LIMIT){function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ').trim();}var panel=document.querySelector('section[aria-label="Search Results"]')||document.querySelector('[class*="searchResultsWrap_"]');if(!panel)return JSON.stringify({error:'no_search_panel',hint:'Open the channel-header search bar (cdp_find(\"Search \") + cdp_click + cdp_paste + cdp_press_key(\"Enter\")) and wait for results before calling cdp_get_search_results.'});var sortMode='';try{var sortBtn=panel.querySelector('[role="tab"][aria-selected="true"], [role="tab"][aria-pressed="true"]');if(sortBtn)sortMode=clean(sortBtn.textContent);if(!sortMode){var sortBtns=Array.from(panel.querySelectorAll('[role="tab"], button'));for(var si=0;si<sortBtns.length;si++){var sb=sortBtns[si];var t=clean(sb.textContent).toLowerCase();if((t==='new'||t==='old'||t==='relevant')&&(sb.getAttribute('aria-selected')==='true'||sb.getAttribute('aria-pressed')==='true'||/active|selected/.test(sb.className||''))){sortMode=clean(sb.textContent);break;}}}}catch(e){}var pages=[];try{var pageEls=Array.from(panel.querySelectorAll('[aria-label^="Page "], [class*="pagination"] [role="button"], [class*="paginator"] [role="button"]'));pages=pageEls.map(function(p){var lbl=clean(p.getAttribute('aria-label')||p.textContent);var cur=(p.getAttribute('aria-current')==='page')||/selected|active/.test(p.className||'');return{label:lbl,current:!!cur};}).filter(function(p){return p.label;});}catch(e){}var totalCountEl=panel.querySelector('[class*="resultCount_"], [class*="searchHeader_"] [class*="title_"]');var totalCount=totalCountEl?clean(totalCountEl.textContent):'';var rows=Array.from(panel.querySelectorAll('li[id^="search-results-"]'));if(LIMIT>0)rows=rows.slice(0,LIMIT);var out=rows.map(function(li){var id=li.id||'';var msgId=id.replace(/^search-results-/,'');var authorEl=li.querySelector('[class*="username_"], [class*="userName_"]');var authorIdEl=li.querySelector('[data-author-id]');var authorId=authorIdEl?(authorIdEl.getAttribute('data-author-id')||''):'';var contentEl=li.querySelector('[id^="message-content-"], [class*="messageContent_"]');var timeEl=li.querySelector('time[datetime]');var images=[];Array.from(li.querySelectorAll('img[src]')).forEach(function(img){var src=img.getAttribute('src')||'';if(src.indexOf('cdn.discordapp.com')===-1&&src.indexOf('media.discordapp.net')===-1)return;if(src.indexOf('/emojis/')!==-1||src.indexOf('/avatars/')!==-1)return;images.push(src.split('?')[0]);});Array.from(li.querySelectorAll('a[href*="cdn.discordapp.com/attachments"], a[href*="media.discordapp.net"]')).forEach(function(a){var h=a.getAttribute('href')||'';if(h)images.push(h.split('?')[0]);});var seen={};images=images.filter(function(u){if(seen[u])return false;seen[u]=true;return true;});var anchor=li.querySelector('a[href*="/channels/"]');var channelHref=anchor?(anchor.getAttribute('href')||''):'';var channelMatch=channelHref.match(/\\/channels\\/(\\d+)\\/(\\d+)\\/(\\d+)/);var guildId=channelMatch?channelMatch[1]:'';var channelId=channelMatch?channelMatch[2]:'';return{id:id,messageId:msgId,author:clean(authorEl?authorEl.textContent:''),authorId:authorId,time:timeEl?timeEl.getAttribute('datetime'):'',text:clean(contentEl?contentEl.textContent:'').slice(0,600),images:images.slice(0,5),guildId:guildId,channelId:channelId,channelHref:channelHref};});var times=out.map(function(r){return r.time;}).filter(Boolean);var ft=times[0]||'',lt=times[times.length-1]||'';var order=(ft&&lt)?(ft<lt?'ascending':(ft>lt?'descending':'flat')):'unknown';var sortLabel=order==='ascending'?'Oldest':order==='descending'?'Newest':(sortMode||'unknown');return JSON.stringify({sortMode:sortLabel,order:order,firstTime:ft,lastTime:lt,pages:pages,totalCount:totalCount,count:out.length,results:out});})(${lim})`;
}

function buildJumpRowCoordsExpr(messageId) {
  const idJson = JSON.stringify(String(messageId || '').replace(/^search-results-/, ''));
  return `(function(){var msgId=${idJson};if(!msgId)return JSON.stringify({error:'no_id'});var row=document.getElementById('search-results-'+msgId);if(!row){try{row=document.querySelector('li[id$="-'+msgId.replace(/[^0-9]/g,'')+'"]');}catch(e){}}if(!row)row=document.querySelector('li[id="search-results-'+msgId+'"]');if(!row)return JSON.stringify({error:'row_not_found',messageId:msgId,hint:'No search-results-<id> li in DOM. Open the search panel and call cdp_get_search_results first.'});try{row.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});}catch(e){}var r=row.getBoundingClientRect();if(r.width===0&&r.height===0)return JSON.stringify({error:'row_zero_size',messageId:msgId});var cx=Math.round(r.left+Math.min(160,r.width*0.5));var cy=Math.round(r.top+r.height/2);return JSON.stringify({ok:true,messageId:msgId,rowId:row.id,x:cx,y:cy,rowWidth:Math.round(r.width),rowHeight:Math.round(r.height)});})()`;
}

function buildJumpButtonCoordsExpr(messageId) {
  const idJson = JSON.stringify(String(messageId || '').replace(/^search-results-/, ''));
  return `(function(){var msgId=${idJson};var row=document.getElementById('search-results-'+msgId);if(!row)return JSON.stringify({error:'row_not_found',messageId:msgId});var btn=null;var labelMatch=row.querySelector('button[aria-label^="Jump to message" i], button[aria-label*="Jump" i]');if(labelMatch)btn=labelMatch;if(!btn){var classMatch=row.querySelector('[class*="jumpButton" i], [class*="jump_" i]');if(classMatch&&classMatch.tagName)btn=classMatch;}if(!btn){var btns=Array.from(row.querySelectorAll('button'));for(var i=0;i<btns.length;i++){var tx=(btns[i].textContent||'').trim().toLowerCase();if(tx==='jump'||tx.indexOf('jump')!==-1){btn=btns[i];break;}}}if(!btn){var anchors=Array.from(row.querySelectorAll('a[href*="/channels/"]'));if(anchors.length)btn=anchors[anchors.length-1];}/* Fallback chain when hover doesn't reveal Jump button: (1) click the row's outer role="button" wrapper, (2) fall back to the <li> itself if nothing else. Modern Discord search panels often have the entire row handle navigation via React onClick delegation. */if(!btn){var rowBtn=row.querySelector('[role="button"]');if(rowBtn)btn=rowBtn;}if(!btn)btn=row;var r=btn.getBoundingClientRect();if(r.width===0&&r.height===0)return JSON.stringify({error:'jump_zero_size',messageId:msgId,tag:btn.tagName,aria:btn.getAttribute('aria-label')||'',hint:'Jump control is in DOM but hidden — Discord hover state likely did not trigger. Retry.'});return JSON.stringify({ok:true,messageId:msgId,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),tag:btn.tagName,aria:(btn.getAttribute('aria-label')||'').slice(0,80),text:(btn.textContent||'').trim().slice(0,40),fallbackUsed:btn===row?'li':(btn.getAttribute('role')==='button'?'role-button':'native')});})()`;
}

function buildCdpJumpSearchResultScript(port, messageId) {
  const rowExpr = buildJumpRowCoordsExpr(messageId);
  const btnExpr = buildJumpButtonCoordsExpr(messageId);
  const rowB64 = Buffer.from(rowExpr, 'utf8').toString('base64');
  const btnB64 = Buffer.from(btnExpr, 'utf8').toString('base64');
  return `
${powershellSendRecvHelpers()}
try {
    $raw = (Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json" -TimeoutSec 5 -UseBasicParsing).Content
    $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json)))
    if ($pages.Count -eq 0) { Write-Output '{"error":"no_targets"}'; exit }
    $target = $null
    foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }
    if (-not $target) { $target = $pages[0] }
    if (-not $target.webSocketDebuggerUrl) { Write-Output '{"error":"no_ws"}'; exit }
    $ws = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new(25000)
    [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
    $rowJs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${rowB64}'))
    $btnJs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${btnB64}'))
    $nextId = 1
    Send-Cmd $ws $cts (@{ id=$nextId; method='Runtime.evaluate'; params=@{ expression=$rowJs; returnByValue=$true } } | ConvertTo-Json -Compress -Depth 5)
    $r1 = Recv-Id $ws $cts $nextId; $nextId++
    if (-not $r1 -or -not $r1.result -or -not $r1.result.result -or -not $r1.result.result.value) {
        Write-Output '{"error":"row_eval_failed"}'; try { $ws.Dispose() } catch {}; exit
    }
    $rowCoords = $r1.result.result.value | ConvertFrom-Json
    if ($rowCoords.error) { Write-Output ($rowCoords | ConvertTo-Json -Compress); try { $ws.Dispose() } catch {}; exit }
    $rx = [double]$rowCoords.x
    $ry = [double]$rowCoords.y
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mouseMoved'; x=$rx; y=$ry; button='none' } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 350
    Send-Cmd $ws $cts (@{ id=$nextId; method='Runtime.evaluate'; params=@{ expression=$btnJs; returnByValue=$true } } | ConvertTo-Json -Compress -Depth 5)
    $r2 = Recv-Id $ws $cts $nextId; $nextId++
    if (-not $r2 -or -not $r2.result -or -not $r2.result.result -or -not $r2.result.result.value) {
        Write-Output '{"error":"btn_eval_failed"}'; try { $ws.Dispose() } catch {}; exit
    }
    $btnCoords = $r2.result.result.value | ConvertFrom-Json
    if ($btnCoords.error) { Write-Output ($btnCoords | ConvertTo-Json -Compress); try { $ws.Dispose() } catch {}; exit }
    $bx = [double]$btnCoords.x
    $by = [double]$btnCoords.y
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mouseMoved'; x=$bx; y=$by; button='none' } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 30
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mousePressed'; x=$bx; y=$by; button='left'; clickCount=1 } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 50
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mouseReleased'; x=$bx; y=$by; button='left'; clickCount=1 } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 600
    try { [void]$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [Threading.CancellationToken]::None).GetAwaiter().GetResult() } catch {}
    try { $ws.Dispose() } catch {}
    $tagStr = [string]$btnCoords.tag
    $ariaStr = ([string]$btnCoords.aria) -replace '"', "'"
    $textStr = ([string]$btnCoords.text) -replace '"', "'"
    Write-Output ('{"ok":true,"messageId":"' + $btnCoords.messageId + '","x":' + $bx + ',"y":' + $by + ',"tag":"' + $tagStr + '","aria":"' + $ariaStr + '","text":"' + $textStr + '"}')
} catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`;
}

async function cdpJumpSearchResultReal(port, messageId) {
  if (process.env.WINDOWS_AUTOBOT_FORCE_PS === '1') {
    return cdpJumpSearchResultRealPS(port, messageId);
  }
  debugLog(`[cdpJumpSearchResult native] port=${port} messageId=${String(messageId).slice(0, 32)}`);
  try {
    const rowExpr = buildJumpRowCoordsExpr(messageId);
    const btnExpr = buildJumpButtonCoordsExpr(messageId);

    // Step 1: eval row coords
    const [r1] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: rowExpr, returnByValue: true } },
    ]);
    if (!r1 || !r1.result || r1.result.value === undefined) return { error: 'row_eval_failed' };
    let rowCoords;
    try { rowCoords = JSON.parse(r1.result.value); } catch { return { error: 'row_parse_failed' }; }
    if (rowCoords.error) return rowCoords;
    const rx = Number(rowCoords.x), ry = Number(rowCoords.y);

    // Step 2 + 3 bundled in ONE WS session: dispatch hover via several
    // mouseMoved events (Discord's React needs a sustained pointer to commit
    // :hover state), wait briefly, then re-evaluate Jump button position.
    // Bundling avoids reconnect-flicker between hover and eval.
    const hoverPath = [
      // Start far from row, move toward it, settle on center. Real-mouse-like.
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: rx + 50, y: ry + 50, button: 'none' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: rx + 20, y: ry + 20, button: 'none' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: rx, y: ry, button: 'none' } },
    ];
    await cdpNativeWsSession(port, hoverPath);
    await new Promise(r => setTimeout(r, 500));

    // Re-anchor pointer on row (some apps clear hover after idle).
    await cdpNativeWsSession(port, [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: rx, y: ry, button: 'none' } },
    ]);
    await new Promise(r => setTimeout(r, 250));

    // Step 4: eval Jump button coords (now rendered due to hover)
    const [r2] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: btnExpr, returnByValue: true } },
    ]);
    if (!r2 || !r2.result || r2.result.value === undefined) return { error: 'btn_eval_failed' };
    let btnCoords;
    try { btnCoords = JSON.parse(r2.result.value); } catch { return { error: 'btn_parse_failed' }; }
    if (btnCoords.error) return btnCoords;
    const bx = Number(btnCoords.x), by = Number(btnCoords.y);

    // Step 5: click Jump
    await cdpNativeWsSession(port, [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: bx, y: by, button: 'none' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 } },
    ]);
    await new Promise(r => setTimeout(r, 600));

    // Step 6 (verification + soft-navigate fallback): some Discord builds don't
    // navigate when the search-result wrapper is clicked without the hover-
    // revealed Jump button. NEVER use location.assign / location.href here —
    // Discord is an SPA, so any hard navigation triggers a full client reload
    // (looks like Discord "restarted" to the user, wipes voice state, scroll
    // position, and unsaved DM drafts). Instead: (1) re-click the row's
    // <a href="/channels/..."> anchor at CDP mouse layer so Discord's React
    // router intercepts via onClick + preventDefault, or (2) use
    // history.pushState + popstate dispatch which Discord's history listener
    // picks up the same way the in-app router does.
    const verifyExpr = `(function(){var msgId=${JSON.stringify(String(messageId).replace(/^search-results-/, ''))};var row=document.getElementById('search-results-'+msgId);if(!row)return JSON.stringify({error:'row_gone'});var anchor=row.querySelector('a[href*="/channels/"]');var href=anchor?anchor.getAttribute('href'):null;var ax=null,ay=null;if(anchor){try{anchor.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});}catch(e){}var ar=anchor.getBoundingClientRect();if(ar.width>0&&ar.height>0){ax=Math.round(ar.left+ar.width/2);ay=Math.round(ar.top+ar.height/2);}}if(!href){var article=row.querySelector('[role="article"][id^="search-result-"]');var realMsgId=null;if(article){var aid=article.id||'';realMsgId=aid.replace(/^search-result-/,'');}if(!realMsgId){var dli=row.querySelector('[data-list-item-id]');if(dli){var m=(dli.getAttribute('data-list-item-id')||'').match(/(\\d+)$/);if(m)realMsgId=m[1];}}var guildId=location.pathname.split('/')[2];var channelId=location.pathname.split('/')[3];if(realMsgId&&guildId&&channelId)href='/channels/'+guildId+'/'+channelId+'/'+realMsgId;}return JSON.stringify({currentUrl:location.href,jumpHref:href,anchorX:ax,anchorY:ay});})()`;
    const [verifyRes] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: verifyExpr, returnByValue: true } },
    ]);
    let verify = {};
    try { verify = JSON.parse(verifyRes?.result?.value || '{}'); } catch {}
    if (verify.jumpHref && !String(verify.currentUrl || '').includes(verify.jumpHref)) {
      // (1) Prefer a real CDP mouse click on the anchor — Discord's onClick
      //     handler calls preventDefault() and routes through the in-app
      //     history without a reload.
      if (Number.isFinite(verify.anchorX) && Number.isFinite(verify.anchorY)) {
        debugLog(`[cdpJumpSearchResult native] click did not navigate — re-clicking anchor at (${verify.anchorX},${verify.anchorY}) via CDP`);
        const ax = Number(verify.anchorX);
        const ay = Number(verify.anchorY);
        await cdpNativeWsSession(port, [
          { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: ax, y: ay, button: 'none' } },
          { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: ax, y: ay, button: 'left', clickCount: 1 } },
          { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: ax, y: ay, button: 'left', clickCount: 1 } },
        ]);
        await new Promise(r => setTimeout(r, 600));
      }
      // (2) Re-check; if still not routed, do an SPA-safe history.pushState +
      //     popstate dispatch. This updates the address without unloading
      //     the document.
      const [recheckRes] = await cdpNativeWsSession(port, [
        { method: 'Runtime.evaluate', params: { expression: `JSON.stringify({currentUrl:location.href})`, returnByValue: true } },
      ]);
      let recheck = {};
      try { recheck = JSON.parse(recheckRes?.result?.value || '{}'); } catch {}
      if (!String(recheck.currentUrl || '').includes(verify.jumpHref)) {
        debugLog(`[cdpJumpSearchResult native] anchor click did not route — using history.pushState soft-navigate to '${verify.jumpHref}'`);
        const pushExpr = `(function(){try{var href=${JSON.stringify(verify.jumpHref)};history.pushState(null,'',href);window.dispatchEvent(new PopStateEvent('popstate',{state:null}));return JSON.stringify({ok:true,currentUrl:location.href});}catch(e){return JSON.stringify({error:String(e.message||e)});}})()`;
        await cdpNativeWsSession(port, [
          { method: 'Runtime.evaluate', params: { expression: pushExpr, returnByValue: true } },
        ]);
        await new Promise(r => setTimeout(r, 800));
      }
    }

    return { ok: true, messageId: btnCoords.messageId, x: bx, y: by, tag: btnCoords.tag, aria: btnCoords.aria, text: btnCoords.text, jumpHref: verify.jumpHref };
  } catch (err) {
    debugLog(`[cdpJumpSearchResult native err] ${err.message} — falling back to PowerShell`);
    return cdpJumpSearchResultRealPS(port, messageId);
  }
}

function cdpJumpSearchResultRealPS(port, messageId) {
  return new Promise((resolve, reject) => {
    const script = buildCdpJumpSearchResultScript(port, messageId);
    debugLog(`[cdpJumpSearchResult ps] port=${port} messageId=${String(messageId).slice(0, 32)}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) { debugLog(`[cdpJumpSearchResult ps err] ${err.message}`); return reject(err); }
      const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      try { resolve(JSON.parse(line || '{"error":"no_output"}')); }
      catch { resolve({ error: 'parse_failed', raw: stdout.slice(0, 200) }); }
    });
  });
}

// Discord search-results SORT control ─────────────────────────────────────────
//
// The recipe used to tell the model to flip sort by clicking a text toggle
// "Old" (cdp_find("Old")). That UI no longer exists. Current Discord renders
// the sort control as a single <button aria-label="Sort"> that opens a portal
// menu (id="search-result-sort-menu") of three <div role="menuitemradio">
// options:
//   #search-result-sort-menu-sort-by-option-newest        (default, checked)
//   #search-result-sort-menu-sort-by-option-oldest
//   #search-result-sort-menu-sort-by-option-most_relevant
// Because there is no "Old" text node, cdp_find("Old") returned nothing and
// the model silently stayed on the default Newest-first sort — so results[0]
// was the NEWEST match, not the oldest. For a "first / earliest image"
// request that means jumping to the wrong (most-recent) image.
//
// cdpSetSearchSortReal drives the dropdown atomically at the CDP mouse layer
// (real isTrusted clicks so React commits the selection) and verifies the
// new ordering from the result-row timestamps, which is authoritative even
// after the menu closes and its radio ids leave the DOM.
const SEARCH_SORT_OPTION_IDS = {
  oldest: 'search-result-sort-menu-sort-by-option-oldest',
  newest: 'search-result-sort-menu-sort-by-option-newest',
  relevant: 'search-result-sort-menu-sort-by-option-most_relevant',
};

function normalizeSortOrder(order) {
  const k = String(order || '').toLowerCase().trim();
  if (k === 'old' || k === 'oldest' || k === 'earliest' || k === 'ascending' || k === 'asc') return 'oldest';
  if (k === 'new' || k === 'newest' || k === 'latest' || k === 'descending' || k === 'desc') return 'newest';
  if (k === 'relevant' || k === 'most_relevant' || k === 'relevance' || k === 'mostrelevant') return 'relevant';
  return null;
}

function buildSortButtonCoordsExpr() {
  return `(function(){var b=document.querySelector('button[aria-label="Sort"]');if(!b){var panel=document.querySelector('section[aria-label="Search Results"]');return JSON.stringify({error:panel?'no_sort_button':'no_search_panel',hint:'Open the channel-header search and submit a query first (cdp_paste + cdp_press_key("Enter")), then cdp_get_search_results, before sorting.'});}try{b.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}var r=b.getBoundingClientRect();if(r.width===0&&r.height===0)return JSON.stringify({error:'sort_button_zero_size'});return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),expanded:b.getAttribute('aria-expanded')});})()`;
}

function buildSortMenuItemCoordsExpr(optionId) {
  const idJson = JSON.stringify(optionId);
  return `(function(){var it=document.getElementById(${idJson});if(!it)return JSON.stringify({error:'sort_menu_item_not_found',hint:'Sort menu did not open or Discord changed the option ids.'});var r=it.getBoundingClientRect();if(r.width===0&&r.height===0)return JSON.stringify({error:'sort_menu_item_zero_size'});return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),checked:it.getAttribute('aria-checked')});})()`;
}

// Authoritative post-sort check: the radio ids only exist while the menu is
// open, so derive ordering from the visible result-row timestamps instead.
function buildSortVerifyExpr() {
  return `(function(){var checked='';var ids=['newest','oldest','most_relevant'];for(var i=0;i<ids.length;i++){var it=document.getElementById('search-result-sort-menu-sort-by-option-'+ids[i]);if(it&&it.getAttribute('aria-checked')==='true'){checked=ids[i];break;}}var rows=Array.from(document.querySelectorAll('li[id^="search-results-"]'));var times=rows.map(function(li){var x=li.querySelector('time[datetime]');return x?x.getAttribute('datetime'):null;}).filter(Boolean);var f=times[0]||'',l=times[times.length-1]||'';var order=(f&&l)?(f<l?'ascending':(f>l?'descending':'flat')):'unknown';return JSON.stringify({checked:checked,order:order,firstTime:f,lastTime:l,count:rows.length});})()`;
}

async function cdpSetSearchSortReal(port, order) {
  const norm = normalizeSortOrder(order);
  if (!norm) return { error: 'bad_order', hint: "order must be 'oldest', 'newest', or 'relevant'." };
  const optionId = SEARCH_SORT_OPTION_IDS[norm];
  const targetCheckedKey = norm === 'relevant' ? 'most_relevant' : norm;
  const click = (x, y) => cdpNativeWsSession(port, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none' } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } },
  ]);
  try {
    // 1. locate the Sort button
    const [r1] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: buildSortButtonCoordsExpr(), returnByValue: true } },
    ]);
    let btn;
    try { btn = JSON.parse(r1.result.value); } catch { return { error: 'sort_button_parse_failed' }; }
    if (btn.error) return btn;

    // 2. open the dropdown menu (skip if already expanded)
    if (btn.expanded !== 'true') {
      await click(Number(btn.x), Number(btn.y));
      await new Promise(r => setTimeout(r, 450));
    }

    // 3. locate the target radio option inside the portal menu
    const [r2] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: buildSortMenuItemCoordsExpr(optionId), returnByValue: true } },
    ]);
    let item;
    try { item = JSON.parse(r2.result.value); } catch { return { error: 'sort_menu_parse_failed' }; }
    if (item.error) return item;

    // 4. select it (or just close the menu if it is already the active sort)
    if (item.checked === 'true') {
      await cdpNativeWsSession(port, [
        { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' } },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' } },
      ]);
      await new Promise(r => setTimeout(r, 300));
    } else {
      await click(Number(item.x), Number(item.y));
      await new Promise(r => setTimeout(r, 1600)); // wait for Discord to re-query + re-render
    }

    // 5. verify from row timestamps (authoritative; radio ids are gone once closed)
    const [r3] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: buildSortVerifyExpr(), returnByValue: true } },
    ]);
    let v = {};
    try { v = JSON.parse(r3.result.value); } catch {}
    const expectedOrder = norm === 'oldest' ? 'ascending' : norm === 'newest' ? 'descending' : null;
    const orderOk = expectedOrder ? v.order === expectedOrder : true;
    const checkedOk = v.checked ? v.checked === targetCheckedKey : false;
    // With 0/1 visible rows the timestamp order is 'flat'/'unknown' — fall back
    // to the radio-checked signal if it was still readable.
    const ok = orderOk || checkedOk;
    return {
      ok,
      requested: norm,
      sortMode: norm === 'oldest' ? 'Oldest' : norm === 'newest' ? 'Newest' : 'Most Relevant',
      order: v.order || 'unknown',
      firstTime: v.firstTime || '',
      lastTime: v.lastTime || '',
      count: v.count || 0,
    };
  } catch (err) {
    debugLog(`[cdpSetSearchSort err] ${err.message}`);
    return { error: 'set_sort_failed', message: err.message };
  }
}

function buildScrollMessagesExpr(direction, pages) {
  const dir = JSON.stringify(String(direction || 'up').toLowerCase());
  const p = Math.max(1, Math.min(20, parseInt(pages, 10) || 3));
  return `(function(){var DIR=${dir};var PAGES=${p};var ol=document.querySelector('ol[data-list-id="chat-messages"]')||document.querySelector('main[class*="chatContent"] ol');if(!ol)return JSON.stringify({error:'scroller_not_found',hint:'No Discord message list in DOM. Open a text channel first.'});var sc=ol.parentElement;while(sc&&sc!==document.body){var ov='';try{ov=getComputedStyle(sc).overflowY;}catch(e){}if(ov==='auto'||ov==='scroll')break;sc=sc.parentElement;}if(!sc||sc===document.body)return JSON.stringify({error:'scroll_container_not_found'});var before=sc.scrollTop;var lisBefore=ol.querySelectorAll('li[id^="chat-messages-"]');var beforeCount=lisBefore.length;var firstIdBefore=lisBefore[0]?lisBefore[0].id:'';var step=Math.max(200,Math.floor(sc.clientHeight*0.9));var delta=step*PAGES;if(DIR==='top'){sc.scrollTop=0;}else if(DIR==='bottom'){sc.scrollTop=sc.scrollHeight;}else if(DIR==='down'){sc.scrollTop=before+delta;}else{sc.scrollTop=Math.max(0,before-delta);}var after=sc.scrollTop;var lisAfter=ol.querySelectorAll('li[id^="chat-messages-"]');var first=lisAfter[0];var last=lisAfter[lisAfter.length-1];return JSON.stringify({ok:true,direction:DIR,pages:PAGES,scrollTopBefore:before,scrollTopAfter:after,scrollHeight:sc.scrollHeight,clientHeight:sc.clientHeight,atTop:after<=2,atBottom:Math.abs(sc.scrollHeight-sc.clientHeight-after)<=2,loadedMessages:lisAfter.length,loadedBefore:beforeCount,firstMessageId:first?first.id:'',lastMessageId:last?last.id:'',firstChanged:(first?first.id:'')!==firstIdBefore,note:'Discord lazy-loads older rows on upward scroll. Re-call cdp_get_messages to see newly mounted messages. Repeat cdp_scroll_messages(up) until firstChanged is false and atTop is true.'});})()`;
}

function buildScrollExpr(direction, pages, containerSel) {
  const dir = JSON.stringify(String(direction || 'up').toLowerCase());
  const p = Math.max(1, Math.min(50, parseInt(pages, 10) || 3));
  const csel = JSON.stringify(String(containerSel || ''));
  return `(function(){var DIR=${dir};var PAGES=${p};var CSEL=${csel};function ancestorScroller(el){var cur=el;while(cur&&cur!==document.body){var ov='';try{ov=getComputedStyle(cur).overflowY;}catch(e){}if((ov==='auto'||ov==='scroll')&&cur.scrollHeight>cur.clientHeight+10)return cur;cur=cur.parentElement;}return null;}function findScroller(){if(CSEL){try{var hit=document.querySelector(CSEL);if(hit){if(hit.scrollHeight>hit.clientHeight+10)return hit;var anc=ancestorScroller(hit);if(anc)return anc;}}catch(e){}}var prefer=['ol[data-list-id="chat-messages"]','main[class*="chatContent"] ol','[role="log"]','[data-testid*="conversation" i]','main [class*="conversation" i]','main [class*="thread" i]','main'];for(var i=0;i<prefer.length;i++){try{var c=document.querySelector(prefer[i]);if(c){if(c.scrollHeight>c.clientHeight+10)return c;var anc2=ancestorScroller(c);if(anc2)return anc2;}}catch(e){}}var best=null,bestArea=0;var all=document.querySelectorAll('div,main,section,ol,ul,article');for(var j=0;j<all.length&&j<8000;j++){var el2=all[j];var st;try{st=getComputedStyle(el2);}catch(e){continue;}var oy=st.overflowY;if(oy!=='auto'&&oy!=='scroll')continue;var sh=el2.scrollHeight,ch=el2.clientHeight;if(sh<=ch+10)continue;var r=el2.getBoundingClientRect();var a=Math.max(0,r.width)*Math.max(0,r.height);if(a>bestArea){bestArea=a;best=el2;}}return best;}var sc=findScroller();if(!sc)return JSON.stringify({error:'scroll_container_not_found',hint:'No scrollable element. Pass an explicit container CSS selector.'});var before=sc.scrollTop;var heightBefore=sc.scrollHeight;var step=Math.max(200,Math.floor(sc.clientHeight*0.9));var delta=step*PAGES;if(DIR==='top'){sc.scrollTop=0;}else if(DIR==='bottom'){sc.scrollTop=sc.scrollHeight;}else if(DIR==='down'){sc.scrollTop=before+delta;}else{sc.scrollTop=Math.max(0,before-delta);}var after=sc.scrollTop;var heightAfter=sc.scrollHeight;var cls='';try{cls=typeof sc.className==='string'?sc.className:(sc.getAttribute&&sc.getAttribute('class')||'');}catch(e){}return JSON.stringify({ok:true,direction:DIR,pages:PAGES,scrollTopBefore:before,scrollTopAfter:after,scrollHeightBefore:heightBefore,scrollHeightAfter:heightAfter,clientHeight:sc.clientHeight,atTop:after<=2,atBottom:Math.abs(heightAfter-sc.clientHeight-after)<=2,heightChanged:heightAfter!==heightBefore,topChanged:after!==before,containerTag:sc.tagName,containerClass:String(cls).slice(0,100),note:'Lazy-loading apps mount new rows during scroll. Repeat until atTop:true AND heightChanged:false for full history reach.'});})()`;
}

function buildMessagesExpr(limit) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  return `(function(LIMIT){function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ').trim();}function extractUserIdFromUrl(u){if(!u)return '';var m=String(u).match(/\\/avatars\\/(\\d+)\\//);return m?m[1]:'';}var currentUser='';var currentUserId='';try{var unEl=document.querySelector('[class*="panels_"] [class*="nameTag_"] [class*="username_"], [class*="panels_"] [class*="usernameContainer_"] [class*="username_"], section[aria-label*="User area" i] [class*="username_"], [class*="panels_"] [class*="username_"]');if(unEl)currentUser=clean(unEl.textContent);if(!currentUser){var btn=document.querySelector('button[aria-label^="Open user profile"], button[aria-label*="Set status"]');if(btn){var lab=btn.getAttribute('aria-label')||'';var m=lab.match(/(?:profile|status)[^A-Za-z0-9_.\\-]+([A-Za-z0-9_.\\-]+)/i);if(m)currentUser=clean(m[1]);}}var panelRoot=document.querySelector('section[aria-label*="User area" i]')||document.querySelector('[class*="panels_"]');if(panelRoot){var imgs=Array.from(panelRoot.querySelectorAll('img[src*="/avatars/"]'));for(var i=0;i<imgs.length&&!currentUserId;i++){currentUserId=extractUserIdFromUrl(imgs[i].getAttribute('src'));}if(!currentUserId){var styled=Array.from(panelRoot.querySelectorAll('[style*="/avatars/"]'));for(var j=0;j<styled.length&&!currentUserId;j++){currentUserId=extractUserIdFromUrl(styled[j].getAttribute('style'));}}if(!currentUserId){var bgs=Array.from(panelRoot.querySelectorAll('[class*="avatar" i]'));for(var k=0;k<bgs.length&&!currentUserId;k++){try{var bg=getComputedStyle(bgs[k]).backgroundImage||'';currentUserId=extractUserIdFromUrl(bg);}catch(e){}}}}if(currentUserId&&!currentUser){var authorEl=document.querySelector('[data-author-id="'+currentUserId+'"]');if(authorEl)currentUser=clean(authorEl.textContent);}}catch(e){}var msgs=Array.from(document.querySelectorAll('li[id^="chat-messages-"]'));if(msgs.length===0){msgs=Array.from(document.querySelectorAll('[id^="chat-messages-"]'));}if(LIMIT>0)msgs=msgs.slice(-LIMIT);var out=msgs.map(function(li){var id=li.id||'';var authorEl=li.querySelector('[class*="username"]');var authorIdEl=li.querySelector('[data-author-id]');var authorId=authorIdEl?(authorIdEl.getAttribute('data-author-id')||''):'';var contentEl=li.querySelector('[id^="message-content-"]');var timeEl=li.querySelector('time[datetime]');var images=[];Array.from(li.querySelectorAll('img[src]')).forEach(function(img){var src=img.getAttribute('src')||'';if(src.indexOf('cdn.discordapp.com')===-1&&src.indexOf('media.discordapp.net')===-1)return;if(src.indexOf('/emojis/')!==-1)return;if(src.indexOf('/avatars/')!==-1)return;images.push(src.split('?')[0]);});Array.from(li.querySelectorAll('a[href*="cdn.discordapp.com/attachments"], a[href*="media.discordapp.net"]')).forEach(function(a){var h=a.getAttribute('href')||'';if(h)images.push(h.split('?')[0]);});var seen={};images=images.filter(function(u){if(seen[u])return false;seen[u]=true;return true;});var reactions=[];Array.from(li.querySelectorAll('[class*="reaction_"], [class*="reactionMe_"], [class*="reactionDefault_"]')).forEach(function(r){if(r.getAttribute('role')!=='button'&&!r.querySelector('img'))return;var emojiEl=r.querySelector('img[alt],img[aria-label]');var emoji=emojiEl?(emojiEl.getAttribute('alt')||emojiEl.getAttribute('aria-label')||''):'';var countEl=r.querySelector('[class*="reactionCount"]');var ctxt=clean(countEl?countEl.textContent:r.textContent);var n=parseInt(ctxt.replace(/[^0-9]/g,''),10);var lbl=clean(r.getAttribute('aria-label')||'');reactions.push({emoji:clean(emoji),count:isNaN(n)?0:n,label:lbl});});var rTotal=reactions.reduce(function(s,r){return s+(r.count||0);},0);return{id:id,author:clean(authorEl?authorEl.textContent:''),authorId:authorId,time:timeEl?timeEl.getAttribute('datetime'):'',text:clean(contentEl?contentEl.textContent:'').slice(0,800),images:images.slice(0,10),reactions:reactions,reactionTotal:rTotal};});return JSON.stringify({currentUser:currentUser,currentUserId:currentUserId,messages:out});})(${lim})`;
}

const CDP_JS_EXPR = `(function(){function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ');}function sel(el){if(el.id){var s='#'+CSS.escape(el.id);try{if(document.querySelectorAll(s).length===1)return s;}catch(e){}}var t=el.getAttribute('data-testid');if(t){var ts='[data-testid="'+t.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ts).length===1)return ts;}catch(e){}}var dli=el.getAttribute('data-list-item-id');if(dli){var ds='[data-list-item-id="'+dli.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ds).length===1)return ds;}catch(e){}}var href=el.tagName==='A'?el.getAttribute('href'):null;if(href){var hs='a[href="'+href.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(hs).length===1)return hs;}catch(e){}}var al=el.getAttribute('aria-label');if(al){var ae=al.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');var ai=el.tagName.toLowerCase()+'[aria-label="'+ae+'"]';try{if(document.querySelectorAll(ai).length===1)return ai;}catch(e){}}var cur=el,parts=[];for(var i=0;cur&&cur.nodeType===1&&cur!==document.body&&i<30;i++){var p=cur.tagName.toLowerCase();if(cur.parentNode){var idx=Array.prototype.indexOf.call(cur.parentNode.children,cur)+1;if(idx>0)p+=':nth-child('+idx+')';}parts.unshift(p);try{if(document.querySelectorAll(parts.join(' > ')).length===1)return parts.join(' > ');}catch(e){}cur=cur.parentNode;}return parts.join(' > ');}var nodes=Array.from(document.querySelectorAll('button,input,select,textarea,a,[role],[aria-label],[contenteditable]'));nodes=nodes.filter(function(el){var r=el.getAttribute('role');return r!=='log'&&r!=='listitem'&&r!=='article';});return JSON.stringify(nodes.slice(0,500).map(function(el){var cn=typeof el.className==='string'?el.className:'';return{Tag:el.tagName,Text:clean(el.textContent).trim().slice(0,100),Id:clean(el.id),Class:clean(cn).split(' ').filter(Boolean).slice(0,3).join(' '),Role:clean(el.getAttribute('role')),AriaLabel:clean(el.getAttribute('aria-label')),Selector:sel(el)}}));})()`;

const DISCORD_REGIONS = {
  servers:  'nav[aria-label*="Servers" i], [class*="guilds_"]',
  channels: 'nav[aria-label*="Channels" i], [class*="sidebar_"] nav',
  composer: 'form[class*="form_"], [role="textbox"][aria-label^="Message "]',
  messages: 'ol[data-list-id="chat-messages"], main[class*="chatContent"] ol',
};

function resolveRegionScope(region) {
  if (!region) return null;
  const key = String(region).trim();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(DISCORD_REGIONS, key.toLowerCase())) {
    return DISCORD_REGIONS[key.toLowerCase()];
  }
  return key;
}

function buildScopedTreeExpr(scopeSelector) {
  const scopeJson = JSON.stringify(String(scopeSelector || ''));
  return `(function(){function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ');}function sel(el){if(el.id){var s='#'+CSS.escape(el.id);try{if(document.querySelectorAll(s).length===1)return s;}catch(e){}}var t=el.getAttribute('data-testid');if(t){var ts='[data-testid="'+t.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ts).length===1)return ts;}catch(e){}}var dli=el.getAttribute('data-list-item-id');if(dli){var ds='[data-list-item-id="'+dli.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ds).length===1)return ds;}catch(e){}}var href=el.tagName==='A'?el.getAttribute('href'):null;if(href){var hs='a[href="'+href.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(hs).length===1)return hs;}catch(e){}}var al=el.getAttribute('aria-label');if(al){var ae=al.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');var ai=el.tagName.toLowerCase()+'[aria-label="'+ae+'"]';try{if(document.querySelectorAll(ai).length===1)return ai;}catch(e){}}var cur=el,parts=[];for(var i=0;cur&&cur.nodeType===1&&cur!==document.body&&i<30;i++){var p=cur.tagName.toLowerCase();if(cur.parentNode){var idx=Array.prototype.indexOf.call(cur.parentNode.children,cur)+1;if(idx>0)p+=':nth-child('+idx+')';}parts.unshift(p);try{if(document.querySelectorAll(parts.join(' > ')).length===1)return parts.join(' > ');}catch(e){}cur=cur.parentNode;}return parts.join(' > ');}var SCOPE=${scopeJson};var root=null;try{root=document.querySelector(SCOPE);}catch(e){root=null;}if(!root)root=document;var nodes=Array.from(root.querySelectorAll('button,input,select,textarea,a,[role],[aria-label],[contenteditable]'));nodes=nodes.filter(function(el){var r=el.getAttribute('role');return r!=='log'&&r!=='listitem'&&r!=='article';});return JSON.stringify(nodes.slice(0,500).map(function(el){var cn=typeof el.className==='string'?el.className:'';return{Tag:el.tagName,Text:clean(el.textContent).trim().slice(0,100),Id:clean(el.id),Class:clean(cn).split(' ').filter(Boolean).slice(0,3).join(' '),Role:clean(el.getAttribute('role')),AriaLabel:clean(el.getAttribute('aria-label')),Selector:sel(el)}}));})()`;
}

function buildFindExpr(needle, limit) {
  const needleJson = JSON.stringify(String(needle || ''));
  const lim = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
  return `(function(){var NEEDLE=${needleJson};var LIMIT=${lim};var needleLower=NEEDLE.toLowerCase();function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ');}function sel(el){if(el.id){var s='#'+CSS.escape(el.id);try{if(document.querySelectorAll(s).length===1)return s;}catch(e){}}var t=el.getAttribute('data-testid');if(t){var ts='[data-testid="'+t.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ts).length===1)return ts;}catch(e){}}var dli=el.getAttribute('data-list-item-id');if(dli){var ds='[data-list-item-id="'+dli.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ds).length===1)return ds;}catch(e){}}var href=el.tagName==='A'?el.getAttribute('href'):null;if(href){var hs='a[href="'+href.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(hs).length===1)return hs;}catch(e){}}var al=el.getAttribute('aria-label');if(al){var ae=al.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');var ai=el.tagName.toLowerCase()+'[aria-label="'+ae+'"]';try{if(document.querySelectorAll(ai).length===1)return ai;}catch(e){}}var cur=el,parts=[];for(var i=0;cur&&cur.nodeType===1&&cur!==document.body&&i<30;i++){var p=cur.tagName.toLowerCase();if(cur.parentNode){var idx=Array.prototype.indexOf.call(cur.parentNode.children,cur)+1;if(idx>0)p+=':nth-child('+idx+')';}parts.unshift(p);try{if(document.querySelectorAll(parts.join(' > ')).length===1)return parts.join(' > ');}catch(e){}cur=cur.parentNode;}return parts.join(' > ');}var nodes=Array.from(document.querySelectorAll('button,input,select,textarea,a,[role],[aria-label],[contenteditable]'));nodes=nodes.filter(function(el){var r=el.getAttribute('role');return r!=='log'&&r!=='listitem'&&r!=='article';});var matched=[];for(var i=0;i<nodes.length&&matched.length<LIMIT;i++){var el=nodes[i];var text=clean(el.textContent).trim().slice(0,200);var aria=clean(el.getAttribute('aria-label'));var id=clean(el.id);var role=clean(el.getAttribute('role'));var hay=(text+' '+aria+' '+id+' '+role).toLowerCase();if(hay.indexOf(needleLower)===-1)continue;var cn=typeof el.className==='string'?el.className:'';matched.push({Tag:el.tagName,Text:text.slice(0,100),Id:id,Class:clean(cn).split(' ').filter(Boolean).slice(0,3).join(' '),Role:role,AriaLabel:aria,Selector:sel(el)});}return JSON.stringify(matched);})()`;
}

function buildCdpExprScript(port, jsExpr) {
  const jsBase64 = Buffer.from(jsExpr, 'utf8').toString('base64');
  return `
try {
    $raw = (Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json" -TimeoutSec 5 -UseBasicParsing).Content
    $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json)))
    if ($pages.Count -eq 0) { Write-Output '[]'; exit }
    $target = $null
    foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }
    if (-not $target) { $target = $pages[0] }
    if (-not $target.webSocketDebuggerUrl) { Write-Output '[]'; exit }
    $js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${jsBase64}'))
    $ws = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new(15000)
    [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
    $cmd = (@{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $js; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 5)
    $bytes = [Text.Encoding]::UTF8.GetBytes($cmd)
    $seg = [ArraySegment[byte]]::new($bytes)
    [void]$ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
    $buf = New-Object byte[] 1048576
    $all = ''
    do {
        $rseg = [ArraySegment[byte]]::new($buf)
        $r = $ws.ReceiveAsync($rseg, $cts.Token).GetAwaiter().GetResult()
        $all += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)
    } while (-not $r.EndOfMessage)
    try { [void]$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [Threading.CancellationToken]::None).GetAwaiter().GetResult() } catch {}
    $ws.Dispose()
    $parsed = $all | ConvertFrom-Json
    if ($parsed.result -and $parsed.result.result -and $parsed.result.result.value) {
        Write-Output $parsed.result.result.value
    } else { Write-Output '[]' }
} catch { Write-Output '[]' }
`;
}

const DEBUG_LOG = path.join(__dirname, '..', 'cdp-debug.log');
function debugLog(msg) {
  fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`, 'utf8');
}

function buildCdpClickScript(port, selector) {
  const coordsJs = `(function(){var sel=${JSON.stringify(selector)};var el=document.querySelector(sel);if(!el)return JSON.stringify({error:'element_not_found'});var svgLike={svg:1,path:1,g:1,circle:1,rect:1,polygon:1,line:1,use:1,polyline:1};var target=el;var hops=0;while(target&&target!==document.body&&hops<8){var tg=(target.tagName||'').toLowerCase();var r=target.getAttribute&&target.getAttribute('role');if(tg==='button'||tg==='a'||tg==='input'||tg==='label')break;if(r&&/^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|option|checkbox|radio|switch)$/.test(r))break;if(target.onclick)break;if(svgLike[tg]||(target.getAttribute&&target.getAttribute('aria-hidden')==='true')){target=target.parentElement;hops++;continue;}break;}if(!target)target=el;try{target.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}var rect=target.getBoundingClientRect();if(rect.width===0&&rect.height===0)return JSON.stringify({error:'zero_size'});return JSON.stringify({x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),tag:target.tagName,walked:target!==el});})()`;
  const jsBase64 = Buffer.from(coordsJs, 'utf8').toString('base64');
  return `
function Send-Cmd { param($ws, $cts, $cmd)
    $bytes = [Text.Encoding]::UTF8.GetBytes($cmd)
    $seg = [ArraySegment[byte]]::new($bytes)
    [void]$ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
}
function Recv-Id { param($ws, $cts, $id)
    $buf = New-Object byte[] 1048576
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $all = ''
        do {
            $rseg = [ArraySegment[byte]]::new($buf)
            $r = $ws.ReceiveAsync($rseg, $cts.Token).GetAwaiter().GetResult()
            $all += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)
        } while (-not $r.EndOfMessage)
        try {
            $parsed = $all | ConvertFrom-Json
            if ($parsed.id -eq $id) { return $parsed }
        } catch {}
    }
    return $null
}
try {
    $raw = (Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json" -TimeoutSec 5 -UseBasicParsing).Content
    $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json)))
    if ($pages.Count -eq 0) { Write-Output '{"error":"no_targets"}'; exit }
    $target = $null
    foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }
    if (-not $target) { $target = $pages[0] }
    if (-not $target.webSocketDebuggerUrl) { Write-Output '{"error":"no_ws"}'; exit }
    $ws = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new(20000)
    [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
    $js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${jsBase64}'))
    $cmd1 = (@{ id=1; method='Runtime.evaluate'; params=@{ expression=$js; returnByValue=$true } } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmd1
    $resp1 = Recv-Id $ws $cts 1
    if (-not $resp1 -or -not $resp1.result -or -not $resp1.result.result -or -not $resp1.result.result.value) {
        Write-Output '{"error":"eval_no_value"}'
        try { $ws.Dispose() } catch {}; exit
    }
    $coords = $resp1.result.result.value | ConvertFrom-Json
    if ($coords.error) {
        Write-Output ($coords | ConvertTo-Json -Compress)
        try { $ws.Dispose() } catch {}; exit
    }
    $x = [double]$coords.x
    $y = [double]$coords.y
    $cmd2 = (@{ id=2; method='Input.dispatchMouseEvent'; params=@{ type='mouseMoved'; x=$x; y=$y; button='none' } } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmd2
    [void](Recv-Id $ws $cts 2)
    Start-Sleep -Milliseconds 20
    $cmd3 = (@{ id=3; method='Input.dispatchMouseEvent'; params=@{ type='mousePressed'; x=$x; y=$y; button='left'; clickCount=1 } } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmd3
    [void](Recv-Id $ws $cts 3)
    Start-Sleep -Milliseconds 40
    $cmd4 = (@{ id=4; method='Input.dispatchMouseEvent'; params=@{ type='mouseReleased'; x=$x; y=$y; button='left'; clickCount=1 } } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmd4
    [void](Recv-Id $ws $cts 4)
    Start-Sleep -Milliseconds 400
    try { [void]$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [Threading.CancellationToken]::None).GetAwaiter().GetResult() } catch {}
    try { $ws.Dispose() } catch {}
    Write-Output ('{"ok":true,"x":' + $x + ',"y":' + $y + ',"tag":"' + $coords.tag + '","walked":' + $coords.walked.ToString().ToLower() + '}')
} catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`;
}

async function cdpClickReal(port, selector) {
  if (process.env.WINDOWS_AUTOBOT_FORCE_PS === '1') {
    return cdpClickRealPS(port, selector);
  }
  debugLog(`[cdpClick native] port=${port} sel=${selector.slice(0, 100)}`);
  try {
    // Step 1: Runtime.evaluate to get coords of the clickable element.
    const coordsJs = `(function(){var sel=${JSON.stringify(selector)};var el=document.querySelector(sel);if(!el)return JSON.stringify({error:'element_not_found'});var svgLike={svg:1,path:1,g:1,circle:1,rect:1,polygon:1,line:1,use:1,polyline:1};var target=el;var hops=0;while(target&&target!==document.body&&hops<8){var tg=(target.tagName||'').toLowerCase();var r=target.getAttribute&&target.getAttribute('role');if(tg==='button'||tg==='a'||tg==='input'||tg==='label')break;if(r&&/^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|option|checkbox|radio|switch)$/.test(r))break;if(target.onclick)break;if(svgLike[tg]||(target.getAttribute&&target.getAttribute('aria-hidden')==='true')){target=target.parentElement;hops++;continue;}break;}if(!target)target=el;try{target.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}var rect=target.getBoundingClientRect();if(rect.width===0&&rect.height===0)return JSON.stringify({error:'zero_size'});return JSON.stringify({x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),tag:target.tagName,walked:target!==el});})()`;
    const [evalRes] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: coordsJs, returnByValue: true } },
    ]);
    if (!evalRes || !evalRes.result || evalRes.result.value === undefined) {
      return { error: 'eval_no_value' };
    }
    let coords;
    try { coords = JSON.parse(evalRes.result.value); } catch { return { error: 'parse_failed' }; }
    if (coords.error) return coords;
    const x = Number(coords.x), y = Number(coords.y);
    // Step 2: dispatch mouse events in sequence. Bundled in one WS session
    // so the native fast-path is one round-trip per click.
    await cdpNativeWsSession(port, [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } },
    ]);
    // SPA settle delay (matches PS path — Discord's React router re-renders async).
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, x, y, tag: coords.tag, walked: !!coords.walked };
  } catch (err) {
    debugLog(`[cdpClick native err] ${err.message} — falling back to PowerShell`);
    return cdpClickRealPS(port, selector);
  }
}

function cdpClickRealPS(port, selector) {
  return new Promise((resolve, reject) => {
    const script = buildCdpClickScript(port, selector);
    debugLog(`[cdpClickReal ps] port=${port} sel=${selector.slice(0, 100)}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { debugLog(`[cdpClickReal ps err] ${err.message}`); return reject(err); }
      const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      try { resolve(JSON.parse(line || '{"error":"no_output"}')); }
      catch { resolve({ error: 'parse_failed', raw: stdout.slice(0, 200) }); }
    });
  });
}

// CDP keyboard primitives ──────────────────────────────────────────────────
//
// Key map for `cdp_press_key`. Covers the keys the model actually needs to
// submit forms, dismiss modals, navigate autocomplete and edit text.
const CDP_KEY_MAP = {
  enter:      { vk: 13, code: 'Enter',      key: 'Enter',      text: '\r' },
  return:     { vk: 13, code: 'Enter',      key: 'Enter',      text: '\r' },
  escape:     { vk: 27, code: 'Escape',     key: 'Escape' },
  esc:        { vk: 27, code: 'Escape',     key: 'Escape' },
  tab:        { vk: 9,  code: 'Tab',        key: 'Tab',        text: '\t' },
  backspace:  { vk: 8,  code: 'Backspace',  key: 'Backspace' },
  delete:     { vk: 46, code: 'Delete',     key: 'Delete' },
  arrowup:    { vk: 38, code: 'ArrowUp',    key: 'ArrowUp' },
  arrowdown:  { vk: 40, code: 'ArrowDown',  key: 'ArrowDown' },
  arrowleft:  { vk: 37, code: 'ArrowLeft',  key: 'ArrowLeft' },
  arrowright: { vk: 39, code: 'ArrowRight', key: 'ArrowRight' },
  up:         { vk: 38, code: 'ArrowUp',    key: 'ArrowUp' },
  down:       { vk: 40, code: 'ArrowDown',  key: 'ArrowDown' },
  left:       { vk: 37, code: 'ArrowLeft',  key: 'ArrowLeft' },
  right:      { vk: 39, code: 'ArrowRight', key: 'ArrowRight' },
  home:       { vk: 36, code: 'Home',       key: 'Home' },
  end:        { vk: 35, code: 'End',        key: 'End' },
  pageup:     { vk: 33, code: 'PageUp',     key: 'PageUp' },
  pagedown:   { vk: 34, code: 'PageDown',   key: 'PageDown' },
  space:      { vk: 32, code: 'Space',      key: ' ',          text: ' ' },
};
const CDP_MODIFIER_MASK = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

function resolveCdpKey(key) {
  const k = String(key || '').toLowerCase().trim();
  if (!k) return null;
  if (CDP_KEY_MAP[k]) return CDP_KEY_MAP[k];
  if (k.length === 1) {
    const isLetter = /[a-z]/.test(k);
    const isDigit = /[0-9]/.test(k);
    return {
      vk: isLetter ? k.toUpperCase().charCodeAt(0) : k.charCodeAt(0),
      code: isLetter ? `Key${k.toUpperCase()}` : (isDigit ? `Digit${k}` : k),
      key: k,
      text: k,
    };
  }
  return null;
}

function resolveCdpModifiers(mods) {
  if (mods === undefined || mods === null) return 0;
  const list = Array.isArray(mods) ? mods : String(mods).split(/[,+ ]+/);
  let mask = 0;
  for (const m of list) {
    const v = CDP_MODIFIER_MASK[String(m).toLowerCase()];
    if (v) mask |= v;
  }
  return mask;
}

function powershellSendRecvHelpers() {
  return `
function Send-Cmd { param($ws, $cts, $cmd)
    $bytes = [Text.Encoding]::UTF8.GetBytes($cmd)
    $seg = [ArraySegment[byte]]::new($bytes)
    [void]$ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult()
}
function Recv-Id { param($ws, $cts, $id)
    $buf = New-Object byte[] 1048576
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $all = ''
        do {
            $rseg = [ArraySegment[byte]]::new($buf)
            $r = $ws.ReceiveAsync($rseg, $cts.Token).GetAwaiter().GetResult()
            $all += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)
        } while (-not $r.EndOfMessage)
        try {
            $parsed = $all | ConvertFrom-Json
            if ($parsed.id -eq $id) { return $parsed }
        } catch {}
    }
    return $null
}`;
}

function buildCdpPressKeyScript(port, keyDef, modifierMask) {
  const params = {
    vk: keyDef.vk,
    code: keyDef.code || '',
    key: keyDef.key || '',
    text: keyDef.text || '',
    mods: modifierMask,
  };
  const paramsB64 = Buffer.from(JSON.stringify(params), 'utf8').toString('base64');
  return `
${powershellSendRecvHelpers()}
try {
    $raw = (Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json" -TimeoutSec 5 -UseBasicParsing).Content
    $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json)))
    if ($pages.Count -eq 0) { Write-Output '{"error":"no_targets"}'; exit }
    $target = $null
    foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }
    if (-not $target) { $target = $pages[0] }
    if (-not $target.webSocketDebuggerUrl) { Write-Output '{"error":"no_ws"}'; exit }
    $ws = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new(20000)
    [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
    $kdJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${paramsB64}'))
    $kd = $kdJson | ConvertFrom-Json
    $vk = [int]$kd.vk
    $codeStr = [string]$kd.code
    $keyStr = [string]$kd.key
    $textStr = [string]$kd.text
    $mods = [int]$kd.mods
    $kdParams = @{ type='keyDown'; windowsVirtualKeyCode=$vk; nativeVirtualKeyCode=$vk; code=$codeStr; key=$keyStr; modifiers=$mods }
    if ($textStr -and -not ($mods -band 2) -and -not ($mods -band 4)) {
        $kdParams.text = $textStr
        $kdParams.unmodifiedText = $textStr
    }
    $cmd1 = (@{ id=1; method='Input.dispatchKeyEvent'; params=$kdParams } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmd1
    [void](Recv-Id $ws $cts 1)
    Start-Sleep -Milliseconds 30
    $kuParams = @{ type='keyUp'; windowsVirtualKeyCode=$vk; nativeVirtualKeyCode=$vk; code=$codeStr; key=$keyStr; modifiers=$mods }
    $cmd2 = (@{ id=2; method='Input.dispatchKeyEvent'; params=$kuParams } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmd2
    [void](Recv-Id $ws $cts 2)
    Start-Sleep -Milliseconds 400
    try { [void]$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [Threading.CancellationToken]::None).GetAwaiter().GetResult() } catch {}
    try { $ws.Dispose() } catch {}
    Write-Output ('{"ok":true,"key":"' + ($keyStr -replace '"', '\\"') + '","modifiers":' + $mods + '}')
} catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`;
}

async function cdpPressKeyReal(port, keyDef, modifierMask) {
  if (process.env.WINDOWS_AUTOBOT_FORCE_PS === '1') {
    return cdpPressKeyRealPS(port, keyDef, modifierMask);
  }
  debugLog(`[cdpPressKey native] port=${port} key=${keyDef.key} mods=${modifierMask}`);
  try {
    const vk = keyDef.vk;
    const code = keyDef.code;
    const key = keyDef.key;
    const text = keyDef.text;
    const kdParams = { type: text ? 'keyDown' : 'rawKeyDown', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers: modifierMask };
    if (text) kdParams.text = text;
    const kuParams = { type: 'keyUp', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers: modifierMask };
    await cdpNativeWsSession(port, [
      { method: 'Input.dispatchKeyEvent', params: kdParams },
      { method: 'Input.dispatchKeyEvent', params: kuParams },
    ]);
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, key, modifiers: modifierMask };
  } catch (err) {
    debugLog(`[cdpPressKey native err] ${err.message} — falling back to PowerShell`);
    return cdpPressKeyRealPS(port, keyDef, modifierMask);
  }
}

function cdpPressKeyRealPS(port, keyDef, modifierMask) {
  return new Promise((resolve, reject) => {
    const script = buildCdpPressKeyScript(port, keyDef, modifierMask);
    debugLog(`[cdpPressKey ps] port=${port} key=${keyDef.key} mods=${modifierMask}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 20000 }, (err, stdout) => {
      if (err) { debugLog(`[cdpPressKey ps err] ${err.message}`); return reject(err); }
      const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      try { resolve(JSON.parse(line || '{"error":"no_output"}')); }
      catch { resolve({ error: 'parse_failed', raw: stdout.slice(0, 200) }); }
    });
  });
}

// cdp_paste — focus element by selector via real CDP click, optionally
// clear existing content (Ctrl+A + Delete), then insert text via
// Input.insertText. Works on rich-text editors (DraftJS, Slate, Lexical,
// generic contenteditable) where cdp_type's JS textContent setter is
// silently swallowed by the editor's own state model.
function buildCdpPasteScript(port, selector, text, clearFirst) {
  const findCoordsJs = `(function(){var sel=${JSON.stringify(selector)};var el=document.querySelector(sel);if(!el)return JSON.stringify({error:'element_not_found'});var target=el;var hops=0;while(target&&target!==document.body&&hops<6){var tg=(target.tagName||'').toLowerCase();var ce=target.isContentEditable;if(tg==='input'||tg==='textarea'||ce)break;target=target.parentElement;hops++;}if(!target)target=el;try{target.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}try{if(target.focus)target.focus({preventScroll:true});}catch(e){}var rect=target.getBoundingClientRect();if(rect.width===0&&rect.height===0)return JSON.stringify({error:'zero_size'});return JSON.stringify({x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),tag:target.tagName,ce:!!target.isContentEditable,walked:target!==el});})()`;
  const findB64 = Buffer.from(findCoordsJs, 'utf8').toString('base64');
  const textB64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
  const doClear = !!clearFirst;
  return `
${powershellSendRecvHelpers()}
try {
    $raw = (Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json" -TimeoutSec 5 -UseBasicParsing).Content
    $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json)))
    if ($pages.Count -eq 0) { Write-Output '{"error":"no_targets"}'; exit }
    $target = $null
    foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }
    if (-not $target) { $target = $pages[0] }
    if (-not $target.webSocketDebuggerUrl) { Write-Output '{"error":"no_ws"}'; exit }
    $ws = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new(25000)
    [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult()
    $js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${findB64}'))
    $cmdEval = (@{ id=1; method='Runtime.evaluate'; params=@{ expression=$js; returnByValue=$true } } | ConvertTo-Json -Compress -Depth 5)
    Send-Cmd $ws $cts $cmdEval
    $r1 = Recv-Id $ws $cts 1
    if (-not $r1 -or -not $r1.result -or -not $r1.result.result -or -not $r1.result.result.value) {
        Write-Output '{"error":"eval_no_value"}'
        try { $ws.Dispose() } catch {}; exit
    }
    $coords = $r1.result.result.value | ConvertFrom-Json
    if ($coords.error) {
        Write-Output ($coords | ConvertTo-Json -Compress)
        try { $ws.Dispose() } catch {}; exit
    }
    $x = [double]$coords.x
    $y = [double]$coords.y
    $nextId = 2
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mouseMoved'; x=$x; y=$y; button='none' } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 20
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mousePressed'; x=$x; y=$y; button='left'; clickCount=1 } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 30
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchMouseEvent'; params=@{ type='mouseReleased'; x=$x; y=$y; button='left'; clickCount=1 } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 250

    if ($${doClear}) {
        # Ctrl+A
        Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchKeyEvent'; params=@{ type='keyDown'; windowsVirtualKeyCode=65; code='KeyA'; key='a'; modifiers=2 } } | ConvertTo-Json -Compress -Depth 5)
        [void](Recv-Id $ws $cts $nextId); $nextId++
        Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchKeyEvent'; params=@{ type='keyUp'; windowsVirtualKeyCode=65; code='KeyA'; key='a'; modifiers=2 } } | ConvertTo-Json -Compress -Depth 5)
        [void](Recv-Id $ws $cts $nextId); $nextId++
        Start-Sleep -Milliseconds 30
        # Delete
        Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchKeyEvent'; params=@{ type='keyDown'; windowsVirtualKeyCode=46; code='Delete'; key='Delete' } } | ConvertTo-Json -Compress -Depth 5)
        [void](Recv-Id $ws $cts $nextId); $nextId++
        Send-Cmd $ws $cts (@{ id=$nextId; method='Input.dispatchKeyEvent'; params=@{ type='keyUp'; windowsVirtualKeyCode=46; code='Delete'; key='Delete' } } | ConvertTo-Json -Compress -Depth 5)
        [void](Recv-Id $ws $cts $nextId); $nextId++
        Start-Sleep -Milliseconds 60
    }

    $textStr = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${textB64}'))
    Send-Cmd $ws $cts (@{ id=$nextId; method='Input.insertText'; params=@{ text=$textStr } } | ConvertTo-Json -Compress -Depth 5)
    [void](Recv-Id $ws $cts $nextId); $nextId++
    Start-Sleep -Milliseconds 250
    try { [void]$ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, '', [Threading.CancellationToken]::None).GetAwaiter().GetResult() } catch {}
    try { $ws.Dispose() } catch {}
    Write-Output ('{"ok":true,"tag":"' + $coords.tag + '","ce":' + $coords.ce.ToString().ToLower() + ',"chars":' + $textStr.Length + ',"cleared":' + ('${doClear}'.ToLower()) + '}')
} catch {
    Write-Output ('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
`;
}

async function cdpPasteReal(port, selector, text, clearFirst) {
  if (process.env.WINDOWS_AUTOBOT_FORCE_PS === '1') {
    return cdpPasteRealPS(port, selector, text, clearFirst);
  }
  debugLog(`[cdpPaste native] port=${port} sel=${selector.slice(0, 80)} chars=${(text || '').length} clear=${!!clearFirst}`);
  try {
    // Step 1: focus the target (or its nearest editable ancestor) + get coords.
    const findCoordsJs = `(function(){var sel=${JSON.stringify(selector)};var el=document.querySelector(sel);if(!el)return JSON.stringify({error:'element_not_found'});var target=el;var hops=0;while(target&&target!==document.body&&hops<6){var tg=(target.tagName||'').toLowerCase();var ce=target.isContentEditable;if(tg==='input'||tg==='textarea'||ce)break;target=target.parentElement;hops++;}if(!target)target=el;try{target.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}try{if(target.focus)target.focus({preventScroll:true});}catch(e){}var rect=target.getBoundingClientRect();if(rect.width===0&&rect.height===0)return JSON.stringify({error:'zero_size'});return JSON.stringify({x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),tag:target.tagName,ce:!!target.isContentEditable,walked:target!==el});})()`;
    const [evalRes] = await cdpNativeWsSession(port, [
      { method: 'Runtime.evaluate', params: { expression: findCoordsJs, returnByValue: true } },
    ]);
    if (!evalRes || !evalRes.result || evalRes.result.value === undefined) {
      return { error: 'eval_no_value' };
    }
    let coords;
    try { coords = JSON.parse(evalRes.result.value); } catch { return { error: 'parse_failed' }; }
    if (coords.error) return coords;
    const x = Number(coords.x), y = Number(coords.y);

    // Step 2: click to set focus, then optional Ctrl+A + Delete, then insertText.
    const cmds = [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } },
    ];
    if (clearFirst) {
      // Ctrl+A
      cmds.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 2 } });
      cmds.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 2 } });
      // Delete
      cmds.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', windowsVirtualKeyCode: 46, code: 'Delete', key: 'Delete' } });
      cmds.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', windowsVirtualKeyCode: 46, code: 'Delete', key: 'Delete' } });
    }
    cmds.push({ method: 'Input.insertText', params: { text: String(text || '') } });
    await cdpNativeWsSession(port, cmds, { timeout: 30000 });
    await new Promise(r => setTimeout(r, 250));
    return { ok: true, tag: coords.tag, ce: !!coords.ce, chars: String(text || '').length, cleared: !!clearFirst };
  } catch (err) {
    debugLog(`[cdpPaste native err] ${err.message} — falling back to PowerShell`);
    return cdpPasteRealPS(port, selector, text, clearFirst);
  }
}

function cdpPasteRealPS(port, selector, text, clearFirst) {
  return new Promise((resolve, reject) => {
    const script = buildCdpPasteScript(port, selector, text, clearFirst);
    debugLog(`[cdpPaste ps] port=${port} sel=${selector.slice(0, 80)} chars=${(text || '').length} clear=${!!clearFirst}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { debugLog(`[cdpPaste ps err] ${err.message}`); return reject(err); }
      const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      try { resolve(JSON.parse(line || '{"error":"no_output"}')); }
      catch { resolve({ error: 'parse_failed', raw: stdout.slice(0, 200) }); }
    });
  });
}

// Native CDP WebSocket transport — bypasses PowerShell shellout entirely.
//
// Why: every PowerShell `execFile` call is a `CreateProcess` against
// `powershell.exe`. On Windows + Defender/EDR, repeated rapid spawns from
// the same Node/Electron parent hit a persistent `spawn EPERM` after ~5
// invocations (verified empirically). The retry wrapper buys us SOME
// resilience for genuinely transient failures, but cannot recover when
// the OS persistently denies spawn under load.
//
// The CDP-transport problem doesn't need a process at all — it's just a
// WebSocket conversation. Node 22 (bundled with Electron 35) ships a
// built-in global `WebSocket`. Use it directly: zero spawns, ~5× faster
// than the PowerShell roundtrip (no shell startup, no Base64 hop), and
// immune to the spawn-EPERM failure mode.
//
// The PowerShell path is kept as a fallback (env `WINDOWS_AUTOBOT_FORCE_PS=1`)
// because some users may be running on older Electron with no global
// WebSocket, and UIA / detect / Codex paths still legitimately need shellout.

const CDP_WS_TARGETS = new Map(); // port -> { url, expiresAt }
const CDP_WS_TTL_MS = 30000;

async function fetchCdpPageWsUrl(port) {
  const cached = CDP_WS_TARGETS.get(port);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          let target = arr.find(p => p.type === 'page') || arr[0];
          if (!target || !target.webSocketDebuggerUrl) return reject(new Error('no_ws_target'));
          CDP_WS_TARGETS.set(port, { url: target.webSocketDebuggerUrl, expiresAt: Date.now() + CDP_WS_TTL_MS });
          resolve(target.webSocketDebuggerUrl);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('http_timeout')); });
  });
}

// Run a sequence of CDP commands over a single WS connection.
// commands: [{ method, params? }, ...]
// Returns: [result, ...] in order — each is the parsed `result` field from
// the CDP response. Errors on any command reject the whole promise.
function cdpNativeWsSession(port, commands, opts) {
  const totalTimeout = (opts && opts.timeout) || 25000;
  return new Promise(async (resolve, reject) => {
    let ws;
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      try { if (ws && ws.readyState === 1) ws.close(); } catch {}
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('cdp_ws_timeout')), totalTimeout);

    let url;
    try { url = await fetchCdpPageWsUrl(port); }
    catch (e) { clearTimeout(timer); return finish(e); }

    try { ws = new WebSocket(url); }
    catch (e) { clearTimeout(timer); return finish(e); }

    const results = new Array(commands.length);
    const pending = new Map(); // id -> index
    let nextId = 1;

    ws.addEventListener('open', () => {
      for (let i = 0; i < commands.length; i++) {
        const id = nextId++;
        pending.set(id, i);
        try {
          ws.send(JSON.stringify({ id, method: commands[i].method, params: commands[i].params || {} }));
        } catch (e) { clearTimeout(timer); return finish(e); }
      }
    });
    ws.addEventListener('message', (ev) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8');
        const msg = JSON.parse(data);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const idx = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            clearTimeout(timer);
            return finish(new Error(`cdp_error:${msg.error.message || JSON.stringify(msg.error)}`));
          }
          results[idx] = msg.result;
          if (pending.size === 0) {
            clearTimeout(timer);
            return finish(null, results);
          }
        }
      } catch (e) { /* ignore non-JSON / event frames */ }
    });
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer);
      finish(new Error(`cdp_ws_error:${ev.message || 'unknown'}`));
    });
    ws.addEventListener('close', (ev) => {
      if (!settled) {
        clearTimeout(timer);
        finish(new Error(`cdp_ws_closed_unexpectedly:${ev.code}`));
      }
    });
  });
}

// Promise-returning Runtime.evaluate with `returnByValue=true`. Returns the
// `.value` string (matching `cdpEvalRaw`'s prior contract — callers expect
// a string that they then JSON.parse).
async function cdpNativeEvaluate(port, jsExpr) {
  const [res] = await cdpNativeWsSession(port, [
    { method: 'Runtime.evaluate', params: { expression: jsExpr, returnByValue: true } },
  ]);
  if (!res || !res.result) return '[]';
  const v = res.result.value;
  if (v === undefined || v === null) return '[]';
  return String(v);
}

function cdpEvalRaw(port, jsExpr) {
  // Force-PS opt-out for environments where WebSocket isn't available
  // or the user wants to verify legacy behavior.
  if (process.env.WINDOWS_AUTOBOT_FORCE_PS === '1') {
    return cdpEvalRawPS(port, jsExpr);
  }
  debugLog(`[cdpEval native] port=${port} exprLen=${jsExpr.length}`);
  return cdpNativeEvaluate(port, jsExpr).catch((err) => {
    debugLog(`[cdpEval native err] ${err.message} — falling back to PowerShell`);
    return cdpEvalRawPS(port, jsExpr);
  });
}

function cdpEvalRawPS(port, jsExpr) {
  return new Promise((resolve, reject) => {
    const script = buildCdpExprScript(port, jsExpr);
    debugLog(`[cdpEval ps] port=${port} scriptLen=${script.length}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) { debugLog(`[cdpEval ps err] ${err.message}`); return reject(err); }
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const jsonLine = lines.find(l => l.startsWith('[') || l.startsWith('{') || l.startsWith('"'));
      resolve(jsonLine || '[]');
    });
  });
}

function inspectCdpElements(port, region) {
  const scope = resolveRegionScope(region);
  const expr = scope ? buildScopedTreeExpr(scope) : CDP_JS_EXPR;
  return cdpEvalRaw(port, expr).then((raw) => {
    const sanitized = (raw || '').replace(new RegExp("[\\x00-\\x1F\\x7F-\\x9F]+", 'g'), ' ');
    try { return JSON.parse(sanitized); }
    catch (e) {
      debugLog(`[inspectCdpElements parse] ${e.message} raw=${raw.substring(0, 200)}`);
      try {
        const around = Math.max(0, (e.message.match(/position (\d+)/) || [0, 0])[1] - 40);
        debugLog(`[inspectCdpElements ctx] ${raw.substring(around, around + 120)}`);
      } catch {}
      return [];
    }
  });
}

function cdpFindElements(port, needle, limit) {
  return cdpEvalRaw(port, buildFindExpr(needle, limit)).then((raw) => {
    const sanitized = (raw || '').replace(new RegExp("[\\x00-\\x1F\\x7F-\\x9F]+", 'g'), ' ');
    try { return JSON.parse(sanitized); }
    catch (e) {
      debugLog(`[cdpFindElements parse] ${e.message} raw=${raw.substring(0, 200)}`);
      return [];
    }
  });
}

function buildCdpActionExpr(action, args) {
  const a = JSON.stringify(args);
  if (action === 'click') {
    return `(function(){var a=${a};try{var el=document.querySelector(a.selector);if(!el)return JSON.stringify({error:'element_not_found'});var svgLike={svg:1,path:1,g:1,circle:1,rect:1,polygon:1,line:1,use:1,polyline:1};var target=el;var hops=0;while(target&&target!==document.body&&hops<8){var tg=(target.tagName||'').toLowerCase();var r=target.getAttribute&&target.getAttribute('role');if(tg==='button'||tg==='a'||tg==='input'||tg==='label')break;if(r&&/^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|option|checkbox|radio|switch)$/.test(r))break;if(target.onclick)break;if(svgLike[tg]||(target.getAttribute&&target.getAttribute('aria-hidden')==='true')){target=target.parentElement;hops++;continue;}break;}if(!target)target=el;try{target.scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}var rect=target.getBoundingClientRect();var cx=rect.left+rect.width/2;var cy=rect.top+rect.height/2;var init={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,screenX:cx,screenY:cy,button:0,buttons:1};var attempts=[];function fire(type,Ctor){try{var Ev=window[Ctor]||MouseEvent;target.dispatchEvent(new Ev(type,init));attempts.push(type);}catch(e){try{target.dispatchEvent(new MouseEvent(type,init));attempts.push(type+'(fb)');}catch(e2){}}}fire('pointerover','PointerEvent');fire('pointerenter','PointerEvent');fire('mouseover','MouseEvent');fire('mouseenter','MouseEvent');fire('pointerdown','PointerEvent');fire('mousedown','MouseEvent');try{if(target.focus)target.focus();}catch(e){}fire('pointerup','PointerEvent');fire('mouseup','MouseEvent');fire('click','MouseEvent');if(typeof target.click==='function'){try{target.click();attempts.push('native');}catch(e){}}return JSON.stringify({ok:true,target_tag:target.tagName,walked:target!==el,attempts:attempts});}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()`;
  }
  if (action === 'type') {
    return `(function(){var a=${a};try{var el=document.querySelector(a.selector);if(!el)return JSON.stringify({error:'element_not_found'});el.focus();var tag=el.tagName;var isCE=el.isContentEditable;if(isCE){el.textContent=a.text;el.dispatchEvent(new InputEvent('input',{bubbles:true,data:a.text,inputType:'insertText'}));return JSON.stringify({ok:true,mode:'contenteditable'});}var proto=tag==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,'value');if(setter&&setter.set){setter.set.call(el,a.text);}else{el.value=a.text;}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({ok:true,mode:'input'});}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()`;
  }
  if (action === 'getText') {
    return `(function(){var a=${a};try{var el=document.querySelector(a.selector);if(!el)return JSON.stringify({error:'element_not_found'});var t=(el.textContent||el.value||'').slice(0,2048);return JSON.stringify({text:t});}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()`;
  }
  throw new Error(`Unknown CDP action: ${action}`);
}

async function cdpAction(port, action, args) {
  const raw = await cdpEvalRaw(port, buildCdpActionExpr(action, args));
  try {
    let s = raw;
    if (s.startsWith('"') && s.endsWith('"')) {
      s = JSON.parse(s);
    }
    return JSON.parse(s);
  } catch (e) {
    return { error: `parse_failed: ${e.message}`, raw: raw.slice(0, 200) };
  }
}

function checkCdpAlive(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

ipcMain.handle('detect-apps', async () => {
  return detectElectronApps();
});

ipcMain.handle('detect-uia-apps', async () => {
  return detectUiaApps();
});

ipcMain.handle('enable-cdp-app', async (_event, exe) => {
  await restartSingleApp(exe, true);
  const apps = await detectElectronApps();

  const enabledApp = apps.find(a => a.Exe === exe);
  if (enabledApp && enabledApp.DebugEnabled) {
    const state = loadCdpState();
    state.apps = (state.apps || []).filter(a => a.exe !== exe);
    state.apps.push({
      name: enabledApp.Name,
      exe: enabledApp.Exe,
      port: enabledApp.DebugPort,
    });
    state.enabled = true;
    saveCdpState(state);
    await registerLogonTask();
  }

  return apps;
});

ipcMain.handle('disable-cdp-app', async (_event, exe) => {
  await restartSingleApp(exe, false);
  const apps = await detectElectronApps();

  const state = loadCdpState();
  state.apps = (state.apps || []).filter(a => a.exe !== exe);
  if (state.apps.length === 0) {
    state.enabled = false;
    saveCdpState(state);
    await unregisterLogonTask();
  } else {
    saveCdpState(state);
  }

  return apps;
});

ipcMain.handle('check-cdp-alive', async (_event, port) => {
  return checkCdpAlive(port);
});

ipcMain.handle('get-cdp-state', () => {
  return loadCdpState();
});

ipcMain.handle('inspect-elements', async (_event, pid, port) => {
  debugLog(`[inspect-elements] pid=${pid} port=${port}`);
  if (port) {
    try {
      const cdpElements = await inspectCdpElements(port);
      debugLog(`[inspect-elements] cdp returned ${cdpElements.length} elements`);
      return { source: 'cdp', elements: cdpElements };
    } catch (e) {
      debugLog(`[inspect-elements] cdp error: ${e.message}`);
      return { source: 'cdp', elements: [] };
    }
  }
  debugLog(`[inspect-elements] no port, using UIA`);
  const uiaElements = await inspectAppElements(pid);
  return { source: 'uia', elements: uiaElements };
});

ipcMain.handle('codex:status', () => {
  return new Promise((resolve) => {
    execFile(CODEX_BIN, ['--version'], { shell: process.platform === 'win32', timeout: 5000 }, (err) => {
      if (err && (err.code === 'ENOENT' || /not recognized|not found/i.test(err.message))) {
        resolve({ installed: false, loggedIn: false });
        return;
      }
      resolve({ installed: true, loggedIn: fs.existsSync(CODEX_AUTH_FILE) });
    });
  });
});

ipcMain.handle('codex:login', async (event) => {
  if (codexLoginProc) throw new Error('Login already in progress');

  return new Promise((resolve, reject) => {
    codexLoginProc = spawn(CODEX_BIN, ['login', '--device-auth'], {
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    let output = '';
    let buffered = '';
    const urlRegex = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/;
    const codeRegex = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
    const stripAnsi = (s) => s
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    let urlOpened = false;
    let codeSent = false;
    const sender = event.sender;

    const handleData = (chunk) => {
      const raw = chunk.toString();
      output += raw;
      buffered += stripAnsi(raw);

      if (!urlOpened) {
        const m = buffered.match(urlRegex);
        if (m) {
          urlOpened = true;
          shell.openExternal(m[0]);
        }
      }
      if (!codeSent) {
        const c = buffered.match(codeRegex);
        if (c) {
          codeSent = true;
          if (!sender.isDestroyed()) {
            sender.send('codex:device-code', { code: c[1] });
          }
        }
      }
      if (buffered.length > 8192) buffered = buffered.slice(-4096);
    };

    codexLoginProc.stdout.on('data', handleData);
    codexLoginProc.stderr.on('data', handleData);

    codexLoginProc.on('exit', (code) => {
      codexLoginProc = null;
      if (code === 0 && fs.existsSync(CODEX_AUTH_FILE)) {
        resolve({ ok: true });
      } else {
        reject(new Error(`codex login exited ${code}: ${output.slice(-500) || 'no output'}`));
      }
    });

    codexLoginProc.on('error', (err) => {
      codexLoginProc = null;
      if (err.code === 'ENOENT') {
        reject(new Error('codex binary not found on PATH. Install codex CLI first.'));
      } else {
        reject(err);
      }
    });
  });
});

ipcMain.handle('codex:logout', () => {
  return new Promise((resolve, reject) => {
    execFile(CODEX_BIN, ['logout'], { shell: process.platform === 'win32', timeout: 15000 }, (err) => {
      if (err && err.code !== 'ENOENT') return reject(err);
      try { if (fs.existsSync(CODEX_AUTH_FILE)) fs.unlinkSync(CODEX_AUTH_FILE); } catch {}
      resolve({ ok: true });
    });
  });
});

ipcMain.handle('codex:cancel-login', () => {
  if (codexLoginProc) {
    try { codexLoginProc.kill(); } catch {}
    codexLoginProc = null;
  }
  return { ok: true };
});

function getCodexAuth() {
  try {
    const data = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, 'utf-8'));
    const token = data.tokens?.access_token || data.OPENAI_API_KEY || null;
    const accountId = data.tokens?.account_id || null;
    const apiKey = data.OPENAI_API_KEY || null;
    return { token, accountId, apiKey };
  } catch {
    return { token: null, accountId: null, apiKey: null };
  }
}

// ── Per-app agent files ──

function appKey(exe) {
  const base = path.basename(exe, path.extname(exe)).toLowerCase();
  const slug = base.replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'app';
  let h = 0;
  for (let i = 0; i < exe.length; i++) h = (h * 31 + exe.charCodeAt(i)) | 0;
  const suffix = Math.abs(h).toString(36).slice(0, 6);
  return `${slug}_${suffix}`;
}

function agentPathFor(exe) {
  return path.join(AGENT_DIR, `${appKey(exe)}.md`);
}

function appSpecificPlaybook(meta) {
  const base = path.basename(meta.exe || '').toLowerCase();
  if (base.startsWith('chatgpt') || base.startsWith('openai')) {
    return `## ChatGPT navigation playbook

ChatGPT is an Electron-wrapped React app whose conversation list is
**virtualized / lazy-loaded**: only messages near the current scroll
position are mounted in the DOM. A bare \`cdp_get_tree()\` or
\`cdp_find()\` reflects the **currently rendered slice**, not the full
conversation. Treat any unscoped query for "first / earliest / oldest /
original" or "last / latest / newest" as **wrong by default** until you
have force-loaded the relevant end of the scroller.

### DOM map

- **Conversation scroller** — a \`main\` element with an inner
  \`overflow-y: auto\` div, or a descendant that becomes the largest
  visible scrollable on the page. \`cdp_scroll()\` auto-detects this.
- **Turns** — each user/assistant message is rendered inside an
  \`article\` (or a similar container) carrying
  \`data-message-author-role="user"\` or \`"assistant"\`. Filtering by
  this attribute is the most reliable way to enumerate turns.
- **User uploads** — images/files appear inside user-role turns as
  \`<img>\` tags and/or thumbnail buttons. The first \`<img>\` in
  document order **within a fully-loaded conversation** is the first
  image the user ever uploaded; the first \`<img>\` in a partial
  conversation is just the first one currently mounted.
- **Composer** — \`<textarea>\` (or contenteditable) at the bottom; the
  Send button is the adjacent button with an aria-label like "Send".
- **Sidebar** — chat list on the left; switching chats throws away the
  current scroller entirely, so refs from a different chat are useless.

### CRITICAL — lazy-load rule for "first / earliest / oldest" queries

Whenever the user asks for **the first**, **the earliest**, **the
oldest**, **the original**, **the first time you said**, or **the
first <X> I uploaded**, you must force-load the top of the conversation
before searching. Recipe:

1. \`cdp_scroll("top")\` — jump the scroller to its top.
2. Inspect the response. If \`atTop:true\` **and** \`heightChanged:false\`,
   the full history is mounted. Continue to step 4.
3. Otherwise (\`heightChanged:true\` means older messages just lazy-loaded
   and the document grew; \`atTop:false\` means the scroller has not yet
   bottomed-out at zero), call \`cdp_scroll("top")\` again. Loop. Cap at
   **15 iterations** — if the loop has not terminated, the chat is
   extremely long; tell the user you reached your scroll budget instead
   of guessing.
4. Now enumerate. For images use \`cdp_find("img")\` and pick the
   first match; for messages by author use
   \`cdp_get_tree("[data-message-author-role='user']")\`. **The first
   match in document order is the earliest in the chat.** Not the first
   match in a previously partial DOM.
5. If the user said "take me to" / "scroll to" / "show me", click the
   target ref (or call a parent's \`scrollIntoView\` via a click) so the
   viewport actually lands on it — finding it in the DOM is not enough.

For **"latest / newest / most recent"** queries: invert the recipe.
Start with \`cdp_scroll("bottom")\` until \`atBottom:true\` and
\`heightChanged:false\`, then enumerate and take the **last** match in
document order. Do **not** assume the current DOM is the bottom — the
user may have scrolled up before asking.

### Anti-patterns — do not do these

- **Do not** report "first image" / "earliest message" from a snapshot
  of the current viewport. That is the first thing currently rendered,
  not the first thing in history. Always \`cdp_scroll("top")\` and
  verify \`{atTop:true, heightChanged:false}\` before declaring success.
- **Do not** call \`cdp_get_messages\` or \`cdp_scroll_messages\` —
  those tools target Discord's specific message list selector
  (\`ol[data-list-id="chat-messages"]\`) and will fail or return empty
  on ChatGPT. Use \`cdp_scroll\` plus \`cdp_find\` / \`cdp_get_tree\`.
- **Do not** ask the user to scroll. The whole point of \`cdp_scroll\`
  is to automate scrolling for them.
- **Do not** reuse refs across scroll calls — a scroll may mount new
  rows and reshuffle the snapshot. Refresh with \`cdp_find\` or
  \`cdp_get_tree\` after each scroll iteration before clicking anything.

`;
  }
  if (base.startsWith('discord')) {
    return `## Discord navigation playbook

Discord is a React SPA with deeply nested SVG/foreignObject scaffolding.
**The selectors and matching rules below have been verified by direct
CDP testing — follow them literally.**

### DOM map

- **Left rail (server list)** — vertical column of square icons. Each
  server is a \`div[role="treeitem"]\`. **\`aria-label\` is empty.** The
  server name lives in the \`text\` column of the snapshot, in one of
  these shapes:
  - \`"<Server Name>"\` — plain
  - \`"Unread messages, <Server Name>"\` — has unread activity
  - \`"<n> mentions, <Server Name>"\` — has mentions
  - \`"<Server Name>, Voice call active"\` / \`"..., Screenshare active"\` — extra noise
  Match servers by **\`text\` substring (case-insensitive)** after
  stripping these prefixes/suffixes. Do **not** filter on \`label\` /
  \`aria-label\` — it will be blank.
- **Channel sidebar** — populated only after a server is clicked.
  Channels are \`<a>\` tags (\`tag = a\`) with both \`text\` and
  \`aria-label\` populated. The \`aria-label\` looks like
  \`"<channel-name> (text channel)"\` or \`"unread, <channel-name> (text channel)"\`.
  Match channels by **\`aria-label\` substring** (strip leading \`#\` from
  the user's intent, strip \`"unread, "\` prefix when comparing).
  Category headers are \`div[role="button"]\` with an aria-label like
  \`"<emoji> <Category> (category)"\` — clicking them only collapses/expands.
- **Main content area** — composer is \`div[role="textbox"]\` with
  \`aria-label\` starting \`"Message "\` (e.g. \`"Message #example-channel"\`).
  Use \`cdp_type(ref, text)\` to write, then click the Send Message
  button.

### Navigation recipe

Goal: from any starting state, land in \`<Server>\` / \`#<channel>\`.

1. \`cdp_get_tree()\` — fetch the current snapshot.
2. **Find the server treeitem.** Filter the snapshot rows where:
   - \`tag = div\` AND \`role = treeitem\` AND
   - \`text\` (case-insensitive) **contains** the server name the user
     gave, **after** you strip \`"Unread messages, "\` /
     \`"<n> mentions, "\` from the start and
     \`", Voice call active"\` / \`", Screenshare active"\` from the end.
   Pick the row whose ref is the **\`div\`**, not any \`svg\`. Call
   \`cdp_click(<that ref>)\`.
3. \`cdp_get_tree("channels")\` — the URL has changed and the channel
   sidebar is now populated. **You must refresh — refs from step 1 are
   stale.** Scoping to the \`"channels"\` region keeps the snapshot to
   ~30-80 rows instead of 500. (A no-arg \`cdp_get_tree()\` still works
   but wastes tokens.)
4. **Find the channel \`<a>\`.** Filter rows where:
   - \`tag = a\` AND
   - \`aria-label\` (case-insensitive) contains the channel name the
     user gave (strip leading \`#\` from the user input, accept an
     \`"unread, "\` prefix and a \`"(text channel)"\` suffix in the
     aria-label). Pick the \`<a>\` ref. Call \`cdp_click(<that ref>)\`.
5. \`cdp_get_tree("composer")\` once more to confirm the composer's
   aria-label now references this channel. Done. (Use the
   \`"composer"\` region — it returns ~5-15 rows instead of 500.)
6. To send a message: locate the composer ref (\`role = textbox\`,
   aria-label starts with \`"Message "\`), call \`cdp_type(<ref>, "<text>")\`,
   then click the Send Message button.

### Reading message content (do NOT use cdp_get_tree)

For tasks like "find the last post with 21+ reactions", "summarise today's
messages", "show the image with the most reactions", **"show me the last
picture/image/file I uploaded"**, "what did <user> last say" — **call
\`cdp_get_messages(limit)\`**.

If the user asks for *their own* last upload, filter the \`messages\`
array by \`authorId === currentUserId\` (preferred — IDs are exact)
or \`author === currentUser\` (fallback — text match) using the
\`currentUser\` / \`currentUserId\` fields returned by
\`cdp_get_messages\`. \`currentUserId\` is the Discord snowflake read
from the user-panel avatar URL and is reliable even during voice
calls when the visible username text is hidden. Then take the most
recent entry whose \`images\` array is non-empty and return the first
URL from that array. Do **not** call \`cdp_get_tree\` for this — the
tree is 80KB+ and will stall the chat for minutes while
\`cdp_get_messages\` returns the same info in ~3KB. The tool returns
\`{ currentUser, currentUserId, count, messages }\` where each
message is \`{ id, author, authorId, time, text, images, reactions, reactionTotal }\`
— no DOM snapshot, no refs, no token bloat.

**If \`currentUser\` AND \`currentUserId\` both come back empty**,
Discord's user panel layout is hiding the username (most common
cause: the user is in an active voice call, which collapses the
username container into a "Voice Connected" widget). **Do not** hunt
for the username by clicking around — there is no visible username
ref to find, and exploratory clicks on the bottom-left panel will hit
\`Mute\` / \`Deafen\` / \`Input Options\` / \`Output Options\` /
\`User Settings\` and dismantle the user's session. Instead:
1. Drop the \`from:\` filter from any search query you were about to
   submit — e.g. rewrite \`from:<user> has:image in:<channel>\` to
   \`has:image in:<channel>\`.
2. Filter the resulting messages array by your own \`authorId\` if
   \`currentUserId\` is non-empty; otherwise tell the user
   "I couldn't read your Discord username — likely because you're in
   a voice call. Tell me your Discord username and I'll redo the
   search" and stop.

**CRITICAL — "latest / last X" tasks must guarantee the bottom is mounted first.**
Discord only renders messages near the current scroll position. If the
user scrolled up earlier (or you opened a channel they were reading mid-
history), the *actual* newest message is **not** in the DOM and
\`cdp_get_messages\` will return a stale window. The recipe for any
"last / latest / most recent / newest" query is:

1. \`cdp_scroll_messages("bottom")\` — force-jump the viewport to the
   end of the channel. Check the result: it must report
   \`atBottom: true\`. If not, call it again (Discord may need a second
   tick to settle after lazy-loading newer rows).
2. \`cdp_get_messages(limit)\` — now safe to read; the newest message
   really is the newest.
3. Filter / find the target as normal.
4. If the target is still missing (e.g. "last image I uploaded" but no
   message in the window has \`author === currentUser\` with a non-empty
   \`images\` array), the upload is older than the current window —
   then and only then call \`cdp_scroll_messages("up", 3)\` and re-fetch.
   Do **not** declare "no upload found" without first confirming
   \`atBottom: true\` on the most recent scroll result.

- If you need older messages (target predates the loaded window), call
  \`cdp_scroll_messages("up", 3)\` and then re-call \`cdp_get_messages\`
  — Discord lazy-loads older rows into the DOM on upward scroll. Loop
  until you find the target or the response reports \`atTop: true\` AND
  \`firstChanged: false\` (channel history exhausted).
  **Never ask the user to scroll manually — automate it.**
- Each \`reactions[i]\` has \`{ emoji, count, label }\`. \`reactionTotal\` is the
  sum across all emoji on that message — use it as a quick filter.
- For unique-reactor counts you would have to open the reaction tooltip
  (\`count\` is per-emoji, so a message with 21 thumbs-up = 21 reactions but
  could be fewer unique people if anyone else added other emoji). Treat
  \`reactionTotal\` as a strong upper bound for "popular post".
- For images, the \`images\` array already contains direct CDN URLs.

**Only use \`cdp_get_tree()\` when you need to click or type something.**
A 25-message \`cdp_get_messages\` reply is ~2-5KB; a full tree is 80KB+.

### Region-scoped snapshots

A no-arg \`cdp_get_tree()\` returns up to 500 rows of the whole document
— huge and slow. Almost every Discord task only cares about one slice.
Pass a region key to scope it:

- \`cdp_get_tree("servers")\` — left rail, the column of server icons.
  Use when picking a server.
- \`cdp_get_tree("channels")\` — channel sidebar inside the current
  server. Use after a server-click to find a channel \`<a>\`.
- \`cdp_get_tree("composer")\` — the message input area. Use to grab
  the textbox ref before typing, or to confirm which channel the
  composer is bound to.
- \`cdp_get_tree("messages")\` — the chat scroller \`<ol>\`. Rarely
  needed (prefer \`cdp_get_messages\` for content), but useful when you
  need clickable refs on individual messages.

You can also pass an arbitrary CSS selector (e.g.
\`cdp_get_tree("[class*='members_']")\`) for ad-hoc scoping. If the
scope element isn't found, the tool falls back to the full document.

Even better when you already know the label of what you want to click:
\`cdp_find("example-channel")\` returns only the matching nodes with
\`f1..fN\` refs, typically 1-5 rows. Use \`cdp_find\` before reaching
for \`cdp_get_tree\`.

### Scrolling the viewport to a specific message

\`cdp_get_messages\` only *reads* the DOM — it does **not** move the chat
scroll position. If the user says **"scroll me to"**, **"show me"**,
**"take me to"**, **"jump to"**, or **"find"** a specific message (their
last upload, the post with the most reactions, etc.), the contract is:

1. \`cdp_get_messages(limit)\` — locate the target message in the result.
2. \`cdp_scroll_to_message(id)\` — pass the message's full \`id\` field
   (e.g. \`"chat-messages-000000000000000000-1374..."\`). This calls
   \`scrollIntoView({block:'center'})\` on the \`<li>\` and briefly
   outlines it in Discord blurple so the user sees where you landed.
3. Only after the scroll tool returns \`{ok:true, visible:true}\` may
   you tell the user "done" / "you're at <message>".

If the target message is **not** in the current \`cdp_get_messages\`
output, it is above the loaded window. Call
\`cdp_scroll_messages("up", 3)\` to load older rows, then re-call
\`cdp_get_messages\` and re-check. Repeat until you find the target
or the scroll tool returns \`atTop: true\` AND \`firstChanged: false\`
(no more history to load). **Do not** ask the user to scroll — the
whole point of this tool is to keep the task automated.

**Never** declare a "scroll to" task complete after only calling
\`cdp_get_messages\`. Finding the message in the JSON proves it exists
in the DOM; it does not prove the viewport moved. The user is looking
at the Discord window — they will see a static channel and a wrong
"done" reply.

### Using Discord's search bar (server + channel scope)

\`cdp_scroll_messages\` is slow for deep history: each round loads ~25
older rows, and the user's "first upload" or "first post about X" may be
thousands of messages back. Discord's own search indexes the entire
server, so use the search bar whenever the task is:

- "find / show / scroll to **my first / oldest / earliest** <X>" (image, post, link, message)
- "find the message where <user> said <thing>"
- "show me when <topic> first came up"
- anything else where you'd otherwise scroll many viewport-heights

**DOM map (channel-header search, verified by live CDP probe):**

- The bar is \`div[class*="searchBar_"]\` in the channel header. Its
  \`textContent\` reads \`"Search <Server Name>"\` (e.g.
  \`"Search example-community - Screenshot Community"\`). Find it with
  \`cdp_find("Search ")\` (note trailing space) or by filtering rows
  where \`tag = div\` and \`text\` starts with \`"Search "\`.
- After clicking, focus lands on
  \`div[role="combobox"][aria-label="Search"][contenteditable="true"]\`
  — a **DraftJS editor**. \`cdp_type\` does NOT work on it (the editor
  owns its state and ignores JS-dispatched InputEvents). Use
  **\`cdp_paste\`**.
- Submitted results render in
  \`section[class*="searchResultsWrap_"][aria-label="Search Results"]\`
  with rows \`li[id^="search-results-"]\`. Each row has a "Jump" button
  that scrolls the main chat view to the source message.
- **Sort control (verified by live CDP probe):** the results header has a
  dropdown \`button[aria-label="Sort"]\` (NOT inline "New/Old/Relevant"
  text toggles — those no longer exist, so \`cdp_find("Old")\` matches
  nothing). Clicking it opens a popup menu
  (\`#search-result-sort-menu\`) with three radios:
  \`Newest\` (default), \`Oldest\`, \`Most Relevant\`. **Default sort is
  Newest-first**, so the panel's \`results[0]\` is the *most recent*
  match until you change it. Use **\`cdp_set_search_sort("oldest")\`**
  to flip it — never try to click a text toggle.

**Search recipe:**

1. \`cdp_find("Search ")\` — returns the search bar (look for the row
   whose \`text\` starts with \`"Search <ServerName>"\`).
2. \`cdp_click(<that ref>)\` — focuses the DraftJS combobox. A filter
   popout appears with hints like \`from:<current-user>\`, \`in:channel\`,
   \`has:link,embed,or file\`, \`mentions:user\`.
3. \`cdp_paste(<same ref or the now-focused combobox>, "<query>")\` —
   use **\`cdp_paste\`**, not \`cdp_type\`. Discord-supported query
   syntax: \`from:<username>\` (your own uploads → \`from:<currentUser>\`,
   read \`currentUser\` from \`cdp_get_messages\` — and verify it is
   non-empty before substituting; **never** paste a literal \`from:\`
   with no username, \`from:me\`, or a guessed username like
   \`from:<current-user>\`. If \`currentUser\` is empty, drop the \`from:\`
   filter entirely and filter messages locally by \`authorId\`
   against \`currentUserId\`. See the "blank currentUser" recovery
   block above.), \`has:image\` / \`has:link\` / \`has:embed\` /
   \`has:file\` / \`has:video\` / \`has:sound\`, \`in:<channel>\`,
   \`mentions:<user>\`, \`before:YYYY-MM-DD\` /
   \`during:YYYY-MM-DD\` / \`after:YYYY-MM-DD\`, plus any free-text
   words to match in message body. Combine: e.g.
   \`from:<current-user> has:image\` finds all of johndoe's image uploads in
   the current server. Refs from the snapshot stay valid for
   \`cdp_paste\` (the search bar element is the same node before and
   after focus).
4. \`cdp_press_key("Enter")\` — submits the search and opens the
   results panel. Wait briefly for results to load.
5. \`cdp_get_search_results(limit?)\` — **REQUIRED** to enumerate
   results. Returns \`{ sortMode, totalCount, pages, count, results: [
   { messageId, author, authorId, time, text, images, guildId,
   channelId } ] }\`. **Do NOT use \`cdp_get_tree("[aria-label='Search
   Results']")\` for this** — the snapshot filter drops
   \`<li role="listitem">\` rows, so you never see row ids, and the
   "Jump" button is hover-revealed so it never appears in the snapshot
   either. \`cdp_get_search_results\` is the only way to read this
   panel.
6. **Set the sort BEFORE choosing a target.** Discord defaults to
   **Newest-first**, so the panel's \`results[0]\` is the *most recent*
   match — picking it for a "first / earliest / oldest" request is the
   classic wrong-answer bug (you jump to the latest image instead of
   the first). The fix:
   - For **first / earliest / oldest**: call
     \`cdp_set_search_sort("oldest")\`. It returns \`{ ok, order }\` —
     proceed only when \`order === "ascending"\`.
   - For **latest / newest / most recent**: call
     \`cdp_set_search_sort("newest")\` (or trust the default) and
     confirm \`order === "descending"\`.
   Then **re-call \`cdp_get_search_results\`** and read \`order\` on the
   fresh result. Only when \`order\` matches the intent is \`results[0]\`
   the correct first/last match. **Never** try \`cdp_find("Old")\` /
   clicking a text toggle — the sort control is a dropdown and there is
   no "Old" element to click. If \`pages\` is non-empty and your target
   may be deeper at the chosen sort, click \`div[aria-label="Page N"]\`
   and re-read.
7. \`cdp_jump_to_search_result(messageId)\` — **REQUIRED** to actually
   navigate. Atomic tool: hovers the row at CDP layer to reveal the
   Jump button, locates it, clicks it. The Discord chat view scrolls
   to the message and highlights it. **Never** \`cdp_click\` on inner
   children of a search-result row — clicking the message-preview div
   opens the image lightbox (or does nothing) and burns rounds; the
   Jump button is the only correct target and it is invisible to
   \`cdp_get_tree\` because Discord hides it with CSS until \`:hover\`.
8. After \`cdp_jump_to_search_result\` returns \`{ok:true}\`, the target
   message — and any image you opened from it — is on screen. **That is
   the deliverable. STOP and reply.** Do **not** press
   \`cdp_press_key("Escape")\` or otherwise "close the search panel" as
   cleanup. Escape dismisses the **topmost** layer, so if an image
   lightbox is open it closes the *image* — exactly what the user asked
   to see — instead of the panel behind it. A lingering search panel is
   harmless; leaving it open is strictly better than risking dismissing
   the result. Also **do not** re-snapshot the search panel to "verify"
   — the jump already moved the viewport; further snapshots/clicks risk
   re-opening the lightbox or hitting stale refs.
9. If you only wanted the URL of an image from a result (not to
   navigate), extract it from \`results[].images[]\` and skip
   \`cdp_jump_to_search_result\`.

**Search vs scroll — when to use which:**

- Use **search** whenever the target predates the last ~50 mounted
  messages, or when the user asks for "first / earliest" in a channel
  with active history. One search call beats dozens of
  \`cdp_scroll_messages("up")\` rounds.
- Use **scroll** when the target is clearly within the recent window
  (last few minutes/hours, "latest", "the message I just posted").
- If a search returns zero results, the query is wrong — refine it
  (drop filters one at a time, try \`from:\` with the exact username
  from \`cdp_get_messages\` rather than a casual name). Do not fall
  back to manual scrolling without telling the user the search
  failed and what query you used.

### Anti-patterns — do not do these

- **Do not match servers by \`aria-label\` / \`label\` column.** It is
  empty on server treeitems. Use the \`text\` column.
- **Do not click \`svg\` refs.** Two \`svg\` refs share the same
  \`text\` as each treeitem — they are decoration. Only the
  \`div[role="treeitem"]\` (for servers) or \`a\` (for channels) is a
  real click target.
- **Do not reuse refs across snapshots.** Always
  \`cdp_get_tree()\` after each navigation click; refs reshuffle.
- **Do not give up after one \`cdp_get_tree()\` returns "no channels"** —
  if the snapshot was taken before the server-click finished settling,
  call \`cdp_get_tree()\` again.
- **Do not declare a scroll/show/jump-to task done after only
  \`cdp_get_messages\`.** That tool reads, it does not scroll. You must
  call \`cdp_scroll_to_message(id)\` and confirm \`{ok:true}\` before
  reporting completion.
- **Do not trust \`cdp_get_messages\` for "latest / last" queries
  without first calling \`cdp_scroll_messages("bottom")\` and seeing
  \`atBottom: true\`.** The DOM only contains messages near the current
  scroll position. If the user was reading history when the task
  fired, "the most recent message in the window" is **not** the most
  recent message in the channel — and the upload they just made may
  not be mounted at all. Always jump to the bottom before searching
  for "the newest X".
- **Do not use \`cdp_type\` to type into the channel-header search
  bar.** The search bar is a DraftJS editor — it ignores
  JS-dispatched InputEvents and looks like it accepted text when it
  actually did not. Always use \`cdp_paste\` for the search bar, and
  \`cdp_press_key("Enter")\` to submit. Same rule for any other rich-
  text editor that surfaces (reply threads in some Discord builds,
  the bug-report modal, etc.).
- **Do not scroll history when search would work.** "Show me my first
  image in this server" → use \`from:<currentUser> has:image\` in the
  channel-header search bar, do not loop \`cdp_scroll_messages("up")\`
  hundreds of times.
- **Do not trust \`results[0]\` as the "first / oldest" without flipping
  sort.** Discord's search defaults to **Newest-first**. For a
  "first / earliest / oldest" request you MUST call
  \`cdp_set_search_sort("oldest")\` and confirm the follow-up
  \`cdp_get_search_results\` reports \`order: "ascending"\` before you
  jump. Skipping this sends you to the user's *most recent* match — the
  exact opposite of what they asked, and they will see the wrong image.
  This is the single most common failure for "first image I uploaded"
  tasks. (Scope it too: \`from:<currentUser> has:image in:<channel>\` so
  you get *their* uploads in *that* channel, not the whole server.)
- **Do not \`cdp_find("Old")\` / click a "New" / "Old" / "Relevant"
  text toggle.** Those toggles were removed; the sort control is now a
  dropdown \`button[aria-label="Sort"]\`. The only correct way to change
  sort is \`cdp_set_search_sort(order)\`.
- **Do not call \`cdp_get_tree("body")\`, \`cdp_get_tree("html")\`, or
  any other near-document-root scope.** It returns 500 rows of
  unrelated UI — title-bar buttons, server icons, friend rows,
  bottom-panel controls — and any subsequent click on a numeric ref
  from that dump is essentially random. The
  \`User Settings\` / \`Mute\` / \`Deafen\` / \`Input Options\` /
  \`Output Options\` / \`Manage profile and status\` buttons in the
  user panel are common false-positive matches for the words
  "User" / "Settings" / "profile" / "Options". If you don't know
  which ref to click, use \`cdp_find("<exact text or aria-label>")\`
  instead — it returns 1-5 rows scoped to the literal needle and you
  cannot misclick into the settings dialog.
- **Do not click the bottom-left user-panel controls.** The buttons
  \`aria-label="User Settings"\` (gear icon → opens the full settings
  modal with the last-viewed tab, often Voice & Video),
  \`aria-label="Mute"\`, \`aria-label="Deafen"\`,
  \`aria-label="Input Options"\` and \`aria-label="Output Options"\`
  are **never** valid steps for a search, navigation, message-send,
  or content-read task. The only time you may click any of them is
  when the user explicitly asks to open settings or change audio
  state. If a search recipe fails, do not "explore" by clicking
  these — surface the failure to the user and ask for clarification.
- **Do not \`cdp_click\` on search-result row children.** Each
  \`li[id^="search-results-"]\` contains the message preview (text +
  image thumbnails) as inner divs/imgs. Clicking the message preview
  opens the image lightbox or the embed expander — it does NOT
  navigate to the source message. The "Jump" button is the only
  navigation target and Discord hides it behind \`:hover\` so it never
  shows up in \`cdp_get_tree\` / \`cdp_find\`. Use
  \`cdp_jump_to_search_result(messageId)\` — it hovers the row at CDP
  layer (real native mouseMoved, triggers \`:hover\` for real) before
  clicking Jump, so the model never needs a ref for a hover-revealed
  control. If you find yourself doing \`cdp_click({ref:"e<N>"})\`
  with a \`li:nth-child(...)\` selector against the search panel,
  stop and call \`cdp_jump_to_search_result\` instead.
- **Do not use \`cdp_get_tree\` on the search-results panel.**
  Result rows are \`<li role="listitem">\` and the snapshot filter
  drops \`role=listitem\` to suppress chat-log noise. You will get
  back snapshot children of rows without their parent ids, and you
  cannot reconstruct \`search-results-<messageId>\`. Always use
  \`cdp_get_search_results\` for that panel.
- **Do not paste a \`from:\` filter with a blank or guessed
  username.** \`from:\` with no value, \`from:me\`, \`from:<current-user>\`, or
  any name you did not read directly from \`cdp_get_messages\`'s
  \`currentUser\` field is a wrong query. If \`currentUser\` is
  empty, drop the filter — see the "blank currentUser" recovery
  block in **Reading message content**.

`;
  }
  return '';
}

function buildAutoBlock(meta) {
  const now = new Date().toISOString();
  const isElectron = meta.type === 'electron';
  const backendDesc = isElectron
    ? 'Chrome DevTools Protocol (CDP) when CDP is enabled on the app, otherwise Windows UI Automation (UIA)'
    : 'Windows UI Automation (UIA)';
  const toolList = isElectron
    ? `- **cdp_click(ref)** — click a DOM element by its ref (e.g. \`e12\`).
- **cdp_type(ref, text)** — focus an input/textarea/contenteditable and set text via JS (native value setter + InputEvent). Fast path for plain \`<input>\`/\`<textarea>\` and simple contenteditable composers. For rich-text editors (DraftJS, Slate, Lexical, Quill, Discord's channel-header search bar) prefer **cdp_paste** — JS-level events are silently dropped by editors that own their state model.
- **cdp_paste(ref, text, clear?)** — focus the element with a real CDP click + dispatch \`Input.insertText\` at the CDP layer. Works on every text surface, including the editors where \`cdp_type\` looks like it succeeded but the field stays empty. Pass \`clear: true\` to select-all + delete any existing content first. Use this any time you need to type into a search bar, a rich-text editor, or anywhere \`cdp_type\` reports ok but a re-inspection shows no value change.
- **cdp_press_key(key, modifiers?)** — dispatch a single key (\`Enter\`, \`Escape\`, \`Tab\`, \`Backspace\`, \`Delete\`, \`ArrowUp/Down/Left/Right\`, \`Home\`, \`End\`, \`PageUp\`, \`PageDown\`, \`Space\`, or any single character). \`modifiers\` is an optional array (\`["ctrl"]\`, \`["ctrl","shift"]\`, etc.). REQUIRED to submit forms (Enter), dismiss popouts/modals (Escape), or navigate autocomplete. Pair with \`cdp_paste\`: paste the query → press Enter to submit.
- **cdp_get_text(ref)** — read \`textContent\` of an element.
- **cdp_get_tree(region?)** — refresh the snapshot. Optional \`region\` ("servers", "channels", "composer", "messages" for Discord, or any CSS selector) narrows the scope and cuts 500 rows to ~30-100.
- **cdp_find(query, limit?)** — search the DOM by substring (text/aria-label/id) and return only matching refs (f1..fN). Use this INSTEAD of cdp_get_tree when you know what you want to click — far cheaper than a 500-row snapshot.
- **cdp_get_messages(limit?)** — Discord only: return the last N messages with author, text, image URLs and reaction emoji+counts. Use this instead of \`cdp_get_tree\` when the task is to read message content, find a post by reactions, count something across messages, etc. Much cheaper than a full DOM snapshot.
- **cdp_scroll_to_message(message_id)** — Discord only: scroll the chat viewport so a specific message is centered. Pass the \`id\` from \`cdp_get_messages\`. **Required** whenever the user says "scroll to", "show me", "jump to", "take me to", or "find" a specific message — \`cdp_get_messages\` only reads the DOM, it does not move the scroll position.
- **cdp_scroll_messages(direction, pages?)** — Discord only: scroll the chat message list to load older or newer messages. \`direction\` is \`"up"\` (default, load older), \`"down"\` (newer), \`"top"\` (oldest history), or \`"bottom"\` (latest). \`pages\` defaults to 3 viewport heights. Use when the target message is not in the current \`cdp_get_messages\` window — never ask the user to scroll manually. Re-call \`cdp_get_messages\` after each scroll to see newly mounted rows. Stop when the result says \`atTop: true\` and \`firstChanged: false\`.
- **cdp_get_search_results(limit?)** — Discord only: scrape the channel-header **Search Results** panel and return structured rows (\`{ messageId, author, authorId, time, text, images, guildId, channelId }\`) plus \`sortMode\`, \`order\` (\`"ascending"\` = oldest-first, \`"descending"\` = newest-first), \`firstTime\`/\`lastTime\`, and \`pages\`. **REQUIRED** for the search-bar flow — \`cdp_get_tree\` drops the \`<li role="listitem">\` rows from snapshots so the model can never see ids. Pair with \`cdp_jump_to_search_result\`.
- **cdp_set_search_sort(order)** — Discord only: set the Search Results sort to \`"oldest"\`, \`"newest"\`, or \`"relevant"\`. **REQUIRED before trusting \`results[0]\` for any first/earliest/oldest (use \`"oldest"\`) or latest/newest (\`"newest"\`) request** — Discord defaults to **Newest-first**, so without this \`results[0]\` is the *most recent* match, not the oldest. The sort control is a dropdown (\`button[aria-label="Sort"]\` → popup menu); \`cdp_find("Old")\` finds nothing. This tool opens the menu and selects the option at CDP mouse layer, then verifies via row timestamps. Returns \`{ ok, order, sortMode, firstTime, lastTime }\`. After \`ok\` with the expected \`order\`, re-call \`cdp_get_search_results\`.
- **cdp_jump_to_search_result(message_id)** — Discord only: navigate to a search result by message id (from \`cdp_get_search_results\`). Atomic: hovers the row at CDP layer to reveal the hover-only **Jump** button, then dispatches a real CDP click. Use this instead of \`cdp_click\` on row children — Jump is invisible to snapshots, and clicking inner divs/images opens the lightbox.
- **cdp_scroll(direction, pages?, container?)** — **Generic** scroll for any app (ChatGPT, Slack, web SPAs). Auto-detects the largest scrollable container (or pass an explicit CSS selector). **Required for any "first / earliest / oldest / original" or "latest / newest" query on a lazy-loaded conversation** — the DOM only contains messages near the current scroll position, so \`cdp_find\` / \`cdp_get_tree\` see a partial slice. Recipe: \`cdp_scroll("top")\` repeatedly until \`{atTop:true, heightChanged:false}\`, then enumerate. For Discord, prefer \`cdp_scroll_messages\` (it knows Discord's specific list selector).
- _Fallback UIA tools_ (\`uia_invoke\`, \`uia_set_value\`, \`uia_get_tree\`) are exposed if CDP is unavailable.`
    : `- **uia_invoke(ref)** — invoke / toggle / select / expand an element by ref (e.g. \`u47\`).
- **uia_set_value(ref, text)** — set text on an editable element (ValuePattern, falls back to SendKeys).
- **uia_get_tree()** — refresh the snapshot and get new refs after the UI changes.`;

  return `---
exe: ${meta.exe}
name: ${meta.name}
type: ${meta.type}
key: ${appKey(meta.exe)}
updated: ${now}
---

# ${meta.name}

## Scope

You operate ONLY on the running instance of **${meta.name}**.
Refuse any request that targets a different application, the OS shell,
or arbitrary web tasks unrelated to this app. If asked about another
app, briefly explain you are scoped to ${meta.name} and stop.

## Capabilities

You receive a live element snapshot of ${meta.name}'s UI on every turn
via ${backendDesc}. You can both **read** the UI and **act** on it
through the tools listed below. After any action that changes the UI,
call the appropriate \`*_get_tree\` tool before continuing — old refs
go stale once the UI mutates.

## Tools

${toolList}

## Snapshot legend

Each row in the snapshot table has a stable \`ref\` (e.g. \`e12\` for
CDP / DOM elements, \`u47\` for UIA elements) that you pass into the
tools above. Refs are only valid for the most recent snapshot.

${appSpecificPlaybook(meta)}## Working style

1. Read the user's request and locate the relevant ref(s) in the snapshot.
2. If you are confident, call the tool. If not, ask a clarifying question.
3. After acting, refresh the snapshot if the UI changed, then verify the
   result before reporting back.
4. Never describe tool calls in chat text — call the tool directly.
5. **Multi-step navigation is the norm, not the exception.** A request like
   "go to channel X in server Y" is *at least* four tool calls: click
   server → \`*_get_tree\` → click channel → \`*_get_tree\`. Do not
   declare success after a single click — verify by re-inspecting.
6. When matching refs to a name the user gave, prefer **substring,
   case-insensitive matches on the \`label\` column** (which is the
   element's \`aria-label\` or visible text). Pure positional guessing
   (e.g. "the first treeitem") is unreliable — Discord and similar SPAs
   reshuffle their order with unread state, folder expansion, etc.
7. **Self-recovery — never give up silently.** If a tool returns an
   error, if a tool reports \`ok\` but the next snapshot shows the UI
   did not change, or if your planned recipe is not producing the
   target state, do not stop and apologise. Try an alternate path
   first. Common substitutions:
   - \`cdp_type\` → \`cdp_paste\` (rich-text editor swallowed the JS event)
   - manual scrolling history → use the app's search bar (faster + reaches deeper)
   - \`cdp_get_tree\` (timed out / too large) → \`cdp_find\` or a scoped \`cdp_get_tree(region)\`
   - a stale ref → \`cdp_find\` for the same label, get a fresh \`f\`-ref
   - a missing element after a click → re-fetch the tree once more (post-click settle)
   Only after at least one alternate attempt should you reply to the
   user — and that reply MUST state explicitly what you tried, what
   blocked you, and what you would try next (or what the user could
   do). **Never** report partial completion as success ("I had to stop
   before…" is a failure, not an answer); the user is watching the app
   and will see the mismatch immediately.
8. **The surfaced target is the deliverable — never undo it.** Once the
   user's goal is *visible* (you jumped to the message, opened the
   image, navigated to the channel, expanded the detail view), the task
   is done — reply. Do **not** fire "cleanup" actions afterward —
   closing panels, dismissing popouts, pressing \`Escape\`, or
   navigating away — to "tidy up". Dismiss keystrokes hit the **topmost**
   layer, which is usually the very thing you just surfaced (a lightbox,
   a highlighted message, an opened menu), so the user watches their
   result vanish. A leftover open panel is harmless; a dismissed result
   is a failed task. Reserve \`Escape\` / close actions for when an
   *unwanted* overlay is actively blocking the next required step — not
   as a finishing flourish.
`;
}

function splitAgent(content) {
  const idx = content.indexOf(AGENT_USER_HEADING);
  if (idx === -1) return { auto: content.trimEnd(), userBlock: '' };
  return {
    auto: content.slice(0, idx).trimEnd(),
    userBlock: content.slice(idx),
  };
}

function ensureAgentFile(meta) {
  if (!fs.existsSync(AGENT_DIR)) {
    fs.mkdirSync(AGENT_DIR, { recursive: true });
  }
  const filePath = agentPathFor(meta.exe);
  const auto = buildAutoBlock(meta);
  let userBlock = `\n\n${AGENT_USER_HEADING}\n\n<!-- Edit below. Preserved across regenerations. -->\n`;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    const split = splitAgent(existing);
    if (split.userBlock) userBlock = `\n\n${split.userBlock.trimEnd()}\n`;
  }
  const final = `${auto}${userBlock}`;
  fs.writeFileSync(filePath, final, 'utf8');
  return { path: filePath, content: final, key: appKey(meta.exe) };
}

function loadAgentForPrompt(meta) {
  const filePath = agentPathFor(meta.exe);
  if (!fs.existsSync(filePath)) {
    return buildAutoBlock(meta);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function escapePipe(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function renderCdpSnapshot(elements) {
  const refMap = {};
  if (!elements || !elements.length) {
    return { text: '_No DOM elements found._', refMap, backend: 'cdp' };
  }
  const capped = elements.slice(0, SNAPSHOT_ELEMENT_CAP);
  const rows = capped.map((el, i) => {
    const ref = `e${i + 1}`;
    refMap[ref] = {
      selector: el.Selector || '',
      tag: el.Tag || '',
      text: el.Text || '',
      aria: el.AriaLabel || '',
      role: el.Role || '',
      id: el.Id || '',
    };
    const tag = (el.Tag || '').toLowerCase();
    const text = escapePipe(el.Text).slice(0, 60);
    const id = escapePipe(el.Id);
    const role = escapePipe(el.Role);
    const aria = escapePipe(el.AriaLabel).slice(0, 60);
    const label = text || aria || id || role || '(unlabeled)';
    return `| ${ref} | ${tag} | ${label} | ${id} | ${role} |`;
  });
  const truncated = elements.length > SNAPSHOT_ELEMENT_CAP
    ? `\n\n_Truncated: showing ${SNAPSHOT_ELEMENT_CAP} of ${elements.length} elements._`
    : '';
  const text = [
    '| ref | tag | label | id | role |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n') + truncated;
  return { text, refMap, backend: 'cdp' };
}

function renderFocusedSnapshot(elements) {
  const refMap = {};
  if (!elements || !elements.length) {
    return { text: '_No matching elements found._', refMap };
  }
  const rows = elements.map((el, i) => {
    const ref = `f${i + 1}`;
    refMap[ref] = {
      selector: el.Selector || '',
      tag: el.Tag || '',
      text: el.Text || '',
      aria: el.AriaLabel || '',
      role: el.Role || '',
      id: el.Id || '',
    };
    const tag = (el.Tag || '').toLowerCase();
    const text = escapePipe(el.Text).slice(0, 60);
    const id = escapePipe(el.Id);
    const role = escapePipe(el.Role);
    const aria = escapePipe(el.AriaLabel).slice(0, 60);
    const label = text || aria || id || role || '(unlabeled)';
    return `| ${ref} | ${tag} | ${label} | ${id} | ${role} |`;
  });
  const text = [
    '| ref | tag | label | id | role |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  return { text, refMap };
}

function renderUiaSnapshot(elements) {
  const refMap = {};
  if (!elements || !elements.length) {
    return { text: '_No UIA elements found._', refMap, backend: 'uia' };
  }
  const capped = elements.slice(0, SNAPSHOT_ELEMENT_CAP);
  const rows = capped.map((el, i) => {
    const ref = `u${i + 1}`;
    refMap[ref] = {
      automationId: el.AutomationId || '',
      name: el.Name || '',
      controlType: el.Type || '',
      className: el.ClassName || '',
    };
    const type = escapePipe(el.Type);
    const name = escapePipe(el.Name).slice(0, 60);
    const aid = escapePipe(el.AutomationId);
    const cls = escapePipe(el.ClassName);
    return `| ${ref} | ${type} | ${name} | ${aid} | ${cls} |`;
  });
  const truncated = elements.length > SNAPSHOT_ELEMENT_CAP
    ? `\n\n_Truncated: showing ${SNAPSHOT_ELEMENT_CAP} of ${elements.length} elements._`
    : '';
  const text = [
    '| ref | type | name | automationId | className |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n') + truncated;
  return { text, refMap, backend: 'uia' };
}

async function buildLiveSnapshot(meta, region) {
  try {
    if (meta.type === 'electron' && meta.port) {
      const alive = await checkCdpAlive(meta.port);
      if (!alive) {
        return {
          text: `_CDP port ${meta.port} unreachable — restart the app with CDP enabled to refresh the snapshot._`,
          refMap: {},
          backend: 'none',
        };
      }
      const els = await inspectCdpElements(meta.port, region);
      return renderCdpSnapshot(els);
    }
    if (meta.pid) {
      const els = await inspectAppElements(meta.pid);
      return renderUiaSnapshot(els);
    }
  } catch (err) {
    debugLog(`[snapshot] error: ${err.message}`);
    return { text: `_Snapshot failed: ${err.message}_`, refMap: {}, backend: 'none' };
  }
  return { text: '_No live snapshot available — app not inspectable._', refMap: {}, backend: 'none' };
}

ipcMain.handle('agent:ensure', (_event, meta) => {
  if (!meta || !meta.exe || !meta.name) {
    throw new Error('agent:ensure requires { exe, name, type }');
  }
  const normalized = { ...meta, type: meta.type || 'uia' };
  return ensureAgentFile(normalized);
});

const activeChats = new Map();
const chatAbortFlags = new Map();
const chatRefMaps = new Map();

const CDP_TOOLS = [
  { type: 'function', name: 'cdp_click', description: 'Click a DOM element by ref from the live snapshot table.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref like e12 from the snapshot table.' } }, required: ['ref'], additionalProperties: false } },
  { type: 'function', name: 'cdp_type', description: 'Focus an input/textarea/contenteditable by ref and set its text.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'], additionalProperties: false } },
  { type: 'function', name: 'cdp_get_text', description: 'Return textContent (or value) of a DOM element by ref. Use to read what is currently displayed.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
  { type: 'function', name: 'cdp_get_tree', description: 'Re-inspect the DOM and return a fresh element snapshot table with new refs. Use after the UI changes. Optional region narrows the scope and slashes snapshot size.', parameters: { type: 'object', properties: { region: { type: 'string', description: 'Optional scope to narrow the snapshot. Discord-aware keys: "servers" (left rail), "channels" (channel sidebar), "composer" (message input area), "messages" (chat scroller). Or pass any CSS selector to scope manually. Omit for full document.' } }, additionalProperties: false } },
  { type: 'function', name: 'cdp_find', description: 'Search the live DOM for elements matching a substring (case-insensitive across text/aria-label/id/role) and return a small focused snapshot with new refs (f1..fN). Much cheaper than cdp_get_tree — prefer this when you know what you are looking for (e.g. "example-channel", "Send", "Direct Messages"). Returns up to 20 matches by default, max 50.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Substring to match against element text/aria-label/id/role. Case-insensitive.' }, limit: { type: 'integer', description: 'Max matches to return (1-50, default 20).' } }, required: ['query'], additionalProperties: false } },
  { type: 'function', name: 'cdp_get_messages', description: 'Discord-aware: return { currentUser, count, messages[] } for the last N visible chat messages. currentUser is the logged-in Discord username from the bottom-left panel (use it to filter "my last upload"-style requests by author). Each message has { id, author, time, text, images, reactions, reactionTotal }. Much cheaper than cdp_get_tree for content-reading tasks.', parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Number of most-recent messages to return (1-100, default 25).' } }, additionalProperties: false } },
  { type: 'function', name: 'cdp_scroll_to_message', description: 'Discord-aware: scroll the chat viewport so a specific message is centered in view. REQUIRED whenever the user asks you to "scroll to", "show me", "take me to", "jump to", or "find" a specific message — reading the DOM via cdp_get_messages does NOT move the viewport. Pass the full message id from cdp_get_messages (looks like "chat-messages-<channel>-<message>"). Returns { ok, id, top, visible } after a synchronous scrollIntoView, with a brief outline flash on the target.', parameters: { type: 'object', properties: { message_id: { type: 'string', description: 'Full DOM id of the message li (from cdp_get_messages "id" field), e.g. "chat-messages-000000000000000000-1374...". The trailing numeric message id alone is also accepted as a fallback.' } }, required: ['message_id'], additionalProperties: false } },
  { type: 'function', name: 'cdp_scroll', description: 'Generic scroll for any app. Auto-detects the largest scrollable container (or use `container` selector) and scrolls up/down/top/bottom. **Required for any "first / earliest / oldest / original" query on a lazy-loaded conversation (ChatGPT, Slack, etc.)** — the conversation is virtualized and the DOM only contains messages near the current scroll position, so cdp_find / cdp_get_tree see a partial view. Recipe: cdp_scroll("top") repeatedly until {atTop:true, heightChanged:false}, then cdp_find / cdp_get_tree to enumerate. For "latest / newest" use cdp_scroll("bottom") first. For Discord specifically, prefer cdp_scroll_messages (it knows Discord\'s message list selector). Returns {ok, direction, scrollTopBefore, scrollTopAfter, scrollHeightBefore, scrollHeightAfter, atTop, atBottom, heightChanged, topChanged, containerTag, containerClass}.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: '"up" loads older content (most common for history dives), "down" newer, "top" jumps to the very top to force-load earliest history, "bottom" jumps to latest. Default "up".' }, pages: { type: 'integer', description: 'Viewport heights to scroll (1-50, default 3). Ignored for top/bottom.' }, container: { type: 'string', description: 'Optional CSS selector for the scroll container. Omit to auto-detect the largest visible scrollable on the page.' } }, additionalProperties: false } },
  { type: 'function', name: 'cdp_scroll_messages', description: 'Discord-aware: scroll the message list to load older/newer messages. Use this INSTEAD of asking the user to scroll. After scrolling, re-call cdp_get_messages to read the newly mounted rows. Returns { ok, direction, scrollTopBefore, scrollTopAfter, loadedMessages, loadedBefore, firstChanged, atTop, atBottom }. Loop: call cdp_scroll_messages("up", 3) → cdp_get_messages → check for target → repeat until found OR atTop is true (already at oldest message in channel).', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: '"up" loads older messages (most common), "down" newer, "top" jumps to the very top to load earliest history, "bottom" jumps to latest. Default "up".' }, pages: { type: 'integer', description: 'How many viewport heights to scroll (1-20, default 3). Larger values cover more history per call but may overshoot a target. Ignored for top/bottom.' } }, additionalProperties: false } },
  { type: 'function', name: 'cdp_paste', description: 'Focus a text editor by ref and insert text via CDP-level keyboard input (Input.insertText). REQUIRED for rich-text editors that ignore cdp_type — DraftJS, Slate, Lexical, Quill, Discord\'s channel-header search bar, ChatGPT\'s composer when it acts up. cdp_type sets `textContent` and dispatches an InputEvent, which silently does nothing on editors that own their state model; cdp_paste clicks the element via CDP Input.* events (isTrusted=true) and then uses Input.insertText, which every editor accepts. If unsure whether cdp_type will work, prefer cdp_paste. Optional `clear` first selects-all and deletes existing content before inserting.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref from the snapshot.' }, text: { type: 'string', description: 'Text to insert at the current caret position.' }, clear: { type: 'boolean', description: 'If true, select-all + delete before inserting. Default false.' } }, required: ['ref', 'text'], additionalProperties: false } },
  { type: 'function', name: 'cdp_press_key', description: 'Dispatch a single key event (keyDown + keyUp) at CDP level via Input.dispatchKeyEvent. REQUIRED to submit forms (Enter), dismiss popouts/modals (Escape), navigate autocomplete (ArrowUp/ArrowDown), tab to next field, etc. Keys recognized: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, plus any single character (a-z, 0-9, punctuation). Modifiers are passed as an array — e.g. ["ctrl"] for Ctrl+A, ["ctrl","shift"] for Ctrl+Shift+K. After cdp_paste-ing into Discord\'s search bar, call cdp_press_key("Enter") to submit the search.', parameters: { type: 'object', properties: { key: { type: 'string', description: 'Key name (Enter, Escape, Tab, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space) or a single character.' }, modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'shift', 'meta'] }, description: 'Optional modifier keys held during the press.' } }, required: ['key'], additionalProperties: false } },
  { type: 'function', name: 'cdp_get_search_results', description: 'Discord-only: scrape the channel-header Search Results panel and return structured per-row data { messageId, author, authorId, time, text, images, guildId, channelId } plus sort mode and pagination info. REQUIRED for any "find / jump to / show me" task that uses the search bar — cdp_get_tree("[aria-label=\'Search Results\']") drops the <li role="listitem"> rows from the snapshot filter, so the model never sees row ids without this tool. Pair with cdp_jump_to_search_result(messageId) to navigate to a chosen result.', parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Max rows to return (1-100, default 25).' } }, additionalProperties: false } },
  { type: 'function', name: 'cdp_set_search_sort', description: 'Discord-only: set the sort order of the open Search Results panel. REQUIRED before trusting results[0] for any "first / earliest / oldest" (use "oldest") or "latest / newest" (use "newest") request — Discord defaults to Newest-first, so without this, cdp_get_search_results.results[0] is the MOST RECENT match, not the oldest. The sort control is a dropdown button (aria-label="Sort"); cdp_find("Old") finds nothing because the options live in a popup menu. This tool opens the menu and clicks the right radio option at the CDP mouse layer, then verifies by reading the result-row timestamps. Returns { ok, requested, sortMode, order ("ascending"=oldest-first / "descending"=newest-first), firstTime, lastTime, count }. After it returns ok with the expected order, re-call cdp_get_search_results and use results[0] as the first/oldest (or newest) match.', parameters: { type: 'object', properties: { order: { type: 'string', enum: ['oldest', 'newest', 'relevant'], description: '"oldest" = oldest-first (for first/earliest queries), "newest" = newest-first (default; for latest queries), "relevant" = most relevant.' } }, required: ['order'], additionalProperties: false } },
  { type: 'function', name: 'cdp_jump_to_search_result', description: 'Discord-only: navigate to a search result message by its messageId (from cdp_get_search_results). Atomic: hovers the search-result row at CDP layer to reveal the hover-only "Jump" button, locates the button, and dispatches a real CDP click on it. Use this INSTEAD of cdp_click on a search-result row child — clicking inner divs/imgs of the row opens the image lightbox or does nothing because the Jump button is the only navigation target and it is hidden until hover. After a successful jump the channel scrolls to the message and the search panel may stay open — follow with cdp_press_key("Escape") if you want it closed before replying.', parameters: { type: 'object', properties: { message_id: { type: 'string', description: 'Message snowflake id from cdp_get_search_results.messageId (e.g. "0000000000000000000"). The full row id "search-results-<msgId>" is also accepted.' } }, required: ['message_id'], additionalProperties: false } },
];

const UIA_TOOLS = [
  { type: 'function', name: 'uia_invoke', description: 'Invoke (click / toggle / select / expand) a UIA element by ref.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
  { type: 'function', name: 'uia_set_value', description: 'Set the text value of an editable UIA element by ref. Falls back to SendKeys if ValuePattern is unavailable.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'], additionalProperties: false } },
  { type: 'function', name: 'uia_get_tree', description: 'Re-inspect the UIA tree and return a fresh element snapshot table with new refs. Use after the UI changes.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];

function toolsForBackend(backend) {
  if (backend === 'cdp') return CDP_TOOLS;
  if (backend === 'uia') return UIA_TOOLS;
  return [];
}

async function executeTool(name, args, meta, refMapHolder) {
  const refMap = refMapHolder.current;
  const lookup = (ref) => {
    const r = refMap[ref];
    if (!r) return { error: 'ref_not_found', hint: `Ref ${ref} is not in the current snapshot. Call cdp_get_tree or uia_get_tree to refresh.` };
    return r;
  };

  if (name === 'cdp_click') {
    const r = lookup(args.ref);
    if (r.error) return r;
    if (!r.selector) return { error: 'no_selector', hint: 'This ref has no CSS selector — UI may have changed.' };
    return cdpClickReal(meta.port, r.selector);
  }
  if (name === 'cdp_type') {
    const r = lookup(args.ref);
    if (r.error) return r;
    if (!r.selector) return { error: 'no_selector' };
    return cdpAction(meta.port, 'type', { selector: r.selector, text: args.text || '' });
  }
  if (name === 'cdp_get_text') {
    const r = lookup(args.ref);
    if (r.error) return r;
    if (!r.selector) return { error: 'no_selector' };
    return cdpAction(meta.port, 'getText', { selector: r.selector });
  }
  if (name === 'cdp_get_tree' || name === 'uia_get_tree') {
    const region = name === 'cdp_get_tree' ? (args && args.region) : undefined;
    if (name === 'cdp_get_tree' && typeof region === 'string') {
      const trimmed = region.trim().toLowerCase();
      if (trimmed === 'body' || trimmed === 'html' || trimmed === '*' || trimmed === 'document') {
        return {
          error: 'unsafe_region',
          hint: `cdp_get_tree("${region}") is blocked — it returns 500 rows of unrelated UI and historically leads to misclicks on user-panel buttons (User Settings, Mute, Deafen). Use a tighter region (e.g. "channels", "composer", "messages", "[aria-label='Search Results']"), or call cdp_find("<needle>") to locate a specific element.`,
        };
      }
    }
    const snap = await buildLiveSnapshot(meta, region);
    refMapHolder.current = snap.refMap;
    chatRefMaps.set(meta.exe, snap.refMap);
    return { snapshot: snap.text, refs: Object.keys(snap.refMap).length, region: region || undefined };
  }
  if (name === 'cdp_find') {
    const elements = await cdpFindElements(meta.port, args.query || '', args.limit);
    const focused = renderFocusedSnapshot(elements);
    const merged = Object.assign({}, refMapHolder.current || {}, focused.refMap);
    refMapHolder.current = merged;
    chatRefMaps.set(meta.exe, merged);
    return { query: args.query || '', count: elements.length, snapshot: focused.text };
  }
  if (name === 'cdp_get_messages') {
    const raw = await cdpEvalRaw(meta.port, buildMessagesExpr(args.limit));
    const sanitized = (raw || '').replace(new RegExp("[\\x00-\\x1F\\x7F-\\x9F]+", 'g'), ' ');
    let payload = sanitized;
    if (payload.startsWith('"') && payload.endsWith('"')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    let parsed;
    try { parsed = JSON.parse(payload); } catch (e) {
      debugLog(`[cdp_get_messages parse] ${e.message} raw=${sanitized.slice(0, 200)}`);
      return { error: 'parse_failed', count: 0, currentUser: '', messages: [] };
    }
    const messages = Array.isArray(parsed) ? parsed : (parsed && parsed.messages) || [];
    const currentUser = Array.isArray(parsed) ? '' : (parsed && parsed.currentUser) || '';
    const currentUserId = Array.isArray(parsed) ? '' : (parsed && parsed.currentUserId) || '';
    return { count: messages.length, currentUser, currentUserId, messages };
  }
  if (name === 'cdp_scroll_to_message') {
    const raw = await cdpEvalRaw(meta.port, buildScrollToMessageExpr(args.message_id));
    let payload = raw;
    if (typeof payload === 'string' && payload.startsWith('"') && payload.endsWith('"')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    try { return JSON.parse(payload); }
    catch { return { error: 'parse_failed', raw: String(raw).slice(0, 200) }; }
  }
  if (name === 'cdp_scroll') {
    const raw = await cdpEvalRaw(meta.port, buildScrollExpr(args.direction, args.pages, args.container));
    let payload = raw;
    if (typeof payload === 'string' && payload.startsWith('"') && payload.endsWith('"')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    try { return JSON.parse(payload); }
    catch { return { error: 'parse_failed', raw: String(raw).slice(0, 200) }; }
  }
  if (name === 'cdp_scroll_messages') {
    const raw = await cdpEvalRaw(meta.port, buildScrollMessagesExpr(args.direction, args.pages));
    let payload = raw;
    if (typeof payload === 'string' && payload.startsWith('"') && payload.endsWith('"')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    try { return JSON.parse(payload); }
    catch { return { error: 'parse_failed', raw: String(raw).slice(0, 200) }; }
  }
  if (name === 'cdp_paste') {
    const r = lookup(args.ref);
    if (r.error) return r;
    if (!r.selector) return { error: 'no_selector', hint: 'This ref has no CSS selector — UI may have changed.' };
    return cdpPasteReal(meta.port, r.selector, args.text || '', !!args.clear);
  }
  if (name === 'cdp_press_key') {
    const keyDef = resolveCdpKey(args.key);
    if (!keyDef) return { error: 'unknown_key', hint: `Unrecognised key "${args.key}". Use Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or a single character.` };
    const mods = resolveCdpModifiers(args.modifiers);
    return cdpPressKeyReal(meta.port, keyDef, mods);
  }
  if (name === 'cdp_get_search_results') {
    const raw = await cdpEvalRaw(meta.port, buildSearchResultsExpr(args.limit));
    const sanitized = (raw || '').replace(new RegExp("[\\x00-\\x1F\\x7F-\\x9F]+", 'g'), ' ');
    let payload = sanitized;
    if (payload.startsWith('"') && payload.endsWith('"')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    let parsed;
    try { parsed = JSON.parse(payload); } catch (e) {
      debugLog(`[cdp_get_search_results parse] ${e.message} raw=${sanitized.slice(0, 200)}`);
      return { error: 'parse_failed', count: 0, results: [] };
    }
    if (parsed && parsed.error) return parsed;
    return {
      sortMode: (parsed && parsed.sortMode) || '',
      order: (parsed && parsed.order) || 'unknown',
      firstTime: (parsed && parsed.firstTime) || '',
      lastTime: (parsed && parsed.lastTime) || '',
      totalCount: (parsed && parsed.totalCount) || '',
      pages: (parsed && parsed.pages) || [],
      count: (parsed && parsed.count) || 0,
      results: (parsed && parsed.results) || [],
    };
  }
  if (name === 'cdp_set_search_sort') {
    if (!args || !args.order) {
      return { error: 'missing_order', hint: "Pass order: 'oldest', 'newest', or 'relevant'." };
    }
    return cdpSetSearchSortReal(meta.port, args.order);
  }
  if (name === 'cdp_jump_to_search_result') {
    if (!args || !args.message_id) {
      return { error: 'missing_message_id', hint: 'Pass message_id from cdp_get_search_results.results[].messageId.' };
    }
    return cdpJumpSearchResultReal(meta.port, args.message_id);
  }
  if (name === 'uia_invoke') {
    const r = lookup(args.ref);
    if (r.error) return r;
    return uiaAction('invoke', { pid: meta.pid, automationId: r.automationId, name: r.name, controlType: r.controlType });
  }
  if (name === 'uia_set_value') {
    const r = lookup(args.ref);
    if (r.error) return r;
    return uiaAction('setValue', { pid: meta.pid, automationId: r.automationId, name: r.name, controlType: r.controlType, text: args.text || '' });
  }
  return { error: 'unknown_tool', name };
}

ipcMain.handle('chat:reset', (_event, exe) => {
  const req = activeChats.get(exe);
  if (req) {
    req.destroy();
    activeChats.delete(exe);
  }
});

ipcMain.handle('chat:stop', (_event, exe) => {
  if (!exe) return { ok: false };
  chatAbortFlags.set(exe, true);
  const req = activeChats.get(exe);
  if (req) {
    try { req.destroy(); } catch {}
    activeChats.delete(exe);
  }
  return { ok: true };
});

function sendResponsesRequest({ useDirectApi, token, accountId, body }) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const bodyBuf = Buffer.from(bodyStr, 'utf-8');
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf.length,
      'Authorization': `Bearer ${token}`,
    };
    if (!useDirectApi && accountId) headers['ChatGPT-Account-ID'] = accountId;

    const req = https.request({
      hostname: useDirectApi ? 'api.openai.com' : 'chatgpt.com',
      path: useDirectApi ? '/v1/responses' : '/backend-api/codex/responses',
      method: 'POST',
      headers,
    }, (res) => {
      try { req.setTimeout(0); } catch {}
      resolve({ req, res });
    });
    req.setTimeout(60_000, () => {
      try { req.destroy(new Error('Initial response timeout (60s) — server did not start streaming')); } catch {}
    });
    req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
    req.write(bodyBuf);
    req.end();
  });
}

async function drainResponse(res) {
  let body = '';
  try {
    for await (const chunk of res) body += chunk.toString();
  } catch {}
  return body;
}

function isTransientNetworkError(msg) {
  return /Network error|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up/i.test(String(msg || ''));
}

async function sendResponsesRequestWithRetry(opts, { retries = 3, baseDelayMs = 1000, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { req, res } = await sendResponsesRequest(opts);
      const status = res.statusCode;
      const retryableStatus = status === 502 || status === 503 || status === 504 || status === 429;
      if (retryableStatus && attempt < retries) {
        const body = await drainResponse(res);
        try { req.destroy(); } catch {}
        const delay = baseDelayMs * Math.pow(2, attempt);
        debugLog(`[retry] HTTP ${status} attempt ${attempt + 1}/${retries + 1}, waiting ${delay}ms. Body: ${body.slice(0, 200)}`);
        if (typeof onRetry === 'function') {
          try { onRetry({ status, attempt: attempt + 1, total: retries + 1, delayMs: delay }); } catch {}
        }
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { req, res };
    } catch (err) {
      lastErr = err;
      const transient = isTransientNetworkError(err.message);
      if (transient && attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        debugLog(`[retry] network err attempt ${attempt + 1}/${retries + 1}, waiting ${delay}ms: ${err.message}`);
        if (typeof onRetry === 'function') {
          try { onRetry({ status: 0, attempt: attempt + 1, total: retries + 1, delayMs: delay, err: err.message }); } catch {}
        }
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('Exhausted retries');
}

async function streamOneRound({ req, res, meta, sender, maxIdleMs, maxTotalMs, partial }) {
  return new Promise((resolve, reject) => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => reject(new Error('Session expired. Log out and log in again.')));
      return;
    }
    if (res.statusCode !== 200) {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => reject(new Error(`API error ${res.statusCode}: ${body.slice(0, 500)}`)));
      return;
    }

    let buffer = '';
    let textContent = '';
    const pendingTools = new Map();

    const HARD_IDLE_MS = maxIdleMs || 180_000;
    const HARD_TOTAL_MS = maxTotalMs || 0;
    const HEARTBEAT_MS = 5_000;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastMeaningfulAt = startedAt;
    let settled = false;

    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const meaningfulIdle = now - lastMeaningfulAt;
      const total = now - startedAt;
      if (HARD_TOTAL_MS && total >= HARD_TOTAL_MS) {
        settled = true;
        clearInterval(heartbeatTimer);
        try { req.destroy(); } catch {}
        reject(new Error(`Stream exceeded ${Math.round(HARD_TOTAL_MS/1000)}s total time — aborted.`));
        return;
      }
      if (meaningfulIdle >= HARD_IDLE_MS) {
        settled = true;
        clearInterval(heartbeatTimer);
        try { req.destroy(); } catch {}
        reject(new Error(`Stream idle ${Math.round(meaningfulIdle/1000)}s with no meaningful events — aborted. The model may be stuck reasoning over a large snapshot; try a narrower tool (cdp_get_messages) or restart the chat.`));
        return;
      }
      if (meaningfulIdle >= HEARTBEAT_MS) {
        try { sender.send('chat:thinking', { exe: meta.exe, heartbeatMs: Date.now() - startedAt, kind: 'reasoning' }); } catch {}
      }
    }, Math.min(HEARTBEAT_MS, HARD_TOTAL_MS ? Math.max(1000, Math.floor(HARD_TOTAL_MS / 4)) : HEARTBEAT_MS));
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) return;
      const payloadStr = trimmed.slice(6);
      if (payloadStr === '[DONE]') return;
      let parsed;
      try { parsed = JSON.parse(payloadStr); } catch { return; }
      lastMeaningfulAt = Date.now();

      const t = parsed.type;
      if (t === 'response.output_text.delta') {
        const delta = parsed.delta;
        if (delta) {
          textContent += delta;
          if (partial) partial.text = textContent;
          sender.send('chat:chunk', { delta, exe: meta.exe });
        }
      } else if (t === 'response.output_item.added' && parsed.item && parsed.item.type === 'function_call') {
        const it = parsed.item;
        const key = it.id || `idx_${parsed.output_index}`;
        pendingTools.set(key, {
          id: it.id,
          call_id: it.call_id,
          name: it.name,
          args: it.arguments || '',
          output_index: parsed.output_index,
        });
      } else if (t === 'response.function_call_arguments.delta') {
        const key = parsed.item_id || `idx_${parsed.output_index}`;
        const entry = pendingTools.get(key);
        if (entry) entry.args += (parsed.delta || '');
      } else if (t === 'response.function_call_arguments.done') {
        const key = parsed.item_id || `idx_${parsed.output_index}`;
        const entry = pendingTools.get(key);
        if (entry && parsed.arguments) entry.args = parsed.arguments;
      } else if (t === 'response.output_item.done' && parsed.item && parsed.item.type === 'function_call') {
        const key = parsed.item.id || `idx_${parsed.output_index}`;
        const entry = pendingTools.get(key);
        if (entry) {
          entry.id = parsed.item.id || entry.id;
          entry.call_id = parsed.item.call_id || entry.call_id;
          entry.name = parsed.item.name || entry.name;
          if (parsed.item.arguments) entry.args = parsed.item.arguments;
        }
      } else if (
        t === 'response.reasoning_summary_text.delta' ||
        t === 'response.reasoning_text.delta' ||
        t === 'response.reasoning.delta'
      ) {
        const delta = parsed.delta;
        if (delta) sender.send('chat:thinking', { exe: meta.exe, delta, kind: 'reasoning' });
      } else if (
        t === 'response.reasoning_summary_part.added' ||
        t === 'response.reasoning_summary_text.added'
      ) {
        sender.send('chat:thinking', { exe: meta.exe, reset: true, kind: 'reasoning' });
      } else if (
        t === 'response.reasoning_summary_part.done' ||
        t === 'response.reasoning_summary_text.done' ||
        t === 'response.reasoning_text.done'
      ) {
        sender.send('chat:thinking', { exe: meta.exe, sectionDone: true, kind: 'reasoning' });
      } else if (t === 'response.failed' || t === 'error') {
        if (settled) return;
        settled = true;
        clearInterval(heartbeatTimer);
        try { req.destroy(); } catch {}
        reject(new Error(`Stream error: ${JSON.stringify(parsed).slice(0, 300)}`));
      } else if (t === 'response.completed') {
        if (settled) return;
        settled = true;
        clearInterval(heartbeatTimer);
        resolve({ textContent, toolCalls: Array.from(pendingTools.values()) });
      }
    };

    res.on('data', (chunk) => {
      lastActivityAt = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) processLine(line);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      if (buffer) for (const line of buffer.split('\n')) processLine(line);
      resolve({ textContent, toolCalls: Array.from(pendingTools.values()) });
    });
    res.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      reject(new Error(`Stream connection error: ${err.message}`));
    });

    activeChats.set(meta.exe, req);
  });
}

function synthesiseDoneReply(trail) {
  const INSPECT_TOOLS = new Set(['cdp_get_tree', 'uia_get_tree', 'cdp_find']);
  let lastAction = null;
  let lastInspect = null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const step = trail[i];
    if (!step || !step.result || step.result.error) continue;
    if (INSPECT_TOOLS.has(step.name)) {
      if (!lastInspect) lastInspect = step;
      continue;
    }
    if (!lastAction) { lastAction = step; break; }
  }
  if (lastAction) {
    const name = lastAction.name;
    const r = lastAction.result;
    if (name === 'cdp_scroll_to_message' && r.ok) return 'Scrolled the message into view.';
    if (name === 'cdp_jump_to_search_result' && r.ok) return 'Jumped to the search result.';
    if (name === 'cdp_set_search_sort' && r.ok) return `Set search sort to ${r.sortMode || r.requested} (${r.order}).`;
    if (name === 'cdp_click' && r.ok) return 'Clicked. (ChatGPT did not send a closing message — the task may not be complete. Try regenerating.)';
    if (name === 'cdp_type' && r.ok) return 'Typed the text.';
    if (name === 'cdp_get_messages') return `Read ${r.count || 0} messages.`;
    if (name === 'cdp_get_text' && r.text !== undefined) return `Read text: ${String(r.text).slice(0, 200)}`;
    if (name === 'cdp_scroll_messages' && r.ok) return r.atTop ? 'Scrolled to the top of the channel history.' : 'Scrolled the message list.';
    if (name === 'cdp_scroll' && r.ok) {
      if (r.atTop) return 'Scrolled to the top of the conversation.';
      if (r.atBottom) return 'Scrolled to the bottom of the conversation.';
      return `Scrolled ${r.direction || ''}.`.trim();
    }
    if (name === 'uia_invoke' && r.ok) return 'Invoked. (ChatGPT did not send a closing message — try regenerating.)';
    if (name === 'uia_set_value' && r.ok) return 'Set value.';
  }
  if (lastInspect) {
    const name = lastInspect.name;
    const r = lastInspect.result;
    if (name === 'cdp_find') return `Found ${r.count || 0} matching element${(r.count || 0) === 1 ? '' : 's'} but ChatGPT did not continue. The task may not have completed — try rephrasing or regenerate.`;
    return 'ChatGPT inspected the UI but stopped without finishing the task. Try regenerating or rephrasing.';
  }
  return 'ChatGPT stopped without sending a reply. Try regenerating.';
}

ipcMain.handle('chat:send', async (event, payload) => {
  const { token, accountId, apiKey } = getCodexAuth();
  if (!token) throw new Error('Not logged in. Click "Login with ChatGPT" first.');
  const useDirectApi = !!apiKey;

  const meta = payload && payload.meta;
  const messages = (payload && payload.messages) || [];
  if (!meta || !meta.exe || !meta.name) {
    throw new Error('chat:send requires payload.meta with { exe, name, type, pid, port }');
  }
  const exe = meta.exe;
  chatAbortFlags.delete(exe);

  const snap = await buildLiveSnapshot(meta);
  chatRefMaps.set(exe, snap.refMap);
  const refMapHolder = { current: snap.refMap };

  const scopeGuard = `You are an assistant scoped to a single running application: **${meta.name}** (pid ${meta.pid || 'unknown'}, exe \`${meta.exe}\`). You may only reason about this app and may only act on this app via the provided tools. If the user asks about anything else, briefly explain you are scoped to ${meta.name} and refuse.`;
  const agentBody = loadAgentForPrompt(meta);
  const toolGuide = snap.backend === 'cdp'
    ? 'Tools available: cdp_click, cdp_type, cdp_paste, cdp_press_key, cdp_get_text, cdp_get_tree, cdp_find, cdp_get_messages, cdp_scroll_to_message, cdp_scroll_messages, cdp_scroll, cdp_get_search_results, cdp_jump_to_search_result. Use refs (e.g. e12 from cdp_get_tree, f1..fN from cdp_find) from the snapshot table when calling click/type/paste/get_text. Prefer cdp_find("name") for targeted lookups when you already know what you want to click (e.g. a server, channel, or button label) — it returns ~5-20 rows instead of 500. Use cdp_get_tree(region) with a Discord-aware region ("servers", "channels", "composer", "messages") or any CSS selector to narrow scope; reserve a no-arg cdp_get_tree() for cases where you truly need a full snapshot. After actions that change the DOM, call cdp_get_tree (or cdp_find) to refresh refs before continuing. For reading Discord message content (text, images, reactions) prefer cdp_get_messages — it returns structured data without a DOM snapshot. When the user asks you to scroll to / show / jump to / find a specific Discord message, you MUST call cdp_scroll_to_message after locating its id — reading the DOM does not move the viewport, and saying "done" without scrolling is a failure. For ANY app whose conversation is lazy-loaded (ChatGPT, Slack, web chats): any "first / earliest / oldest / original" or "latest / newest" query MUST start with cdp_scroll("top") or cdp_scroll("bottom") looped until {atTop:true, heightChanged:false} (or {atBottom:true, heightChanged:false}) before searching with cdp_find / cdp_get_tree — the virtualized DOM only contains messages near the current viewport. For text input: cdp_type is the fast JS path for plain inputs/textareas and the Discord message composer. For rich-text editors that ignore JS events (Discord channel-header SEARCH BAR, ChatGPT composer when it misbehaves, any DraftJS/Slate/Lexical/Quill editor), use cdp_paste — it focuses the element via real CDP mouse clicks and dispatches Input.insertText at CDP layer. Use cdp_press_key("Enter") to submit forms / searches and cdp_press_key("Escape") only to dismiss an overlay that is actively BLOCKING your next step — never as cleanup after you have surfaced the user\'s target. Escape closes the topmost layer, so it dismisses the lightbox / detail view / jumped-to result you just opened (the thing the user asked to see) instead of the harmless panel behind it. Once the target is visible, the task is done: reply, do not "tidy up". When a search-style task is feasible, USE THE APP\'S OWN SEARCH (server / channel / global search bar) instead of scrolling history — it is faster, more accurate, and the only way to reach content older than the loaded scrollback. For Discord specifically, after submitting a query in the channel-header search bar, you MUST read results via cdp_get_search_results (cdp_get_tree drops search-result rows from the snapshot because they are role="listitem") and you MUST navigate to a chosen result via cdp_jump_to_search_result(messageId) — never cdp_click on a search-result row child, the Jump button is hover-only and clicking inner divs/images opens the lightbox or does nothing, burning tool rounds. When a tool returns an error, a tool reports ok but the next snapshot shows no change, or you exhaust your normal recipe, do not silently give up — try an alternate path (a different selector, the search bar instead of scrolling, cdp_paste instead of cdp_type, etc.). If you genuinely cannot proceed, reply to the user with what you tried, what blocked you, and what you would try next — never report partial completion as success.'
    : snap.backend === 'uia'
      ? 'Tools available: uia_invoke, uia_set_value, uia_get_tree. Use refs (e.g. u47) from the snapshot table when calling them. After actions that change the UI, call uia_get_tree to refresh refs before continuing.'
      : 'No automation backend available for this app. You can only describe actions to the user in plain language.';

  const instructions = [
    scopeGuard,
    agentBody,
    `## Tool usage\n\n${toolGuide}`,
    `## Live element snapshot (${new Date().toISOString()}, backend: ${snap.backend})\n\n${snap.text}`,
  ].join('\n\n');

  try {
    fs.writeFileSync(
      path.join(AGENT_DIR, `${appKey(exe)}.snapshot.md`),
      `# ${meta.name} — last snapshot\n\nGenerated ${new Date().toISOString()} (backend: ${snap.backend})\n\n${snap.text}\n`,
      'utf8',
    );
  } catch {}

  let input = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  const tools = toolsForBackend(snap.backend);

  const MAX_ROUNDS = 40;
  let fullContent = '';
  let errorReason = null;
  let roundsUsed = 0;
  let lastRoundToolCount = 0;
  const turnTrail = [];
  const mainPartial = { text: '' };
  const forcePartial = { text: '' };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (chatAbortFlags.get(exe)) break;
      roundsUsed = round + 1;
      const body = {
        model: 'gpt-5.5',
        stream: true,
        input,
        store: false,
        reasoning: { effort: 'high' },
        instructions,
      };
      if (tools.length) body.tools = tools;

      const notifyRetry = ({ status, attempt, total, delayMs }) => {
        try {
          event.sender.send('chat:thinking', {
            exe: meta.exe,
            delta: `\n[retry ${attempt}/${total} after HTTP ${status || 'network error'} — waiting ${Math.round(delayMs / 1000)}s]`,
            kind: 'reasoning',
          });
        } catch {}
      };
      const { req, res } = await sendResponsesRequestWithRetry(
        { useDirectApi, token, accountId, body },
        { retries: 3, baseDelayMs: 1000, onRetry: notifyRetry },
      );
      mainPartial.text = '';
      const { textContent, toolCalls } = await streamOneRound({ req, res, meta, sender: event.sender, partial: mainPartial });
      fullContent += textContent;
      mainPartial.text = '';
      lastRoundToolCount = toolCalls.length;

      if (!toolCalls.length) break;

      for (const tc of toolCalls) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { parsedArgs = {}; }
        debugLog(`[tool] ${tc.name} ${JSON.stringify(parsedArgs)}`);
        event.sender.send('chat:tool', { exe, name: tc.name, args: parsedArgs });
        // Snapshot the target element BEFORE the call. cdp_get_tree / cdp_find
        // overwrite refMapHolder.current, so this is the only chance to capture
        // what the ref pointed to. Recipe generator uses this to write specific
        // cdp_find queries instead of guessing from the user prompt.
        let refInfo = null;
        if (typeof parsedArgs.ref === 'string' && refMapHolder.current) {
          const r = refMapHolder.current[parsedArgs.ref];
          if (r) {
            refInfo = {
              ref: parsedArgs.ref,
              tag: r.tag || '',
              text: (r.text || '').slice(0, 160),
              aria: (r.aria || '').slice(0, 160),
              role: r.role || '',
              id: r.id || '',
              name: r.name || '',
              automationId: r.automationId || '',
              controlType: r.controlType || '',
            };
          }
        }
        let result;
        try {
          result = await executeTool(tc.name, parsedArgs, meta, refMapHolder);
        } catch (err) {
          result = { error: String(err.message || err) };
        }
        event.sender.send('chat:tool-result', { exe, name: tc.name, result });
        turnTrail.push({ name: tc.name, args: parsedArgs, result, refInfo });
        input.push({ type: 'function_call', call_id: tc.call_id, name: tc.name, arguments: tc.args || '{}' });
        input.push({ type: 'function_call_output', call_id: tc.call_id, output: JSON.stringify(result) });
      }
    }

    if (!fullContent.trim() && turnTrail.length > 0 && !chatAbortFlags.get(exe)) {
      const lastStep = turnTrail[turnTrail.length - 1];
      const lastErrored = lastStep && lastStep.result && lastStep.result.error;
      if (!lastErrored) {
        try {
          input.push({
            role: 'user',
            content: 'Your tool calls finished. Reply right now with a single sentence to the user describing what you did or why you stopped. Do NOT call any more tools. Be brief.',
          });
          const forceBody = {
            model: 'gpt-5.5',
            stream: true,
            input,
            store: false,
            reasoning: { effort: 'low' },
            instructions,
          };
          const { req: fReq, res: fRes } = await sendResponsesRequestWithRetry(
            { useDirectApi, token, accountId, body: forceBody },
            { retries: 1, baseDelayMs: 800 },
          );
          forcePartial.text = '';
          const { textContent: forced } = await streamOneRound({ req: fReq, res: fRes, meta, sender: event.sender, maxIdleMs: 15_000, maxTotalMs: 25_000, partial: forcePartial });
          fullContent += forced;
          forcePartial.text = '';
        } catch (err) {
          if (forcePartial.text) {
            fullContent += forcePartial.text;
            debugLog(`[force-reply] ${err.message || err} (kept ${forcePartial.text.length} partial chars)`);
          } else {
            debugLog(`[force-reply] ${err.message || err}`);
          }
          forcePartial.text = '';
        }
        if (!fullContent.trim()) {
          const synth = synthesiseDoneReply(turnTrail);
          fullContent = synth;
          try { event.sender.send('chat:chunk', { delta: synth, exe }); } catch {}
        }
      }
    }

    if (!fullContent.trim()) {
      if (lastRoundToolCount > 0 && roundsUsed >= MAX_ROUNDS) {
        errorReason = `ChatGPT stopped responding after ${MAX_ROUNDS} tool rounds without sending a reply. The task may be too complex — try simplifying or breaking it up.`;
      } else if (lastRoundToolCount > 0) {
        errorReason = `ChatGPT stopped after ${roundsUsed} tool round${roundsUsed === 1 ? '' : 's'} without sending a reply.`;
      } else {
        errorReason = 'ChatGPT returned an empty response.';
      }
    }
  } catch (err) {
    errorReason = err.message || String(err);
    if (mainPartial.text) {
      fullContent += mainPartial.text;
      debugLog(`[chat:send] error: ${errorReason} (kept ${mainPartial.text.length} partial chars)`);
    } else {
      debugLog(`[chat:send] error: ${errorReason}`);
    }
  } finally {
    const aborted = chatAbortFlags.get(exe);
    chatAbortFlags.delete(exe);
    activeChats.delete(exe);
    if (aborted) errorReason = 'Stopped by user';
    event.sender.send('chat:done', { exe, error: errorReason, trail: turnTrail, content: fullContent });
  }
  return { content: fullContent, error: errorReason, trail: turnTrail };
});

// ── Automations: per-app JSON recipes generated by Codex ──

const automationProcs = new Map();

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'automation';
}

function uniqueId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function automationsAppDir(exe) {
  const dir = path.join(AUTOMATIONS_DIR, appKey(exe));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadAutomations(exe) {
  try {
    const idxPath = path.join(automationsAppDir(exe), 'index.json');
    if (!fs.existsSync(idxPath)) return [];
    const data = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    debugLog(`[loadAutomations] ${e.message}`);
    return [];
  }
}

function writeAutomationIndex(exe, list) {
  const idxPath = path.join(automationsAppDir(exe), 'index.json');
  fs.writeFileSync(idxPath, JSON.stringify(list, null, 2), 'utf8');
}

function validateRecipe(steps, backend) {
  if (!Array.isArray(steps)) return { ok: false, error: 'recipe is not an array' };
  if (steps.length === 0) return { ok: false, error: 'recipe is empty' };
  const allowed = backend === 'uia' ? AUTOMATION_TOOLS_UIA : AUTOMATION_TOOLS_CDP;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object') return { ok: false, error: `step ${i + 1} not an object` };
    if (typeof s.tool !== 'string') return { ok: false, error: `step ${i + 1} missing tool` };
    if (!allowed.has(s.tool)) return { ok: false, error: `step ${i + 1} disallowed tool: ${s.tool}` };
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
      return { ok: false, error: `step ${i + 1} args must be an object` };
    }
    if (s.capture !== undefined && typeof s.capture !== 'string') {
      return { ok: false, error: `step ${i + 1} capture must be a string` };
    }
    if (s.description !== undefined && typeof s.description !== 'string') {
      return { ok: false, error: `step ${i + 1} description must be a string` };
    }
  }
  return { ok: true };
}

function extractJsonArray(text) {
  if (!text) return null;
  let stripped = String(text).replace(/^﻿/, '').trim();
  // Strip fenced code blocks (```json ... ``` or ``` ... ```)
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) stripped = fence[1].trim();
  const start = stripped.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

// Strip C0/C1 control chars from any string heading into the recipe prompt.
// inspectCdpElements / cdp_get_messages sanitize at the source, but trail
// strings can be re-derived from rendered snapshots whose downstream rendering
// occasionally smuggles raw 0x00–0x1F / 0x7F–0x9F bytes through. Garbled
// queries like `Example User [TAG]` come from this leak — strip defensively.
function cleanCtrl(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function cleanDeep(v) {
  if (typeof v === 'string') return cleanCtrl(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = cleanDeep(val);
    return out;
  }
  return v;
}

// Heuristic: did the assistant's final reply admit failure / partial completion?
// Kept in sync with renderer.js FAILURE_REGEX — see there for the canonical list.
// Server-side guard so a recipe is never generated from a turn the user could
// not have launched via the "Save as automation" button anyway (defense in
// depth against direct IPC calls or future renderer regressions).
const APOS_SRC = "['’]";
const SERVER_FAILURE_REGEX = new RegExp(
  '\\b(' +
    'failed|error|aborted|stuck|gave up|timed out|timeout|expired|' +
    '(?:could|would|should|did|do|does|was|were|is|are|has|have|had|wo|ca)n' + APOS_SRC + '?t(?:\\s+(?:click|find|reach|open|complete|finish|submit|locate|navigate|scroll|paste|type|move|jump|load|fetch|read|work))?|' +
    'cannot|unable to|not able to|' +
    'stopped (?:without|before|early|short)|had to stop|ran out of|out of (?:rounds|time|budget)|' +
    '(?:before|until|when)\\s+(?:the\\s+)?(?:tool\\s+)?session\\s+(?:ended|expired|ran out|stopped|finished)|session\\s+(?:ended|expired)\\s+(?:before|without)|' +
    'partial(?:ly)?\\s+(?:complete|completed|completion|done|successful|success)|partial completion|not complete|never (?:loaded|opened|clicked|reached)|' +
    'may not (?:be|have|work)|try (?:again|regenerating|rephrasing)|regenerate|rephrase|not sure how|' +
    'didn' + APOS_SRC + '?t\\s+(?:work|find|reach|click|load|open|complete)|' +
    'isn' + APOS_SRC + '?t\\s+(?:working|clickable|visible|loaded|present)' +
  ')\\b',
  'i'
);
function replyAdmitsFailure(reply) {
  return SERVER_FAILURE_REGEX.test(String(reply || ''));
}

function buildCodexPrompt({ meta, backend, userMsg, finalReply, trail }) {
  const toolList = backend === 'uia'
    ? '`uia_invoke`, `uia_set_value`, `uia_get_tree`'
    : '`cdp_find`, `cdp_click`, `cdp_type`, `cdp_paste`, `cdp_press_key`, `cdp_get_text`, `cdp_get_tree`, `cdp_get_messages`, `cdp_scroll_to_message`, `cdp_scroll_messages`, `cdp_scroll`, `cdp_get_search_results`, `cdp_set_search_sort`, `cdp_jump_to_search_result`';
  const refRule = backend === 'uia'
    ? 'Refs (u1, u47, ...) expire between UIA snapshots. Insert a `uia_get_tree` step before each `uia_invoke` / `uia_set_value` that needs a fresh ref, and reference the element by `automationId` or `name` in the args.'
    : 'Refs (e12, f3, ...) expire between snapshots. Replace ref-based clicks with a `cdp_find` step that captures the lookup, then reference `$<capture-name>.fN` in later steps. Prefer `cdp_find` over `cdp_get_tree` for targeted lookups.';
  const example = backend === 'uia' ? '' : `
EXAMPLE — user asked "go to example-community then #example-channel". Successful trail had cdp_get_tree → cdp_click(e58, targetElement.text="example-community - Screenshot Community") → cdp_get_tree → cdp_click(e203, targetElement.aria="example-channel (text channel)") → cdp_get_tree → cdp_get_messages.
Correct distilled recipe (queries pulled from targetElement, NOT from the user's wording; every step has a plain-English description):
[
  {"tool":"cdp_find","args":{"query":"example-community - Screenshot Community"},"capture":"server","description":"Find the example-community server in the sidebar"},
  {"tool":"cdp_click","args":{"ref":"$server.f1"},"description":"Open the example-community server"},
  {"tool":"cdp_find","args":{"query":"example-channel (text channel)"},"capture":"channel","description":"Find the #example-channel channel"},
  {"tool":"cdp_click","args":{"ref":"$channel.f1"},"description":"Open the #example-channel channel"},
  {"tool":"cdp_get_messages","args":{"limit":25},"description":"Read the 25 most recent messages"}
]
`;
  const trailJson = JSON.stringify(trail.map(t => cleanDeep({
    name: t.name,
    args: t.args,
    targetElement: t.refInfo || undefined,
    result_summary: summariseResult(t.result),
  })), null, 2);
  const cleanUserMsg = cleanCtrl(userMsg || '');
  const cleanFinalReply = cleanCtrl(finalReply || '').slice(0, 600);
  const instructions = `You convert a successful UI-automation tool trail into a minimal deterministic JSON recipe that replays the same task.

OUTPUT REQUIREMENTS
- Output a SINGLE JSON ARRAY of steps. Nothing else. No prose, no markdown fences.
- Each step shape: { "tool": "<name>", "args": { ... }, "capture"?: "<name>", "description": "<plain English>" }.
- Allowed tools: ${toolList}.
- ${refRule}
- Drop redundant tool calls. The recipe should be the MINIMUM steps to accomplish the user's goal — skip retries, exploratory snapshots, and dead ends present in the trail.
- If the user asked to read or scroll to content, end the recipe with the relevant read/scroll step (e.g. cdp_get_messages, cdp_scroll_to_message, cdp_get_text).
- Do NOT include any \`capture\` field on tools that don't produce ref maps (clicks, types, pastes, scrolls, key presses). Only \`cdp_find\` (and rarely \`cdp_get_tree\`) should be captured.

PLAIN-ENGLISH DESCRIPTION (required on EVERY step — a non-programmer reads this)
- Every step MUST include a "description": one short sentence, in plain English, describing what the step does in terms of the app and the user's goal.
- Write it for someone who does not code. Say what happens on screen — "Open the example-community server", "Type \\"sunset\\" into the search box", "Press Enter to run the search", "Read the 25 most recent messages".
- NEVER put tool names (cdp_find, cdp_click, …), refs (e12, f3, $server.f1), selectors, or JSON in the description. Those belong only in "tool"/"args".
- Keep it to ~10 words where possible. Start with a verb.

CHOOSING cdp_find QUERIES (load-bearing — most recipe failures come from generic queries)
- For every original \`cdp_click\` / \`cdp_type\` / \`cdp_paste\` / \`cdp_get_text\` whose args contained a ref (eN/fN), the trail entry carries a \`targetElement\` object with the actual element the user successfully clicked: { tag, text, aria, role, id }.
- Build the \`cdp_find\` query from \`targetElement\`. Pick the MOST UNIQUELY IDENTIFYING attribute available, in this priority:
  1. Exact non-empty \`aria\` (full string, not a substring of it).
  2. Exact non-empty \`text\` (full string, trimmed; preserve case).
  3. \`role\` + \`name\` combo when text/aria are empty.
  4. Tag + the most distinguishing visible word in text/aria as a fallback.
- DO NOT use the user's natural-language wording ("example-community", "example-channel") as the query if a more specific attribute exists ("example-community - Screenshot Community", "example-channel (text channel)"). Generic substrings match many siblings and the wrong \`.fN\` gets clicked.
- After a \`cdp_find\` returns multiple matches, look at the corresponding step's \`result_summary.matches\` table to choose the \`.fN\` whose label matches \`targetElement\`. If the original click landed on the second row, use \`.f2\`, not \`.f1\`.

OTHER RULES
- Never embed a literal newline (\\n) or carriage return inside a \`cdp_type\` / \`cdp_paste\` \`text\` argument to submit a form. Use a separate \`cdp_press_key\` step with \`{"key":"Enter"}\` after the typing step.
- For rich-text editors (DraftJS / Slate / Lexical / contenteditable comboboxes — including Discord's channel-header search bar), use \`cdp_paste\` instead of \`cdp_type\`. \`cdp_type\` silently no-ops on these.
- If the trail submitted a search and clicked a result row, emit the full search recipe: \`cdp_find\` → \`cdp_click\` (focus) → \`cdp_paste\` (query) → \`cdp_press_key("Enter")\` → \`cdp_find\` (result row) → \`cdp_click\`. Don't collapse it into a single click.
- If the task required scrolling a lazy-loaded list to the top/bottom (any "first/earliest/oldest" or "latest/newest" query), include the \`cdp_scroll\` / \`cdp_scroll_messages\` loop step(s) — do not assume the target is in the initial DOM.

DO NOT INVENT STEPS (load-bearing — second-most common recipe failure)
- The output recipe MUST be derived from the trail. Every emitted step must correspond to a tool call that actually fired in the trail. Do NOT add navigation steps that never happened — no "click next page", "go to page N", "scroll to load more", "click Jump" etc. unless those exact tool calls appear in the trail.
- If a trail \`cdp_find\` returned \`result_summary.count: 0\`, treat that as a dead-end probe — do NOT emit it (and do NOT emit any downstream step that depended on its capture). The recipe should reflect what worked, not what the model tried and abandoned.
- If the final assistant reply admits failure or partial completion ("couldn't", "wasn't clickable", "before the session ended", "had to stop", "ran out of rounds", "partial"), the task did NOT complete. Output an empty array \`[]\` — NEVER guess the missing steps. An empty recipe surfaces "this turn isn't replayable" cleanly; a fabricated recipe wastes the user's time and corrupts their automation library.

DISCORD SEARCH RESULTS — use the dedicated tools
- Reading the panel: use \`cdp_get_search_results({"limit":25})\` — \`cdp_get_tree\` on the search-results region drops \`<li role="listitem">\` rows and never returns row ids. \`cdp_get_search_results\` is the only tool that returns \`results[].messageId\`.
- Navigating to a result: use \`cdp_jump_to_search_result({"message_id":"<snowflake>"})\` — NEVER a \`cdp_click\` on a search-result row child. The Jump button is hover-only and \`cdp_jump_to_search_result\` hovers the row at CDP layer to reveal it. If the trail attempted \`cdp_click\` on a row child (selector like \`li:nth-child(N) > div:nth-child(M)\` inside the search panel) and the next steps were also failed clicks, drop those steps and emit \`cdp_jump_to_search_result\` instead — derive the \`message_id\` from the matching \`cdp_get_search_results\` result that the trail's user-facing reply described.
- Sort is a dropdown, not text toggles. For any first/earliest/oldest request, emit \`cdp_set_search_sort({"order":"oldest"})\` (for latest/newest, \`"newest"\`) BEFORE reading results — Discord defaults to Newest-first, so \`results[0]\` is the most-recent match until sort is flipped. Then re-call \`cdp_get_search_results\` and confirm \`order\` is \`"ascending"\` (oldest) / \`"descending"\` (newest) before using \`results[0]\`. NEVER emit a \`cdp_find("Old")\` or a click on a "New"/"Old"/"Relevant" toggle — that element does not exist. The panel also has numeric pagination (\`div[aria-label="Page N"]\`); to reach a result several pages deep at the current sort, emit the \`div[aria-label="Page N"]\` click then re-call \`cdp_get_search_results\`.
- If the trail did not contain a successful \`cdp_jump_to_search_result\` (or a successful pre-tool Jump-button click) the task is incomplete. See the "Do not invent" rule — output \`[]\`.
${example}`;
  const input = `App: ${meta.name} (exe: ${meta.exe})
Backend: ${backend}
User request: ${JSON.stringify(cleanUserMsg)}
Final assistant reply: ${JSON.stringify(cleanFinalReply)}

Tool trail (in execution order):
${trailJson}

Produce the recipe now. Output the JSON ARRAY ONLY:`;
  return { instructions, input };
}

// Prompt for rewriting ONE step of an existing recipe from a plain-English
// instruction the user typed. Returns the replacement step(s) only — one edit
// may expand into several executable steps (e.g. "search for X" → focus →
// paste → Enter → find → click).
function buildStepEditPrompt({ meta, backend, steps, index, instruction }) {
  const toolList = backend === 'uia'
    ? '`uia_invoke`, `uia_set_value`, `uia_get_tree`'
    : '`cdp_find`, `cdp_click`, `cdp_type`, `cdp_paste`, `cdp_press_key`, `cdp_get_text`, `cdp_get_tree`, `cdp_get_messages`, `cdp_scroll_to_message`, `cdp_scroll_messages`, `cdp_scroll`, `cdp_get_search_results`, `cdp_set_search_sort`, `cdp_jump_to_search_result`';
  const refRule = backend === 'uia'
    ? 'Refs (u1, u47, ...) expire between UIA snapshots. Insert a `uia_get_tree` step before each `uia_invoke` / `uia_set_value` that needs a fresh ref, and reference the element by `automationId` or `name` in the args.'
    : 'Refs (e12, f3, ...) expire between snapshots. Do not emit raw eN/fN refs. To act on an element, emit a `cdp_find` step that captures the lookup, then reference `$<capture-name>.fN` in the following step. To reuse an element a previous step already captured, reference its existing `$<capture-name>.fN`.';
  const target = steps[index] || {};
  const usedCaptures = steps.map(s => s && s.capture).filter(Boolean);
  const cleanRecipe = cleanDeep(steps);
  const recipeJson = JSON.stringify(cleanRecipe, null, 2);
  const instructions = `You edit exactly ONE step of an existing UI-automation recipe, following a plain-English instruction from a non-programmer. The recipe replays a task in the app "${meta.name}".

OUTPUT
- Output a SINGLE JSON ARRAY containing ONLY the replacement step(s) for the target step. NOTHING else — no prose, no markdown fences, and do NOT re-output the other steps of the recipe.
- One instruction may need several steps. Example: "search for sunset and open the first result" → focus the search box, paste the query, press Enter, find the result, click it. Emit all of them, in order.
- Each step shape: { "tool": "<name>", "args": { ... }, "capture"?: "<name>", "description": "<plain English>" }.
- Allowed tools: ${toolList}.
- ${refRule}

DESCRIPTIONS (required on every step)
- Every step MUST include a plain-English "description" a non-programmer can read. Say what happens on screen ("Open the Settings panel"), start with a verb, ~10 words. NEVER mention tool names, refs, selectors, or JSON in the description.

KEEP THE RECIPE CONSISTENT (load-bearing)
- The full recipe is given below for context. Later steps may depend on a value the target step captured.
- The target step's capture name is: ${target.capture ? '"' + target.capture + '"' : '(none)'}. If later steps reference it (look for "$${target.capture || 'NAME'}." in the recipe), you MUST keep a step that captures under that EXACT name, or those later steps will break.
- Capture names already used in this recipe: ${usedCaptures.length ? usedCaptures.map(c => '"' + c + '"').join(', ') : '(none)'}. If you introduce a NEW capture, pick a name not in that list.
- Stay on the same backend (${backend}); only use the allowed tools above.`;
  const input = `App: ${meta.name} (exe: ${meta.exe})
Backend: ${backend}

Full current recipe (CONTEXT ONLY — do not re-output it):
${recipeJson}

Target step to replace — index ${index} (0-based):
${JSON.stringify(cleanDeep(target))}

The user wants this step to instead do:
${JSON.stringify(cleanCtrl(instruction || ''))}

Output the replacement step(s) as a JSON ARRAY only:`;
  return { instructions, input };
}

// Build a prompt that asks the model to author NEW step(s) to be inserted at a
// given position. Mirrors buildStepEditPrompt but frames the task as insertion
// rather than replacement: the existing recipe stays intact, the model only
// emits the step(s) to splice in at `index`.
function buildStepAddPrompt({ meta, backend, steps, index, instruction }) {
  const toolList = backend === 'uia'
    ? '`uia_invoke`, `uia_set_value`, `uia_get_tree`'
    : '`cdp_find`, `cdp_click`, `cdp_type`, `cdp_paste`, `cdp_press_key`, `cdp_get_text`, `cdp_get_tree`, `cdp_get_messages`, `cdp_scroll_to_message`, `cdp_scroll_messages`, `cdp_scroll`, `cdp_get_search_results`, `cdp_set_search_sort`, `cdp_jump_to_search_result`';
  const refRule = backend === 'uia'
    ? 'Refs (u1, u47, ...) expire between UIA snapshots. Insert a `uia_get_tree` step before each `uia_invoke` / `uia_set_value` that needs a fresh ref, and reference the element by `automationId` or `name` in the args.'
    : 'Refs (e12, f3, ...) expire between snapshots. Do not emit raw eN/fN refs. To act on an element, emit a `cdp_find` step that captures the lookup, then reference `$<capture-name>.fN` in the following step. To reuse an element a previous step already captured, reference its existing `$<capture-name>.fN`.';
  const usedCaptures = steps.map(s => s && s.capture).filter(Boolean);
  const cleanRecipe = cleanDeep(steps);
  const recipeJson = JSON.stringify(cleanRecipe, null, 2);
  const before = index > 0 ? steps[index - 1] : null;
  const after = index < steps.length ? steps[index] : null;
  const instructions = `You add one or more NEW steps to an existing UI-automation recipe, following a plain-English instruction from a non-programmer. The new step(s) will be inserted at position ${index} (0-based) — the recipe otherwise stays exactly as-is. The recipe replays a task in the app "${meta.name}".

OUTPUT
- Output a SINGLE JSON ARRAY containing ONLY the new step(s) to insert. NOTHING else — no prose, no markdown fences, and do NOT re-output the existing steps.
- One instruction may need several steps. Example: "search for sunset and open the first result" → focus the search box, paste the query, press Enter, find the result, click it. Emit all of them, in order.
- Each step shape: { "tool": "<name>", "args": { ... }, "capture"?: "<name>", "description": "<plain English>" }.
- Allowed tools: ${toolList}.
- ${refRule}

DESCRIPTIONS (required on every step)
- Every step MUST include a plain-English "description" a non-programmer can read. Say what happens on screen ("Open the Settings panel"), start with a verb, ~10 words. NEVER mention tool names, refs, selectors, or JSON in the description.

KEEP THE RECIPE CONSISTENT (load-bearing)
- The full recipe is given below for context. Your new step(s) run AFTER the step before the insertion point and BEFORE the step after it.
- Capture names already used in this recipe: ${usedCaptures.length ? usedCaptures.map(c => '"' + c + '"').join(', ') : '(none)'}. If your new step(s) capture something, pick a name NOT in that list. Do not collide with an existing capture name.
- Stay on the same backend (${backend}); only use the allowed tools above.`;
  const input = `App: ${meta.name} (exe: ${meta.exe})
Backend: ${backend}

Full current recipe (CONTEXT ONLY — do not re-output it):
${recipeJson}

The new step(s) will be inserted at index ${index} (0-based).
Step immediately before the insertion point: ${before ? JSON.stringify(cleanDeep(before)) : '(none — this becomes the first step)'}
Step immediately after the insertion point: ${after ? JSON.stringify(cleanDeep(after)) : '(none — this becomes the last step)'}

The user wants to add a step that does:
${JSON.stringify(cleanCtrl(instruction || ''))}

Output the new step(s) as a JSON ARRAY only:`;
  return { instructions, input };
}

function summariseResult(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.error) return { error: r.error };
  if (r.snapshot !== undefined) {
    // Keep the rendered table excerpt so the recipe generator can see what each
    // returned ref (eN / fN) actually was — label/aria/role per row. Without
    // this, the model only knows "10 matches" and has to guess which .fN was
    // the right one when emitting a cdp_click step.
    // Defensive: strip control chars before slicing. The snapshot table is
    // rebuilt from element data that *should* already be clean, but garbled
    // queries in saved recipes (`Example User [TAG]`) prove a leak exists
    // somewhere downstream. Sanitize at the sink so the Codex prompt is safe.
    const snap = String(r.snapshot || '').replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ');
    return {
      refs: r.refs,
      region: r.region,
      count: r.count,
      query: r.query,
      matches: snap.length > 1500 ? snap.slice(0, 1500) + '\n…(truncated)' : snap,
    };
  }
  if (Array.isArray(r.messages)) return { count: r.count, currentUser: r.currentUser, sample: r.messages.slice(0, 2).map(m => ({ id: m.id, author: m.author, text: (m.text || '').slice(0, 80) })) };
  if (Array.isArray(r.results)) return { sortMode: r.sortMode, totalCount: r.totalCount, pages: r.pages, count: r.count, sample: r.results.slice(0, 3).map(m => ({ messageId: m.messageId, author: m.author, time: m.time, text: (m.text || '').slice(0, 80), images: (m.images || []).length })) };
  if (r.text !== undefined) return { text: String(r.text).slice(0, 200) };
  if (r.ok !== undefined) return { ok: r.ok };
  return r;
}

function runRecipeGenerator({ instructions, input }, sender, jobId) {
  return new Promise((resolve, reject) => {
    const { token, accountId, apiKey } = getCodexAuth();
    if (!token) {
      reject(new Error('Not signed in to ChatGPT. Click "Sign in to ChatGPT" first.'));
      return;
    }
    const useDirectApi = !!apiKey;
    const body = {
      model: 'gpt-5.5',
      stream: true,
      instructions,
      input: [{ role: 'user', content: input }],
      store: false,
      reasoning: { effort: 'high' },
    };

    let req;
    let res;
    let aborted = false;
    let textOut = '';
    let errBody = '';

    const finish = (err) => {
      if (jobId) automationProcs.delete(jobId);
      if (err) return reject(err);
      resolve({ text: textOut });
    };

    sendResponsesRequest({ useDirectApi, token, accountId, body })
      .then(({ req: r, res: s }) => {
        req = r;
        res = s;
        if (jobId) {
          automationProcs.set(jobId, {
            kill: () => { aborted = true; try { req.destroy(); } catch {} },
          });
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          let body2 = '';
          res.on('data', (d) => { body2 += d.toString(); });
          res.on('end', () => finish(new Error('ChatGPT session expired. Sign out and sign in again.')));
          return;
        }
        if (res.statusCode !== 200) {
          let body2 = '';
          res.on('data', (d) => { body2 += d.toString(); });
          res.on('end', () => finish(new Error(`ChatGPT API error ${res.statusCode}: ${body2.slice(0, 400)}`)));
          return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data: ')) continue;
            const payload = t.slice(6);
            if (payload === '[DONE]') continue;
            let parsed;
            try { parsed = JSON.parse(payload); } catch { continue; }
            if (parsed.type === 'response.output_text.delta' && parsed.delta) {
              textOut += parsed.delta;
              if (sender && !sender.isDestroyed()) {
                try { sender.send('automation:codex-progress', { bytes: textOut.length, jobId }); } catch {}
              }
            } else if (parsed.type === 'response.failed' || parsed.type === 'error') {
              errBody = JSON.stringify(parsed).slice(0, 300);
            }
          }
        });
        res.on('end', () => {
          if (aborted) return finish(new Error('cancelled'));
          if (errBody) return finish(new Error(`ChatGPT stream error: ${errBody}`));
          finish(null);
        });
        res.on('error', (e) => finish(new Error(`Stream error: ${e.message}`)));
      })
      .catch((e) => finish(e));
  });
}

ipcMain.handle('automation:create', async (event, payload) => {
  const meta = payload && payload.meta;
  const userMsg = (payload && payload.userMsg) || '';
  const finalReply = (payload && payload.finalReply) || '';
  const trail = (payload && Array.isArray(payload.trail)) ? payload.trail : [];
  if (!meta || !meta.exe) throw new Error('automation:create requires meta.exe');
  if (trail.length === 0) throw new Error('No tool calls in this turn — nothing to automate.');
  if (replyAdmitsFailure(finalReply)) {
    throw new Error('This turn ended with a failure / partial-completion reply ("' + cleanCtrl(finalReply).slice(0, 120) + '"). Re-run the task in chat until it completes cleanly, then save that reply instead.');
  }
  // Also reject if the last trail step errored — recipes built on failed final
  // steps usually break the same way at replay time.
  const lastStep = trail[trail.length - 1];
  if (lastStep && lastStep.result && lastStep.result.error) {
    throw new Error('Last tool call in this turn errored (' + String(lastStep.result.error).slice(0, 160) + '). Re-run the task so it ends on a successful step before saving.');
  }

  const backend = meta.type === 'electron' && meta.port ? 'cdp' : (meta.type === 'electron' ? 'uia' : 'uia');
  const promptParts = buildCodexPrompt({ meta, backend, userMsg, finalReply, trail });
  const jobId = uniqueId();

  debugLog(`[automation:create] job=${jobId} trail=${trail.length} backend=${backend}`);
  event.sender.send('automation:codex-progress', { jobId, status: 'streaming' });

  const { text } = await runRecipeGenerator(promptParts, event.sender, jobId);
  debugLog(`[automation:create] response.len=${text.length}`);

  const jsonText = extractJsonArray(text);
  if (!jsonText) {
    debugLog(`[automation:create] no JSON array in response`);
    throw new Error(`ChatGPT output did not contain a JSON array.\n\nFirst 500 chars:\n${text.slice(0, 500)}`);
  }
  let steps;
  try { steps = JSON.parse(jsonText); }
  catch (e) { throw new Error(`Failed to parse JSON: ${e.message}\n\n${jsonText.slice(0, 400)}`); }
  const v = validateRecipe(steps, backend);
  if (!v.ok) throw new Error(`Recipe validation: ${v.error}\n\n${jsonText.slice(0, 400)}`);

  return { steps, backend, jobId };
});

ipcMain.handle('automation:cancel-create', (_event, jobId) => {
  const handle = automationProcs.get(jobId);
  if (handle && typeof handle.kill === 'function') {
    try { handle.kill(); } catch {}
    automationProcs.delete(jobId);
  }
  return { ok: true };
});

ipcMain.handle('automation:list', (_event, exe) => {
  if (!exe) return [];
  return loadAutomations(exe);
});

ipcMain.handle('automation:save', (_event, payload) => {
  const { exe, name, steps, userMsg, finalReply } = payload || {};
  if (!exe) throw new Error('automation:save requires exe');
  const v = validateRecipe(steps, 'cdp'); // permissive — backend stored on entry
  // We accept either backend; validate against both
  if (!v.ok) {
    const v2 = validateRecipe(steps, 'uia');
    if (!v2.ok) throw new Error(`Invalid recipe: ${v.error}`);
  }
  const list = loadAutomations(exe);
  const id = uniqueId();
  const slug = slugify(name || userMsg || 'automation');
  const entry = {
    id,
    name: (name || userMsg || 'Untitled').slice(0, 120),
    slug,
    createdAt: new Date().toISOString(),
    userMsg: (userMsg || '').slice(0, 600),
    finalReply: (finalReply || '').slice(0, 400),
    steps,
  };
  list.unshift(entry);
  writeAutomationIndex(exe, list);
  return entry;
});

ipcMain.handle('automation:delete', (_event, payload) => {
  const { exe, id } = payload || {};
  if (!exe || !id) throw new Error('automation:delete requires { exe, id }');
  const list = loadAutomations(exe).filter(a => a.id !== id);
  writeAutomationIndex(exe, list);
  return { ok: true };
});

ipcMain.handle('automation:rename', (_event, payload) => {
  const { exe, id, name } = payload || {};
  if (!exe || !id) throw new Error('automation:rename requires { exe, id }');
  const list = loadAutomations(exe);
  const entry = list.find(a => a.id === id);
  if (!entry) throw new Error('automation not found');
  entry.name = String(name || 'Untitled').slice(0, 120);
  writeAutomationIndex(exe, list);
  return entry;
});

// Overwrite the steps (and optionally name) of an already-saved automation —
// used when the user edits steps or JSON while viewing a saved recipe.
ipcMain.handle('automation:update', (_event, payload) => {
  const { exe, id, steps, name } = payload || {};
  if (!exe || !id) throw new Error('automation:update requires { exe, id }');
  const v = validateRecipe(steps, 'cdp');
  if (!v.ok) {
    const v2 = validateRecipe(steps, 'uia');
    if (!v2.ok) throw new Error(`Invalid recipe: ${v.error}`);
  }
  const list = loadAutomations(exe);
  const entry = list.find(a => a.id === id);
  if (!entry) throw new Error('automation not found');
  entry.steps = steps;
  if (name !== undefined) entry.name = String(name || 'Untitled').slice(0, 120);
  writeAutomationIndex(exe, list);
  return entry;
});

// Rewrite ONE step from a plain-English instruction. Returns the full new
// recipe (target step spliced out, model's replacement step(s) spliced in).
ipcMain.handle('automation:edit-step', async (event, payload) => {
  const { meta, steps, index, instruction } = payload || {};
  if (!meta || !meta.exe) throw new Error('automation:edit-step requires meta.exe');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('automation:edit-step requires a non-empty steps array');
  if (typeof index !== 'number' || index < 0 || index >= steps.length) throw new Error('automation:edit-step: index out of range');
  if (!instruction || !String(instruction).trim()) throw new Error('automation:edit-step: empty instruction');

  const backend = payload.backend || (meta.type === 'electron' && meta.port ? 'cdp' : 'uia');
  const promptParts = buildStepEditPrompt({ meta, backend, steps, index, instruction });
  const jobId = uniqueId();
  debugLog(`[automation:edit-step] job=${jobId} index=${index} backend=${backend}`);
  event.sender.send('automation:codex-progress', { jobId, status: 'rewriting step…' });

  const { text } = await runRecipeGenerator(promptParts, event.sender, jobId);
  const jsonText = extractJsonArray(text);
  if (!jsonText) {
    throw new Error(`ChatGPT output did not contain a JSON array.\n\nFirst 400 chars:\n${text.slice(0, 400)}`);
  }
  let replacement;
  try { replacement = JSON.parse(jsonText); }
  catch (e) { throw new Error(`Failed to parse JSON: ${e.message}\n\n${jsonText.slice(0, 400)}`); }
  if (!Array.isArray(replacement) || replacement.length === 0) {
    throw new Error('The edit produced no steps. Try rephrasing the instruction.');
  }
  // The replacement steps must be individually valid for the backend...
  const v = validateRecipe(replacement, backend);
  if (!v.ok) throw new Error(`Edited step is invalid: ${v.error}`);
  // ...and the resulting whole recipe must validate too.
  const newSteps = steps.slice(0, index).concat(replacement, steps.slice(index + 1));
  const v2 = validateRecipe(newSteps, backend);
  if (!v2.ok) throw new Error(`Resulting recipe is invalid: ${v2.error}`);

  return { steps: newSteps, replaced: replacement.length, backend, jobId };
});

// Author NEW step(s) from a plain-English instruction and splice them in at
// `index`. Like edit-step, but inserts instead of replacing. `index` may equal
// steps.length (append) and the steps array may be empty (first step ever).
ipcMain.handle('automation:add-step', async (event, payload) => {
  const { meta, steps, index, instruction } = payload || {};
  if (!meta || !meta.exe) throw new Error('automation:add-step requires meta.exe');
  if (!Array.isArray(steps)) throw new Error('automation:add-step requires a steps array');
  if (typeof index !== 'number' || index < 0 || index > steps.length) throw new Error('automation:add-step: index out of range');
  if (!instruction || !String(instruction).trim()) throw new Error('automation:add-step: empty instruction');

  const backend = payload.backend || (meta.type === 'electron' && meta.port ? 'cdp' : 'uia');
  const promptParts = buildStepAddPrompt({ meta, backend, steps, index, instruction });
  const jobId = uniqueId();
  debugLog(`[automation:add-step] job=${jobId} index=${index} backend=${backend}`);
  event.sender.send('automation:codex-progress', { jobId, status: 'adding step…' });

  const { text } = await runRecipeGenerator(promptParts, event.sender, jobId);
  const jsonText = extractJsonArray(text);
  if (!jsonText) {
    throw new Error(`ChatGPT output did not contain a JSON array.\n\nFirst 400 chars:\n${text.slice(0, 400)}`);
  }
  let addition;
  try { addition = JSON.parse(jsonText); }
  catch (e) { throw new Error(`Failed to parse JSON: ${e.message}\n\n${jsonText.slice(0, 400)}`); }
  if (!Array.isArray(addition) || addition.length === 0) {
    throw new Error('No step was produced. Try rephrasing the instruction.');
  }
  // The new step(s) must be individually valid for the backend...
  const v = validateRecipe(addition, backend);
  if (!v.ok) throw new Error(`New step is invalid: ${v.error}`);
  // ...and the resulting whole recipe must validate too.
  const newSteps = steps.slice(0, index).concat(addition, steps.slice(index));
  const v2 = validateRecipe(newSteps, backend);
  if (!v2.ok) throw new Error(`Resulting recipe is invalid: ${v2.error}`);

  return { steps: newSteps, added: addition.length, backend, jobId };
});

function resolveStepArgs(args, captures) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const m = v.match(/^\$([A-Za-z0-9_]+)\.([efu]\d+)$/);
      if (m) {
        const cap = captures[m[1]];
        if (!cap) throw new Error(`unknown capture: $${m[1]} (no prior step captured it)`);
        const refMap = cap.refMap || {};
        const resolved = refMap[m[2]];
        if (!resolved) {
          const refsInCap = Object.keys(refMap);
          if (refsInCap.length === 0) {
            const q = cap.query ? ` (query=${JSON.stringify(cap.query)})` : '';
            throw new Error(`capture "${m[1]}" is empty${q} — the prior cdp_find matched 0 elements, so $${m[1]}.${m[2]} cannot be resolved. The recipe likely targets UI that doesn't exist in the current app state (e.g. an invented pagination control, or a search term that doesn't match the live DOM). Re-record this automation from a fresh successful chat turn.`);
          }
          const avail = refsInCap.slice(0, 5).join(', ');
          throw new Error(`ref ${m[2]} not in capture "${m[1]}" (have: ${avail})`);
        }
        out[k] = m[2];
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}

async function executeAutomationStep(step, ctx) {
  const { meta, captures, refMapHolder } = ctx;
  const args = resolveStepArgs(step.args || {}, captures);

  // For refs that came from a $capture, we need to inject the capture's refMap into refMapHolder
  // so that executeTool's lookup() finds the selector.
  if (step.args && typeof step.args === 'object') {
    for (const v of Object.values(step.args)) {
      if (typeof v === 'string') {
        const m = v.match(/^\$([A-Za-z0-9_]+)\.([efu]\d+)$/);
        if (m && captures[m[1]] && captures[m[1]].refMap) {
          refMapHolder.current = Object.assign({}, refMapHolder.current || {}, captures[m[1]].refMap);
        }
      }
    }
  }

  const result = await executeTool(step.tool, args, meta, refMapHolder);

  if (step.capture) {
    // Find the refMap that this step produced. `cdp_find` and `cdp_get_tree`
    // mutate refMapHolder.current and chatRefMaps. The new refs are in
    // refMapHolder.current — but we want just THIS step's refs, not merged
    // history. For cdp_find we re-render from result data. For cdp_get_tree,
    // refMapHolder.current is exactly the fresh map.
    const capQuery = (step.args && typeof step.args === 'object') ? step.args.query : undefined;
    if (step.tool === 'cdp_find') {
      // Only the first `count` f-refs belong to this find — stop short to
      // avoid pulling in stale f-refs from a prior find that returned more.
      const merged = refMapHolder.current || {};
      const fOnly = {};
      const cnt = (result && result.count) || 0;
      for (let i = 1; i <= cnt; i++) {
        const k = `f${i}`;
        if (merged[k]) fOnly[k] = merged[k];
      }
      captures[step.capture] = { refMap: fOnly, count: cnt, query: capQuery };
    } else {
      captures[step.capture] = { refMap: Object.assign({}, refMapHolder.current || {}), query: capQuery };
    }
  }
  return result;
}

ipcMain.handle('automation:run', async (event, payload) => {
  const { exe, id } = payload || {};
  if (!exe || !id) throw new Error('automation:run requires { exe, id }');
  const list = loadAutomations(exe);
  const entry = list.find(a => a.id === id);
  if (!entry) throw new Error('automation not found');

  // Resolve live app metadata (port may have changed since save)
  const meta = payload.meta || null;
  if (!meta || !meta.exe) throw new Error('automation:run requires meta — open the app first');

  const refMapHolder = { current: {} };
  const captures = {};
  const ctx = { meta, captures, refMapHolder };
  const sender = event.sender;

  const runId = uniqueId();
  sender.send('automation:run-start', { runId, id, name: entry.name, total: entry.steps.length });

  let stopped = false;
  const stopHandler = (_e, payload2) => {
    if (payload2 && payload2.runId === runId) stopped = true;
  };
  ipcMain.on('automation:stop', stopHandler);

  try {
    // Build an initial snapshot so refMapHolder isn't empty for any tool that needs it
    const snap = await buildLiveSnapshot(meta);
    refMapHolder.current = snap.refMap;
    chatRefMaps.set(exe, snap.refMap);

    for (let i = 0; i < entry.steps.length; i++) {
      if (stopped) { sender.send('automation:run-step', { runId, i, name: entry.steps[i].tool, status: 'stopped' }); break; }
      const step = entry.steps[i];
      sender.send('automation:run-step', { runId, i, name: step.tool, args: step.args, status: 'start' });
      let result;
      try {
        result = await executeAutomationStep(step, ctx);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        sender.send('automation:run-step', { runId, i, name: step.tool, status: 'error', error: msg });
        sender.send('automation:run-done', { runId, ok: false, error: `Step ${i + 1} (${step.tool}): ${msg}` });
        return { ok: false, error: msg, stepIndex: i };
      }
      if (result && result.error) {
        sender.send('automation:run-step', { runId, i, name: step.tool, status: 'error', error: result.error, result });
        sender.send('automation:run-done', { runId, ok: false, error: `Step ${i + 1} (${step.tool}): ${result.error}` });
        return { ok: false, error: result.error, stepIndex: i, result };
      }
      sender.send('automation:run-step', { runId, i, name: step.tool, status: 'ok', result });
    }
    if (stopped) {
      sender.send('automation:run-done', { runId, ok: false, error: 'stopped by user' });
      return { ok: false, error: 'stopped' };
    }
    sender.send('automation:run-done', { runId, ok: true });
    return { ok: true };
  } finally {
    ipcMain.removeListener('automation:stop', stopHandler);
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
