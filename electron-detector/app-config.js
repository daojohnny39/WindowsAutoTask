// App configuration (config.json at repo root) — overlay + hotkey settings.
//
// Separate from chat-logger's loadConfig (which only surfaces `logging`). This
// module reads the WHOLE file, fills overlay/hotkey defaults, and writes back
// with all keys preserved (a merge), so toggling one setting never drops
// another. Used by the main process for the hotkey, tray, and overlay geometry.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');

const DEFAULTS = {
  // Global hotkey that toggles the overlay. Double-tapping it opens Automation
  // Mode. Electron accelerator syntax. Ctrl+Alt+Space is the default — plain
  // Ctrl+Space is commonly owned by the Windows IME and fails to register.
  // Rebindable in Settings; startup falls back through HOTKEY_FALLBACKS.
  hotkey: 'Control+Alt+Space',
  // When true (default), pressing Esc or clicking outside the overlay dismisses
  // it (blur-dismiss + backdrop click + Esc). When false, those paths are
  // disabled and the user must click the launcher X button (only shown in that
  // mode) or the global hotkey to close.
  allowOverlayClose: true,
  overlay: {
    width: 600,
    collapsedHeight: 90,   // launcher card only; BrowserWindow hugs the card
    dropdownMaxHeight: 280,
    chatHeight: 540,       // legacy: initial chat panel height (still consulted as fallback)
    chatWidth: 760,        // overlay width while chat panel is active (auto-clamped to display)
    chatMinHeight: 280,    // floor for top-anchored growing chat
    chatMaxHeightFrac: 0.72, // cap as fraction of work-area height
    runHeight: 560,        // height when an automation run modal is shown
    persistPosition: true,
  },
  startMinimized: true,    // start hidden in the tray (overlay summoned by hotkey)
};

function readRaw() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {}
  return {};
}

// Full config with overlay/hotkey defaults applied (non-destructive — does not write).
function load() {
  const raw = readRaw();
  const overlay = (raw && typeof raw.overlay === 'object' && raw.overlay) || {};
  return {
    ...raw,
    hotkey: (typeof raw.hotkey === 'string' && raw.hotkey.trim()) ? raw.hotkey.trim() : DEFAULTS.hotkey,
    allowOverlayClose: raw.allowOverlayClose !== false,
    overlay: { ...DEFAULTS.overlay, ...overlay },
    startMinimized: raw.startMinimized !== false,
  };
}

// Merge `patch` into config.json, preserving every existing key (e.g. logging).
function save(patch) {
  const raw = readRaw();
  const next = { ...raw, ...patch };
  if (patch && patch.overlay) next.overlay = { ...(raw.overlay || {}), ...patch.overlay };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {}
  return load();
}

module.exports = { CONFIG_PATH, DEFAULTS, load, save };
