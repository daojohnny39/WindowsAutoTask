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
  reset: (exe) => ipcRenderer.invoke('chat:reset', exe),
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
  removeListeners: () => {
    ipcRenderer.removeAllListeners('chat:chunk');
    ipcRenderer.removeAllListeners('chat:done');
    ipcRenderer.removeAllListeners('chat:tool');
    ipcRenderer.removeAllListeners('chat:tool-result');
    ipcRenderer.removeAllListeners('chat:thinking');
  },
});
