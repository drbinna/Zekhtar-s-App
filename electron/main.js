const { app, BrowserWindow, ipcMain, screen, session, systemPreferences, globalShortcut, Tray, Menu, nativeImage } = require('electron');
// Mic permission still proactively requested for future re-introduction of voice input.
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const capture = require('./capture');
const tags = require('./tags');
const overlay = require('./overlay');
let actuator = null;
try {
  actuator = require('./actuator');
} catch (err) {
  console.warn('[task] actuator unavailable (run npm install in electron/ to enable):', err.message);
}
const fileTool = require('./file-tool');

const SERVER_URL = process.env.ZEKTHAR_SERVER_URL || 'http://localhost:3000';
const HISTORY_LIMIT = 20; // last 10 exchanges (user+assistant)
// Flip this on once Zek'thar can actually click. For now the pointer is
// decorative and tends to stick around after a capture.
const ENABLE_POINTER = false;

let mainWindow = null;
let taskInputWindow = null;
let welcomeWindow = null;
let tray = null;
let isVisible = false;
const history = [];
const seenAnamIds = new Set();
let HISTORY_FILE = null;

// Task-mode state
const MAX_TASK_STEPS = 15;
let taskAbort = false;
let taskInFlight = false;

function loadHistory() {
  if (!HISTORY_FILE || !fs.existsSync(HISTORY_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (Array.isArray(parsed)) {
      history.push(...parsed.slice(-HISTORY_LIMIT));
      console.log(`[history] loaded ${history.length} turns from ${HISTORY_FILE}`);
    }
  } catch (err) {
    console.error('[history] load failed:', err.message);
  }
}

async function saveHistory() {
  if (!HISTORY_FILE) return;
  try {
    await fsp.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[history] save failed:', err.message);
  }
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 280,
    height: 320,
    x: screenWidth - 300,
    y: screenHeight - 380,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false, // hidden until the welcome screen is dismissed
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'avatar.html'));
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'floating', 1);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADNSURBVDiNpdMxTsNAEIXhf4xTcAEuwBFoqDgCR6DnCNRQUHIE6gguQEPJBYIUx2b5KVZre+MYMdJIu/Nm3uzOjH6FMZZYo8F5iccZbtHhLcW3OA3xPU6wOCBwiXvM8YRKiCPjYLbgMeXnGIV4iQ7f+MJ7qLd4DPkBulB7jHBPIFYJbjDBT4JvuA7xMYbYDOqCMV5S/BN8hniDaYgnKe7wmOIvwRPMQlwFH0I8xSzBKXYJrnCW4hOCuwJXOE3xEA+4Sx3gOtQF/3rAb/gFW5o5sycNgtMAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show/Hide Zek'thar", click: () => toggleVisibility() },
    { label: 'Ask Zek\'thar', click: () => triggerChat() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setToolTip("Zek'thar - AI Companion");
  tray.setContextMenu(contextMenu);
}

function toggleVisibility() {
  if (!mainWindow) return;
  if (isVisible) mainWindow.hide();
  else mainWindow.show();
  isVisible = !isVisible;
}

async function triggerChat(transcript = null) {
  if (!mainWindow) return;
  const result = await chat(transcript);
  if (result?.speech) {
    mainWindow.webContents.send('chat:speech', result.speech);
  }
  if (result?.scene) {
    mainWindow.webContents.send('chat:context', result.scene);
  }
}

// ─── WELCOME SCREEN ────────────────────────────────────
function openWelcome() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.focus();
    return;
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = 480, h = 540;
  welcomeWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((sw - w) / 2),
    y: Math.round((sh - h) / 2 - 30),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'welcome-preload.js'),
    },
  });
  welcomeWindow.loadFile(path.join(__dirname, 'welcome.html'));
  welcomeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  welcomeWindow.on('closed', () => { welcomeWindow = null; });
}

function dismissWelcome() {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.close();
  }
  welcomeWindow = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    isVisible = true;
  }
}

