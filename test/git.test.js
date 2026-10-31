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

test('branchAt reads branch switches from the reflog file, without running git', () => {
  const cwd = env.project();
  const line = (sec, message) => `${'0'.repeat(40)} ${'1'.repeat(40)} A U Thor <author@example.com> ${sec} -0500\t${message}`;
  fs.mkdirSync(path.join(cwd, '.git', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  fs.writeFileSync(
    path.join(cwd, '.git', 'logs', 'HEAD'),
    [line(1000, 'commit (initial): First'), line(2000, 'checkout: moving from main to feature'), line(3000, 'checkout: moving from feature to 1a2b3c4d5e'), line(4000, 'checkout: moving from 1a2b3c4d5e to feature')].join('\n') + '\n',
  );
  const at = g.branchAt(cwd);
  assert.equal(at(500 * 1000), 'main', 'before the first switch, even before the first commit: the branch it left');
  assert.equal(at(2500 * 1000), 'feature');
  assert.equal(at(3500 * 1000), undefined, 'a detached checkout');
  assert.equal(at(5000 * 1000), 'feature');

  fs.writeFileSync(path.join(cwd, '.git', 'logs', 'HEAD'), line(1000, 'commit (initial): First') + '\n');
  assert.equal(g.branchAt(cwd)(0), 'feature', 'no switches: the current branch');
  assert.equal(g.branchAt(env.project())(0), undefined, 'outside git');
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

  const state = g.repoState(repo, g.gitView(repo, [path.join(repo, '.claude', 'handoff.md')]));
  assert.match(state, /\*\*Branch:\*\* `feature\/pay` \(1 commit ahead of `main`\)/);
  assert.match(state, /Last commit:\*\* `[0-9a-f]+` Add pay/);
  assert.match(state, /modified: `README\.md`/); // first status line keeps its full name
  assert.match(state, /untracked: `notes\.md`/);
  assert.doesNotMatch(state, /handoff\.md/);
});

test('gitView: changes, ignored files and commits', { skip }, () => {
  const repo = env.project({ git: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed');
  const view = g.gitView(repo);
  assert.match(view.changeOf('README.md'), /uncommitted change \(modified\)/);
  assert.equal(view.changeOf('ghost.js'), null);
  assert.equal(view.isIgnored('.env'), true);
  assert.equal(view.isIgnored('README.md'), false);
  assert.equal(view.commitExists(git(repo, 'rev-parse', '--short', 'HEAD')), true);
  assert.equal(view.commitExists('deadbee'), false);
  assert.equal(view.relative(path.join(env.root, 'outside.js')), null);
});

test('repoState is empty outside git', () => {
  assert.equal(g.repoState(env.project()), '');
});
