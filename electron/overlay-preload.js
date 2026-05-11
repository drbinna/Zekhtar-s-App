const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  onPoint: (cb) => ipcRenderer.on('overlay:point', (_e, data) => cb(data)),
  onClear: (cb) => ipcRenderer.on('overlay:clear', () => cb()),
});
