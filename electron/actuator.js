// Translates Anthropic computer-tool actions into mouse/keyboard events
// via @nut-tree-fork/nut-js. Coordinates from Claude are in screenshot pixel
// space (the display_width_px / display_height_px we declared); we translate
// them to physical screen coordinates using the captured shot's display bounds.

const { mouse, keyboard, Button, Key, Point } = require('@nut-tree-fork/nut-js');

mouse.config.mouseSpeed = 1500;
keyboard.config.autoDelayMs = 12;

// Ease the cursor with an ease-out cubic so motion reads as intentional rather
// than teleported. nut-js's straightTo is linear at config.mouseSpeed; this
// gives a brisk decelerating arc that's easier for users to follow.
async function easeTo(point) {
  const start = await mouse.getPosition();
  const dx = point.x - start.x;
  const dy = point.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) {
    await mouse.setPosition(point);
    return;
  }
  const durationMs = Math.min(380, Math.max(180, 180 + dist * 0.4));
  const steps = Math.max(8, Math.round(durationMs / 16));
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);
    const x = Math.round(start.x + dx * eased);
    const y = Math.round(start.y + dy * eased);
    await mouse.setPosition(new Point(x, y));
    const targetTime = t0 + (i / steps) * durationMs;
    const wait = targetTime - Date.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
  }
}

const KEY_MAP = {
  cmd: Key.LeftCmd, command: Key.LeftCmd, super: Key.LeftCmd, win: Key.LeftCmd,
  shift: Key.LeftShift,
  alt: Key.LeftAlt, opt: Key.LeftAlt, option: Key.LeftAlt,
  ctrl: Key.LeftControl, control: Key.LeftControl,
  enter: Key.Enter, return: Key.Enter,
  esc: Key.Escape, escape: Key.Escape,
  tab: Key.Tab,
  space: Key.Space,
  backspace: Key.Backspace, delete: Key.Delete,
  up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
  pageup: Key.PageUp, pagedown: Key.PageDown,
  home: Key.Home, end: Key.End,
  capslock: Key.CapsLock,
  f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4, f5: Key.F5, f6: Key.F6,
  f7: Key.F7, f8: Key.F8, f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,
  comma: Key.Comma, period: Key.Period, slash: Key.Slash,
  semicolon: Key.Semicolon, quote: Key.Quote,
  minus: Key.Minus, equal: Key.Equal,
  leftbracket: Key.LeftBracket, rightbracket: Key.RightBracket,
  backslash: Key.Backslash, grave: Key.Grave,
};

function letterKey(ch) {
  if (/^[a-z]$/i.test(ch)) {
    const v = Key[ch.toUpperCase()];
    return v !== undefined ? v : null;
  }
  if (/^[0-9]$/.test(ch)) {
    const v = Key['Num' + ch];
    return v !== undefined ? v : null;
  }
  return null;
}

function parseKeyToken(token) {
  const t = token.trim().toLowerCase();
  // Note: Key is a numeric enum — Key.Escape can be 0, which is falsy.
  // Use explicit undefined-check instead of truthy-check.
  if (KEY_MAP[t] !== undefined) return KEY_MAP[t];
  if (t.length === 1) return letterKey(t);
  return null;
}

// Parse an Anthropic key spec like "cmd+a", "ctrl+shift+t", "Return".
function parseKeyChord(spec) {
  const tokens = String(spec).split(/[+\s]+/).filter(Boolean);
  const keys = tokens.map(parseKeyToken);
  if (keys.some((k) => k == null)) {
    throw new Error(`Unrecognized key in chord: ${spec}`);
  }
  return keys;
}

// Translate Claude-space (screenshot pixel) coords → physical screen DIP coords.
// Assumes the action targets the "shot" we last sent up.
function translate(shot, x, y) {
  const xDip = (x / shot.width) * shot.bounds.width;
  const yDip = (y / shot.height) * shot.bounds.height;
  return new Point(
    Math.round(shot.bounds.x + xDip),
    Math.round(shot.bounds.y + yDip),
  );
}

async function executeAction(action, shot) {
  switch (action.action) {
    case 'screenshot':
      return { kind: 'screenshot' };

    case 'cursor_position': {
      const p = await mouse.getPosition();
      return { kind: 'cursor_position', x: p.x, y: p.y };
    }

    case 'mouse_move': {
      const p = translate(shot, action.coordinate[0], action.coordinate[1]);
      await easeTo(p);
      return { kind: 'ok' };
    }

    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      if (action.coordinate) {
        const p = translate(shot, action.coordinate[0], action.coordinate[1]);
        await easeTo(p);
      }
      const button = action.action.startsWith('right') ? Button.RIGHT
        : action.action.startsWith('middle') ? Button.MIDDLE
        : Button.LEFT;
      const presses = action.action.startsWith('double') ? 2
        : action.action.startsWith('triple') ? 3
        : 1;
      for (let i = 0; i < presses; i++) {
        await mouse.click(button);
      }
      return { kind: 'ok' };
    }

    case 'left_click_drag':
    case 'left_mouse_down': {
      if (action.action === 'left_mouse_down') {
        await mouse.pressButton(Button.LEFT);
        return { kind: 'ok' };
      }
      const start = action.start_coordinate || action.coordinate;
      const end = action.coordinate;
      if (action.start_coordinate) {
        await easeTo(translate(shot, start[0], start[1]));
      }
      await mouse.pressButton(Button.LEFT);
      await easeTo(translate(shot, end[0], end[1]));
      await mouse.releaseButton(Button.LEFT);
      return { kind: 'ok' };
    }

    case 'left_mouse_up': {
      await mouse.releaseButton(Button.LEFT);
      return { kind: 'ok' };
    }

    case 'type': {
      await keyboard.type(action.text);
      return { kind: 'ok' };
    }

    case 'key': {
      const keys = parseKeyChord(action.text);
      await keyboard.type(...keys);
      return { kind: 'ok' };
    }

    case 'scroll': {
      if (action.coordinate) {
        const p = translate(shot, action.coordinate[0], action.coordinate[1]);
        await easeTo(p);
      }
      const amt = Math.max(1, Math.abs(action.scroll_amount || 3));
      const dir = (action.scroll_direction || 'down').toLowerCase();
      switch (dir) {
        case 'up':    await mouse.scrollUp(amt); break;
        case 'down':  await mouse.scrollDown(amt); break;
        case 'left':  await mouse.scrollLeft(amt); break;
        case 'right': await mouse.scrollRight(amt); break;
      }
      return { kind: 'ok' };
    }

    case 'wait': {
      const ms = Math.round((action.duration || 1) * 1000);
      await new Promise((r) => setTimeout(r, ms));
      return { kind: 'ok' };
    }

    default:
      throw new Error(`Unsupported action: ${action.action}`);
  }
}

module.exports = { executeAction };
