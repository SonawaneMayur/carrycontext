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
  assert.doesNotMatch(untracked, /AGENTS\.md|GEMINI\.md/, "instruction files only CarryContext wrote (its pointer) aren't offered to git either");
  assert.equal(read(path.join(cwd, '.gitignore')), 'node_modules/\n', "the user's .gitignore is untouched");

  // Your own text makes it your file: it shows up in git again, so your text gets committed.
  fs.appendFileSync(path.join(cwd, 'AGENTS.md'), '\nTeam rule: run the tests before pushing.\n');
  await compact(cwd, cfg);
  assert.match(git(cwd, 'status', '--porcelain', '--untracked-files=all'), /AGENTS\.md/);
  assert.match(read(path.join(cwd, 'AGENTS.md')), /Team rule: run the tests before pushing\./);
});

test('a handoff warns when the chat is about another story than its branch', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  git(cwd, 'checkout', '-q', '-b', 'feature/24114362');
  const file = writeClaude(cwd, 'o', [
    { role: 'user', text: 'Build the Outlook utilities for story 24173551', branch: 'feature/24114362' },
    { role: 'assistant', text: 'Started', branch: 'feature/24114362' },
  ]);
  const res = await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });
  assert.match(res.doc, /⚠️ story 24173551 discussed on `feature\/24114362`: this branch is for story 24114362/);
  assert.match(res.doc, /- \*\*Verification:\*\* 0 verified, 1 unverified, 0 contradicted/);
});

