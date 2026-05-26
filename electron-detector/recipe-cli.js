// CLI driver: load main.js with a shimmed `electron` module, capture its
// IPC handler registrations, and invoke `automation:run` directly.
// Verifies the actual 15-step recipe runs end-to-end through the EPERM-
// fixed execFile wrapper.
//
// Usage: node electron-detector/recipe-cli.js <automation-id>
//
// Requires Discord to be running with CDP debug port (from cdp-state.json).

const Module = require('module');
const path = require('path');
const fs = require('fs');

// ---- Capture IPC handler registrations ----------------------------------
const ipcHandlers = new Map();
const ipcOnHandlers = new Map();
const ipcStopListeners = [];

const eventBus = new (require('events').EventEmitter)();

// ---- Shim the `electron` module ----------------------------------------
const electronShim = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => process.exit(0),
    getPath: (n) => path.join(process.cwd(), '.shim', n),
  },
  BrowserWindow: function BrowserWindow() {
    return {
      loadFile: () => {},
      on: () => {},
      webContents: {
        send: () => {},
        on: () => {},
        openDevTools: () => {},
      },
    };
  },
  ipcMain: {
    handle: (ch, fn) => { ipcHandlers.set(ch, fn); },
    on: (ch, fn) => {
      if (!ipcOnHandlers.has(ch)) ipcOnHandlers.set(ch, new Set());
      ipcOnHandlers.get(ch).add(fn);
    },
    removeListener: (ch, fn) => {
      if (ipcOnHandlers.has(ch)) ipcOnHandlers.get(ch).delete(fn);
    },
  },
  shell: { openExternal: () => {} },
};

// Inject the shim into the require cache so `require('electron')` returns it
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: electronShim, paths: [], children: [],
};

// ---- Load main.js (registers IPC handlers via shimmed ipcMain) ----------
console.log('Loading main.js with shimmed electron...');
try {
  require('./main.js');
} catch (e) {
  console.error(`FAIL: main.js threw during load: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
console.log(`Captured ${ipcHandlers.size} IPC handlers: ${[...ipcHandlers.keys()].join(', ')}`);

// ---- Invoke automation:run with synthetic event sender ------------------
const automationId = process.argv[2];
if (!automationId) {
  console.error('Usage: node recipe-cli.js <automation-id>');
  process.exit(2);
}

const cdpState = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdp-state.json'), 'utf8'));
const discordApp = cdpState.apps.find(a => /Discord/i.test(a.name)) || cdpState.apps[0];
if (!discordApp) { console.error('No app in cdp-state.json'); process.exit(3); }

const meta = {
  exe: discordApp.exe,
  port: discordApp.port,
  pid: null,
  backend: 'cdp',
  name: discordApp.name,
};

const events = [];
const fakeSender = {
  send: (channel, payload) => {
    events.push({ channel, payload, t: Date.now() });
    if (channel === 'automation:run-step') {
      const { i, name, status, error, result } = payload;
      const arrow = status === 'ok' ? '✓' : status === 'error' ? '✕' : '…';
      let detail = '';
      if (result) {
        if (result.count !== undefined) detail = `${result.count} refs`;
        else if (result.ok) detail = 'ok';
        else if (result.refs !== undefined) detail = `${result.refs} refs`;
      }
      if (error) detail = `ERROR: ${error}`;
      console.log(`  [step ${i + 1}] ${arrow} ${name} ${detail}`);
    } else if (channel === 'automation:run-start') {
      console.log(`  Starting "${payload.name}" (${payload.total} steps)`);
    } else if (channel === 'automation:run-done') {
      console.log(`  Done: ${JSON.stringify(payload)}`);
    }
  },
};

(async () => {
  const handler = ipcHandlers.get('automation:run');
  if (!handler) { console.error('automation:run handler not registered'); process.exit(4); }

  console.log(`\nInvoking automation:run id=${automationId} against ${meta.name} on port ${meta.port}\n`);

  const fakeEvent = { sender: fakeSender };
  try {
    const result = await handler(fakeEvent, { exe: meta.exe, id: automationId, meta });
    console.log(`\n=== Final result: ${JSON.stringify(result)} ===`);

    // Count execFile retries logged during this run
    const dbgPath = path.join(__dirname, '..', 'cdp-debug.log');
    if (fs.existsSync(dbgPath)) {
      const log = fs.readFileSync(dbgPath, 'utf8');
      const lines = log.split('\n');
      // Look at last 1000 lines for retry events
      const recent = lines.slice(-1000).filter(l => l.includes('execFile retry'));
      if (recent.length > 0) {
        console.log(`\nexecFile retry events fired during this run: ${recent.length}`);
        recent.slice(-10).forEach(l => console.log('  ' + l));
      } else {
        console.log('\nNo execFile retry events fired (no EPERM in this run).');
      }
    }

    // Verify no step reported `spawn EPERM` reaching the caller
    const epermEvents = events.filter(e => e.channel === 'automation:run-step' && e.payload.error && /spawn EPERM/.test(e.payload.error));
    if (epermEvents.length > 0) {
      console.error(`\nFAIL: ${epermEvents.length} step(s) surfaced spawn EPERM (wrapper failed):`);
      epermEvents.forEach(e => console.error(`  step ${e.payload.i + 1}: ${e.payload.error}`));
      process.exit(5);
    }
    console.log('\nVerification: no `spawn EPERM` reached the caller. Wrapper held.');
    process.exit(result.ok ? 0 : 6);
  } catch (e) {
    console.error(`\nUNCAUGHT in handler: ${e.message}`);
    console.error(e.stack);
    process.exit(7);
  }
})();
