const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, hasGit, git, read } = require('./helpers/env');
const { writeClaude, writeCodex, standardConversation } = require('./helpers/sessions');
const { startMockLlm, MOCK_BASE_PATHS } = require('./helpers/mockLlm');

const env = sandbox();
const { DEFAULTS } = require('../src/core/config');
const h = require('../src/core/handoff');
const { getProvider } = require('../src/providers');
test.after(() => env.cleanup());

const config = (over = {}) => ({ ...DEFAULTS, ...over, summarizer: { ...DEFAULTS.summarizer, ...(over.summarizer || {}) } });
const noKey = async () => undefined;
const claudeSession = (file) => ({ adapter: getProvider('claude'), ref: { provider: 'claude', id: path.basename(file, '.jsonl'), path: file, updatedAt: Date.now() } });

async function compact(cwd, cfg = config()) {
  return h.updateHandoff({ cwd, sessions: await h.gatherSessions(cwd, cfg), trigger: 'test', config: cfg, getApiKey: noKey });
}

test('outside git: writes the handoff, a named copy, provider copies and pointers', async () => {
  const cwd = env.project();
  writeClaude(cwd, 's1', standardConversation(cwd), { title: 'Payments page' });
  const res = await compact(cwd);

  const doc = read(path.join(cwd, '.carrycontext', 'handoff.md'));
  assert.match(doc, /^<!-- carrycontext:handoff v1 -->/);
  assert.match(doc, /## Goal\n\nBuild the payments page/);
  assert.doesNotMatch(doc, /\*\*Branch:\*\*/);
  assert.match(path.basename(res.sessionFile), /^claude-payments-page--now-add-tests\.md$/);
  for (const copy of ['.claude/handoff.md', '.codex/handoff.md', '.gemini/handoff.md']) assert.equal(read(path.join(cwd, copy)), doc, copy);
  assert.match(read(path.join(cwd, 'AGENTS.md')), /read `\.codex\/handoff\.md`/);
  assert.match(read(path.join(cwd, 'GEMINI.md')), /read `\.gemini\/handoff\.md`/);
  assert.match(read(path.join(cwd, '.carrycontext', '.gitignore')), /handoffs\//);
});

test('other recent sessions on the branch are listed, one line each with a link', async () => {
  const cwd = env.project();
  const save = (id, ask, reply, cfg = config()) => {
    const file = writeClaude(cwd, id, [{ role: 'user', text: ask }, { role: 'assistant', text: reply }]);
    return h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: cfg, getApiKey: noKey });
  };
  const others = (res) => (res.doc.split('## Other recent sessions\n\n')[1] || '').split('\n\n')[0];

  const pay = await save('pay-0001', 'Build the payments page', '**Payments page** is done and tested.');
  assert.equal(others(pay), '', 'nothing else saved yet: no section');
  const ask = await save('ask-0002', 'What exactly is a handoff?', 'A briefing note.');
  assert.match(others(ask), /^- \*\*Build the payments page\*\* · Build the payments page · 2 msgs · \d{4}-\d\d-\d\d \d\d:\d\d UTC · stopped at: "Payments page is done and tested\." · `\.carrycontext\/handoffs\/claude-build-the-payments-page--[\w-]+\.md`$/);
  assert.doesNotMatch(others(ask), /handoff\?/, 'the session being saved is not listed');

  const again = await save('pay-0001', 'Build the payments page', 'Added refunds.');
  assert.equal(others(again).split('\n').length, 1);
  assert.match(others(again), /^- \*\*What exactly is a handoff\?\*\*/, 'a session is listed once, by its latest save');

  const old = Date.now() / 1000 - 48 * 3600; // outside the 24h lookback
  for (const f of h.listSavedHandoffs(cwd)) fs.utimesSync(f.file, old, old);
  assert.equal(others(await save('pay-0001', 'Build the payments page', 'Done.')), '', 'old sessions are left out');

  for (let i = 0; i < 7; i++) await save(`cap${i}-000`, `Task number ${i}`, 'ok');
  assert.equal(others(await save('last-000', 'Last task', 'ok')).split('\n').length, 5, 'at most 5 are listed');
});

