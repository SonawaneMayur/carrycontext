const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers/env');
const { standardConversation, SESSION_WRITERS, writeClaude, writeCodex } = require('./helpers/sessions');

const env = sandbox();
const { listProviders, getProvider, registerProvider } = require('../src/providers');
test.after(() => env.cleanup());

// Contract: every provider that can read sessions must pass these with the standard conversation.
for (const provider of listProviders().filter((p) => p.listSessions)) {
  test(`contract: ${provider.id} lists and reads its sessions`, async () => {
    const write = SESSION_WRITERS[provider.id];
    assert.ok(write, `add a session writer for "${provider.id}" to test/helpers/sessions.js`);
    const cwd = env.project();
    write(cwd, `${provider.id}-session-1`, standardConversation(cwd));

    const sessions = await provider.listSessions(cwd);
    assert.equal(sessions.length, 1, 'finds exactly the session for this folder');
    assert.equal(sessions[0].provider, provider.id);
    assert.ok(sessions[0].updatedAt > 0);

    const messages = await provider.readSession(sessions[0]);
    const users = messages.filter((m) => m.role === 'user').map((m) => m.text);
    assert.deepEqual(users, ['Build the payments page', 'Now add tests'], 'injected noise is filtered out');
    assert.ok(messages.some((m) => m.role === 'assistant' && /Tests added/.test(m.text)));
    const tools = messages.flatMap((m) => m.tools || []);
    assert.ok(JSON.stringify(tools).includes('pay.js'), 'file edits are visible as tool calls');
    const testRun = tools.find((t) => JSON.stringify(t.input).includes('npm test'));
    assert.ok(testRun, 'shell commands are visible as tool calls');
    assert.equal(testRun.ok, true, 'tool results are attached to their calls (needed for verification)');
    assert.ok(messages.every((m) => m.provider === provider.id));
  });

  test(`contract: ${provider.id} ignores sessions from other folders`, async () => {
    const mine = env.project();
    const other = env.project();
    SESSION_WRITERS[provider.id](other, `${provider.id}-other`, standardConversation(other));
    assert.deepEqual(await provider.listSessions(mine), []);
  });

  test(`contract: ${provider.id} returns only the newest sessions when given a limit`, async () => {
    const cwd = env.project();
    const older = SESSION_WRITERS[provider.id](cwd, `${provider.id}-older`, standardConversation(cwd));
    const newer = SESSION_WRITERS[provider.id](cwd, `${provider.id}-newer`, standardConversation(cwd));
    const now = Date.now() / 1000;
    fs.utimesSync(older, now - 60, now - 60);
    fs.utimesSync(newer, now, now);
    assert.deepEqual((await provider.listSessions(cwd, { limit: 1 })).map((s) => s.path), [newer]);
    assert.equal((await provider.listSessions(cwd)).length, 2);
  });
}

// Contract: every provider that can receive a handoff names a file inside the project.
for (const provider of listProviders().filter((p) => p.target)) {
  test(`contract: ${provider.id} handoff target stays inside the project`, () => {
    const cwd = env.project();
    for (const file of [provider.target.handoffFile(cwd), provider.target.instructionsFile?.(cwd)].filter(Boolean)) {
      assert.ok(!path.relative(cwd, file).startsWith('..'), `${file} escapes the project`);
    }
  });
}

test('claude: strips IDE tags and harness noise, reads titles and branches', async () => {
  const cwd = env.project();
  writeClaude(
    cwd,
    'c1',
    [
      { role: 'user', text: '<ide_opened_file>The user opened x.js</ide_opened_file>Fix the bug', branch: 'feature/x' },
      { role: 'user', text: '<command-name>/clear</command-name>' },
      { role: 'assistant', text: 'Fixed', branch: 'feature/x' },
    ],
    { title: 'Bug fixing' },
  );
  const claude = getProvider('claude');
  const [ref] = await claude.listSessions(cwd);
  const messages = await claude.readSession(ref);
  assert.deepEqual(messages.map((m) => m.text), ['Fix the bug', 'Fixed']);
  assert.equal(ref.title, 'Bug fixing');
  assert.ok(messages.every((m) => m.branch === 'feature/x'));
});

test('claude: background-task notices and interruption markers are not prompts', async () => {
  const cwd = env.project();
  writeClaude(cwd, 'n1', [
    { role: 'user', text: 'Refactor the parser' },
    { role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' },
    { role: 'user', text: '[Request interrupted by user for tool use]' },
    { role: 'user', text: '[Request interrupted by user]' },
  ]);
  const claude = getProvider('claude');
  const [ref] = await claude.listSessions(cwd);
  assert.deepEqual((await claude.readSession(ref)).map((m) => m.text), ['Refactor the parser']);
});

test('claude: work recorded on "HEAD" (no branch checked out) stays with the branch the session was on', async () => {
  const cwd = env.project();
  writeClaude(cwd, 'rebase', [
    { role: 'user', text: 'Rebase onto main', branch: 'feature/x' },
    { role: 'assistant', text: 'Resolving conflicts', branch: 'HEAD' },
  ]);
  writeClaude(cwd, 'detached', [{ role: 'user', text: 'Look at this old commit', branch: 'HEAD' }]);
  const claude = getProvider('claude');
  const sessions = await claude.listSessions(cwd);
  const branches = async (id) => (await claude.readSession(sessions.find((s) => s.id === id))).map((m) => m.branch);
  assert.deepEqual(await branches('rebase'), ['feature/x', 'feature/x']);
  assert.deepEqual(await branches('detached'), [undefined], 'no branch yet: it goes to the checked-out one');
});

test('codex: takes the branch from session metadata', async () => {
  const cwd = env.project();
  writeCodex(cwd, 'x1', standardConversation(cwd), { branch: 'release' });
  const codex = getProvider('codex');
  const [ref] = await codex.listSessions(cwd);
  assert.ok((await codex.readSession(ref)).every((m) => m.branch === 'release'));
});

test('gemini: falls back to logs.json (user prompts only) on older CLI versions', async () => {
  const cwd = env.project();
  const crypto = require('crypto');
  const dir = path.join(env.home, '.gemini', 'tmp', crypto.createHash('sha256').update(cwd).digest('hex'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs.json'), JSON.stringify([{ type: 'user', message: 'Old style prompt', timestamp: 't' }]));
  const gemini = getProvider('gemini');
  const [ref] = await gemini.listSessions(cwd);
  assert.deepEqual((await gemini.readSession(ref)).map((m) => m.text), ['Old style prompt']);
});

test('registerProvider adds a provider that the registry returns', () => {
  registerProvider({ id: 'test-target', label: 'Test', target: { handoffFile: (cwd) => path.join(cwd, '.test', 'handoff.md') } });
  assert.equal(getProvider('test-target').label, 'Test');
});
