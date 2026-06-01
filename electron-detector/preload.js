const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  detectApps: () => ipcRenderer.invoke('detect-apps'),
  enableCdpApp: (exe) => ipcRenderer.invoke('enable-cdp-app', exe),
  disableCdpApp: (exe) => ipcRenderer.invoke('disable-cdp-app', exe),
  checkCdpAlive: (port) => ipcRenderer.invoke('check-cdp-alive', port),
  getCdpState: () => ipcRenderer.invoke('get-cdp-state'),
  detectUiaApps: () => ipcRenderer.invoke('detect-uia-apps'),
  inspectElements: (pid, port) => ipcRenderer.invoke('inspect-elements', pid, port),
});

contextBridge.exposeInMainWorld('codex', {
  status: () => ipcRenderer.invoke('codex:status'),
  login: () => ipcRenderer.invoke('codex:login'),
  logout: () => ipcRenderer.invoke('codex:logout'),
  cancelLogin: () => ipcRenderer.invoke('codex:cancel-login'),
  onDeviceCode: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('codex:device-code', handler);
    return () => ipcRenderer.removeListener('codex:device-code', handler);
  },
});

contextBridge.exposeInMainWorld('agent', {
  ensure: (meta) => ipcRenderer.invoke('agent:ensure', meta),
});

contextBridge.exposeInMainWorld('chat', {
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  sendDirect: (payload) => ipcRenderer.invoke('chat:send-direct', payload),
  loadDirect: () => ipcRenderer.invoke('chat:load-direct'),
  resetDirect: () => ipcRenderer.invoke('chat:reset-direct'),
  reset: (exe) => ipcRenderer.invoke('chat:reset', exe),
  stop: (exe) => ipcRenderer.invoke('chat:stop', exe),
  answer: (payload) => ipcRenderer.invoke('chat:answer', payload),
  listWindows: (port) => ipcRenderer.invoke('chat:list-windows', port),
  selectWindow: (payload) => ipcRenderer.invoke('chat:select-window', payload),
  listTabs: (port) => ipcRenderer.invoke('chat:list-tabs', port),
  pickFile: () => ipcRenderer.invoke('chat:pick-file'),
  onChunk: (callback) => {
    ipcRenderer.on('chat:chunk', (_e, data) => callback(data));
  },
  onDone: (callback) => {
    ipcRenderer.on('chat:done', (_e, data) => callback(data));
  },
  onTool: (callback) => {
    ipcRenderer.on('chat:tool', (_e, data) => callback(data));
  },
  onToolResult: (callback) => {
    ipcRenderer.on('chat:tool-result', (_e, data) => callback(data));
  },
  onThinking: (callback) => {
    ipcRenderer.on('chat:thinking', (_e, data) => callback(data));
  },
  onAsk: (callback) => {
    ipcRenderer.on('chat:ask', (_e, data) => callback(data));
  },
  onCitation: (callback) => {
    ipcRenderer.on('chat:citation', (_e, data) => callback(data));
  },
  removeListeners: () => {
    ipcRenderer.removeAllListeners('chat:chunk');
    ipcRenderer.removeAllListeners('chat:done');
    ipcRenderer.removeAllListeners('chat:tool');
    ipcRenderer.removeAllListeners('chat:tool-result');
    ipcRenderer.removeAllListeners('chat:thinking');
    ipcRenderer.removeAllListeners('chat:ask');
    ipcRenderer.removeAllListeners('chat:citation');
  },
});

contextBridge.exposeInMainWorld('shell', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});

contextBridge.exposeInMainWorld('overlay', {
  resize: (width, height, opts) => ipcRenderer.send('overlay:resize', { width, height, center: opts && opts.center, anchor: opts && opts.anchor, instant: !!(opts && opts.instant) }),
  // Drag the frameless overlay from the renderer: report the desired top-left;
  // main applies horizontal-center snap + on-screen clamp.
  moveTo: (x, y) => ipcRenderer.send('overlay:move-to', { x, y }),
  getPosition: () => ipcRenderer.invoke('overlay:get-position'),
  maxHeight: () => ipcRenderer.invoke('overlay:max-height'),
  // Suppress blur-dismiss while a footer drag is in progress.
  setDragging: (active) => ipcRenderer.send('overlay:set-dragging', { active: !!active }),
  dismiss: () => ipcRenderer.invoke('overlay:dismiss'),
  // Renderer acks the close animation finished → main hides the BrowserWindow.
  finishHide: () => ipcRenderer.send('overlay:hide-finished'),
  setResetProgress: (progress) => ipcRenderer.send('tray:reset-progress', progress),
  openSettings: (section) => ipcRenderer.invoke('overlay:open-settings', section),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setHotkey: (accel) => ipcRenderer.invoke('config:set-hotkey', accel),
  suspendHotkey: () => ipcRenderer.invoke('config:suspend-hotkey'),
  resumeHotkey: () => ipcRenderer.invoke('config:resume-hotkey'),
  setOverlayConfig: (patch) => ipcRenderer.invoke('config:set-overlay', patch),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  onShow: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('overlay:show', handler);
    return () => ipcRenderer.removeListener('overlay:show', handler);
  },
  onHide: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('overlay:hide', handler);
    return () => ipcRenderer.removeListener('overlay:hide', handler);
  },
  onSettingsFocusSection: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('settings:focus-section', handler);
    return () => ipcRenderer.removeListener('settings:focus-section', handler);
  },
});

contextBridge.exposeInMainWorld('automation', {
  create: (payload) => ipcRenderer.invoke('automation:create', payload),
  cancelCreate: (jobId) => ipcRenderer.invoke('automation:cancel-create', jobId),
  list: (exe) => ipcRenderer.invoke('automation:list', exe),
  save: (payload) => ipcRenderer.invoke('automation:save', payload),
  update: (payload) => ipcRenderer.invoke('automation:update', payload),
  editStep: (payload) => ipcRenderer.invoke('automation:edit-step', payload),
  addStep: (payload) => ipcRenderer.invoke('automation:add-step', payload),
  rename: (payload) => ipcRenderer.invoke('automation:rename', payload),
  remove: (payload) => ipcRenderer.invoke('automation:delete', payload),
  run: (payload) => ipcRenderer.invoke('automation:run', payload),
  stop: (runId) => ipcRenderer.send('automation:stop', { runId }),
  onCodexProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('automation:codex-progress', handler);
    return () => ipcRenderer.removeListener('automation:codex-progress', handler);
  },
  onRunStart: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('automation:run-start', handler);
    return () => ipcRenderer.removeListener('automation:run-start', handler);
  },
  onRunStep: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('automation:run-step', handler);
    return () => ipcRenderer.removeListener('automation:run-step', handler);
  },
  onRunDone: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('automation:run-done', handler);
    return () => ipcRenderer.removeListener('automation:run-done', handler);
  },
});
