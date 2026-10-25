const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sandbox, hasGit, git, read } = require('./helpers/env');
const { writeClaude, standardConversation } = require('./helpers/sessions');

const env = sandbox();
const { DEFAULTS } = require('../src/core/config');
const hooks = require('../src/core/claudeHooks');
const h = require('../src/core/handoff');
test.after(() => env.cleanup());

const CLI = path.join(__dirname, '..', 'bin', 'carrycontext.js');
const settings = (cwd) => JSON.parse(read(path.join(cwd, '.claude', 'settings.local.json')));
const runHook = (cwd, arg, input = '') =>
  execFileSync('sh', [path.join(cwd, '.carrycontext', 'hooks', 'claude-hook.sh'), arg], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });

test('install registers three hooks and the /compact-all command, idempotently', () => {
  const cwd = env.project();
  hooks.installClaudeHooks(cwd, CLI, process.execPath);
  hooks.installClaudeHooks(cwd, CLI, process.execPath);
  const s = settings(cwd);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart']);
  for (const entries of Object.values(s.hooks)) assert.equal(entries.length, 1);
  assert.equal(s.hooks.SessionStart[0].matcher, 'startup|clear|compact');
  assert.ok(fs.existsSync(path.join(cwd, '.claude', 'commands', 'compact-all.md')));
  assert.ok(hooks.hooksInstalled(cwd));
});

test("upgrading changes only CarryContext's entries and never adds missing events", () => {
  const cwd = env.project();
  const old = {
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      SessionStart: [
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] },
        { matcher: 'startup|clear', hooks: [{ type: 'command', command: 'sh "$CLAUDE_PROJECT_DIR/.carrycontext/hooks/claude-hook.sh" session-start' }] },
      ],
    },
  };
  fs.mkdirSync(path.join(cwd, '.claude'));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify(old));
  hooks.updateHookSettings(cwd, false);
  const s = settings(cwd);
  assert.deepEqual(s.permissions, old.permissions);
  assert.deepEqual(Object.keys(s.hooks), ['SessionStart']);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, 'echo mine');
  assert.equal(s.hooks.SessionStart[1].matcher, 'startup|clear|compact');
});

test('a user-edited /compact-all command is not overwritten', () => {
  const cwd = env.project();
  const cmd = path.join(cwd, '.claude', 'commands', 'compact-all.md');
  fs.mkdirSync(path.dirname(cmd), { recursive: true });
  fs.writeFileSync(cmd, 'my own version');
  hooks.installClaudeHooks(cwd, CLI, process.execPath);
  assert.equal(read(cmd), 'my own version');
});

test('processPayload: a payload is handled exactly once, even when two workers race', async () => {
  const cwd = env.project();
  const transcript = writeClaude(cwd, 'race', standardConversation(cwd));
  const inbox = path.join(cwd, '.carrycontext', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const payload = path.join(inbox, 'claude-1.json');
  fs.writeFileSync(payload, JSON.stringify({ transcript_path: transcript, hook_event_name: 'PreCompact', trigger: 'auto' }));
  const results = await Promise.all([
    hooks.processPayload(cwd, payload, DEFAULTS, async () => undefined),
    hooks.processPayload(cwd, payload, DEFAULTS, async () => undefined),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(fs.readdirSync(inbox), []);
  assert.match(read(path.join(cwd, '.carrycontext', 'handoff.md')), /Trigger:\*\* claude:PreCompact:auto/);
});

test('hook script: update and session-start round trip', { skip: process.platform === 'win32' }, () => {
  const cwd = env.project();
  const transcript = writeClaude(cwd, 'hook', standardConversation(cwd));
  hooks.installClaudeHooks(cwd, CLI, process.execPath);
  runHook(cwd, 'update', JSON.stringify({ transcript_path: transcript, hook_event_name: 'SessionEnd', reason: 'exit' }));
  assert.match(runHook(cwd, 'session-start'), /^<!-- carrycontext:handoff v1 -->[\s\S]*Build the payments page/);
});

test('hook script: session-start loads the checked-out branch, even without Node', { skip: (process.platform === 'win32' || !hasGit) && 'needs sh and git' }, async () => {
  const cwd = env.project({ git: true });
  const file = writeClaude(cwd, 'br', [{ role: 'user', text: 'Main work', branch: 'main' }]);
  const session = { adapter: require('../src/providers').getProvider('claude'), ref: { provider: 'claude', id: 'br', path: file, updatedAt: Date.now() } };
  await h.updateHandoff({ cwd, sessions: [session], trigger: 't', config: DEFAULTS, getApiKey: async () => undefined });
  git(cwd, 'checkout', '-q', '-b', 'side');
  h.activateBranch(cwd, DEFAULTS); // .claude/handoff.md is now "side"
  git(cwd, 'checkout', '-q', 'main');

  hooks.installClaudeHooks(cwd, '/nonexistent/cli.js', '/nonexistent/node'); // forces the sh-only path
  const out = execFileSync('sh', [path.join(cwd, '.carrycontext', 'hooks', 'claude-hook.sh'), 'session-start'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, PATH: '/usr/bin:/bin' },
  });
  assert.match(out, /^# Handoff: .* \(main\)$/m);
});
