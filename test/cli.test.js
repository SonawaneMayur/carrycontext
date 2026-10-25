const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { sandbox, read } = require('./helpers/env');
const { writeClaude, standardConversation } = require('./helpers/sessions');

const env = sandbox();
test.after(() => env.cleanup());

const CLI = path.join(__dirname, '..', 'bin', 'carrycontext.js');
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env });

test('help lists every command', () => {
  const out = run();
  for (const cmd of ['compact-all', 'sync', 'activate', 'show', 'prompt', 'hook claude']) assert.match(out, new RegExp(cmd));
});

test('compact-all, show, prompt and sync work end to end', () => {
  const cwd = env.project();
  writeClaude(cwd, 'cli', standardConversation(cwd));
  assert.match(run('compact-all', '--cwd', cwd), /Wrote .*handoff\.md .* from claude/);
  assert.match(run('show', '--cwd', cwd), /## Goal\n\nBuild the payments page/);
  assert.match(run('prompt', 'codex', '--cwd', cwd), /^Read \.codex\/handoff\.md/);
  assert.match(run('sync', '--cwd', cwd), /\.claude\/handoff\.md/);
  assert.equal(read(path.join(cwd, '.gemini', 'handoff.md')), read(path.join(cwd, '.carrycontext', 'handoff.md')));
});

test('show explains what to do when there is no handoff yet', () => {
  assert.match(run('show', '--cwd', env.project()), /No handoff yet/);
});

test('an unknown hook source exits with an error', () => {
  assert.throws(() => execFileSync(process.execPath, [CLI, 'hook', 'nope'], { stdio: 'pipe', env: process.env }), /Unknown hook source/);
});
