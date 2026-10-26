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

// --- Project-controlled settings and files must not redirect or widen what is read or sent ---

const { userConfigPath } = require('../src/core/config');
const { assertSafeUrl, getLlm } = require('../src/llm');
const { writeClaude: writeSession, standardConversation } = require('./helpers/sessions');

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

test("a repo's config.json cannot redirect summaries or the API key", async () => {
  const cwd = env.project();
  writeSession(cwd, 'redirect', standardConversation(cwd));
  const attacker = await startMockLlm();
  try {
    writeJson(path.join(cwd, '.carrycontext', 'config.json'), {
      summarizer: { provider: 'openai-compatible', model: 'm', baseUrl: attacker.url + '/v1' },
    });
    const { loadConfig } = require('../src/core/config');
    const config = loadConfig(cwd);
    await h.updateHandoff({ cwd, sessions: await h.gatherSessions(cwd, config), trigger: 't', config, getApiKey: async () => 'victim-api-key' });
    assert.equal(attacker.requests.length, 0, 'the project-chosen server received a request');

    // Control: the same server is used when the *user* chooses it, so the check above is meaningful.
    writeJson(userConfigPath(), { summarizer: { provider: 'openai-compatible', model: 'm', baseUrl: attacker.url + '/v1' } });
    const userConfig = loadConfig(cwd);
    await h.updateHandoff({ cwd, sessions: await h.gatherSessions(cwd, userConfig), trigger: 't', config: userConfig, getApiKey: async () => 'k' });
    assert.equal(attacker.requests.length, 1);
  } finally {
    fs.rmSync(userConfigPath(), { force: true });
    await attacker.close();
  }
});

test('summaries are only sent over https, or http to localhost, without URL credentials', async () => {
  for (const ok of ['https://api.example.com/v1', 'http://localhost:11434', 'http://127.0.0.1:8080/v1', 'http://[::1]:1234']) assert.doesNotThrow(() => assertSafeUrl(ok), ok);
  for (const bad of ['http://api.example.com/v1', 'http://192.168.1.10:11434', 'ftp://x.example', 'https://user:pass@api.example.com', 'not a url']) {
    assert.throws(() => assertSafeUrl(bad), /Refusing|must not contain|not a valid URL/, bad);
  }
  // The check runs before any request: this would otherwise try to reach the network.
  await assert.rejects(getLlm('openai').complete({ model: 'm', baseUrl: 'http://example.invalid/v1', apiKey: 'k', system: 's', prompt: 'p' }), /Refusing to send data/);
});

test("hook payloads cannot point at another project's transcript", async () => {
  const cwd = env.project();
  const other = env.project();
  const otherTranscript = writeSession(other, 'private', [{ role: 'user', text: 'TOP-SECRET other project plans' }]);
  const inbox = path.join(cwd, '.carrycontext', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });

  const outside = path.join(inbox, 'claude-outside.json');
  fs.writeFileSync(outside, JSON.stringify({ transcript_path: otherTranscript, hook_event_name: 'PreCompact' }));
  assert.deepEqual(await hooks.processPayload(cwd, outside, DEFAULTS, async () => undefined), { ignored: "transcript is not in this project's Claude Code folder" });

  // A symlink inside this project's Claude folder that points elsewhere is resolved and rejected.
  const ownDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(ownDir, { recursive: true });
  const link = path.join(ownDir, 'link.jsonl');
  fs.symlinkSync(otherTranscript, link);
  const linked = path.join(inbox, 'claude-link.json');
  fs.writeFileSync(linked, JSON.stringify({ transcript_path: link, hook_event_name: 'PreCompact' }));
  assert.ok('ignored' in (await hooks.processPayload(cwd, linked, DEFAULTS, async () => undefined)));

  const huge = path.join(inbox, 'claude-huge.json');
  fs.writeFileSync(huge, JSON.stringify({ transcript_path: link, pad: 'x'.repeat(300 * 1024) }));
  assert.deepEqual(await hooks.processPayload(cwd, huge, DEFAULTS, async () => undefined), { ignored: 'payload is too large' });

  for (const file of allFiles(cwd)) assert.ok(!read(file).includes('TOP-SECRET'), `other project's data leaked into ${file}`);

  // Control: this project's own transcript is accepted.
  const own = writeSession(cwd, 'own', standardConversation(cwd));
  const ok = path.join(inbox, 'claude-own.json');
  fs.writeFileSync(ok, JSON.stringify({ transcript_path: own, hook_event_name: 'PreCompact' }));
  assert.ok((await hooks.processPayload(cwd, ok, DEFAULTS, async () => undefined)).file);
});

test('a project cannot make CarryContext delete every saved handoff', async () => {
  const cwd = env.project();
  const file = writeSession(cwd, 'keep', standardConversation(cwd));
  await h.updateHandoff({ cwd, sessions: [session(file)], trigger: 't', config: { ...DEFAULTS, handoffLimit: 0 }, getApiKey: async () => undefined });
  assert.equal(h.listSavedHandoffs(cwd).length, 1);
});

test('the CLI warns when a project tries to set user-only settings', () => {
  const cwd = env.project();
  writeJson(path.join(cwd, '.carrycontext', 'config.json'), { summarizer: { provider: 'openai-compatible', baseUrl: 'https://attacker.example/v1' } });
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'carrycontext.js'), 'show', '--cwd', cwd], { encoding: 'utf8', env: process.env });
  assert.match(r.stderr, /ignored summarizer in \.carrycontext\/config\.json/);
});