test('compact-all merges sessions from several providers in time order', async () => {
  const cwd = env.project();
  writeClaude(cwd, 'c', [{ role: 'user', text: 'Claude task', ts: '2026-10-25T09:00:00Z' }]);
  writeCodex(cwd, 'x', [{ role: 'user', text: 'Codex task', ts: '2026-10-25T09:30:00Z' }]);
  const res = await compact(cwd);
  assert.deepEqual(res.doc.match(/claude `|codex `/g), ['claude `', 'codex `']);
  assert.match(res.doc, /## Recent requests\n\n- Claude task\n- Codex task/);
  assert.match(path.basename(res.sessionFile), /^claude-codex-compact-all--/);
});

test('handoffLimit counts versions per session: every session keeps its latest', async () => {
  const cwd = env.project();
  for (let i = 0; i < 4; i++) {
    const file = writeClaude(cwd, `s${i}`, [{ role: 'user', text: `Distinct request number ${i}` }]);
    await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config({ handoffLimit: 2 }), getApiKey: noKey });
  }
  assert.equal(h.listSavedHandoffs(cwd).length, 4); // see test/catalog.test.js for versions
});

test('LLM summarizer: used when it works, heuristic fallback with a note when it fails', async () => {
  const cwd = env.project();
  writeClaude(cwd, 's', standardConversation(cwd));
  const mock = await startMockLlm();
  try {
    const ok = await compact(cwd, config({ summarizer: { provider: 'ollama', model: 'm', baseUrl: mock.url + MOCK_BASE_PATHS.ollama } }));
    assert.match(ok.doc, /\*\*Summarizer:\*\* ollama:m/);
    assert.match(ok.doc, /Mock goal/);
  } finally {
    await mock.close();
  }
  const failed = await compact(cwd, config({ summarizer: { provider: 'anthropic' } }));
  assert.match(failed.doc, /\*\*Summarizer:\*\* heuristic/);
  assert.match(failed.warning, /No API key for anthropic/);
});

test('per-branch: new branches inherit, switching restores, split sessions go to both', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  const file = writeClaude(cwd, 'b', [
    { role: 'user', text: 'Set up the skeleton', branch: 'main' },
    { role: 'assistant', text: 'Skeleton ready', branch: 'main' },
  ]);
  await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });

  git(cwd, 'checkout', '-q', '-b', 'feature/pay');
  const activated = h.activateBranch(cwd, config());
  assert.deepEqual([activated.branch, activated.inheritedFrom], ['feature/pay', 'main']);
  assert.match(read(path.join(cwd, '.claude', 'handoff.md')), /## Background\n\nBranched from `main`[\s\S]*Set up the skeleton/);

  fs.appendFileSync(
    file,
    JSON.stringify({ type: 'user', gitBranch: 'feature/pay', timestamp: '2026-10-25T12:00:00Z', message: { role: 'user', content: 'Add Stripe' } }) + '\n',
  );
  const res = await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });
  assert.deepEqual(res.branches.sort(), ['feature/pay', 'main']);
  const feature = read(path.join(cwd, '.carrycontext', 'handoff.md'));
  assert.match(feature, /## Goal\n\nAdd Stripe/);
  assert.match(feature, /## Background/); // kept until replaced
  assert.match(feature, /## Repository state/);
  assert.doesNotMatch(read(path.join(cwd, '.carrycontext', 'branches', 'main', 'handoff.md')), /Stripe/);

  git(cwd, 'checkout', '-q', 'main');
  assert.equal(h.activateBranch(cwd, config()).changed, true);
  assert.match(read(path.join(cwd, '.codex', 'handoff.md')), /^# Handoff: .* \(main\)$/m);
  assert.deepEqual([...new Set(h.listSavedHandoffs(cwd).map((s) => s.branch))].sort(), ['feature__pay', 'main']);
});

test('in git: provider copies are kept out of git through .git/info/exclude, once each', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'Ignore deps');
  writeClaude(cwd, 's', standardConversation(cwd));
  const cfg = config({ targets: ['claude', 'codex', 'gemini', 'copilot', 'cursor'] });
  await compact(cwd, cfg);
  await compact(cwd, cfg);

  const copies = ['.claude/handoff.md', '.codex/handoff.md', '.gemini/handoff.md', '.github/handoff.md', '.cursor/rules/handoff.mdc'];
  const exclude = read(path.join(cwd, '.git', 'info', 'exclude'));
  for (const copy of copies) assert.equal(exclude.split('\n').filter((l) => l === `/${copy}`).length, 1, copy);
  const untracked = git(cwd, 'status', '--porcelain', '--untracked-files=all');
  for (const copy of copies) assert.ok(!untracked.includes(copy), `${copy} is not offered to git`);
  assert.match(untracked, /AGENTS\.md/, 'instruction files are left to the user');
  assert.equal(read(path.join(cwd, '.gitignore')), 'node_modules/\n', "the user's .gitignore is untouched");
});

