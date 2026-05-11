const POINT_RE = /\[POINT:\s*(none|(-?\d+)\s*,\s*(-?\d+)\s*(?::\s*([^\]:]+?)\s*)?(?::\s*screen\s*(\d+)\s*)?)\]/i;
const SCENE_RE = /\[SCENE:\s*([^\]]+?)\s*\]/i;

function parse(rawText) {
  if (!rawText) return { speech: '', point: null, scene: null };

  const sceneMatch = rawText.match(SCENE_RE);
  const scene = sceneMatch ? sceneMatch[1].trim() : null;
  const withoutScene = sceneMatch ? rawText.replace(SCENE_RE, '') : rawText;

  const match = withoutScene.match(POINT_RE);
  if (!match) return { speech: withoutScene.trim(), point: null, scene };

  const speech = withoutScene.replace(POINT_RE, '').trim();

  if (/^none$/i.test(match[1])) {
    return { speech, point: { none: true }, scene };
  }

  const point = {
    x: parseInt(match[2], 10),
    y: parseInt(match[3], 10),
    label: (match[4] || '').trim() || null,
    screen: match[5] ? parseInt(match[5], 10) : 1,
  };

  return { speech, point, scene };
}

module.exports = { parse };
