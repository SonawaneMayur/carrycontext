// @ts-check
// Current git branch, read straight from .git/HEAD so it is instant and needs no git binary.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readText, writeFile } = require('./util');

/** The .git directory for cwd or any parent, following worktree "gitdir:" files. */
function gitDir(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      const m = (readText(dotGit) || '').match(/^gitdir:\s*(.+)$/m);
      if (m) return path.resolve(dir, m[1].trim());
    } catch {
      // no .git here
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Path of the HEAD file to watch for branch switches, or null outside a repo. */
function headFile(cwd) {
  const dir = gitDir(cwd);
  return dir ? path.join(dir, 'HEAD') : null;
}

/** "main", "feature/payments", "detached-1a2b3c4", or null when not in a git repo. */
function currentBranch(cwd) {
  const file = headFile(cwd);
  const head = file && (readText(file) || '').trim();
  if (!head) return null;
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return ref ? ref[1] : `detached-${head.slice(0, 7)}`;
}

/**
 * Which branch was checked out at a given time, for work an assistant logged on "HEAD" (a session
 * started before `git init` keeps logging it). Read from the reflog's "checkout: moving from A to B"
 * lines in .git/logs/HEAD, without running git: the branch last switched to; before the first
 * switch, the one it left; with no switches, the current branch. Undefined for a detached
 * checkout or outside git.
 * @param {string} cwd
 * @returns {(ms: number) => string | undefined}
 */
function branchAt(cwd) {
  const dir = gitDir(cwd);
  if (!dir) return () => undefined;
  const branch = (name) => (name && !/^[0-9a-f]{7,40}$/.test(name) && !name.startsWith('detached-') ? name : undefined);
  const current = branch(currentBranch(cwd));
  const moves = [];
  for (const line of (readText(path.join(dir, 'logs', 'HEAD')) || '').split('\n')) {
    const m = line.match(/ (\d+) [+-]\d{4}\tcheckout: moving from (\S+) to (\S+)$/);
    if (m) moves.push({ at: Number(m[1]) * 1000, from: m[2], to: m[3] });
  }
  return (ms) => {
    const before = moves.filter((m) => m.at <= ms).pop();
    if (before) return branch(before.to);
    return moves.length ? branch(moves[0].from) : current;
  };
}

/** Folder-safe branch name. Keep in sync with the sed expression in claudeHooks.js. */
const branchSlug = (branch) => branch.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');

let available;
/**
 * Whether running `git` is safe. On macOS /usr/bin/git is a stub that pops up an
 * install dialog when the developer tools are missing, which a hook must never do.
 */
function gitAvailable() {
  if (available !== undefined) return available;
  const run = (cmd, args) => {
    try {
      execFileSync(cmd, args, { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  };
  if (process.platform === 'darwin') {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter((d) => d && d !== '/usr/bin');
    const realGit = dirs.some((d) => fs.existsSync(path.join(d, 'git')));
    available = (realGit || run('xcode-select', ['-p'])) && run('git', ['--version']);
  } else {
    available = run('git', ['--version']);
  }
  return available;
}

/**
 * Keep files out of git through the repo's local exclude list (.git/info/exclude). It is never
 * committed, so the user's own .gitignore stays untouched. Does nothing outside a repo.
 * @param {string} cwd
 * @param {string[]} files absolute paths of existing files inside the repo
 */
function excludeLocally(cwd, files) {
  const list = localExcludes(cwd, files);
  if (!list) return;
  const lines = list.existing.split('\n').map((l) => l.trim());
  const missing = list.entries.filter((e) => !lines.includes(e));
  if (missing.length) writeFile(list.file, `${list.existing}${list.existing && !list.existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/** Undo excludeLocally, for files that should show up in git again (e.g. ones you've since added text to). */
function includeLocally(cwd, files) {
  const list = localExcludes(cwd, files);
  if (!list?.existing) return;
  const lines = list.existing.split('\n');
  const kept = lines.filter((l) => !list.entries.includes(l.trim()));
  if (kept.length !== lines.length) writeFile(list.file, kept.join('\n'));
}

/** The local exclude file and the entries for `files` in it, or null outside a repo. */
function localExcludes(cwd, files) {
  const out = files.length ? git(cwd, ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude']) : null;
  if (!out) return null;
  const [root, excludePath] = out.split('\n');
  const file = path.resolve(cwd, excludePath);
  // Anchored at the repo root. realpath: git reports the root with symlinks resolved.
  const entries = [...new Set(files.map((f) => '/' + path.relative(root, fs.realpathSync(f)).split(path.sep).join('/')))];
  return { file, existing: readText(file) || '', entries };
}

function git(cwd, args) {
  try {
    // trimEnd, not trim: `git status --porcelain` lines start with a significant space.
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  } catch {
    return null;
  }
}

/** The branch this one most likely came from: origin's default branch, else main/master/develop. */
function baseBranch(cwd, branch) {
  const originHead = git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [originHead && originHead.replace(/^origin\//, ''), 'main', 'master', 'develop'].filter(Boolean);
  return candidates.find((b) => b !== branch && git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null);
}

/** Whether the checked-out commit includes `branch`'s latest commit, as a branch made from it does. */
function contains(cwd, branch) {
  return gitAvailable() && git(cwd, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD']) !== null;
}

/** Whether git tracks the file, so your changes to it get committed. False outside a repo. */
function isTracked(cwd, file) {
  return gitAvailable() && git(cwd, ['ls-files', '--error-unmatch', '--', file]) !== null;
}

/** Local branches, most recently committed first. Empty outside git. */
function localBranches(cwd) {
  const out = gitAvailable() ? git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']) : null;
  return out ? out.split('\n').filter(Boolean) : [];
}

const STATUS_LABELS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '??': 'untracked' };
const MAX_LIST = 25;

/**
 * A one-time read of the repo that several checks share, so git runs a handful of times
 * per handoff rather than once per file. Returns null outside git or when git can't run.
 * @param {string} cwd
 * @param {string[]} ownFiles  files CarryContext itself writes, left out of the status
 */
function gitView(cwd, ownFiles = []) {
  if (!gitDir(cwd) || !gitAvailable()) return null;
  const branch = currentBranch(cwd);
  const root = git(cwd, ['rev-parse', '--show-toplevel']) || cwd;
  const base = branch && !branch.startsWith('detached-') ? baseBranch(cwd, branch) : null;
  const aheadText = base ? git(cwd, ['rev-list', '--count', `${base}..HEAD`]) : null;
  const ahead = aheadText ? Number(aheadText) : 0;

  const own = new Set(ownFiles.map((f) => path.relative(root, f).split(path.sep).join('/')));
  /** @type {Map<string, string>} file -> label ("modified", "untracked", ...) */
  const status = new Map();
  // Our own files aren't project changes. "all" lists files inside new folders individually.
  for (const l of (git(cwd, ['status', '--porcelain', '--untracked-files=all']) || '').split('\n')) {
    const file = l.slice(3).replace(/^.* -> /, '');
    if (!l || file.startsWith('.carrycontext/') || own.has(file)) continue;
    const code = l.slice(0, 2).trim() || 'M';
    status.set(file, STATUS_LABELS[code] || STATUS_LABELS[code[0]] || 'changed');
  }

  // Files changed in recent history count as real changes too.
  const committed = new Set();
  const range = ahead ? [`${base}...HEAD`] : ['HEAD~10..HEAD'];
  for (const f of (git(cwd, ['diff', '--name-only', ...range]) || git(cwd, ['log', '-10', '--name-only', '--format=']) || '').split('\n')) {
    if (f) committed.add(f);
  }

  const relative = (f) => path.relative(root, path.resolve(cwd, f)).split(path.sep).join('/');
  return {
    root,
    branch,
    base,
    ahead,
    status,
    /** repo-relative path, or null when the file is outside the repo */
    relative: (f) => {
      const r = relative(f);
      return r && !r.startsWith('..') ? r : null;
    },
    changeOf: (rel) => (status.has(rel) ? `uncommitted change (${status.get(rel)})` : committed.has(rel) ? 'changed in recent commits' : null),
    isIgnored: (rel) => git(root, ['check-ignore', '-q', '--', rel]) !== null,
    commitExists: (sha) => git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null,
    /** Short sha of the latest commit touching rel at or after an ISO time, or null. */
    committedSince: (rel, iso) => git(root, ['log', '-1', '--format=%h', `--since=${iso}`, '--', rel]) || null,
    log: (args) => git(cwd, args),
  };
}

/**
 * Markdown "Repository state" from git: branch, last commit, uncommitted changes and
 * branch commits. Returns '' outside git or when git can't run.
 * @param {string} cwd
 * @param {ReturnType<typeof gitView>} [view]
 */
function repoState(cwd, view = gitView(cwd)) {
  if (!view) return '';
  const { branch, base, ahead, status } = view;
  const lines = [`- **Branch:** \`${branch}\`${ahead ? ` (${ahead} commit${ahead === 1 ? '' : 's'} ahead of \`${base}\`)` : ''}`];

  const last = view.log(['log', '-1', '--format=%h%x09%s%x09%cr']);
  if (last) {
    const [sha, subject, when] = last.split('\t');
    lines.push(`- **Last commit:** \`${sha}\` ${subject} (${when})`);
  } else {
    lines.push('- **Last commit:** none yet');
  }

  if (status.size) {
    const counts = {};
    for (const label of status.values()) counts[label] = (counts[label] || 0) + 1;
    const items = [...status].map(([file, label]) => `  - ${label}: \`${file}\``);
    lines.push(`- **Uncommitted changes:** ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`, ...items.slice(0, MAX_LIST));
    if (items.length > MAX_LIST) lines.push(`  - … ${items.length - MAX_LIST} more`);
  } else {
    lines.push('- **Uncommitted changes:** none (working tree clean)');
  }

  if (ahead) {
    const commits = (view.log(['log', '--format=%h %s', `${base}..HEAD`, '-n', '10']) || '').split('\n').filter(Boolean);
    lines.push(`- **Commits on this branch:**`, ...commits.map((c) => `  - \`${c.slice(0, c.indexOf(' '))}\` ${c.slice(c.indexOf(' ') + 1)}`));
  }

  return `_Read from git when this handoff was written. Check it again before relying on it._\n\n${lines.join('\n')}`;
}

module.exports = { gitDir, headFile, currentBranch, branchAt, contains, isTracked, localBranches, branchSlug, gitAvailable, gitView, repoState, excludeLocally, includeLocally };
