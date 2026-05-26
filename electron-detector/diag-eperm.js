// Diagnose what's causing persistent EPERM after a few PowerShell spawns.
// Strategy: spawn powershell.exe in different patterns and report timing
// + failure pattern. Helps decide whether the wrapper needs:
//   (a) longer backoff (transient throttle)
//   (b) different invocation (cmd /c powershell ...)
//   (c) PS-from-tempfile vs -Command
//   (d) total elimination via native WS

const { execFile: _rawExecFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function tryOne(label, fn) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    try {
      fn((err, stdout) => {
        const ms = Date.now() - t0;
        if (err) {
          console.log(`  ${label}: FAIL in ${ms}ms code=${err.code} syscall=${err.syscall} msg=${(err.message||'').slice(0,80)}`);
        } else {
          console.log(`  ${label}: OK in ${ms}ms stdout=${JSON.stringify((stdout||'').slice(0,40))}`);
        }
        resolve({ ok: !err, ms, err });
      });
    } catch (syncErr) {
      const ms = Date.now() - t0;
      console.log(`  ${label}: SYNC-THROW in ${ms}ms code=${syncErr.code} syscall=${syncErr.syscall} msg=${(syncErr.message||'').slice(0,80)}`);
      resolve({ ok: false, ms, err: syncErr, sync: true });
    }
  });
}

function smallPs(cb) {
  _rawExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], { timeout: 10000 }, cb);
}

function smallCmd(cb) {
  _rawExecFile('cmd.exe', ['/c', 'echo OK'], { timeout: 10000 }, cb);
}

function bigScriptPs(cb) {
  // Mimic the size + content of cdpEvalRaw scripts (~4800 chars)
  const filler = 'X'.repeat(4500);
  const script = `Write-Output 'OK-${filler.slice(0, 20)}'; $x = '${filler}'`;
  _rawExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 }, cb);
}

function bigScriptFromFile(cb) {
  const tmp = path.join(os.tmpdir(), `diag-ps-${Date.now()}.ps1`);
  const filler = 'X'.repeat(4500);
  fs.writeFileSync(tmp, `Write-Output 'OK-file'\n$x = '${filler}'`);
  _rawExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], { timeout: 10000 }, (err, stdout) => {
    try { fs.unlinkSync(tmp); } catch {}
    cb(err, stdout);
  });
}

function cmdShellPs(cb) {
  _rawExecFile('cmd.exe', ['/c', 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK-via-cmd'],
    { timeout: 10000 }, cb);
}

(async () => {
  console.log('--- Pattern A: 10x small PowerShell -Command back-to-back ---');
  for (let i = 0; i < 10; i++) await tryOne(`A.${i+1}`, smallPs);

  console.log('\n--- Pattern B: 10x big PowerShell -Command back-to-back ---');
  for (let i = 0; i < 10; i++) await tryOne(`B.${i+1}`, bigScriptPs);

  console.log('\n--- Pattern C: 10x big PowerShell -File ---');
  for (let i = 0; i < 10; i++) await tryOne(`C.${i+1}`, bigScriptFromFile);

  console.log('\n--- Pattern D: 10x cmd.exe → powershell.exe ---');
  for (let i = 0; i < 10; i++) await tryOne(`D.${i+1}`, cmdShellPs);

  console.log('\n--- Pattern E: 10x cmd.exe echo (control — should never EPERM) ---');
  for (let i = 0; i < 10; i++) await tryOne(`E.${i+1}`, smallCmd);
})();
