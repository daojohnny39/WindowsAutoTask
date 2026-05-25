const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'cdp-state.json');
const PS_SCRIPT_PATH = path.join(__dirname, '..', 'Start-ElectronDebug.ps1');
const TASK_NAME = 'ElectronCDP-Persistent';
const AGENT_DIR = path.join(__dirname, '..', 'app-agents');
const AGENT_USER_HEADING = '## User notes';
const SNAPSHOT_ELEMENT_CAP = 500;

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

function buildMessagesExpr(limit) {
  const lim = Math.max(1, Math.min(100, Number(limit) || 25));
  return `(function(LIMIT){function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ').trim();}var msgs=Array.from(document.querySelectorAll('li[id^="chat-messages-"]'));if(msgs.length===0){msgs=Array.from(document.querySelectorAll('[id^="chat-messages-"]'));}if(LIMIT>0)msgs=msgs.slice(-LIMIT);var out=msgs.map(function(li){var id=li.id||'';var authorEl=li.querySelector('[class*="username"]');var contentEl=li.querySelector('[id^="message-content-"]');var timeEl=li.querySelector('time[datetime]');var images=[];Array.from(li.querySelectorAll('img[src]')).forEach(function(img){var src=img.getAttribute('src')||'';if(src.indexOf('cdn.discordapp.com')===-1&&src.indexOf('media.discordapp.net')===-1)return;if(src.indexOf('/emojis/')!==-1)return;if(src.indexOf('/avatars/')!==-1)return;images.push(src.split('?')[0]);});Array.from(li.querySelectorAll('a[href*="cdn.discordapp.com/attachments"], a[href*="media.discordapp.net"]')).forEach(function(a){var h=a.getAttribute('href')||'';if(h)images.push(h.split('?')[0]);});var seen={};images=images.filter(function(u){if(seen[u])return false;seen[u]=true;return true;});var reactions=[];Array.from(li.querySelectorAll('[class*="reaction_"], [class*="reactionMe_"], [class*="reactionDefault_"]')).forEach(function(r){if(r.getAttribute('role')!=='button'&&!r.querySelector('img'))return;var emojiEl=r.querySelector('img[alt],img[aria-label]');var emoji=emojiEl?(emojiEl.getAttribute('alt')||emojiEl.getAttribute('aria-label')||''):'';var countEl=r.querySelector('[class*="reactionCount"]');var ctxt=clean(countEl?countEl.textContent:r.textContent);var n=parseInt(ctxt.replace(/[^0-9]/g,''),10);var lbl=clean(r.getAttribute('aria-label')||'');reactions.push({emoji:clean(emoji),count:isNaN(n)?0:n,label:lbl});});var rTotal=reactions.reduce(function(s,r){return s+(r.count||0);},0);return{id:id,author:clean(authorEl?authorEl.textContent:''),time:timeEl?timeEl.getAttribute('datetime'):'',text:clean(contentEl?contentEl.textContent:'').slice(0,800),images:images.slice(0,10),reactions:reactions,reactionTotal:rTotal};});return JSON.stringify(out);})(${lim})`;
}

