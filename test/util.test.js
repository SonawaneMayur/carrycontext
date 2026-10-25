const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sandbox, read } = require('./helpers/env');

const env = sandbox();
const util = require('../src/core/util');
test.after(() => env.cleanup());

test('shortenPaths: project root becomes ".", home becomes "~"', () => {
  const cwd = path.join(env.home, 'projects', 'app');
  const text = `${cwd}/src/a.js and ${cwd} and ${env.home}/other/b.js and ${env.home}`;
  assert.equal(util.shortenPaths(text, cwd), './src/a.js and . and ~/other/b.js and ~');
});

test('shortenPaths: covers the dash-encoded folder names Claude Code uses', () => {
  const encoded = env.home.replace(/[^a-zA-Z0-9]/g, '-');
  assert.equal(util.shortenPaths(`projects/${encoded}-projects-app/x.jsonl`, '/nowhere'), 'projects/-~-projects-app/x.jsonl');
});

test('tildify hides the home folder', () => {
  assert.equal(util.tildify(path.join(env.home, '.claude', 'x')), '~/.claude/x');
});

test('upsertManagedBlock creates, replaces and never touches user content', () => {
  const file = path.join(env.root, 'AGENTS.md');
  fs.writeFileSync(file, '# My rules\n\nBe nice.\n');
  util.upsertManagedBlock(file, 'first');
  util.upsertManagedBlock(file, 'second $& $1'); // $-patterns must be inserted literally
  const text = read(file);
  assert.match(text, /^# My rules\n\nBe nice\.\n/);
  assert.equal(text.match(/carrycontext:start/g).length, 1);
  assert.match(text, /second \$& \$1/);
  assert.doesNotMatch(text, /first/);
});

test('readJsonl skips malformed and partial lines', () => {
  const file = path.join(env.root, 'x.jsonl');
  fs.writeFileSync(file, '{"a":1}\nnot json\n{"b":2}\n{"c":');
  assert.deepEqual(util.readJsonl(file), [{ a: 1 }, { b: 2 }]);
});

test('truncate keeps short text and marks long text', () => {
  assert.equal(util.truncate('short', 10), 'short');
  assert.match(util.truncate('x'.repeat(20), 5), /^x{5}… \[truncated 15 chars\]$/);
});

test('shellQuote produces one literal word, even with quotes and $()', { skip: process.platform === 'win32' }, () => {
  const nasty = `it's "$(echo pwned)" \`id\` $HOME`;
  const out = execFileSync('sh', ['-c', `printf %s ${util.shellQuote(nasty)}`], { encoding: 'utf8' });
  assert.equal(out, nasty);
});

test('ago formats relative times', () => {
  assert.equal(util.ago(Date.now()), 'just now');
  assert.equal(util.ago(Date.now() - 5 * 60000), '5m ago');
  assert.equal(util.ago(Date.now() - 3 * 3600000), '3h ago');
  assert.equal(util.ago(Date.now() - 2 * 86400000), '2d ago');
});
