// @ts-check
const fs = require('fs');
const os = require('os');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file, fallback) {
  const text = readText(file);
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Parse a JSONL file, skipping malformed lines. */
function readJsonl(file) {
  const text = readText(file) || '';
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line while the CLI is still writing
    }
  }
  return out;
}

/** Read only the first maxBytes of a (possibly large) file. */
function readHead(file, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const readFirstLine = (file, maxBytes) => readHead(file, maxBytes).split('\n')[0];

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function listFiles(dir, predicate = () => true) {
  try {
    return fs
      .readdirSync(dir)
      .filter(predicate)
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/**
 * Insert or replace a marked block inside a file the user also edits
 * (AGENTS.md, GEMINI.md, copilot-instructions.md). Content outside the
 * markers is never touched.
 */
function upsertManagedBlock(file, content) {
  const start = '<!-- carrycontext:start -->';
  const end = '<!-- carrycontext:end -->';
  const block = `${start}\n${content.trim()}\n${end}`;
  const existing = readText(file) || '';
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  const next = re.test(existing)
    ? existing.replace(re, () => block)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${block}\n`;
  if (next !== existing) writeFile(file, next);
}

/**
 * Strip personal absolute paths from text that may be shared or recorded:
 * the project root becomes "." and the home folder "~". Also covers the
 * dash-encoded form Claude Code uses for its project folders.
 */
function shortenPaths(text, cwd) {
  const home = os.homedir();
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  return [
    [cwd + path.sep, './'],
    [cwd, '.'],
    [home + path.sep, '~/'],
    [home, '~'],
    [enc(home), '-~'],
  ].reduce((t, [from, to]) => (from && from.length > 1 ? t.split(from).join(to) : t), text)
    .replace(USERNAME_RE || /$^/, '<user>');
}

// The bare username, as a whole word; skipped for short names that could be ordinary words.
const USERNAME = (() => {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
})();
const USERNAME_RE = USERNAME.length >= 6 ? new RegExp(`\\b${USERNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g') : null;

const tildify = (p) => shortenPaths(p, '\0');

/** Quote a string for POSIX sh so it is always one literal word. */
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function rel(cwd, file) {
  return path.relative(cwd, file).split(path.sep).join('/');
}

function ago(when) {
  const s = Math.round((Date.now() - new Date(when).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

module.exports = {
  ago,
  ensureDir,
  writeFile,
  readText,
  readJson,
  readJsonl,
  readHead,
  readFirstLine,
  mtime,
  listFiles,
  truncate,
  upsertManagedBlock,
  shortenPaths,
  shellQuote,
  tildify,
  rel,
};
