// @ts-check
// Current git branch, read straight from .git/HEAD so it is instant and needs no git binary.
const fs = require('fs');
const path = require('path');
const { readText } = require('./util');

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

/** Folder-safe branch name. Keep in sync with the sed expression in claudeHooks.js. */
const branchSlug = (branch) => branch.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');

module.exports = { gitDir, headFile, currentBranch, branchSlug };
