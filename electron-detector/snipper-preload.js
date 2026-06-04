const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snipper', {
  // Main pushes init payload {captureId, previewDataUrl, displayBounds:{x,y,width,height}, virtualBounds:{x,y,width,height}, scaleFactor} via this listener after did-finish-load.
  onInit: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('screenshot:snipper-init', handler);
    return () => ipcRenderer.removeListener('screenshot:snipper-init', handler);
  },
  // Submit region in global DIP coords or cancel. Payload MUST include captureId.
  submitRegion: (payload) => ipcRenderer.invoke('screenshot:snipper-region', payload),
});
