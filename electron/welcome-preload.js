const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('welcomeAPI', {
  dismiss: () => ipcRenderer.send('welcome:dismiss'),
});
