// Probe Discord search result row for Jump button structure.
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

const psScript = (jsExpr) => {
  const jsBase64 = Buffer.from(jsExpr, 'utf8').toString('base64');
  return `try { $raw = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 -UseBasicParsing).Content; $pages = @([System.Collections.ArrayList]@(($raw | ConvertFrom-Json))); $target = $null; foreach ($p in $pages) { if ($p.type -eq 'page') { $target = $p; break } }; if (-not $target) { $target = $pages[0] }; $js = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${jsBase64}')); $ws = [Net.WebSockets.ClientWebSocket]::new(); $cts = [Threading.CancellationTokenSource]::new(15000); [void]$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult(); $cmd = (@{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $js; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 5); $bytes = [Text.Encoding]::UTF8.GetBytes($cmd); $seg = [ArraySegment[byte]]::new($bytes); [void]$ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult(); $buf = New-Object byte[] 1048576; $all = ''; do { $rseg = [ArraySegment[byte]]::new($buf); $r = $ws.ReceiveAsync($rseg, $cts.Token).GetAwaiter().GetResult(); $all += [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count) } while (-not $r.EndOfMessage); $ws.Dispose(); $parsed = $all | ConvertFrom-Json; if ($parsed.result -and $parsed.result.result -and $parsed.result.result.value) { Write-Output $parsed.result.result.value } else { Write-Output '[]' } } catch { Write-Output ('ERROR:' + $_.Exception.Message) }`;
};

function evalCdp(jsExpr) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript(jsExpr)],
      { timeout: 30000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
  });
}

(async () => {
  console.log('--- search panel exists? ---');
  console.log(await evalCdp(`JSON.stringify(!!document.querySelector('section[aria-label="Search Results"]'))`));

  console.log('\n--- li[id^="search-results-"] structure ---');
  console.log(await evalCdp(`JSON.stringify(Array.from(document.querySelectorAll('li[id^="search-results-"]')).slice(0,2).map(li=>({id:li.id,buttons:Array.from(li.querySelectorAll('button')).map(b=>({aria:b.getAttribute('aria-label'),cls:(b.className||'').toString().slice(0,40),text:(b.textContent||'').slice(0,30)})),anchors:Array.from(li.querySelectorAll('a[href*="/channels/"]')).map(a=>({href:(a.getAttribute('href')||'').slice(0,80),cls:(a.className||'').toString().slice(0,40)}))})))`));

  console.log('\n--- row 0 outerHTML (first 800 chars) ---');
  console.log(await evalCdp(`(function(){var r=document.getElementById('search-results-0');return r?r.outerHTML.slice(0,800):'NOT FOUND';})()`));

  console.log('\n--- after hovering row 0, jump button visible? ---');
  console.log(await evalCdp(`(function(){var r=document.getElementById('search-results-0');if(!r)return 'no row';var btns=Array.from(r.querySelectorAll('button')).map(b=>({aria:b.getAttribute('aria-label'),cls:(b.className||'').toString().slice(0,40),rect:JSON.stringify(b.getBoundingClientRect()),visible:b.offsetWidth>0}));return JSON.stringify(btns);})()`));
})();
