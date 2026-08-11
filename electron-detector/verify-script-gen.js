// Verification for the plain-English / editable recipe feature.
//   node electron-detector/verify-script-gen.js
// Part 1: load main.js under an electron shim, assert the new IPC handlers
//         registered and the module loads clean.
// Part 2: run the renderer's pure translation helpers and assert the English.
// No network, no Electron, no filesystem writes.

const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? `  — ${extra}` : ''}`);
  if (!cond) failures++;
}

// ── Part 1: main.js loads + handlers register ───────────────────────────
(function loadMain() {
  const ipcHandlers = new Map();
  const electronShim = {
    app: { whenReady: () => Promise.resolve(), on: () => {}, quit: () => {}, getPath: (n) => path.join(process.cwd(), '.shim', n) },
    BrowserWindow: function () { return { loadFile: () => {}, on: () => {}, webContents: { send: () => {}, on: () => {}, openDevTools: () => {} } }; },
    ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn), on: () => {}, removeListener: () => {} },
    shell: { openExternal: () => {} },
  };
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electronShim, paths: [], children: [] };
  try {
    require('./main.js');
  } catch (e) {
    ok('main.js loads without throwing', false, e.message);
    return;
  }
  ok('main.js loads without throwing', true);
  ok('automation:edit-step handler registered', ipcHandlers.has('automation:edit-step'));
  ok('automation:update handler registered', ipcHandlers.has('automation:update'));
  ok('automation:create still registered', ipcHandlers.has('automation:create'));
})();

// ── Part 2: renderer translation helpers (pure slice, no DOM) ────────────
(function rendererHelpers() {
  const src = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const startMarker = '// ── Plain-English recipe steps (the non-coder view) ──';
  const endMarker = 'let stepEditToken = 0;';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    ok('extract renderer helper slice', false, 'markers not found');
    return;
  }
  const slice = src.slice(start, end);
  let helpers;
  try {
    helpers = new Function(`${slice}\n return { humanizeStep, stepText, validateRecipeClient, refTargetLabel, backendFor }; `)();
  } catch (e) {
    ok('renderer helper slice evals', false, e.message);
    return;
  }
  ok('renderer helper slice evals', true);
  const { stepText, humanizeStep, validateRecipeClient } = helpers;

  const recipe = [
    { tool: 'cdp_find', args: { query: 'Example Community' }, capture: 'server', description: 'Find the Example Community server in the sidebar' },
    { tool: 'cdp_click', args: { ref: '$server.f1' }, description: 'Open the Example Community server' },
    { tool: 'cdp_paste', args: { ref: '$bar.f1', text: 'sunset' } },           // no description → fallback
    { tool: 'cdp_press_key', args: { key: 'Enter' } },                          // no description → fallback
    { tool: 'cdp_get_messages', args: { limit: 25 } },                          // no description → fallback
  ];

  ok('uses model description when present', stepText(recipe[1], recipe) === 'Open the Example Community server');
  ok('cdp_find fallback names the query', humanizeStep(recipe[0], recipe) === 'Find "Example Community"');
  ok('cdp_click fallback resolves $capture to its query',
     humanizeStep({ tool: 'cdp_click', args: { ref: '$server.f1' } }, recipe) === 'Click "Example Community"');
  ok('cdp_paste fallback', stepText(recipe[2], recipe) === 'Type "sunset"');
  ok('cdp_press_key fallback', stepText(recipe[3], recipe) === 'Press Enter');
  ok('cdp_get_messages fallback', stepText(recipe[4], recipe) === 'Read the latest 25 messages');

  // validateRecipeClient
  ok('valid recipe passes client validation', validateRecipeClient(recipe, 'cdp') === null);
  ok('non-array rejected', typeof validateRecipeClient({}, 'cdp') === 'string');
  ok('empty rejected', typeof validateRecipeClient([], 'cdp') === 'string');
  ok('unknown tool rejected', typeof validateRecipeClient([{ tool: 'rm_rf', args: {} }], 'cdp') === 'string');
  ok('uia tool rejected under cdp backend', typeof validateRecipeClient([{ tool: 'uia_invoke', args: {} }], 'cdp') === 'string');
  ok('non-string description rejected', typeof validateRecipeClient([{ tool: 'cdp_press_key', args: {}, description: 5 }], 'cdp') === 'string');

  // Show the rendered recipe so a human can eyeball it
  console.log('\nRendered recipe (what a non-coder sees):');
  recipe.forEach((s, i) => console.log(`  ${i + 1}. ${stepText(s, recipe)}`));
})();

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
