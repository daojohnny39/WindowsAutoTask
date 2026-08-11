const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./direct-chat-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobot-direct-store-'));
const file = path.join(dir, 'direct-gpt.json');

try {
  const disabled = { storePath: file };
  const enabled = { enabled: true, storePath: file };

  assert.deepStrictEqual(store.load(null, disabled), { messages: [], updated: 0 });
  assert.deepStrictEqual(
    store.appendTurn({ userContent: 'private input', assistantContent: 'private reply' }, null, disabled),
    { messages: [], updated: 0 },
  );
  assert.strictEqual(fs.existsSync(file), false);

  const first = store.appendTurn({ userContent: 'hello', assistantContent: 'hi' }, null, enabled);
  assert.strictEqual(first.messages.length, 2);
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(store.load(null, enabled).messages[1].content, 'hi');
  assert.deepStrictEqual(store.load(null, disabled), { messages: [], updated: 0 });

  store.reset(null, enabled);
  assert.strictEqual(fs.existsSync(file), false);
  console.log('8 passed, 0 failed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