const SECRET_DOC = '<!-- carrycontext:handoff v1 -->\n# Handoff: app\n\n## Goal\n\nShip the secret plan\n';
const copilotOnly = () => ({ ...config(), targets: ['copilot'] });

test("Copilot: the whole handoff only in a file CarryContext alone writes, kept out of git; once it's yours, a pointer", { skip: !hasGit && 'git missing' }, () => {
  const cwd = env.project({ git: true });
  const instructions = path.join(cwd, '.github', 'copilot-instructions.md');
  const changes = () => git(cwd, 'status', '--porcelain', '--untracked-files=all');

  h.syncTargets(cwd, copilotOnly(), SECRET_DOC);
  assert.match(read(instructions), /Ship the secret plan/, 'inline, since Copilot Ask mode cannot open files');
  assert.equal(changes(), '', 'neither .github file would be committed');

  // You add your own text: it's your file now, so it gets a pointer and shows up in git again.
  fs.appendFileSync(instructions, '\nUse tabs.\n');
  h.syncTargets(cwd, copilotOnly(), SECRET_DOC);
  const text = read(instructions);
  assert.match(text, /Use tabs\./);
  assert.match(text, /read `\.github\/handoff\.md`/);
  assert.doesNotMatch(text, /Ship the secret plan/);
  assert.match(changes(), /\.github\/copilot-instructions\.md/, 'visible to git, so your text gets committed');
  assert.doesNotMatch(changes(), /handoff\.md/, 'the handoff copy stays out of git');
});

test('Copilot: a team instructions file in git gets only a pointer, never the conversation', { skip: !hasGit && 'git missing' }, () => {
  const cwd = env.project({ git: true });
  const instructions = path.join(cwd, '.github', 'copilot-instructions.md');
  fs.mkdirSync(path.dirname(instructions), { recursive: true });
  fs.writeFileSync(instructions, 'Team rules: write tests.\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'Team Copilot rules');

  h.syncTargets(cwd, copilotOnly(), SECRET_DOC);
  const text = read(instructions);
  assert.match(text, /Team rules: write tests\./);
  assert.match(text, /read `\.github\/handoff\.md`/);
  assert.doesNotMatch(text, /Ship the secret plan/);
  assert.match(read(path.join(cwd, '.github', 'handoff.md')), /Ship the secret plan/, 'the copy it points to has the handoff');
});

test('per-branch: switching back to main from a feature branch starts empty, not from the feature', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  h.activateBranch(cwd, config()); // on main, nothing saved yet
  git(cwd, 'checkout', '-q', '-b', 'feature/search');
  fs.writeFileSync(path.join(cwd, 'search.js'), 'x');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'Search');
  const file = writeClaude(cwd, 's', [
    { role: 'user', text: 'Build product search', branch: 'feature/search' },
    { role: 'assistant', text: 'Search works', branch: 'feature/search' },
  ]);
  await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });

  git(cwd, 'checkout', '-q', 'main'); // main doesn't contain feature/search's work
  const res = h.activateBranch(cwd, config());
  assert.deepEqual([res.branch, res.inheritedFrom], ['main', undefined]);
  const doc = read(path.join(cwd, '.carrycontext', 'handoff.md'));
  assert.match(doc, /^# Handoff: .* \(main\)$/m);
  assert.match(doc, /No saved context for `main` yet/);
  assert.doesNotMatch(doc, /product search|Branched from/);
  assert.match(read(path.join(cwd, '.claude', 'handoff.md')), /No saved context for `main` yet/, 'assistants get it too');
});

