// Persisted history for the direct GPT-5.5 chat (no app context).
//
// Single global thread stored at logs/direct-gpt.json. Schema:
//   { messages: [{ role:'user'|'assistant', content:string, ts:number }], updated:number }
//
// Append-only during a chat turn (write after the turn completes, never mid-stream).
// Atomic write via temp + rename. Corrupt JSON falls back to empty in-memory state and
// rewrites the file on the next save. Trail / reasoning / tool details from the live
// turn are dropped on disk — only the plain conversation text persists so a future
// /resume can re-feed the model.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(REPO_ROOT, 'logs');
const STORE_PATH = path.join(STORE_DIR, 'direct-gpt.json');

function ensureDir() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch {}
}

function readStore(debugLog) {
  try {
    if (!fs.existsSync(STORE_PATH)) return { messages: [], updated: 0 };
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed && parsed.messages) ? parsed.messages : [];
    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content, ts: Number(m.ts) || 0 }));
    return { messages: clean, updated: Number(parsed && parsed.updated) || 0 };
  } catch (err) {
    try { if (typeof debugLog === 'function') debugLog(`[direct-chat-store] read failed: ${err.message} — starting empty`); } catch {}
    return { messages: [], updated: 0 };
  }
}

function writeStoreAtomic(state, debugLog) {
  try {
    ensureDir();
    const tmp = STORE_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_PATH);
    return true;
  } catch (err) {
    try { if (typeof debugLog === 'function') debugLog(`[direct-chat-store] write failed: ${err.message}`); } catch {}
    return false;
  }
}

function load(debugLog) {
  return readStore(debugLog);
}

function appendTurn({ userContent, assistantContent }, debugLog) {
  const state = readStore(debugLog);
  const now = Date.now();
  if (typeof userContent === 'string' && userContent.length) {
    state.messages.push({ role: 'user', content: userContent, ts: now });
  }
  if (typeof assistantContent === 'string' && assistantContent.length) {
    state.messages.push({ role: 'assistant', content: assistantContent, ts: now });
  }
  state.updated = now;
  writeStoreAtomic(state, debugLog);
  return state;
}

function reset(debugLog) {
  try {
    ensureDir();
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  } catch (err) {
    try { if (typeof debugLog === 'function') debugLog(`[direct-chat-store] reset failed: ${err.message}`); } catch {}
  }
  return { messages: [], updated: 0 };
}

module.exports = { load, appendTurn, reset, STORE_PATH };