const CDP_JS_EXPR = `(function(){function clean(s){return (s||'').replace(/[\\u0000-\\u001F\\u007F-\\u009F]+/g,' ');}function sel(el){if(el.id){var s='#'+CSS.escape(el.id);try{if(document.querySelectorAll(s).length===1)return s;}catch(e){}}var t=el.getAttribute('data-testid');if(t){var ts='[data-testid="'+t.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ts).length===1)return ts;}catch(e){}}var dli=el.getAttribute('data-list-item-id');if(dli){var ds='[data-list-item-id="'+dli.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(ds).length===1)return ds;}catch(e){}}var href=el.tagName==='A'?el.getAttribute('href'):null;if(href){var hs='a[href="'+href.replace(/"/g,'\\\\"')+'"]';try{if(document.querySelectorAll(hs).length===1)return hs;}catch(e){}}var al=el.getAttribute('aria-label');if(al){var ae=al.replace(/\\\\/g,'\\\\\\\\').replace(/"/g,'\\\\"');var ai=el.tagName.toLowerCase()+'[aria-label="'+ae+'"]';try{if(document.querySelectorAll(ai).length===1)return ai;}catch(e){}}var cur=el,parts=[];for(var i=0;cur&&cur.nodeType===1&&cur!==document.body&&i<30;i++){var p=cur.tagName.toLowerCase();if(cur.parentNode){var idx=Array.prototype.indexOf.call(cur.parentNode.children,cur)+1;if(idx>0)p+=':nth-child('+idx+')';}parts.unshift(p);try{if(document.querySelectorAll(parts.join(' > ')).length===1)return parts.join(' > ');}catch(e){}cur=cur.parentNode;}return parts.join(' > ');}var nodes=Array.from(document.querySelectorAll('button,input,select,textarea,a,[role],[aria-label],[contenteditable]'));nodes=nodes.filter(function(el){var r=el.getAttribute('role');return r!=='log'&&r!=='listitem'&&r!=='article';});return JSON.stringify(nodes.slice(0,500).map(function(el){var cn=typeof el.className==='string'?el.className:'';return{Tag:el.tagName,Text:clean(el.textContent).trim().slice(0,100),Id:clean(el.id),Class:clean(cn).split(' ').filter(Boolean).slice(0,3).join(' '),Role:clean(el.getAttribute('role')),AriaLabel:clean(el.getAttribute('aria-label')),Selector:sel(el)}}));})()`;

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
  const coordsJs = `(function(){var sel=${JSON.stringify(selector)};var el=document.querySelector(sel);if(!el)return JSON.stringify({error:'element_not_found'});var svgLike={svg:1,path:1,g:1,circle:1,rect:1,polygon:1,line:1,use:1,polyline:1};var target=el;var hops=0;while(target&&target!==document.body&&hops<8){var tg=(target.tagName||'').toLowerCase();var r=target.getAttribute&&target.getAttribute('role');if(tg==='button'||tg==='a'||tg==='input'||tg==='label')break;if(r&&/^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|option|checkbox|radio|switch)$/.test(r))break;if(target.onclick)break;if(svgLike[tg]||(target.getAttribute&&target.getAttribute('aria-hidden')==='true')){target=target.parentElement;hops++;continue;}break;}if(!target)target=el;try{target.scrollIntoView({block:'center',inline:'center'});}catch(e){}var rect=target.getBoundingClientRect();if(rect.width===0&&rect.height===0)return JSON.stringify({error:'zero_size'});return JSON.stringify({x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2),tag:target.tagName,walked:target!==el});})()`;
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