test('per-branch: messages without a branch go to the branch checked out when they were sent', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  const before = new Date(Date.now() - 60000).toISOString();
  git(cwd, 'checkout', '-q', '-b', 'feature/cart'); // recorded in .git/logs/HEAD with the time
  const after = new Date(Date.now() + 60000).toISOString();
  // No branch recorded, as in Gemini CLI's logs.
  const file = writeClaude(cwd, 'g', [
    { role: 'user', text: 'Plan the cart', ts: before },
    { role: 'assistant', text: 'Planned', ts: before },
    { role: 'user', text: 'Build the cart page', ts: after },
    { role: 'assistant', text: 'Built', ts: after },
  ]);
  const res = await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });
  assert.deepEqual(res.branches.sort(), ['feature/cart', 'main']);
  const main = read(path.join(cwd, '.carrycontext', 'branches', 'main', 'handoff.md'));
  assert.match(main, /Plan the cart/);
  assert.doesNotMatch(main, /Build the cart page/);
});

test('unsavedSessions: each conversation once idle, oldest first; every one on a branch switch', async () => {
  const cwd = env.project();
  const old = writeClaude(cwd, 'old', [{ role: 'user', text: 'Give me a tour' }, { role: 'assistant', text: 'Here it is' }]);
  const recent = writeClaude(cwd, 'recent', [{ role: 'user', text: 'Add search' }, { role: 'assistant', text: 'Working on it' }]);
  const ago = (s) => new Date(Date.now() - s * 1000);
  fs.utimesSync(old, ago(600), ago(600)); // you moved on 10 minutes ago
  fs.utimesSync(recent, ago(10), ago(10)); // still going
  const ids = async (opts = {}) => (await h.unsavedSessions(cwd, config(), { idleMs: 120000, ...opts })).map((s) => s.ref.id);

  assert.deepEqual(await ids(), ['old'], 'not only the newest conversation');
  assert.deepEqual(await ids({ switched: true }), ['old', 'recent'], 'a branch switch saves every one, oldest first');
  fs.utimesSync(recent, ago(300), ago(300));
  assert.deepEqual(await ids(), ['old', 'recent']);
  assert.deepEqual(await ids({ hooked: ['claude'] }), ['old'], "the hooks save Claude's newest conversation");
  assert.deepEqual(await ids({ hooked: ['claude'], switched: true }), ['old', 'recent'], 'no hook fires on a branch switch');
  await h.updateHandoff({ cwd, sessions: [claudeSession(old)], trigger: 't', config: config(), getApiKey: noKey });
  assert.deepEqual(await ids(), ['recent'], 'saved since its last change');
});

test('decision log accumulates across updates', async () => {
  const cwd = env.project();
  const file = writeClaude(cwd, 'd', [{ role: 'user', text: "Don't commit secrets ever." }]);
  await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: 't2', message: { role: 'user', content: 'Always use pnpm instead of npm.' } }) + '\n');
  const res = await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });
  const log = h.SECTIONS && require('../src/core/summarize').parseSections(res.doc)['Key decisions'];
  assert.equal(log.split('\n').length, 2);
  assert.match(log, /Don't commit secrets/);
  assert.match(log, /pnpm/);
});

test('resumePrompt points each provider at its own copy', () => {
  const cwd = env.project();
  assert.match(h.resumePrompt(cwd, 'codex'), /^Read \.codex\/handoff\.md\./);
  assert.match(h.resumePrompt(cwd, 'cursor'), /\.cursor\/rules\/handoff\.mdc/);
});
