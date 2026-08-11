// Probe live Discord to see what selector hits the channel-header search bar.
const fs = require('fs');
const path = require('path');
const { execFile: _rawExecFile } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const startMarker = 'const TRANSIENT_SPAWN_CODES';
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf('\n}\n', src.indexOf('function execFile', startIdx)) + 2;
const wrapperSrc = src.slice(startIdx, endIdx);
function debugLog() {}
const execFile = new Function('_rawExecFile', 'debugLog',
  wrapperSrc + '\nreturn execFile;')(_rawExecFile, debugLog);

function buildPsScript(port, jsExpr) {
  const jsBase64 = Buffer.from(jsExpr, 'utf8').toString('base64');
  return `try { $raw = (Invoke-WebRequest -Uri "http://127.0.0.1:${port}/json" -TimeoutSec 5 -UseBasicParsing).Content; $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json))); $target = $null; foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }; if (-not $target) { $target = $pages[0] }; $js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${jsBase64}')); $ws = [Net.WebSockets.ClientWebSocket]::new(); $cts = [Threading.CancellationTokenSource]::new(15000); [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult(); $cmd = (@{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $js; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 5); $bytes = [Text.Encoding]::UTF8.GetBytes($cmd); $seg = [ArraySegment[byte]]::new($bytes); [void]$ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult(); $buf = New-Object byte[] 1048576; $all = ''; do { $rseg = [ArraySegment[byte]]::new($buf); $r = $ws.ReceiveAsync($rseg, $cts.Token).GetAwaiter().GetResult(); $all += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count) } while (-not $r.EndOfMessage); $ws.Dispose(); $parsed = $all | ConvertFrom-Json; if ($parsed.result -and $parsed.result.result -and $parsed.result.result.value) { Write-Output $parsed.result.result.value } else { Write-Output '[]' } } catch { Write-Output ('ERROR:' + $_.Exception.Message) }`;
}

function evalCdp(jsExpr) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', buildPsScript(9222, jsExpr)],
      { timeout: 30000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
  });
}

(async () => {
  console.log('--- URL ---');
  console.log(await evalCdp('JSON.stringify({url: location.href, title: document.title})'));

  console.log('\n--- [class*="searchBar_"] count ---');
  console.log(await evalCdp(`JSON.stringify(Array.from(document.querySelectorAll('[class*="searchBar_"]')).map(e=>({tag:e.tagName,cls:e.className.slice(0,80),text:(e.textContent||'').slice(0,80)})))`));

  console.log('\n--- "Search " textContent finds ---');
  console.log(await evalCdp(`JSON.stringify(Array.from(document.querySelectorAll('*')).filter(e=>e.children.length<3 && (e.textContent||'').startsWith('Search ')).slice(0,5).map(e=>({tag:e.tagName,cls:(e.className||'').toString().slice(0,80),text:(e.textContent||'').slice(0,80)})))`));

  console.log('\n--- channel header (header containing channel name) ---');
  console.log(await evalCdp(`JSON.stringify(Array.from(document.querySelectorAll('section[aria-label*="channel"]')).slice(0,3).map(e=>({tag:e.tagName,aria:e.getAttribute('aria-label'),cls:(e.className||'').toString().slice(0,80)})))`));

  console.log('\n--- search combobox / input candidates ---');
  console.log(await evalCdp(`JSON.stringify(Array.from(document.querySelectorAll('[role="combobox"],[aria-label="Search"],[contenteditable]')).slice(0,10).map(e=>({tag:e.tagName,role:e.getAttribute('role'),aria:e.getAttribute('aria-label'),ce:e.isContentEditable,cls:(e.className||'').toString().slice(0,60)})))`));
})();
