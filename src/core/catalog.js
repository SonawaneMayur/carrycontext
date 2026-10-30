// @ts-check
// Saved handoffs as the panel and search show them: grouped by branch, one entry per session,
// with that session's earlier versions as its history.
//
// Each file's header (session, branch, sources, ...) is cached in .carrycontext/handoffs/index.json
// so the panel doesn't re-read every file. It is only a cache: every read checks it against the
// files' names and modification times and re-reads whatever changed, so it can't go stale, and it
// lives in handoffs/, which is already git-ignored. Shared by the extension and the CLI/hooks, so
// nothing in here may import 'vscode'.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./config');
const { readText, readJson, writeFile, listFiles, mtime } = require('./util');
const { parseSections, isSubstantive } = require('./summarize');

const INDEX_VERSION = 1;
const handoffsDir = (cwd) => path.join(dataDir(cwd), 'handoffs');
const indexFile = (cwd) => path.join(handoffsDir(cwd), 'index.json');

/**
 * @typedef {Object} Meta
 * @property {string} session       session title
 * @property {string} description   what was being worked on when it was saved
 * @property {string} goal
 * @property {string} branch        branch name as written in the handoff ('' outside git)
 * @property {string} key           the session(s) it was made from, e.g. "claude:1a2b3c4d"
 * @property {string[]} providers
 * @property {{verified: number, unverified: number, contradicted: number} | null} verification
 *
 * @typedef {{file: string, at: number, description: string}} Version
 * @typedef {{key: string, title: string, description: string, goal: string, providers: string[], at: number, file: string, verification: Meta['verification'], versions: Version[]}} Session
 * @typedef {{slug: string | null, name: string, at: number, sessions: Session[]}} Branch
 */

/**
 * Every saved handoff file, newest first. `branch` is the folder name (slug) or null for
 * handoffs saved outside git or before branch support.
 * @returns {{file: string, branch: string | null, at: number}[]}
 */
function listSaved(cwd) {
  const root = handoffsDir(cwd);
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      for (const f of listFiles(full, (n) => n.endsWith('.md'))) out.push({ file: f, branch: e.name, at: mtime(f) });
    } else if (e.name.endsWith('.md')) {
      out.push({ file: full, branch: null, at: mtime(full) });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * A saved handoff's header fields and goal. Handoffs from older versions may lack fields; the
 * file name ("<provider>-<session>--<description>") fills in for them.
 * @returns {Meta}
 */
function readMeta(text, name) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const [, key, value] of text.split(/\n## /)[0].matchAll(/^- \*\*([A-Za-z ]+):\*\* (.*)$/gm)) fields[key] ??= value.trim();
  const [prefix, rest = ''] = name.split('--');
  const sources = [...(fields.Sources || '').matchAll(/([a-z][\w-]*) `([^`]+)`/g)];
  const counts = (fields.Verification || '').match(/(\d+) verified, (\d+) unverified, (\d+) contradicted/);
  const goal = (parseSections(text).Goal || '').split('\n').map((l) => l.replace(/^>\s?/, '').trim()).find(Boolean) || '';
  return {
    session: fields.Session || prefix.replace(/-/g, ' '),
    description: fields.Description || rest.replace(/-/g, ' '),
    goal: goal.length > 300 ? `${goal.slice(0, 300)}…` : goal,
    branch: fields.Branch || '',
    key: sources.map(([, provider, id]) => `${provider}:${id}`).join('+') || prefix,
    providers: [...new Set(sources.map(([, provider]) => provider))],
    verification: counts ? { verified: Number(counts[1]), unverified: Number(counts[2]), contradicted: Number(counts[3]) } : null,
  };
}

/**
 * Every saved handoff with its metadata, newest first: from the index where it is current,
 * from the file where it isn't. The index is written back when anything changed.
 */
function load(cwd) {
  const index = readJson(indexFile(cwd), null);
  const current = index?.version === INDEX_VERSION;
  /** @type {Record<string, {at: number, meta: Meta}>} */
  const cached = (current && index.files) || {};
  /** @type {Record<string, {at: number, meta: Meta}>} */
  const files = {};
  let changed = !current;
  const out = listSaved(cwd).map(({ file, branch, at }) => {
    const id = branch ? `${branch}/${path.basename(file)}` : path.basename(file);
    let entry = cached[id];
    if (!entry || entry.at !== at) {
      entry = { at, meta: readMeta(readText(file) || '', path.basename(file, '.md')) };
      changed = true;
    }
    files[id] = entry;
    return { file, branch, at, meta: entry.meta };
  });
  if (Object.keys(cached).length !== out.length) changed = true; // files were removed
  if (changed && out.length) writeFile(indexFile(cwd), JSON.stringify({ version: INDEX_VERSION, files }) + '\n');
  return out;
}

/**
 * Saved handoffs grouped by branch, then by session, both newest first. A session's first
 * version is its latest handoff.
 * @returns {Branch[]}
 */
function catalog(cwd) {
  /** @type {Map<string | null, Branch>} */
  const branches = new Map();
  for (const { file, branch: slug, at, meta } of load(cwd)) {
    let branch = branches.get(slug);
    if (!branch) {
      branch = { slug, name: meta.branch || (slug ? slug.replace(/__/g, '/') : ''), at, sessions: [] };
      branches.set(slug, branch);
    }
    let session = branch.sessions.find((s) => s.key === meta.key);
    if (!session) {
      // Older handoffs were named after replies like "sure"; show the goal for those instead.
      const description = isSubstantive(meta.description) || !meta.goal ? meta.description : meta.goal;
      session = { key: meta.key, title: meta.session, description, goal: meta.goal, providers: meta.providers, at, file, verification: meta.verification, versions: [] };
      branch.sessions.push(session);
    }
    session.versions.push({ file, at, description: meta.description });
  }
  return [...branches.values()];
}

/**
 * Keep the newest `keep` versions of each session's handoff on one branch (slug, or null
 * outside git). Every session keeps its latest, so a busy session can't push out the others.
 */
function pruneHistory(cwd, slug, keep) {
  const branch = catalog(cwd).find((b) => b.slug === slug);
  for (const session of branch?.sessions || []) {
    for (const version of session.versions.slice(Math.max(1, keep))) fs.rmSync(version.file, { force: true });
  }
}

/**
 * Saved handoffs that contain every word of `query`, in any case, newest first: for each
 * session, the newest version that matches, with the text around the first word.
 * @returns {{branch: Branch, session: Session, file: string, at: number, snippet: string}[]}
 */
function search(cwd, query, limit = 50) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  if (!words.length) return hits;
  for (const branch of catalog(cwd)) {
    for (const session of branch.sessions) {
      for (const version of session.versions) {
        const text = readText(version.file) || '';
        const lower = text.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;
        hits.push({ branch, session, file: version.file, at: version.at, snippet: around(text, lower.indexOf(words[0]), words[0].length) });
        break;
      }
    }
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** About a line of text around a match, on one line. */
function around(text, i, length) {
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + length + 80);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

module.exports = { listSaved, readMeta, catalog, pruneHistory, search };
