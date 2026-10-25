// End-to-end security checks: what CarryContext writes to disk or sends to an LLM must never
// contain secrets, the user's home path or username, and its shell code must not be injectable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sandbox, allFiles, read } = require('./helpers/env');
const { writeClaude } = require('./helpers/sessions');
const { startMockLlm, MOCK_BASE_PATHS, sentText } = require('./helpers/mockLlm');
const { FAKE_SECRETS } = require('./helpers/fakeSecrets');

const env = sandbox();
const { DEFAULTS, saveConfig, loadConfig } = require('../src/core/config');
const h = require('../src/core/handoff');
const hooks = require('../src/core/claudeHooks');
test.after(() => env.cleanup());

const secrets = Object.values(FAKE_SECRETS);

/** A session that pastes every kind of secret and mentions absolute paths. */
function leakySession(cwd) {
  return writeClaude(cwd, 'leaky', [
    { role: 'user', text: `Use this key ${FAKE_SECRETS['openai-key']} and token ${FAKE_SECRETS['github-token']}. Never commit them.` },
    {
      role: 'assistant',
      text: `Configured ${cwd}/config.js with ${secrets.join(' ')} and postgres://admin:supersecret99@db/app. Notes in ${env.home}/notes.txt`,
      edits: [path.join(cwd, 'config.js')],
    },
  ]);
}

const session = (file) => ({ adapter: require('../src/providers').getProvider('claude'), ref: { provider: 'claude', id: 'leaky', path: file, updatedAt: Date.now() } });
const targets = ['claude', 'codex', 'gemini', 'copilot', 'cursor'];

function assertClean(text, where) {
  for (const s of secrets) assert.ok(!text.includes(s), `secret leaked into ${where}`);
  assert.ok(!text.includes('supersecret99'), `URL password leaked into ${where}`);
  assert.ok(!text.includes(env.home), `home path leaked into ${where}`);
}

test('no secret or home path reaches any file CarryContext writes', async () => {
  const cwd = env.project();
  const res = await h.updateHandoff({ cwd, sessions: [session(leakySession(cwd))], trigger: 't', config: { ...DEFAULTS, targets }, getApiKey: async () => undefined });
  const files = allFiles(cwd);
  assert.ok(files.length >= 8, 'handoff, named copy, 5 provider copies, instruction files');
  for (const file of files) assertClean(read(file), path.relative(cwd, file));
  assert.match(res.doc, /\*\*Redacted:\*\* \d+ secrets \(/);
});

test('the summarizer LLM never receives secrets or home paths', async () => {
  const cwd = env.project();
  const mock = await startMockLlm();
  try {
    const config = { ...DEFAULTS, summarizer: { provider: 'anthropic', model: 'm', baseUrl: mock.url + MOCK_BASE_PATHS.anthropic } };
    await h.updateHandoff({ cwd, sessions: [session(leakySession(cwd))], trigger: 't', config, getApiKey: async () => 'test-api-key' });
    assert.equal(mock.requests.length, 1);
    assertClean(sentText(mock.requests), 'the LLM request');
    for (const file of allFiles(cwd)) assert.ok(!read(file).includes('test-api-key'), `API key written to ${file}`);
  } finally {
    await mock.close();
  }
});

test('the bare username is masked in handoffs', { skip: os.userInfo().username.length < 6 && 'short usernames are not masked' }, async () => {
  const cwd = env.project();
  const name = os.userInfo().username;
  const file = writeClaude(cwd, 'u', [{ role: 'user', text: `My account is ${name}, set it up` }]);
  const res = await h.updateHandoff({ cwd, sessions: [session(file)], trigger: 't', config: DEFAULTS, getApiKey: async () => undefined });
  assert.ok(!new RegExp(`\\b${name}\\b`).test(res.doc));
  assert.match(res.doc, /<user>/);
});

test('config.json never stores API keys', () => {
  const cwd = env.project();
  saveConfig(cwd, loadConfig(cwd));
  const text = read(path.join(cwd, '.carrycontext', 'config.json'));
  assert.doesNotMatch(text, /apiKey|api_key|secret/i);
});

test('hook script paths cannot inject shell commands', { skip: process.platform === 'win32' }, () => {
  const cwd = env.project();
  const marker = path.join(env.root, 'PWNED');
  const evil = `/tmp/x"; touch ${marker}; echo "$(touch ${marker}2)\`touch ${marker}3\``;
  hooks.installClaudeHooks(cwd, evil, evil);
  execFileSync('sh', [path.join(cwd, '.carrycontext', 'hooks', 'claude-hook.sh'), 'session-start'], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, PATH: '/usr/bin:/bin' },
  });
  for (const f of [marker, `${marker}2`, `${marker}3`]) assert.ok(!fs.existsSync(f), `injection ran: ${f}`);
});

test('managed blocks never alter user content in instruction files', async () => {
  const cwd = env.project();
  const mine = '# Team rules\n\nAlways review PRs.\n';
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), mine);
  const file = leakySession(cwd);
  for (let i = 0; i < 3; i++) {
    await h.updateHandoff({ cwd, sessions: [session(file)], trigger: 't', config: DEFAULTS, getApiKey: async () => undefined });
  }
  const text = read(path.join(cwd, 'AGENTS.md'));
  assert.ok(text.startsWith(mine));
  assert.equal(text.match(/carrycontext:start/g).length, 1);
});

test('redaction can be disabled explicitly, and is on by default', async () => {
  const cwd = env.project();
  const file = writeClaude(cwd, 'r', [{ role: 'user', text: `key ${FAKE_SECRETS['stripe-key']}` }]);
  const on = await h.updateHandoff({ cwd, sessions: [session(file)], trigger: 't', config: DEFAULTS, getApiKey: async () => undefined });
  assert.ok(!on.doc.includes(FAKE_SECRETS['stripe-key']));
  const off = await h.updateHandoff({ cwd, sessions: [session(file)], trigger: 't', config: { ...DEFAULTS, redact: { enabled: false, extraPatterns: [] } }, getApiKey: async () => undefined });
  assert.ok(off.doc.includes(FAKE_SECRETS['stripe-key']));
});