// ─── TASK MODE ──────────────────────────────────────────
function openTaskInput() {
  if (taskInputWindow && !taskInputWindow.isDestroyed()) {
    taskInputWindow.focus();
    return;
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = 520, h = 56;
  taskInputWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((sw - w) / 2),
    y: Math.round(sh * 0.25),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'task-input-preload.js'),
    },
  });
  taskInputWindow.loadFile(path.join(__dirname, 'task-input.html'));
  taskInputWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  taskInputWindow.on('closed', () => { taskInputWindow = null; });
  taskInputWindow.on('blur', () => closeTaskInput());
}

function closeTaskInput() {
  if (taskInputWindow && !taskInputWindow.isDestroyed()) {
    taskInputWindow.close();
  }
  taskInputWindow = null;
}

function speakNarration(text) {
  if (mainWindow && text) mainWindow.webContents.send('chat:speech', text);
}

function notifyTaskStatus(status, payload = {}) {
  if (mainWindow) mainWindow.webContents.send('task:status', { status, ...payload });
}

// Build a screenshot tool_result content block from a fresh capture of the
// primary display. Returns { block, shot } so the caller can also use shot
// for coordinate translation on subsequent actions.
async function freshScreenshotBlock(toolUseId) {
  const shots = await capture.snapshot();
  const shot = shots.find((s) => s.isFocus) || shots[0];
  if (!shot) {
    return { block: { type: 'tool_result', tool_use_id: toolUseId, content: 'screenshot failed', is_error: true }, shot: null };
  }
  return {
    block: {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: shot.mediaType || 'image/jpeg', data: shot.data },
      }],
    },
    shot,
  };
}

