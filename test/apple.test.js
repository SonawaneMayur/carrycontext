// The Apple on-device client. The fake helper (test/fixtures/fake-apple-helper.py) runs inside
// the same macOS sandbox as the real one, so these tests prove the sandbox blocks writes,
// network and home-folder reads, and that prompts and keys don't leak into argv or the
// environment. A last test runs the real model when this Mac has it (never in CI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sandbox } = require('./helpers/env');

const env = sandbox();
process.env.CARRYCONTEXT_CACHE_DIR = path.join(env.root, 'cache');
// The sandbox blocks reads in the home folder, where this repo lives, so the fake helper is
// copied to the test's temp folder first, just as the real helper lives outside home.
const FAKE = path.join(env.root, 'fake-apple-helper.py');
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-apple-helper.py'), FAKE);
fs.chmodSync(FAKE, 0o755);
test.after(() => env.cleanup());

const isMac = process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 25;
const hasDevTools = (() => {
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// The protocol and sandbox tests need a Mac where the sandbox can be applied (some virtual
// machines don't allow it) and where the fake helper can start inside it.
const canSandbox = (() => {
  if (!isMac || !hasDevTools) return false;
  try {
    const profile = require('../src/llm/apple').PROFILE_FOR_TESTS;
    execFileSync('/usr/bin/sandbox-exec', ['-D', `HOME=${os.userInfo().homedir}`, '-p', profile, FAKE, '--status'], {
      stdio: 'pipe',
      timeout: 20000,
      env: { PATH: '/usr/bin:/bin', HOME: os.userInfo().homedir },
    });
    return true;
  } catch {
    return false;
  }
})();
const macOnly = !canSandbox && 'needs macOS 26, the developer tools, and a Mac that allows the sandbox';

/** Load a fresh copy of the client so each test controls the environment it reads. */
function client({ fake = true, timeoutMs } = {}) {
  if (fake) process.env.CARRYCONTEXT_APPLE_HELPER = FAKE;
  else delete process.env.CARRYCONTEXT_APPLE_HELPER;
  if (timeoutMs) process.env.CARRYCONTEXT_APPLE_TIMEOUT_MS = String(timeoutMs);
  else delete process.env.CARRYCONTEXT_APPLE_TIMEOUT_MS;
  delete require.cache[require.resolve('../src/llm/apple')];
  return require('../src/llm/apple');
}
const ask = (apple, prompt, system = 'sys') => apple.complete({ model: 'system', system, prompt });

test('refuses to run anywhere it cannot sandbox the helper (fails closed)', { skip: canSandbox && 'the sandbox works here' }, async () => {
  const apple = client();
  const status = await apple.status();
  assert.equal(status.ready, false);
  assert.ok(['platform', 'sandbox', 'toolchain'].includes(status.code), status.code);
  await assert.rejects(ask(apple, 'hello'), (e) => ['platform', 'sandbox'].includes(e.code));
});

test('protocol: status, text and structured answers', { skip: macOnly }, async () => {
  const apple = client();
  assert.deepEqual(await apple.status(), { ready: true, contextSize: 4096 });
  assert.equal(await ask(apple, 'hello', 'be brief'), 'echo:be brief|hello');
  assert.deepEqual(await apple.completeJson({ system: 's', prompt: 'p', schema: { type: 'object' } }), { schemaType: 'object' });
});

test('the prompt goes through stdin, never the command line', { skip: macOnly }, async () => {
  const argv = JSON.parse(await ask(client(), 'MODE:argv SECRET-PROMPT-TEXT'));
  assert.ok(!JSON.stringify(argv).includes('SECRET-PROMPT-TEXT'), argv);
});

test('the helper gets an empty environment, so shell API keys never reach it', { skip: macOnly }, async () => {
  const canaries = { OPENAI_API_KEY: 'sk-should-not-leak', ANTHROPIC_API_KEY: 'sk-ant-should-not-leak', CARRYCONTEXT_CANARY: 'x' };
  Object.assign(process.env, canaries);
  try {
    const keys = JSON.parse(await ask(client(), 'MODE:env'));
    // Variables passed on from CarryContext's own environment, other than PATH and HOME.
    // (The fake's Python launcher adds toolchain variables such as SDKROOT itself; those
    // didn't come from us, and the real helper, a compiled program, doesn't get them.)
    const inherited = Object.keys(canaries).filter((k) => keys.includes(k));
    assert.deepEqual(inherited, [], `leaked into the helper: ${inherited.join(', ')}`);
  } finally {
    for (const k of Object.keys(canaries)) delete process.env[k];
  }
});

test('the sandbox blocks file writes', { skip: macOnly }, async () => {
  const target = path.join(env.root, 'written-by-helper.txt');
  assert.match(await ask(client(), `MODE:write:${target}`), /^blocked:/);
  assert.equal(fs.existsSync(target), false);
});

test('the sandbox blocks network access, even to this machine', { skip: macOnly }, async () => {
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    s.destroy();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = /** @type {net.AddressInfo} */ (server.address());
    assert.match(await ask(client(), `MODE:net:${port}`), /^blocked:/);
    assert.equal(connections, 0);
  } finally {
    server.close();
  }
});

test('the sandbox blocks reading your home folder', { skip: macOnly }, async () => {
  assert.match(await ask(client(), 'MODE:readhome'), /^blocked:/);
});

test('errors carry codes and numbers, with a fix for the user', { skip: macOnly }, async () => {
  const apple = client();
  await assert.rejects(ask(apple, 'MODE:context'), (e) => e.code === 'context' && e.tokens === 9000 && e.limit === 4096);
  await assert.rejects(ask(apple, 'MODE:unavailable'), (e) => e.code === 'appleIntelligenceNotEnabled' && /System Settings/.test(e.message));
  await assert.rejects(ask(apple, 'MODE:garbage'), /unreadable answer/);
});

test('a hung helper is killed after the timeout', { skip: macOnly }, async () => {
  const start = Date.now();
  await assert.rejects(ask(client({ timeoutMs: 500 }), 'MODE:sleep'), (e) => e.code === 'timeout');
  assert.ok(Date.now() - start < 10000);
});

test('summaries fit the small context: too-long prompts are retried once, shrunk', { skip: macOnly }, async () => {
  client(); // the registry loads the client with the fake helper
  delete require.cache[require.resolve('../src/llm')];
  delete require.cache[require.resolve('../src/core/summarize')];
  const { llmSections } = require('../src/core/summarize');
  const messages = Array.from({ length: 300 }, (_, i) => ({ role: 'user', text: `MODE:fit message ${i} ${'x'.repeat(80)}`, provider: 'claude' }));
  const config = { summarizer: { provider: 'apple', model: '', baseUrl: '' }, maxTranscriptChars: 150000, redact: { enabled: true, extraPatterns: [] } };
  const sections = await llmSections(messages, '', config, undefined, '', env.root);
  const length = Number(sections.Goal.match(/prompt length (\d+)/)[1]);
  assert.ok(length <= 6000, `retry was not shrunk: ${length}`);
});

test('the registry lists the client as local, with no key and a small context', () => {
  delete require.cache[require.resolve('../src/llm')];
  const apple = require('../src/llm').getLlm('apple');
  assert.equal(apple.local, true);
  assert.ok(!apple.needsKey && !apple.envKey);
  assert.ok(apple.contextChars > 0 && apple.contextChars < 20000);
});

// The real model: only on a Mac where Apple Intelligence is on. Never in CI.
test('real model: builds a private helper and answers inside the sandbox', { skip: (macOnly || process.env.CI) && 'needs a Mac with Apple Intelligence (skipped in CI)' }, async (t) => {
  const apple = client({ fake: false });
  const status = await apple.status();
  if (!status.ready) return t.skip(`Apple model not available here: ${status.reason}`);
  const dir = process.env.CARRYCONTEXT_CACHE_DIR;
  const [helper] = fs.readdirSync(dir).filter((f) => f.startsWith('carrycontext-apple-'));
  assert.ok(helper, 'helper built into the cache folder');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, helper)).mode & 0o777, 0o700);

  const text = await ask(apple, 'Reply with the single word: ready', 'Answer with one word.');
  assert.ok(text.trim().length > 0);
  const json = await apple.completeJson({
    system: 'Extract the claims.',
    prompt: 'I edited src/a.js and the build passed.',
    schema: { type: 'object', required: ['claims'], properties: { claims: { type: 'array', items: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['file', 'build', 'other'] } } } } } },
  });
  assert.ok(Array.isArray(json.claims));
  assert.ok(json.claims.every((c) => ['file', 'build', 'other'].includes(c.kind)));
});
