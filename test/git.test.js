const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, hasGit, git } = require('./helpers/env');

const env = sandbox();
const g = require('../src/core/git');
test.after(() => env.cleanup());

const skip = !hasGit && 'git is not installed';

test('currentBranch is null outside git', () => {
  assert.equal(g.currentBranch(env.project()), null);
});

test('currentBranch reads branches with slashes, from subfolders too', { skip }, () => {
  const repo = env.project({ git: true });
  git(repo, 'checkout', '-q', '-b', 'feature/payments');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  assert.equal(g.currentBranch(repo), 'feature/payments');
  assert.equal(g.currentBranch(path.join(repo, 'src', 'deep')), 'feature/payments');
});

test('currentBranch handles detached HEAD and worktrees', { skip }, () => {
  const repo = env.project({ git: true });
  const sha = git(repo, 'rev-parse', '--short=7', 'HEAD');
  const wt = path.join(env.root, 'worktree');
  git(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  assert.equal(g.currentBranch(wt), 'wt-branch');
  git(repo, 'checkout', '-q', '--detach');
  assert.equal(g.currentBranch(repo), `detached-${sha}`);
});

test('branchSlug makes folder-safe names that cannot escape a directory', () => {
  assert.equal(g.branchSlug('feature/pay ments#2'), 'feature__pay-ments-2');
  for (const evil of ['../../etc', '..\\..\\x', 'a/../../b']) {
    const slug = g.branchSlug(evil);
    assert.ok(!slug.includes('/') && !slug.includes('\\'), slug);
    assert.equal(path.dirname(path.join('/base', slug)), '/base');
  }
});

test('repoState: branch, ahead count, changes, and own files hidden', { skip }, () => {
  const repo = env.project({ git: true });
  git(repo, 'checkout', '-q', '-b', 'feature/pay');
  fs.writeFileSync(path.join(repo, 'pay.js'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'Add pay');
  fs.appendFileSync(path.join(repo, 'README.md'), 'more');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'n');
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.writeFileSync(path.join(repo, '.claude', 'handoff.md'), 'ours');

  const state = g.repoState(repo, [], [path.join(repo, '.claude', 'handoff.md')]);
  assert.match(state, /\*\*Branch:\*\* `feature\/pay` \(1 commit ahead of `main`\)/);
  assert.match(state, /Last commit:\*\* `[0-9a-f]+` Add pay/);
  assert.match(state, /modified: `README\.md`/); // first status line keeps its full name
  assert.match(state, /untracked: `notes\.md`/);
  assert.doesNotMatch(state, /handoff\.md/);
});

test('repoState flags claimed edits git shows no change for, except ignored files', { skip }, () => {
  const repo = env.project({ git: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed');
  const state = g.repoState(repo, [path.join(repo, 'README.md'), path.join(repo, 'ghost.js'), path.join(repo, '.env')]);
  const flagged = state.split('**Check these:**')[1] || '';
  assert.match(flagged, /ghost\.js/);
  assert.doesNotMatch(flagged, /README\.md/);
  assert.doesNotMatch(flagged, /\.env/);
});

test('repoState is empty outside git', () => {
  assert.equal(g.repoState(env.project()), '');
});