test('Move a Question to a new chat: its own handoff and prompt, and it stays out of the chat it left', async () => {
  const cwd = env.project();
  const file = writeClaude(cwd, 'cart', [
    { role: 'user', text: 'Build the cart page' },
    { role: 'assistant', text: 'Cart page built' },
    { role: 'user', text: 'Side question: how do refunds work?' },
    { role: 'assistant', text: 'Refunds go through the payments API' },
  ]);
  const session = claudeSession(file);
  await h.updateHandoff({ cwd, sessions: [session], trigger: 't', config: config(), getApiKey: noKey }); // a version that includes it
  const questions = await h.recentQuestions(cwd, session);
  assert.deepEqual(questions.map((q) => q.text), ['Side question: how do refunds work?', 'Build the cart page'], 'newest first');

  const res = await h.moveQuestion({ cwd, config: config(), session, question: questions[0], to: { kind: 'new' }, getApiKey: noKey });
  assert.match(read(res.file), /## Goal\n\nSide question: how do refunds work\?/);
  assert.match(read(res.file), /Refunds go through the payments API/, 'with the answer so far');
  assert.match(res.prompt, /^Read \.carrycontext\/handoffs\/.+\.md\. It is a question moved here from another chat/);
  const handoff = () => read(path.join(cwd, '.carrycontext', 'handoff.md'));
  assert.match(handoff(), /Build the cart page/);
  assert.doesNotMatch(handoff(), /refund/i);
  const sessions = require('../src/core/catalog').catalog(cwd)[0].sessions;
  assert.deepEqual(sessions.map((s) => s.title).sort(), ['Build the cart page', 'Moved question'], 'listed as its own session');
  assert.equal(sessions.find((s) => s.title === 'Build the cart page').versions.length, 1, 'the version saved with the question in it is gone');

  // More chatting in the same chat: saved as usual, and the moved question stays out.
  fs.appendFileSync(file, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Now add the checkout button' } }) + '\n');
  await h.updateHandoff({ cwd, sessions: [session], trigger: 't', config: config(), getApiKey: noKey });
  assert.match(handoff(), /checkout button/);
  assert.doesNotMatch(handoff(), /refund/i);
  assert.deepEqual((await h.recentQuestions(cwd, session)).map((q) => q.text), ['Now add the checkout button', 'Build the cart page']);
});

test("Move a Question to another branch: listed under Side questions there, that branch's own state untouched", { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  git(cwd, 'checkout', '-q', '-b', 'feature/search');
  fs.writeFileSync(path.join(cwd, 'search.js'), 'x');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'Search');
  const searchChat = writeClaude(cwd, 'search', [
    { role: 'user', text: 'Build product search', branch: 'feature/search' },
    { role: 'assistant', text: 'Search works', branch: 'feature/search' },
  ]);
  await h.updateHandoff({ cwd, sessions: [claudeSession(searchChat)], trigger: 't', config: config(), getApiKey: noKey });
  git(cwd, 'checkout', '-q', 'main');
  const mainChat = writeClaude(cwd, 'main', [
    { role: 'user', text: 'Tidy the README', branch: 'main' },
    { role: 'assistant', text: 'Tidied', branch: 'main' },
    { role: 'user', text: 'Should search match partial words?', branch: 'main' },
    { role: 'assistant', text: 'Yes, use a prefix match', branch: 'main' },
  ]);
  const session = claudeSession(mainChat);
  const [side] = await h.recentQuestions(cwd, session);
  await h.moveQuestion({ cwd, config: config(), session, question: side, to: { kind: 'branch', branch: 'feature/search' }, getApiKey: noKey });

  const search = () => read(path.join(cwd, '.carrycontext', 'branches', 'feature__search', 'handoff.md'));
  assert.match(search(), /## Side questions\n\n- \d{4}-\d\d-\d\d · from `main`: Should search match partial words\? \(\[question and answer\]\(\.carrycontext\/handoffs\/feature__search\/[^)]+\.md\)\)/);
  assert.match(search(), /Search works/, "the branch's own state is untouched");
  assert.doesNotMatch(read(path.join(cwd, '.carrycontext', 'handoff.md')), /partial words/, "main's handoff leaves it out");

  // The section survives that branch's next save.
  git(cwd, 'checkout', '-q', 'feature/search');
  fs.appendFileSync(searchChat, JSON.stringify({ type: 'user', gitBranch: 'feature/search', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Add search filters' } }) + '\n');
  await h.updateHandoff({ cwd, sessions: [claudeSession(searchChat)], trigger: 't', config: config(), getApiKey: noKey });
  assert.match(search(), /Add search filters/);
  assert.match(search(), /## Side questions\n\n- .*partial words/);
});

const storyFolder = (main, id) => path.join(path.dirname(main), `${path.basename(main)}-${id}`);

test('story folders share one store: each keeps its own active handoff, and deleting one loses nothing', { skip: !hasGit && 'git missing' }, async () => {
  const main = env.project({ git: true });
  const store = path.join(fs.realpathSync(main), '.carrycontext');
  for (const [id, ask] of [['24114362', 'Build the invoice PDF'], ['24173551', 'Add the Outlook export']]) {
    const folder = storyFolder(main, id);
    git(main, 'worktree', 'add', '-q', '-b', `feature/${id}`, folder);
    const file = writeClaude(folder, `s${id}`, [{ role: 'user', text: ask, branch: `feature/${id}` }, { role: 'assistant', text: 'Started', branch: `feature/${id}` }]);
    await h.updateHandoff({ cwd: folder, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });
  }
  const invoice = storyFolder(main, '24114362');
  assert.match(read(path.join(store, 'branches', 'feature__24114362', 'handoff.md')), /Build the invoice PDF/);
  assert.match(read(path.join(store, 'branches', 'feature__24173551', 'handoff.md')), /Add the Outlook export/);
  assert.deepEqual([...new Set(h.listSavedHandoffs(main).map((s) => s.branch))].sort(), ['feature__24114362', 'feature__24173551'], 'the main folder sees every story');
  assert.match(read(path.join(invoice, '.carrycontext', 'handoff.md')), /invoice PDF/);
  assert.doesNotMatch(read(path.join(invoice, '.carrycontext', 'handoff.md')), /Outlook/, 'each folder reads only its own story');
  assert.ok(!fs.existsSync(path.join(invoice, '.carrycontext', 'branches')), 'no store of its own');

  git(main, 'worktree', 'remove', '--force', invoice);
  assert.ok(!fs.existsSync(invoice));
  assert.match(read(path.join(store, 'branches', 'feature__24114362', 'handoff.md')), /Build the invoice PDF/, 'still there after the folder is gone');
  assert.ok(h.listSavedHandoffs(main).some((s) => s.branch === 'feature__24114362'));
});

test('a story folder made with 0.8 moves its own data into the shared store once, backed up first', { skip: !hasGit && 'git missing' }, () => {
  const main = env.project({ git: true });
  const folder = storyFolder(main, 'old');
  git(main, 'worktree', 'add', '-q', '-b', 'feature/old', folder);
  const local = path.join(folder, '.carrycontext');
  fs.mkdirSync(path.join(local, 'branches', 'feature__old'), { recursive: true });
  fs.writeFileSync(path.join(local, 'branches', 'feature__old', 'handoff.md'), '# old handoff\n');
  fs.mkdirSync(path.join(local, 'handoffs', 'feature__old'), { recursive: true });
  fs.writeFileSync(path.join(local, 'handoffs', 'feature__old', 'claude-s--a-version.md'), '# a version\n');
  fs.writeFileSync(path.join(local, 'usage.json'), JSON.stringify({ stamp: 'x', sessions: { a: { provider: 'claude', size: 10, rows: [] } } }));
  const store = path.join(fs.realpathSync(main), '.carrycontext');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'usage.json'), JSON.stringify({ stamp: 'x', sessions: { b: { provider: 'claude', size: 5, rows: [] } } }));

  assert.equal(h.adoptLocalStore(folder, config()), true);
  assert.equal(read(path.join(store, 'branches', 'feature__old', 'handoff.md')), '# old handoff\n');
  assert.ok(fs.existsSync(path.join(store, 'handoffs', 'feature__old', 'claude-s--a-version.md')));
  assert.deepEqual(Object.keys(JSON.parse(read(path.join(store, 'usage.json'))).sessions).sort(), ['a', 'b'], 'both ledgers kept');
  assert.ok(!fs.existsSync(path.join(local, 'branches')) && !fs.existsSync(path.join(local, 'usage.json')), 'moved, not left behind');
  assert.ok(require('../src/core/backup').listBackups(folder, config()).some((b) => /-from-/.test(b.name)), 'backed up first');
  assert.equal(h.adoptLocalStore(folder, config()), false, 'only once');
});

test('start a story: its own branch from the base, its own folder and a handoff saying which story; nothing here changes', { skip: !hasGit && 'git missing' }, async () => {
  const main = env.project({ git: true });
  const file = writeClaude(main, 'm', [{ role: 'user', text: 'Set up CI', branch: 'main' }, { role: 'assistant', text: 'Done', branch: 'main' }]);
  await h.updateHandoff({ cwd: main, sessions: [claudeSession(file)], trigger: 't', config: config(), getApiKey: noKey });

  const plan = h.storyPlan(main, config(), { id: '24173551', title: 'Outlook export!' });
  assert.deepEqual([plan.branch, plan.base, path.basename(plan.folder), plan.exists], ['feature/24173551-outlook-export', 'main', `${path.basename(main)}-24173551`, false]);
  const res = h.startStory(main, config(), plan);
  assert.match(res.note, /Couldn't fetch main .* so it starts from your local main/, 'no remote here: it says so');
  assert.equal(git(plan.folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/24173551-outlook-export');
  assert.equal(git(main, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'this folder stays on its branch');
  const doc = read(path.join(fs.realpathSync(main), '.carrycontext', 'branches', 'feature__24173551-outlook-export', 'handoff.md'));
  assert.match(doc, /## Goal\n\nStory 24173551: Outlook export!/);
  assert.match(doc, /## Background\n\nBranched from `main`[\s\S]*Set up CI/, "the base branch's context, not the current work's");
  const requests = path.join(main, '.carrycontext', 'requests');
  assert.equal(JSON.parse(read(path.join(requests, fs.readdirSync(requests)[0]))).folder, plan.folder, 'VS Code is asked to open it');
  assert.ok(fs.existsSync(path.join(plan.folder, '.carrycontext', 'start-chat')), 'and to start a chat there');

  assert.throws(() => h.startStory(main, config(), plan), /already exists, so it was left alone/);
  git(main, 'worktree', 'remove', '--force', plan.folder);
  const again = h.storyPlan(main, config(), { id: '24173551', title: 'Outlook export!' });
  assert.equal(again.exists, true);
  h.startStory(main, config(), again);
  assert.equal(git(again.folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/24173551-outlook-export', 'an existing branch is checked out as it is');
  assert.equal(h.storyPlan(main, config({ stories: { branchPattern: 'story/{id}' } }), { id: 'ABC-12', title: 'Fix login' }).branch, 'story/ABC-12');
  assert.equal(h.storyPlan(main, config(), { id: '24190000', base: 'release/2026.11' }).base, 'release/2026.11', 'a base per story');
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
