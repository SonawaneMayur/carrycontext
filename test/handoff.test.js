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

test('compact-all merges sessions from several providers in time order', async () => {
  const cwd = env.project();
  writeClaude(cwd, 'c', [{ role: 'user', text: 'Claude task', ts: '2026-10-25T09:00:00Z' }]);
  writeCodex(cwd, 'x', [{ role: 'user', text: 'Codex task', ts: '2026-10-25T09:30:00Z' }]);
  const res = await compact(cwd);
  assert.deepEqual(res.doc.match(/claude `|codex `/g), ['claude `', 'codex `']);
  assert.match(res.doc, /## Recent requests\n\n- Claude task\n- Codex task/);
  assert.match(path.basename(res.sessionFile), /^claude-codex-compact-all--/);
});

test('saved handoffs are pruned to handoffLimit', async () => {
  const cwd = env.project();
  for (let i = 0; i < 4; i++) {
    const file = writeClaude(cwd, `s${i}`, [{ role: 'user', text: `Distinct request number ${i}` }]);
    await h.updateHandoff({ cwd, sessions: [claudeSession(file)], trigger: 't', config: config({ handoffLimit: 2 }), getApiKey: noKey });
  }
  assert.equal(h.listSavedHandoffs(cwd).length, 2);
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
