const { screen, desktopCapturer, nativeImage } = require('electron');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const execFileP = promisify(execFile);
const MAX_DIM = 1280;
const JPEG_QUALITY = 80;

function fitWithin(width, height, max) {
  if (width <= max && height <= max) return { width, height };
  if (width >= height) {
    return { width: max, height: Math.round((height / width) * max) };
  }
  return { width: Math.round((width / height) * max), height: max };
}

// Slow but rock-solid: shells out to /usr/sbin/screencapture for a single display.
async function screencaptureFallback(displayIndex1Based) {
  const tmpfile = path.join(os.tmpdir(), `zek-${process.pid}-${Date.now()}-${displayIndex1Based}.jpg`);
  try {
    await execFileP('/usr/sbin/screencapture', ['-x', '-t', 'jpg', '-D', String(displayIndex1Based), tmpfile]);
    const raw = await fs.readFile(tmpfile);
    if (!raw || raw.length === 0) return null;
    const img = nativeImage.createFromBuffer(raw);
    const { width, height } = img.getSize();
    if (width === 0 || height === 0) return null;
    return img;
  } catch (err) {
    console.error('[capture] screencapture fallback failed for display index', displayIndex1Based, err.message);
    return null;
  } finally {
    fs.unlink(tmpfile).catch(() => {});
  }
}

// Cache the last snapshot (and any in-flight one) so wake-word-triggered
// prefetches can hide capture latency from the task seed step.
let lastShots = null;
let lastShotsAt = 0;
let pendingSnapshot = null;

// Return shots that are either pending (await the in-flight prefetch) or
// recently captured (<= maxAgeMs old). Returns null if neither — caller
// should fall back to a fresh capture.snapshot().
async function recentOrPending(maxAgeMs = 2000) {
  if (pendingSnapshot) {
    try { return await pendingSnapshot; } catch { return null; }
  }
  if (lastShots && Date.now() - lastShotsAt <= maxAgeMs) {
    return lastShots;
  }
  return null;
}

async function snapshot() {
  if (pendingSnapshot) return pendingSnapshot;
  const p = _captureNow().then(
    (shots) => { lastShots = shots; lastShotsAt = Date.now(); return shots; },
    (err) => { throw err; },
  ).finally(() => { if (pendingSnapshot === p) pendingSnapshot = null; });
  pendingSnapshot = p;
  return p;
}

async function _captureNow() {
  const displays = screen.getAllDisplays();
  const cursorPoint = screen.getCursorScreenPoint();
  const focusedDisplay = screen.getDisplayNearestPoint(cursorPoint);

  // Fast path: single in-process call grabs thumbnails for every display at once.
  // No subprocess, no disk roundtrip. Falls back to /usr/sbin/screencapture
  // per-display if a thumbnail comes back empty (a known macOS quirk).
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: MAX_DIM, height: MAX_DIM },
    });
  } catch (err) {
    console.warn('[capture] desktopCapturer.getSources failed, will fall back:', err.message);
  }

  // Cursor display first, others after.
  const ordered = [...displays].sort((a, b) => {
    if (a.id === focusedDisplay.id) return -1;
    if (b.id === focusedDisplay.id) return 1;
    return 0;
  });

  // screencapture's -D flag is 1-indexed against displays.getAllDisplays() order
  // (the original, unsorted order — important).
  const captureIndexFor = new Map();
  displays.forEach((d, i) => captureIndexFor.set(d.id, i + 1));

  const total = ordered.length;

  const shots = (await Promise.all(ordered.map(async (display, i) => {
    let img = null;
    let nativeW = 0, nativeH = 0;
    let usedFallback = false;

    // Try desktopCapturer first.
    const source = sources.find((s) => String(s.display_id) === String(display.id));
    if (source && source.thumbnail) {
      const sz = source.thumbnail.getSize();
      if (sz.width > 0 && sz.height > 0) {
        img = source.thumbnail;
        nativeW = sz.width;
        nativeH = sz.height;
      }
    }

    // Fallback: shell out to screencapture for this display.
    if (!img) {
      console.warn(`[capture] desktopCapturer empty for display ${display.id}, falling back to screencapture`);
      const captureIdx = captureIndexFor.get(display.id) || (i + 1);
      img = await screencaptureFallback(captureIdx);
      if (img) {
        const sz = img.getSize();
        nativeW = sz.width;
        nativeH = sz.height;
        usedFallback = true;
      }
    }

    if (!img) {
      console.error('[capture] both paths failed for display', display.id);
      return null;
    }

    const target = fitWithin(nativeW, nativeH, MAX_DIM);
    if (target.width !== nativeW || target.height !== nativeH) {
      img = img.resize({ width: target.width, height: target.height, quality: 'good' });
    }
    const jpegBuf = img.toJPEG(JPEG_QUALITY);

    const path = usedFallback ? '(fallback)' : '(fast)';
    const resizeNote = (target.width !== nativeW) ? ` → resized ${target.width}x${target.height}` : '';
    console.log(`[capture] shot ${i + 1} ${path} ${nativeW}x${nativeH}${resizeNote} jpegBytes=${jpegBuf.length}`);

    const isFocus = display.id === focusedDisplay.id;
    const focusStr = total > 1 && isFocus ? ' — cursor is on this screen (primary focus)' : '';

    return {
      screenIndex: i + 1,
      displayId: display.id,
      isFocus,
      width: target.width,
      height: target.height,
      bounds: display.bounds,
      label: `screen ${i + 1} of ${total}${focusStr} (image dimensions: ${target.width}x${target.height} pixels)`,
      mediaType: 'image/jpeg',
      data: jpegBuf.toString('base64'),
    };
  }))).filter(Boolean);

  return shots;
}

function mapToGlobal(shot, x, y) {
  const xDip = (x / shot.width) * shot.bounds.width;
  const yDip = (y / shot.height) * shot.bounds.height;
  return {
    globalX: Math.round(shot.bounds.x + xDip),
    globalY: Math.round(shot.bounds.y + yDip),
    localX: Math.round(xDip),
    localY: Math.round(yDip),
    displayId: shot.displayId,
  };
}

// First desktopCapturer call after launch can be slow (~300-600ms cold start
// on macOS). Run a throwaway call during app init so the first real snapshot
// hits a warm pipeline. Errors are swallowed — this is best-effort.
async function warmup() {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
  } catch {}
}

module.exports = { snapshot, mapToGlobal, warmup, recentOrPending };
