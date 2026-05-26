// Verify execFile retry wrapper handles transient spawn EPERM correctly.
// Run: node electron-detector/test-spawn-retry.js
//
// Strategy: load main.js's wrapper definition by replicating it here with the
// same shape, but stub `_rawExecFile` to control failure injection. The actual
// wrapper in main.js is the source-of-truth; this test mirrors it 1:1.

const assert = require('assert');

// ---- Test harness for the wrapper ---------------------------------------

function makeWrapper(fakeRawExecFile) {
  const TRANSIENT_SPAWN_CODES = new Set(['EPERM', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY']);
  const MAX_SPAWN_RETRIES = 4;
  function execFile(cmd, args, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    let attempt = 0;
    const tryOnce = () => {
      return fakeRawExecFile(cmd, args, opts || {}, (err, stdout, stderr) => {
        if (err && err.syscall === 'spawn' && TRANSIENT_SPAWN_CODES.has(err.code) && attempt < MAX_SPAWN_RETRIES) {
          attempt++;
          const delay = 80 * Math.pow(2, attempt - 1);
          setTimeout(tryOnce, delay);
          return;
        }
        if (cb) cb(err, stdout, stderr);
      });
    };
    return tryOnce();
  }
  return execFile;
}

function spawnErr(code) {
  const e = new Error(`spawn ${code}`);
  e.code = code;
  e.errno = -4048;
  e.syscall = 'spawn';
  return e;
}

// ---- Test 1: EPERM 2x then success --------------------------------------
async function test1() {
  let calls = 0;
  const fake = (cmd, args, opts, cb) => {
    calls++;
    if (calls <= 2) {
      setImmediate(() => cb(spawnErr('EPERM'), '', ''));
    } else {
      setImmediate(() => cb(null, 'ok-stdout', ''));
    }
    return {};
  };
  const execFile = makeWrapper(fake);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-x'], {}, (err, stdout) => {
      try {
        assert.strictEqual(err, null, 'should succeed after retries');
        assert.strictEqual(stdout, 'ok-stdout');
        assert.strictEqual(calls, 3, `expected 3 spawn attempts, got ${calls}`);
        console.log(`PASS test1: EPERM x2 → success on 3rd attempt (calls=${calls})`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Test 2: EPERM exhausts all retries (5 failures) --------------------
async function test2() {
  let calls = 0;
  const fake = (cmd, args, opts, cb) => {
    calls++;
    setImmediate(() => cb(spawnErr('EPERM'), '', ''));
    return {};
  };
  const execFile = makeWrapper(fake);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-x'], {}, (err, stdout, stderr) => {
      try {
        assert.ok(err, 'should fail after exhaustion');
        assert.strictEqual(err.code, 'EPERM');
        assert.strictEqual(calls, 5, `expected 5 attempts (1 + 4 retries), got ${calls}`);
        console.log(`PASS test2: EPERM persistent → fails after ${calls} attempts`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Test 3: ENOENT (not transient) — no retry --------------------------
async function test3() {
  let calls = 0;
  const fake = (cmd, args, opts, cb) => {
    calls++;
    const e = spawnErr('ENOENT');
    setImmediate(() => cb(e, '', ''));
    return {};
  };
  const execFile = makeWrapper(fake);
  return new Promise((resolve, reject) => {
    execFile('missing.exe', [], {}, (err) => {
      try {
        assert.ok(err, 'should fail');
        assert.strictEqual(err.code, 'ENOENT');
        assert.strictEqual(calls, 1, `ENOENT should NOT retry, got ${calls} calls`);
        console.log(`PASS test3: ENOENT → no retry (calls=${calls})`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Test 4: process-stage error (non-zero exit) — no retry -------------
async function test4() {
  let calls = 0;
  const fake = (cmd, args, opts, cb) => {
    calls++;
    // Process started but exited 1; no syscall:'spawn'.
    const e = new Error('Command failed: powershell.exe');
    e.code = 1;
    setImmediate(() => cb(e, 'partial-stdout', 'stderr'));
    return {};
  };
  const execFile = makeWrapper(fake);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [], {}, (err, stdout, stderr) => {
      try {
        assert.ok(err);
        assert.strictEqual(stdout, 'partial-stdout');
        assert.strictEqual(stderr, 'stderr');
        assert.strictEqual(calls, 1, `process-stage failure should NOT retry, got ${calls}`);
        console.log(`PASS test4: non-zero exit → no retry, stdout/stderr preserved (calls=${calls})`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Test 5: 3-arg signature (options omitted) --------------------------
async function test5() {
  let calls = 0;
  const fake = (cmd, args, opts, cb) => {
    calls++;
    if (calls === 1) {
      setImmediate(() => cb(spawnErr('EBUSY'), '', ''));
    } else {
      setImmediate(() => cb(null, 'ok', ''));
    }
    return {};
  };
  const execFile = makeWrapper(fake);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-x'], (err, stdout) => {
      try {
        assert.strictEqual(err, null);
        assert.strictEqual(stdout, 'ok');
        assert.strictEqual(calls, 2);
        console.log(`PASS test5: 3-arg signature (opts omitted) → wrapper still retries`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Test 6: success first try — no retry overhead ----------------------
async function test6() {
  let calls = 0;
  const fake = (cmd, args, opts, cb) => {
    calls++;
    setImmediate(() => cb(null, 'fast-stdout', ''));
    return {};
  };
  const execFile = makeWrapper(fake);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [], {}, (err, stdout) => {
      try {
        assert.strictEqual(err, null);
        assert.strictEqual(stdout, 'fast-stdout');
        assert.strictEqual(calls, 1, `happy path should fire exactly once, got ${calls}`);
        console.log(`PASS test6: happy path → exactly 1 spawn (calls=${calls})`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Test 7: backoff timing (>= 80+160+320 = 560ms before 4th try) ------
async function test7() {
  let calls = 0;
  const timestamps = [];
  const fake = (cmd, args, opts, cb) => {
    calls++;
    timestamps.push(Date.now());
    if (calls < 4) {
      setImmediate(() => cb(spawnErr('EPERM'), '', ''));
    } else {
      setImmediate(() => cb(null, 'ok', ''));
    }
    return {};
  };
  const execFile = makeWrapper(fake);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [], {}, (err) => {
      try {
        assert.strictEqual(err, null);
        assert.strictEqual(calls, 4);
        const totalMs = Date.now() - t0;
        // Expected delays before 2nd, 3rd, 4th attempts: 80, 160, 320 ms = 560 ms minimum
        assert.ok(totalMs >= 540, `expected >=540ms backoff, got ${totalMs}ms`);
        assert.ok(totalMs < 1500, `expected <1500ms (no runaway), got ${totalMs}ms`);
        console.log(`PASS test7: exponential backoff total=${totalMs}ms (>=560 expected)`);
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

// ---- Run ----------------------------------------------------------------
(async () => {
  const tests = [test1, test2, test3, test4, test5, test6, test7];
  let passed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (e) {
      console.error(`FAIL ${t.name}: ${e.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
