// Implements Anthropic's `text_editor_20250728` tool — view / create /
// str_replace / insert against the local filesystem. Path access is fenced
// to the user's home directory and /tmp; everything else is refused.

const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const ALLOWED_ROOTS = [
  os.homedir(),
  '/tmp',
  '/private/tmp',
];

function assertSafePath(p) {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error('path is required');
  }
  // Expand a leading ~ to the home dir.
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const resolved = path.resolve(expanded);
  const allowed = ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!allowed) {
    throw new Error(
      `path '${resolved}' is outside allowed roots (${ALLOWED_ROOTS.join(', ')})`
    );
  }
  return resolved;
}

function lineNumbered(text) {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

async function executeAction(input) {
  const command = input.command || input.action;
  switch (command) {
    case 'view': {
      const p = assertSafePath(input.path);
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(p, { withFileTypes: true });
        const list = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
          .join('\n');
        return `Directory ${p}:\n${list || '(empty)'}`;
      }
      const text = await fs.readFile(p, 'utf-8');
      if (Array.isArray(input.view_range) && input.view_range.length === 2) {
        const [start, end] = input.view_range;
        const lines = text.split('\n');
        const startIdx = Math.max(0, (Number(start) || 1) - 1);
        const endIdx = end === -1 ? lines.length : Math.min(lines.length, Number(end) || lines.length);
        return lineNumbered(lines.slice(startIdx, endIdx).join('\n'));
      }
      return lineNumbered(text);
    }

    case 'create': {
      const p = assertSafePath(input.path);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, input.file_text ?? '', 'utf-8');
      return `Created ${p}`;
    }

    case 'str_replace': {
      const p = assertSafePath(input.path);
      const text = await fs.readFile(p, 'utf-8');
      const oldStr = input.old_str ?? '';
      const newStr = input.new_str ?? '';
      if (!oldStr) throw new Error('old_str must be non-empty');
      const occurrences = text.split(oldStr).length - 1;
      if (occurrences === 0) {
        throw new Error('No match found for old_str — make it more specific.');
      }
      if (occurrences > 1) {
        throw new Error(`Found ${occurrences} matches for old_str — make it more specific so the replacement is unique.`);
      }
      const updated = text.replace(oldStr, newStr);
      await fs.writeFile(p, updated, 'utf-8');
      return `Replaced text in ${p}`;
    }

    case 'insert': {
      const p = assertSafePath(input.path);
      const text = await fs.readFile(p, 'utf-8');
      const lines = text.split('\n');
      const at = Math.max(0, Math.min(Number(input.insert_line) || 0, lines.length));
      lines.splice(at, 0, input.insert_text ?? '');
      await fs.writeFile(p, lines.join('\n'), 'utf-8');
      return `Inserted text at line ${at} in ${p}`;
    }

    default:
      throw new Error(`Unsupported text_editor command: ${command}`);
  }
}

module.exports = { executeAction };
