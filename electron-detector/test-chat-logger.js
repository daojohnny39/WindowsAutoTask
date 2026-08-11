// Unit test for chat-logger.js — run: node test-chat-logger.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./chat-logger');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-test-'));
const cfgOrig = fs.existsSync(L.CONFIG_PATH) ? fs.readFileSync(L.CONFIG_PATH, 'utf8') : null;

try {
  // ── loadConfig ──
  fs.writeFileSync(L.CONFIG_PATH, JSON.stringify({ logging: { enabled: true, dir: 'logs' } }), 'utf8');
  let c = L.loadConfig();
  ok(c.logging.enabled === true, 'enabled:true honored');
  ok(c.logging.dir === 'logs', 'dir read');
  ok(c.directChat.persistHistory === false, 'direct chat persistence defaults off');

  fs.writeFileSync(L.CONFIG_PATH, JSON.stringify({ directChat: { persistHistory: true } }), 'utf8');
  c = L.loadConfig();
  ok(c.directChat.persistHistory === true, 'direct chat persistence requires explicit opt-in');

  fs.writeFileSync(L.CONFIG_PATH, JSON.stringify({ logging: { enabled: false } }), 'utf8');
  c = L.loadConfig();
  ok(c.logging.enabled === false, 'enabled:false honored');
  ok(c.logging.dir === 'logs', 'dir defaults when missing');

  fs.writeFileSync(L.CONFIG_PATH, JSON.stringify({ logging: { enabled: 'yes' } }), 'utf8');
  c = L.loadConfig();
  ok(c.logging.enabled === false, 'non-boolean enabled treated as off');

  fs.writeFileSync(L.CONFIG_PATH, 'not json{', 'utf8');
  c = L.loadConfig();
  ok(c.logging.enabled === false, 'malformed config falls back to disabled default (rewritten)');
  ok(JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8')).logging.enabled === false, 'disabled default rewritten on parse fail');

  fs.rmSync(L.CONFIG_PATH);
  c = L.loadConfig();
  ok(c.logging.enabled === false && fs.existsSync(L.CONFIG_PATH), 'missing config recreated with disabled default');

  // ── chatLogsDir ──
  ok(L.chatLogsDir({ logging: { dir: tmp } }) === tmp, 'absolute dir passes through');
  ok(path.isAbsolute(L.chatLogsDir({ logging: { dir: 'logs' } })), 'relative dir resolved to absolute');

  // ── safeFileFragment ──
  ok(L.safeFileFragment('C:\\App\\Foo.exe') === 'C-App-Foo-exe', 'sanitizes path chars');
  ok(L.safeFileFragment('') === 'app', 'empty -> app');

  // ── startChatLogSession ──
  const cfg = { logging: { enabled: true, dir: tmp } };
  const meta = { key: 'chatgpt', name: 'ChatGPT', pid: 4242, exe: 'C:\\x\\ChatGPT.exe', type: 'electron' };
  const s1 = L.startChatLogSession(meta, cfg);
  ok(s1 && fs.existsSync(s1.file), 'session file created');
  ok(s1.turnCount === 0, 'turnCount starts 0');
  ok(path.basename(s1.file).startsWith('chatgpt_'), 'filename keyed by app');
  let head = fs.readFileSync(s1.file, 'utf8');
  ok(head.includes('App:        ChatGPT') && head.includes('PID:        4242') && head.includes('C:\\x\\ChatGPT.exe'), 'header has app/pid/exe');

  const s2 = L.startChatLogSession(meta, cfg);
  ok(s2.file !== s1.file, 'second session = distinct file');

  // ── logChatTurn ──
  L.logChatTurn(s1, {
    userMsg: 'react to the last message',
    reasoning: 'I should find the message then click react.',
    reply: 'Done — reacted to the last message.',
    backend: 'cdp',
    trail: [
      { name: 'cdp_find', args: { query: 'last' }, result: { ok: true, rows: 3 } },
      { name: 'cdp_click', args: { ref: 'f2' }, result: { ok: true } },
    ],
  });
  ok(s1.turnCount === 1, 'turnCount incremented');
  let body = fs.readFileSync(s1.file, 'utf8');
  ok(body.includes('TURN 1') && body.includes('(backend: cdp)'), 'turn header + backend');
  ok(body.includes('[USER]') && body.includes('react to the last message'), 'user message logged');
  ok(body.includes('[REASONING]') && body.includes('find the message then click react'), 'reasoning logged');
  ok(body.includes('[ACTIONS] (2)'), 'action count');
  ok(body.includes('cdp_find {"query":"last"}') && body.includes('"rows":3'), 'tool args + result logged');
  ok(body.includes('[CHATGPT]') && body.includes('Done — reacted'), 'reply logged');

  // second turn appends, error path, no-text reply
  L.logChatTurn(s1, { userMsg: 'now do X', reply: '', trail: [], error: 'Stopped by user' });
  body = fs.readFileSync(s1.file, 'utf8');
  ok(s1.turnCount === 2 && body.includes('TURN 2'), 'second turn appended');
  ok(body.includes('[CHATGPT]\n(no text reply)'), 'empty reply placeholder');
  ok(body.includes('[ERROR] Stopped by user'), 'error logged');

  // long result truncation
  const big = 'x'.repeat(5000);
  L.logChatTurn(s1, { userMsg: 'big', reply: 'k', trail: [{ name: 'cdp_get_tree', args: {}, result: big }] });
  body = fs.readFileSync(s1.file, 'utf8');
  ok(body.includes('more chars)'), 'oversized result truncated');

  // null session is a no-op (does not throw)
  L.logChatTurn(null, { userMsg: 'x' });
  ok(true, 'null session no-op');

  // ── session-boundary algorithm (mirrors the chat:send block in main.js) ──
  // Proves: fresh convo -> new file, continued convo -> same file, "New chat"
  // reset -> new file, disabled -> no file.
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-bound-'));
  const bcfgOn = { logging: { enabled: true, dir: bdir } };
  const sessions = new Map();
  const exe = 'C:\\x\\ChatGPT.exe';
  const m2 = { key: 'chatgpt', name: 'ChatGPT', pid: 1, exe, type: 'electron' };

  function send(messages, cfg) {
    let sess = null;
    if (cfg.logging.enabled) {
      const prior = messages.filter(x => x.role === 'user' || x.role === 'assistant').length;
      const fresh = prior <= 1;
      sess = sessions.get(exe) || null;
      if (fresh || !sess) { sess = L.startChatLogSession(m2, cfg); sessions.set(exe, sess); }
    } else {
      sessions.delete(exe);
    }
    if (sess) L.logChatTurn(sess, { userMsg: messages[messages.length - 1].content, reply: 'ok' });
    return sess;
  }
  function reset() { sessions.delete(exe); } // chat:reset / "New chat"

  const sA = send([{ role: 'user', content: 'first' }], bcfgOn);                         // fresh -> file A
  const sB = send([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second' }], bcfgOn); // continue -> A
  ok(sA && sB && sA.file === sB.file, 'continued conversation appends to same file');
  reset();
  const sC = send([{ role: 'user', content: 'brand new' }], bcfgOn);                      // reset -> file B
  ok(sC && sC.file !== sA.file, 'reset ("New chat") opens a new file');
  const files = fs.readdirSync(bdir).filter(f => f.endsWith('.log'));
  ok(files.length === 2, `two sessions -> two files (got ${files.length})`);
  ok(fs.readFileSync(sA.file, 'utf8').includes('TURN 2'), 'first file has 2 turns');

  const sD = send([{ role: 'user', content: 'nope' }], { logging: { enabled: false, dir: bdir } }); // disabled
  ok(sD === null && fs.readdirSync(bdir).filter(f => f.endsWith('.log')).length === 2, 'disabled writes no file + clears session');
  fs.rmSync(bdir, { recursive: true, force: true });

} finally {
  if (cfgOrig !== null) fs.writeFileSync(L.CONFIG_PATH, cfgOrig, 'utf8');
  else fs.rmSync(L.CONFIG_PATH, { force: true });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
