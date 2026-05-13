const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Server URL (may differ from default if port 3000 was busy)
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),

  // Anam session token (renderer fetches via main → server)
  getSessionToken: () => ipcRenderer.invoke('get-session-token'),

  // Send a transcript (or null for "look and tell me") through the chat pipeline.
  // Returns { speech, point } — overlay is already driven in main.
  chat: (transcript) => ipcRenderer.invoke('chat', transcript),

  // Receive speech from a globally-triggered chat (e.g. Cmd+Shift+S).
  onSpeech: (callback) => {
    ipcRenderer.on('chat:speech', (_e, speech) => callback(speech));
  },

  // Receive a scene description to inject into Anam's persona context.
  onContext: (callback) => {
    ipcRenderer.on('chat:context', (_e, scene) => callback(scene));
  },

  // Manually clear the on-screen pointer.
  clearOverlay: () => ipcRenderer.send('overlay:clear'),

  // Mirror Anam's conversation history into our Claude memory.
  sendAnamHistory: (messages) => ipcRenderer.send('anam:history', messages),

  // Send a debug breadcrumb to the main process log (for voice-trigger debugging).
  logVoice: (label, text) => ipcRenderer.send('voice:log', { label, text }),

  // Push-to-talk: main process tells renderer when the user wants to capture
  // a forced-task utterance window (Cmd+Shift+V) or cancel it (Esc).
  onTaskListenStart: (cb) => ipcRenderer.on('task:listen-start', () => cb()),
  onTaskListenCancel: (cb) => ipcRenderer.on('task:listen-cancel', () => cb()),

  // Window dragging
  moveWindow: (deltaX, deltaY) => ipcRenderer.send('move-window', { deltaX, deltaY }),

  // Task mode (autonomous screen interaction).
  runTask: (goal) => ipcRenderer.invoke('task:run', goal),
  abortTask: () => ipcRenderer.send('task:abort'),
  onTaskStatus: (callback) => {
    ipcRenderer.on('task:status', (_e, payload) => callback(payload));
  },
});
