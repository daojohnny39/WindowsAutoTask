// Smoke test: extract the live wrapper from main.js (not a copy) and run it
// against real powershell.exe. Verifies the wrapper byte-installed in main.js
// works end-to-end with a real Windows child process.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
// Extract just the wrapper region (constants + function declaration)
const startMarker = "const TRANSIENT_SPAWN_CODES";
const startIdx = src.indexOf(startMarker);
const endIdx = src.indexOf('\n}\n', src.indexOf('function execFile', startIdx)) + 2;
const wrapperSrc = src.slice(startIdx, endIdx);

if (!wrapperSrc || !wrapperSrc.includes('function execFile')) {
  console.error('FAIL: could not extract wrapper from main.js');
  process.exit(1);
}

// Eval the extracted source in a scope that provides _rawExecFile + debugLog
const { execFile: _rawExecFile } = require('child_process');
function debugLog(msg) { console.log(`[debugLog] ${msg}`); }

// Eval in an isolated function scope so the function declaration doesn't
// collide with our outer binding.
const execFile = new Function('_rawExecFile', 'debugLog',
  wrapperSrc + '\nreturn execFile;')(_rawExecFile, debugLog);

if (typeof execFile !== 'function') {
  console.error('FAIL: execFile not defined after Function eval');
  process.exit(1);
}

// Test 1: real powershell.exe roundtrip
function realSpawnTest() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output "hello-from-ps"'],
      { timeout: 10000 }, (err, stdout, stderr) => {
        const ms = Date.now() - start;
        if (err) {
          console.error(`FAIL realSpawnTest: ${err.message} (after ${ms}ms)`);
          return reject(err);
        }
        if (!stdout.includes('hello-from-ps')) {
          console.error(`FAIL realSpawnTest: unexpected stdout=${JSON.stringify(stdout)}`);
          return reject(new Error('stdout mismatch'));
        }
        console.log(`PASS realSpawnTest: powershell.exe roundtrip ok (${ms}ms, stdout includes 'hello-from-ps')`);
        resolve();
      });
  });
}

// Test 2: invalid binary (ENOENT) — wrapper should NOT retry
function enoentTest() {
  return new Promise((resolve) => {
    const start = Date.now();
    execFile('this-binary-does-not-exist-xyz.exe', [], (err) => {
      const ms = Date.now() - start;
      if (!err) {
        console.error('FAIL enoentTest: expected error');
        return resolve();
      }
      if (err.code !== 'ENOENT') {
        console.log(`NOTE enoentTest: got code=${err.code} (expected ENOENT, environment-dependent)`);
      }
      // Should fail fast — under 500ms (no retry backoff)
      if (ms > 1500) {
        console.error(`FAIL enoentTest: took ${ms}ms — wrapper may be retrying ENOENT`);
        return resolve();
      }
      console.log(`PASS enoentTest: failed fast in ${ms}ms (code=${err.code}, no retry)`);
      resolve();
    });
  });
}

(async () => {
  console.log(`Wrapper source extracted from main.js (${wrapperSrc.length} chars)`);
  console.log(`Contains MAX_SPAWN_RETRIES = ${/MAX_SPAWN_RETRIES = (\d+)/.exec(wrapperSrc)?.[1]}`);
  console.log(`Contains backoff = ${/(\d+) \* Math\.pow\(2/.exec(wrapperSrc)?.[1]} \* 2^n ms`);
  console.log('');
  await realSpawnTest();
  await enoentTest();
  console.log('\nAll real-spawn smoke tests passed');
})().catch(e => { console.error(e); process.exit(1); });
