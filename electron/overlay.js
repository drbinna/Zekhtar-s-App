const { BrowserWindow, screen } = require('electron');
const path = require('path');

const overlays = new Map();

function createOverlayForDisplay(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  return win;
}

function init() {
  for (const d of screen.getAllDisplays()) {
    overlays.set(d.id, createOverlayForDisplay(d));
  }
  screen.on('display-added', (_e, d) => {
    overlays.set(d.id, createOverlayForDisplay(d));
  });
  screen.on('display-removed', (_e, d) => {
    const win = overlays.get(d.id);
    if (win && !win.isDestroyed()) win.close();
    overlays.delete(d.id);
  });
}

function pointTo(displayId, localX, localY, label) {
  const win = overlays.get(displayId);
  if (!win || win.isDestroyed()) return;
  win.webContents.send('overlay:point', { x: localX, y: localY, label });
}

function clear() {
  for (const win of overlays.values()) {
    if (!win.isDestroyed()) win.webContents.send('overlay:clear');
  }
}

function getWindowIds() {
  return [...overlays.values()].map((w) => w.id);
}

module.exports = { init, pointTo, clear, getWindowIds };
