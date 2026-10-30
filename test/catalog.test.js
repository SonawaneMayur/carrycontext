// Saved handoffs as the panel and Find Handoff see them: one entry per session with its earlier
// versions, grouped by branch, pruned per session, cached in an index that can't go stale, and
// searchable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, hasGit, git } = require('./helpers/env');
const { writeClaude } = require('./helpers/sessions');

const env = sandbox();
const { DEFAULTS } = require('../src/core/config');
const h = require('../src/core/handoff');
const { catalog, search, readMeta } = require('../src/core/catalog');
const { getProvider } = require('../src/providers');
test.after(() => env.cleanup());

const conversations = new Map();
/** Add a request (and a reply) to a Claude session, then save a handoff from it as a compaction would. */
async function save(cwd, id, text, { title, branch, reply = `Done: ${text}`, limit } = {}) {
  const key = `${cwd}:${id}`;
  if (!conversations.has(key)) conversations.set(key, []);
  const turns = conversations.get(key);
  turns.push({ role: 'user', text, branch }, { role: 'assistant', text: reply, branch });
  const file = writeClaude(cwd, id, turns, { title });
  const ref = { provider: 'claude', id, path: file, updatedAt: Date.now() };
  const config = { ...DEFAULTS, ...(limit ? { handoffLimit: limit } : {}) };
  return h.updateHandoff({ cwd, sessions: [{ adapter: getProvider('claude'), ref }], trigger: 'test', config, getApiKey: async () => undefined });
}
const indexFile = (cwd) => path.join(cwd, '.carrycontext', 'handoffs', 'index.json');

test('one entry per session, newest first, with its earlier versions as history', async () => {
  const cwd = env.project();
  await save(cwd, 'pay', 'Build the payments page'); // before Claude Code has named the session
  await save(cwd, 'pay', 'sure', { title: 'Payments' }); // a bare reply doesn't name a handoff
  await save(cwd, 'pay', 'Add tests for checkout', { title: 'Payments' });
  await save(cwd, 'notes', 'Write the release notes', { title: 'Release notes' });

  const branches = catalog(cwd);
  assert.equal(branches.length, 1);
  assert.equal(branches[0].slug, null, 'outside git everything is one list');
  const [notes, pay] = branches[0].sessions;
  assert.deepEqual([notes.title, pay.title], ['Release notes', 'Payments']);
  assert.equal(pay.description, 'Add tests for checkout');
  assert.equal(pay.goal, 'Build the payments page');
  assert.deepEqual(pay.providers, ['claude']);
  assert.deepEqual(
    pay.versions.map((v) => v.description),
    ['Add tests for checkout', 'Build the payments page', 'Build the payments page'],
  );
  assert.equal(pay.file, pay.versions[0].file, 'the entry opens the latest version');
  assert.deepEqual(catalog(env.project()), [], 'no saved handoffs yet');
});

test('the limit counts versions per session, so a busy session cannot remove the others', async () => {
  const cwd = env.project();
  await save(cwd, 'quiet', 'Plan the database migration', { title: 'Migration' });
  for (const n of ['one', 'two', 'three', 'four', 'five']) {
    await save(cwd, 'busy', `Fix flaky test number ${n}`, { title: 'Flaky tests', limit: 2 });
  }
  const [busy, quiet] = catalog(cwd)[0].sessions;
  assert.deepEqual([busy.title, busy.versions.length], ['Flaky tests', 2]);
  assert.deepEqual(busy.versions.map((v) => v.description), ['Fix flaky test number five', 'Fix flaky test number four']);
  assert.deepEqual([quiet.title, quiet.versions.length], ['Migration', 1]);
});

test('the index is only a cache: rebuilt when deleted or broken, and follows the files', async () => {
  const cwd = env.project();
  await save(cwd, 'a', 'Write the onboarding guide', { title: 'Onboarding' });
  await save(cwd, 'b', 'Profile the slow endpoint', { title: 'Performance' });
  const before = catalog(cwd);
  assert.ok(fs.existsSync(indexFile(cwd)));
  assert.match(fs.readFileSync(path.join(cwd, '.carrycontext', '.gitignore'), 'utf8'), /^handoffs\/$/m, 'the index is never committed');

  fs.rmSync(indexFile(cwd));
  assert.deepEqual(catalog(cwd), before);
  assert.ok(fs.existsSync(indexFile(cwd)), 'written again');
  fs.writeFileSync(indexFile(cwd), '{ broken');
  assert.deepEqual(catalog(cwd), before);

  // Edited and deleted outside CarryContext: picked up on the next read.
  const perf = before[0].sessions.find((s) => s.title === 'Performance');
  fs.writeFileSync(perf.file, fs.readFileSync(perf.file, 'utf8').replace('- **Session:** Performance', '- **Session:** Speed'));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(perf.file, later, later);
  assert.deepEqual(catalog(cwd)[0].sessions.map((s) => s.title), ['Speed', 'Onboarding']);
  fs.rmSync(perf.file);
  assert.deepEqual(catalog(cwd)[0].sessions.map((s) => s.title), ['Onboarding']);
});

