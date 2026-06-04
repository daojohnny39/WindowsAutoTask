// Config + per-session chat transcript logging.
//
// config.json (repo root) toggles transcript logging for debugging. The caller
// reads config fresh on every chat:send so flipping `logging.enabled` takes
// effect without a restart. Each chat session gets its own file under
// logging.dir (default `logs/`); a session = one conversation (the caller
// resets it on "New chat" / fresh open). All fs work is wrapped so logging can
// never break a chat turn — failures are reported via the optional `log` fn.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
const DEFAULT_CONFIG = {
  logging: { enabled: true, dir: 'logs' },
  experimental: { allowProxyImages: false },
};

function noop() {}

// Read config.json, normalizing shape. Materializes a default file when absent
// so the user always has something to toggle.
function loadConfig(log = noop) {
  let raw = null;
  try {
    if (fs.existsSync(CONFIG_PATH)) raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    log(`[loadConfig] parse failed: ${e.message}`);
  }
  if (!raw) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8'); } catch {}
    raw = DEFAULT_CONFIG;
  }
  const logging = (raw && typeof raw.logging === 'object' && raw.logging) || {};
  const experimental = (raw && typeof raw.experimental === 'object' && raw.experimental) || {};
  return {
    logging: {
      enabled: logging.enabled === true,
      dir: (typeof logging.dir === 'string' && logging.dir.trim()) ? logging.dir.trim() : DEFAULT_CONFIG.logging.dir,
    },
    experimental: {
      allowProxyImages: experimental.allowProxyImages === true,
    },
  };
}

function chatLogsDir(cfg) {
  const d = (cfg && cfg.logging && cfg.logging.dir) || DEFAULT_CONFIG.logging.dir;
  return path.isAbsolute(d) ? d : path.join(REPO_ROOT, d);
}

function safeFileFragment(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

// Create a new session log file with a header. Returns a session handle
// ({ file, id, startedAt, turnCount }) or null if the file could not be created.
function startChatLogSession({ key, name, pid, exe, type }, cfg, log = noop) {
  let dir;
  try {
    dir = chatLogsDir(cfg);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log(`[chatlog] cannot create dir: ${e.message}`);
    return null;
  }
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${safeFileFragment(key)}_${stamp}_${id}.log`);
  const header =
    `================ CHAT SESSION LOG ================\n` +
    `App:        ${name}\n` +
    `PID:        ${pid || 'unknown'}\n` +
    `Exe:        ${exe}\n` +
    `Type:       ${type || 'unknown'}\n` +
    `Session ID: ${id}\n` +
    `Started:    ${new Date().toISOString()}\n` +
    `==================================================\n`;
  try {
    fs.writeFileSync(file, header, 'utf8');
  } catch (e) {
    log(`[chatlog] cannot write header: ${e.message}`);
    return null;
  }
  log(`[chatlog] new session ${path.basename(file)}`);
  return { file, id, startedAt: Date.now(), turnCount: 0 };
}

// Append one user→ChatGPT turn (message, reasoning, tool actions, reply, error).
function logChatTurn(session, { userMsg, reasoning, reply, trail, error, backend }, log = noop) {
  if (!session || !session.file) return;
  session.turnCount += 1;
  const ts = new Date().toISOString();
  let out = `\n───────────────── TURN ${session.turnCount} — ${ts}`;
  if (backend) out += ` (backend: ${backend})`;
  out += ` ─────────────────\n\n`;
  out += `[USER]\n${(userMsg || '(no user message)').trim()}\n\n`;
  if (reasoning && reasoning.trim()) {
    out += `[REASONING]\n${reasoning.trim()}\n\n`;
  }
  if (Array.isArray(trail) && trail.length) {
    out += `[ACTIONS] (${trail.length})\n`;
    trail.forEach((step, i) => {
      let args;
      try { args = JSON.stringify(step.args); } catch { args = String(step.args); }
      let res;
      try { res = JSON.stringify(step.result); } catch { res = String(step.result); }
      if (res && res.length > 2000) res = res.slice(0, 2000) + `…(+${res.length - 2000} more chars)`;
      out += `  ${i + 1}. ${step.name} ${args}\n     -> ${res}\n`;
    });
    out += `\n`;
  }
  out += `[CHATGPT]\n${(reply && reply.trim()) ? reply.trim() : '(no text reply)'}\n\n`;
  if (error) out += `[ERROR] ${error}\n\n`;
  try {
    fs.appendFileSync(session.file, out, 'utf8');
  } catch (e) {
    log(`[chatlog] append failed: ${e.message}`);
  }
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  chatLogsDir,
  safeFileFragment,
  startChatLogSession,
  logChatTurn,
};
