const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskAPI', {
  submit: (goal) => ipcRenderer.send('task-input:submit', goal),
  cancel: () => ipcRenderer.send('task-input:cancel'),
});
