// Verifier for the cdp_jump_to_search_result reload fix.
//
// Plants a window-scope marker on the live Discord page, runs the saved
// automation end-to-end via recipe-cli.js, then re-checks the marker. If the
// jump step had triggered a hard reload (the original `location.assign` bug),
// the marker would be wiped — survival means the fix held.
//
// Usage: node electron-detector/verify-jump-fix.js <automation-id>

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 9222;
const AUTOMATION_ID = process.argv[2];
if (!AUTOMATION_ID) { console.error('Usage: node verify-jump-fix.js <automation-id>'); process.exit(2); }

function fetchTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function pickPageWsUrl() {
  const all = await fetchTargets();
  const pages = all.filter(t => t.type === 'page');
  // Discord renderer page hosts /channels/* or /app routes — prefer those.
  const discord = pages.find(p => /discord\.com|discordapp/i.test(p.url || '')) || pages[0];
  if (!discord) throw new Error('No CDP page target');
  return { wsUrl: discord.webSocketDebuggerUrl, url: discord.url, title: discord.title };
}

function evalOnTarget(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('eval timeout')); }, 10_000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
          resolve(msg.result?.result?.value);
        }
      } catch (e) { /* keep waiting */ }
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(String(e.message || e))); });
  });
}

function runRecipe() {
  return new Promise((resolve) => {
    const cliPath = path.join(__dirname, 'recipe-cli.js');
    const child = spawn(process.execPath, [cliPath, AUTOMATION_ID], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { const s = b.toString(); out += s; process.stdout.write(s); });
    child.stderr.on('data', (b) => { const s = b.toString(); err += s; process.stderr.write(s); });
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

(async () => {
  if (typeof WebSocket === 'undefined') {
    console.error('Node WebSocket missing — need Node >= 22.4. Got', process.version);
    process.exit(1);
  }
  console.log('1) Probing CDP page target ...');
  const { wsUrl, url: urlBefore } = await pickPageWsUrl();
  console.log(`   target url: ${urlBefore}`);

  const MARKER = `autobot-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`2) Planting marker ${MARKER} on window ...`);
  await evalOnTarget(wsUrl, `(window.__autobotMarker=${JSON.stringify(MARKER)}, window.__autobotMarker)`);

  // Snapshot URL right before the run.
  const urlBeforeRun = await evalOnTarget(wsUrl, `location.href`);
  console.log(`   url at run-start: ${urlBeforeRun}`);

  console.log(`3) Running automation ${AUTOMATION_ID} ...\n`);
  const { code: cliExit } = await runRecipe();
  console.log(`\n   recipe-cli exited with code ${cliExit}`);

  // Re-acquire WS URL because CDP target list can shift if Discord opened
  // any popouts; the same renderer page should still be present.
  const { wsUrl: wsUrlAfter, url: urlAfter } = await pickPageWsUrl();

  console.log('4) Reading marker after run ...');
  const markerSeen = await evalOnTarget(wsUrlAfter, `(typeof window.__autobotMarker==='string')?window.__autobotMarker:null`);
  const urlAfterRun = await evalOnTarget(wsUrlAfter, `location.href`);
  console.log(`   url at run-end: ${urlAfterRun}`);
  console.log(`   marker seen:   ${markerSeen}`);
  console.log(`   target url:    ${urlAfter}`);

  const surviveOk = markerSeen === MARKER;
  const urlChanged = urlBeforeRun !== urlAfterRun;

  console.log('\n=== VERDICT ===');
  console.log(`recipe-cli exit:        ${cliExit} ${cliExit === 0 ? 'OK' : 'FAIL'}`);
  console.log(`url changed:            ${urlChanged ? 'yes (jump navigated)' : 'no'}`);
  console.log(`window marker survived: ${surviveOk ? 'YES — no hard reload (fix held)' : 'NO — page reloaded (regression!)'}`);

  if (cliExit !== 0 || !surviveOk) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error('UNCAUGHT:', e); process.exit(99); });