test('search: every word, any case, in any saved version; the newest match of each session', async () => {
  const cwd = env.project();
  // The first request becomes the shared goal outside git, so it names nothing searched for.
  await save(cwd, 'pay', 'Plan the payments work', { title: 'Payments' });
  await save(cwd, 'pay', 'Set up the Stripe webhook handler', { title: 'Payments', reply: 'Webhook secret stored in the vault' });
  await save(cwd, 'pay', 'Now style the receipt email', { title: 'Payments' });
  await save(cwd, 'orders', 'Migrate the orders table', { title: 'Orders' });

  const [stripe, ...others] = search(cwd, 'STRIPE webhook');
  assert.equal(others.length, 0);
  assert.equal(stripe.session.title, 'Payments');
  assert.equal(stripe.file, stripe.session.file, 'the latest version still mentions it');

  const [vault] = search(cwd, 'vault');
  assert.notEqual(vault.file, vault.session.file, 'only an earlier version mentions the vault');
  assert.match(vault.snippet, /^….*secret stored in the vault/);

  assert.deepEqual(search(cwd, 'stripe orders'), [], 'all words must match');
  assert.deepEqual(search(cwd, '   '), []);
  assert.deepEqual(search(cwd, 'the').map((hit) => hit.session.title), ['Orders', 'Payments'], 'one hit per session, newest first');
  assert.equal(search(cwd, 'the', 1).length, 1);
});

test('reads the header: sources, providers and verification counts', () => {
  const meta = readMeta(
    '# Handoff: app\n\n- **Session:** compact-all\n- **Description:** fix the build\n- **Branch:** feature/ci\n' +
      '- **Sources:** claude `1a2b3c4d` (3 msgs), codex `9f8e7d6c` (2 msgs)\n' +
      '- **Verification:** 2 verified, 1 unverified, 0 contradicted\n\n## Goal\n\n> Green CI\n\n## Next steps\n\n- **Session:** not a header\n',
    'claude-codex-compact-all--fix-the-build',
  );
  assert.equal(meta.session, 'compact-all');
  assert.equal(meta.branch, 'feature/ci');
  assert.equal(meta.goal, 'Green CI');
  assert.equal(meta.key, 'claude:1a2b3c4d+codex:9f8e7d6c');
  assert.deepEqual(meta.providers, ['claude', 'codex']);
  assert.deepEqual(meta.verification, { verified: 2, unverified: 1, contradicted: 0 });
});

test('handoffs saved by older versions are listed from their file names', () => {
  const cwd = env.project();
  const dir = path.join(cwd, '.carrycontext', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-export-work--send.md'), '# Handoff: app\n\n## Goal\n\nShip the CSV export\n');
  const meta = readMeta('', 'claude-export-work--send');
  assert.deepEqual([meta.session, meta.description, meta.key, meta.goal, meta.verification], ['claude export work', 'send', 'claude-export-work', '', null]);
  const [session] = catalog(cwd)[0].sessions;
  assert.equal(session.title, 'claude export work');
  assert.equal(session.description, 'Ship the CSV export', 'a bare reply like "send" is replaced by the goal');
});

test('in git: grouped by the branch each handoff was saved on, newest branch first', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  await save(cwd, 'm', 'Set up the project skeleton', { title: 'Skeleton', branch: 'main' });
  git(cwd, 'checkout', '-q', '-b', 'feature/pay');
  await save(cwd, 'f', 'Build the payments page', { title: 'Payments', branch: 'feature/pay' });
  const branches = catalog(cwd);
  assert.deepEqual(branches.map((b) => [b.slug, b.name]), [['feature__pay', 'feature/pay'], ['main', 'main']]);
  assert.deepEqual(branches.map((b) => b.sessions.map((s) => s.title)), [['Payments'], ['Skeleton']]);
});