async function runTask(goal) {
  if (!actuator) {
    const msg = "i can't act on the screen yet. install the native bits first — run `npm install` inside the electron folder, then relaunch me.";
    speakNarration(msg);
    return;
  }
  if (taskInFlight) {
    speakNarration("i'm already mid-task. one thing at a time.");
    return;
  }
  taskInFlight = true;
  taskAbort = false;
  notifyTaskStatus('start', { goal });
  speakNarration("on it.");

  // Seed the conversation: goal + initial screenshot so Claude has context.
  const conversation = [
    { role: 'user', content: [{ type: 'text', text: goal }] },
  ];
  let lastShot = null;

  try {
    // Grab an initial screenshot up front so the first turn has something to reason over.
    const seedShots = await capture.snapshot();
    lastShot = seedShots.find((s) => s.isFocus) || seedShots[0];
    if (!lastShot) {
      speakNarration("can't see your screen — grant screen recording permission and try again.");
      return;
    }
    conversation[0].content.push({
      type: 'image',
      source: { type: 'base64', media_type: lastShot.mediaType, data: lastShot.data },
    });

    for (let step = 0; step < MAX_TASK_STEPS; step++) {
      if (taskAbort) {
        speakNarration("ok, stopping.");
        break;
      }

      notifyTaskStatus('step', { step: step + 1 });

      const res = await fetch(`${SERVER_URL}/api/task/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation,
          displayWidth: lastShot.width,
          displayHeight: lastShot.height,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error('[task] /api/task/step HTTP', res.status, err);
        speakNarration("the brain link dropped. let's try again later.");
        break;
      }
      const { content, stopReason } = await res.json();
      console.log('[task] step', step + 1, 'stop=', stopReason, 'blocks=', content.map((b) => b.type).join(','));

      // Append assistant turn to conversation.
      conversation.push({ role: 'assistant', content });

      // Speak any text blocks (Claude's narration).
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          speakNarration(block.text.trim());
        }
      }

      // If there are no tool_use blocks, Claude's done (success or stuck-and-said-so).
      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        notifyTaskStatus('done');
        return;
      }

      // Execute each tool_use, build tool_results.
      const toolResults = [];
      for (const tu of toolUses) {
        if (taskAbort) {
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'aborted by user', is_error: true });
          continue;
        }
        try {
          // Route by tool name. text_editor reads/writes files; computer
          // drives mouse and keyboard.
          if (tu.name === 'str_replace_based_edit_tool') {
            const out = await fileTool.executeAction(tu.input || {});
            console.log('[task] file:', tu.input?.command, '→', String(out).slice(0, 80).replace(/\n/g, ' '));
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: out,
            });
            continue;
          }
          if (!actuator) throw new Error('actuator unavailable');
          const result = await actuator.executeAction(tu.input || {}, lastShot);
          if (result.kind === 'screenshot') {
            const { block, shot } = await freshScreenshotBlock(tu.id);
            if (shot) lastShot = shot;
            toolResults.push(block);
          } else if (result.kind === 'cursor_position') {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: `X=${result.x}, Y=${result.y}`,
            });
          } else {
            // Default: settle, then take a fresh screenshot for Claude to see the result.
            await new Promise((r) => setTimeout(r, settleMsFor(tu.input?.action)));
            const { block, shot } = await freshScreenshotBlock(tu.id);
            if (shot) lastShot = shot;
            toolResults.push(block);
          }
        } catch (err) {
          console.error('[task] action failed:', tu.input?.action || tu.input?.command, err.message);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `action failed: ${err.message}`,
            is_error: true,
          });
        }
      }

      conversation.push({ role: 'user', content: toolResults });
    }

    if (!taskAbort) {
      speakNarration("i hit my step limit. let's regroup.");
    }
  } catch (err) {
    console.error('[task] crashed:', err);
    speakNarration("something went sideways on my end. try again?");
  } finally {
    notifyTaskStatus('end');
    taskInFlight = false;
    taskAbort = false;
  }
}

function settleMsFor(actionName) {
  switch (actionName) {
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'left_click_drag':
      return 600;
    case 'type':
    case 'key':
      return 400;
    case 'scroll':
      return 350;
    case 'mouse_move':
      return 100;
    case 'wait':
      return 0;
    default:
      return 250;
  }
}

async function chat(transcript) {
  try {
    console.log('[chat] called, transcript:', transcript ? `"${transcript}"` : '<no transcript>');
    const shots = await capture.snapshot();
    console.log('[chat] snapshot returned', shots.length, 'shot(s)');
    if (shots.length === 0) {
      const msg = "i can't see your screen yet. grant screen recording permission to electron in system settings, then quit and relaunch me.";
      if (mainWindow) mainWindow.webContents.send('chat:speech', msg);
      return { speech: msg, point: null };
    }
    const screenshots = shots.map((s) => ({
      label: s.label,
      mediaType: s.mediaType,
      data: s.data,
    }));

    const res = await fetch(`${SERVER_URL}/api/vision/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        screenshots,
        history: history.slice(-HISTORY_LIMIT),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('vision/chat HTTP', res.status, err);
      return { speech: null, point: null };
    }

    const { text } = await res.json();
    const parsed = tags.parse(text);

    // Drive overlay (gated until Zek'thar can actually click).
    if (ENABLE_POINTER) {
      if (parsed.point && !parsed.point.none) {
        const shot = shots.find((s) => s.screenIndex === parsed.point.screen) || shots[0];
        if (shot) {
          const mapped = capture.mapToGlobal(shot, parsed.point.x, parsed.point.y);
          overlay.pointTo(shot.displayId, mapped.localX, mapped.localY, parsed.point.label);
        }
      } else if (parsed.point?.none) {
        overlay.clear();
      }
    } else {
      overlay.clear();
    }

    // Always push a user-side entry so role alternation stays valid for Claude,
    // even when triggered by a hotkey with no spoken transcript.
    history.push({ role: 'user', content: transcript || '[screen capture]' });
    if (parsed.speech) history.push({ role: 'assistant', content: parsed.speech });
    while (history.length > HISTORY_LIMIT) history.shift();
    saveHistory().catch(() => {});

    return parsed;
  } catch (err) {
    console.error('chat failed:', err);
    return { speech: null, point: null };
  }
}

// IPC
ipcMain.handle('chat', async (_e, transcript) => chat(transcript));

ipcMain.handle('get-session-token', async () => {
  try {
    const response = await fetch(`${SERVER_URL}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return data.sessionToken;
  } catch (error) {
    console.error('Failed to get session token:', error);
    return null;
  }
});

ipcMain.on('move-window', (_e, { deltaX, deltaY }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

ipcMain.on('overlay:clear', () => overlay.clear());

// Voice-trigger debug breadcrumbs surfaced from the renderer.
ipcMain.on('voice:log', (_e, { label, text }) => {
  console.log(`[voice] ${label}: ${typeof text === 'string' ? text : JSON.stringify(text)}`);
});

// Welcome window → main: dismiss (CTA clicked)
ipcMain.on('welcome:dismiss', () => dismissWelcome());

// Task input window → main: submit / cancel
ipcMain.on('task-input:submit', (_e, goal) => {
  closeTaskInput();
  if (typeof goal === 'string' && goal.trim()) {
    runTask(goal.trim()).catch((err) => console.error('[task] runTask error:', err));
  }
});
ipcMain.on('task-input:cancel', () => closeTaskInput());

// Renderer can also start/stop tasks programmatically
ipcMain.handle('task:run', async (_e, goal) => {
  if (typeof goal !== 'string' || !goal.trim()) return false;
  runTask(goal.trim()).catch((err) => console.error('[task] runTask error:', err));
  return true;
});
ipcMain.on('task:abort', () => { taskAbort = true; });

// Bridge: Anam's audio-loop conversation flows in here. We dedupe by message id
// and merge new turns into the Claude history so future screen captures have
// the full conversational context.
ipcMain.on('anam:history', (_e, messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return;
  let added = false;
  for (const msg of messages) {
    if (!msg || !msg.id || !msg.content || seenAnamIds.has(msg.id)) continue;
    seenAnamIds.add(msg.id);
    const role = msg.role === 'user' ? 'user' : 'assistant';
    history.push({ role, content: msg.content });
    added = true;
  }
  if (added) {
    while (history.length > HISTORY_LIMIT) history.shift();
    saveHistory().catch(() => {});
  }
});

app.whenReady().then(async () => {
  HISTORY_FILE = path.join(app.getPath('userData'), 'history.json');
  loadHistory();

  // Auto-grant media (mic / camera / display) permissions to our renderer.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const allow = ['media', 'mediaKeySystem', 'display-capture', 'microphone'].includes(permission);
    callback(allow);
  });

  // Trigger the macOS Microphone TCC prompt up front, before PTT runs.
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[zek] mic access status:', micStatus);
    if (micStatus !== 'granted') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        console.log('[zek] mic granted:', granted);
      } catch (err) {
        console.error('[zek] mic ask failed:', err);
      }
    }
    const screenStatus = systemPreferences.getMediaAccessStatus('screen');
    console.log('[zek] screen recording status:', screenStatus);
    if (screenStatus !== 'granted') {
      console.warn('[zek] ⚠️  Screen Recording permission is NOT granted. Open System Settings → Privacy & Security → Screen & System Audio Recording, enable Electron, then fully quit (Cmd+Q) and relaunch.');
    }
  }

  createWindow();
  overlay.init();
  createTray();
  openWelcome();

  globalShortcut.register('CommandOrControl+Shift+Z', toggleVisibility);
  globalShortcut.register('CommandOrControl+Shift+S', () => triggerChat());
  globalShortcut.register('CommandOrControl+Shift+T', () => openTaskInput());
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (mainWindow) mainWindow.webContents.send('task:listen-start');
  });
  globalShortcut.register('Escape', () => {
    overlay.clear();
    if (taskInFlight) {
      taskAbort = true;
      console.log('[task] abort requested via Esc');
    }
    if (taskInputWindow) closeTaskInput();
    if (mainWindow) mainWindow.webContents.send('task:listen-cancel');
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
