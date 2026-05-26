// Headless boot smoke test: load index.html in a hidden BrowserWindow and
// report any renderer console errors / load failures, then quit.
//   npx electron smoke-boot.js
const { app, BrowserWindow } = require('electron');

const errors = [];
app.on('ready', () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: require('path').join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level 3 === error
    if (level >= 3) errors.push(`console error: ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load: ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone: ${JSON.stringify(d)}`));
  win.webContents.on('did-finish-load', () => {
    // give the renderer a tick to run its init (refreshApps etc.)
    setTimeout(() => {
      if (errors.length) { console.log('SMOKE FAIL\n' + errors.join('\n')); app.exit(1); }
      else { console.log('SMOKE OK — renderer loaded with no console errors'); app.exit(0); }
    }, 1200);
  });
  win.loadFile('index.html').catch((e) => { console.log('loadFile threw: ' + e.message); app.exit(1); });
});
setTimeout(() => { console.log('SMOKE TIMEOUT'); app.exit(2); }, 20000);