function cdpClickReal(port, selector) {
  return new Promise((resolve, reject) => {
    const script = buildCdpClickScript(port, selector);
    debugLog(`[cdpClickReal] port=${port} sel=${selector.slice(0, 100)}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) { debugLog(`[cdpClickReal err] ${err.message}`); return reject(err); }
      const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      try { resolve(JSON.parse(line || '{"error":"no_output"}')); }
      catch { resolve({ error: 'parse_failed', raw: stdout.slice(0, 200) }); }
    });
  });
}

function cdpEvalRaw(port, jsExpr) {
  return new Promise((resolve, reject) => {
    const script = buildCdpExprScript(port, jsExpr);
    debugLog(`[cdpEval] port=${port} scriptLen=${script.length}`);
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) { debugLog(`[cdpEval err] ${err.message}`); return reject(err); }
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const jsonLine = lines.find(l => l.startsWith('[') || l.startsWith('{') || l.startsWith('"'));
      resolve(jsonLine || '[]');
    });
  });
}

function inspectCdpElements(port) {
  return cdpEvalRaw(port, CDP_JS_EXPR).then((raw) => {
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

function buildCdpActionExpr(action, args) {
  const a = JSON.stringify(args);
  if (action === 'click') {
    return `(function(){var a=${a};try{var el=document.querySelector(a.selector);if(!el)return JSON.stringify({error:'element_not_found'});var svgLike={svg:1,path:1,g:1,circle:1,rect:1,polygon:1,line:1,use:1,polyline:1};var target=el;var hops=0;while(target&&target!==document.body&&hops<8){var tg=(target.tagName||'').toLowerCase();var r=target.getAttribute&&target.getAttribute('role');if(tg==='button'||tg==='a'||tg==='input'||tg==='label')break;if(r&&/^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem|option|checkbox|radio|switch)$/.test(r))break;if(target.onclick)break;if(svgLike[tg]||(target.getAttribute&&target.getAttribute('aria-hidden')==='true')){target=target.parentElement;hops++;continue;}break;}if(!target)target=el;try{target.scrollIntoView({block:'center',inline:'center'});}catch(e){}var rect=target.getBoundingClientRect();var cx=rect.left+rect.width/2;var cy=rect.top+rect.height/2;var init={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,screenX:cx,screenY:cy,button:0,buttons:1};var attempts=[];function fire(type,Ctor){try{var Ev=window[Ctor]||MouseEvent;target.dispatchEvent(new Ev(type,init));attempts.push(type);}catch(e){try{target.dispatchEvent(new MouseEvent(type,init));attempts.push(type+'(fb)');}catch(e2){}}}fire('pointerover','PointerEvent');fire('pointerenter','PointerEvent');fire('mouseover','MouseEvent');fire('mouseenter','MouseEvent');fire('pointerdown','PointerEvent');fire('mousedown','MouseEvent');try{if(target.focus)target.focus();}catch(e){}fire('pointerup','PointerEvent');fire('mouseup','MouseEvent');fire('click','MouseEvent');if(typeof target.click==='function'){try{target.click();attempts.push('native');}catch(e){}}return JSON.stringify({ok:true,target_tag:target.tagName,walked:target!==el,attempts:attempts});}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()`;
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
3. \`cdp_get_tree()\` again — the URL has changed and the channel sidebar
   is now populated. **You must refresh — refs from step 1 are stale.**
4. **Find the channel \`<a>\`.** Filter rows where:
   - \`tag = a\` AND
   - \`aria-label\` (case-insensitive) contains the channel name the
     user gave (strip leading \`#\` from the user input, accept an
     \`"unread, "\` prefix and a \`"(text channel)"\` suffix in the
     aria-label). Pick the \`<a>\` ref. Call \`cdp_click(<that ref>)\`.
5. \`cdp_get_tree()\` once more to confirm the composer's aria-label now
   references this channel. Done.
6. To send a message: locate the composer ref (\`role = textbox\`,
   aria-label starts with \`"Message "\`), call \`cdp_type(<ref>, "<text>")\`,
   then click the Send Message button.

### Reading message content (do NOT use cdp_get_tree)

For tasks like "find the last post with 21+ reactions", "summarise today's
messages", "show the image with the most reactions", **"show me the last
picture/image/file I uploaded"**, "what did <user> last say" — **call
\`cdp_get_messages(limit)\`**.

If the user asks for *their own* last upload, filter the result by
\`author\` matching the logged-in user (visible in the bottom-left of the
client) and take the most recent entry whose \`images\` array is non-empty;
return the first URL from that array. Do **not** call \`cdp_get_tree\` for
this — the tree is 80KB+ and will stall the chat for minutes while
\`cdp_get_messages\` returns the same info in ~3KB.
It returns an array of \`{ id, author, time, text, images, reactions, reactionTotal }\`
for the last N visible messages — no DOM snapshot, no refs, no token bloat.

- Scroll up first if you need older messages (click into the channel and the
  list auto-loads; \`cdp_get_messages\` reads what's currently in the DOM).
- Each \`reactions[i]\` has \`{ emoji, count, label }\`. \`reactionTotal\` is the
  sum across all emoji on that message — use it as a quick filter.
- For unique-reactor counts you would have to open the reaction tooltip
  (\`count\` is per-emoji, so a message with 21 thumbs-up = 21 reactions but
  could be fewer unique people if anyone else added other emoji). Treat
  \`reactionTotal\` as a strong upper bound for "popular post".
- For images, the \`images\` array already contains direct CDN URLs.

**Only use \`cdp_get_tree()\` when you need to click or type something.**
A 25-message \`cdp_get_messages\` reply is ~2-5KB; a full tree is 80KB+.

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
output, it is above the loaded window. Either ask the user to scroll up
manually first, or click into the channel header / a pinned message to
re-anchor — \`cdp_get_messages\` cannot fetch what is not in the DOM.

**Never** declare a "scroll to" task complete after only calling
\`cdp_get_messages\`. Finding the message in the JSON proves it exists
in the DOM; it does not prove the viewport moved. The user is looking
at the Discord window — they will see a static channel and a wrong
"done" reply.

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
- **cdp_type(ref, text)** — focus an input/textarea/contenteditable and set text.
- **cdp_get_text(ref)** — read \`textContent\` of an element.
- **cdp_get_tree()** — refresh the snapshot and get new refs after the DOM changes.
- **cdp_get_messages(limit?)** — Discord only: return the last N messages with author, text, image URLs and reaction emoji+counts. Use this instead of \`cdp_get_tree\` when the task is to read message content, find a post by reactions, count something across messages, etc. Much cheaper than a full DOM snapshot.
- **cdp_scroll_to_message(message_id)** — Discord only: scroll the chat viewport so a specific message is centered. Pass the \`id\` from \`cdp_get_messages\`. **Required** whenever the user says "scroll to", "show me", "jump to", "take me to", or "find" a specific message — \`cdp_get_messages\` only reads the DOM, it does not move the scroll position.
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
    refMap[ref] = { selector: el.Selector || '', tag: el.Tag, text: el.Text };
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

async function buildLiveSnapshot(meta) {
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
      const els = await inspectCdpElements(meta.port);
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
const chatRefMaps = new Map();

const CDP_TOOLS = [
  { type: 'function', name: 'cdp_click', description: 'Click a DOM element by ref from the live snapshot table.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref like e12 from the snapshot table.' } }, required: ['ref'], additionalProperties: false } },
  { type: 'function', name: 'cdp_type', description: 'Focus an input/textarea/contenteditable by ref and set its text.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'], additionalProperties: false } },
  { type: 'function', name: 'cdp_get_text', description: 'Return textContent (or value) of a DOM element by ref. Use to read what is currently displayed.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
  { type: 'function', name: 'cdp_get_tree', description: 'Re-inspect the DOM and return a fresh element snapshot table with new refs. Use after the UI changes.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'cdp_get_messages', description: 'Discord-aware: return the last N visible chat messages with author, text, image URLs, and reaction emoji+counts. Much cheaper than cdp_get_tree for content-reading tasks.', parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Number of most-recent messages to return (1-100, default 25).' } }, additionalProperties: false } },
  { type: 'function', name: 'cdp_scroll_to_message', description: 'Discord-aware: scroll the chat viewport so a specific message is centered in view. REQUIRED whenever the user asks you to "scroll to", "show me", "take me to", "jump to", or "find" a specific message — reading the DOM via cdp_get_messages does NOT move the viewport. Pass the full message id from cdp_get_messages (looks like "chat-messages-<channel>-<message>"). Returns { ok, id, top, visible } after a synchronous scrollIntoView, with a brief outline flash on the target.', parameters: { type: 'object', properties: { message_id: { type: 'string', description: 'Full DOM id of the message li (from cdp_get_messages "id" field), e.g. "chat-messages-000000000000000000-1374...". The trailing numeric message id alone is also accepted as a fallback.' } }, required: ['message_id'], additionalProperties: false } },
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
    const snap = await buildLiveSnapshot(meta);
    refMapHolder.current = snap.refMap;
    chatRefMaps.set(meta.exe, snap.refMap);
    return { snapshot: snap.text, refs: Object.keys(snap.refMap).length };
  }
  if (name === 'cdp_get_messages') {
    const raw = await cdpEvalRaw(meta.port, buildMessagesExpr(args.limit));
    const sanitized = (raw || '').replace(new RegExp("[\\x00-\\x1F\\x7F-\\x9F]+", 'g'), ' ');
    let payload = sanitized;
    if (payload.startsWith('"') && payload.endsWith('"')) {
      try { payload = JSON.parse(payload); } catch {}
    }
    let messages = [];
    try { messages = JSON.parse(payload); } catch (e) {
      debugLog(`[cdp_get_messages parse] ${e.message} raw=${sanitized.slice(0, 200)}`);
      return { error: 'parse_failed', count: 0, messages: [] };
    }
    return { count: messages.length, messages };
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
    }, (res) => resolve({ req, res }));
    req.on('error', (err) => reject(new Error(`Network error: ${err.message}`)));
    req.write(bodyBuf);
    req.end();
  });
}

async function streamOneRound({ req, res, meta, sender }) {
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

    const HARD_IDLE_MS = 240_000;
    const HEARTBEAT_MS = 10_000;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let settled = false;

    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      const idle = Date.now() - lastActivityAt;
      if (idle >= HARD_IDLE_MS) {
        settled = true;
        clearInterval(heartbeatTimer);
        try { req.destroy(); } catch {}
        reject(new Error(`Stream idle ${Math.round(idle/1000)}s with no events — aborted. The model may be stuck reasoning over a large snapshot; try a narrower tool (cdp_get_messages) or restart the chat.`));
        return;
      }
      if (idle >= HEARTBEAT_MS) {
        try { sender.send('chat:thinking', { exe: meta.exe, heartbeatMs: Date.now() - startedAt, kind: 'reasoning' }); } catch {}
      }
    }, HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) return;
      const payloadStr = trimmed.slice(6);
      if (payloadStr === '[DONE]') return;
      let parsed;
      try { parsed = JSON.parse(payloadStr); } catch { return; }

      const t = parsed.type;
      if (t === 'response.output_text.delta') {
        const delta = parsed.delta;
        if (delta) {
          textContent += delta;
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

  const snap = await buildLiveSnapshot(meta);
  chatRefMaps.set(exe, snap.refMap);
  const refMapHolder = { current: snap.refMap };

  const scopeGuard = `You are an assistant scoped to a single running application: **${meta.name}** (pid ${meta.pid || 'unknown'}, exe \`${meta.exe}\`). You may only reason about this app and may only act on this app via the provided tools. If the user asks about anything else, briefly explain you are scoped to ${meta.name} and refuse.`;
  const agentBody = loadAgentForPrompt(meta);
  const toolGuide = snap.backend === 'cdp'
    ? 'Tools available: cdp_click, cdp_type, cdp_get_text, cdp_get_tree, cdp_get_messages, cdp_scroll_to_message. Use refs (e.g. e12) from the snapshot table when calling click/type/get_text. After actions that change the DOM, call cdp_get_tree to refresh refs before continuing. For reading Discord message content (text, images, reactions) prefer cdp_get_messages — it returns structured data without the 500-row DOM snapshot. When the user asks you to scroll to / show / jump to / find a specific message, you MUST call cdp_scroll_to_message after locating its id — reading the DOM does not move the viewport, and saying "done" without scrolling is a failure.'
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

  const MAX_ROUNDS = 16;
  let fullContent = '';
  let errorReason = null;
  let roundsUsed = 0;
  let lastRoundToolCount = 0;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
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

      const { req, res } = await sendResponsesRequest({ useDirectApi, token, accountId, body });
      const { textContent, toolCalls } = await streamOneRound({ req, res, meta, sender: event.sender });
      fullContent += textContent;
      lastRoundToolCount = toolCalls.length;

      if (!toolCalls.length) break;

      for (const tc of toolCalls) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(tc.args || '{}'); } catch { parsedArgs = {}; }
        debugLog(`[tool] ${tc.name} ${JSON.stringify(parsedArgs)}`);
        event.sender.send('chat:tool', { exe, name: tc.name, args: parsedArgs });
        let result;
        try {
          result = await executeTool(tc.name, parsedArgs, meta, refMapHolder);
        } catch (err) {
          result = { error: String(err.message || err) };
        }
        event.sender.send('chat:tool-result', { exe, name: tc.name, result });
        input.push({ type: 'function_call', call_id: tc.call_id, name: tc.name, arguments: tc.args || '{}' });
        input.push({ type: 'function_call_output', call_id: tc.call_id, output: JSON.stringify(result) });
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
    debugLog(`[chat:send] error: ${errorReason}`);
  } finally {
    activeChats.delete(exe);
    event.sender.send('chat:done', { exe, error: errorReason });
  }
  return { content: fullContent, error: errorReason };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
