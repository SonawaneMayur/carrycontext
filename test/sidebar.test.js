// The panel (src/sidebar.js), run against a stand-in for the VS Code API: which rows it shows,
// in what order and with what labels, and that hover text never shows your home folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Module = require('module');
const { sandbox, hasGit, git } = require('./helpers/env');
const { writeClaude } = require('./helpers/sessions');

const env = sandbox();
// require('vscode') gets the stand-in, here and in src/. Each test file runs in its own process.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? require.resolve('./helpers/fakeVscode') : resolve.call(this, request, ...rest);
};
const { TreeItemCollapsibleState: State } = require('vscode');
const { HandoffTree } = require('../src/sidebar');
const { DEFAULTS } = require('../src/core/config');
const h = require('../src/core/handoff');
const { getProvider } = require('../src/providers');
test.after(() => env.cleanup());

const conversations = new Map();
/** Add a request to a Claude session and save a handoff from it. */
async function save(cwd, id, text, { title, branch } = {}) {
  const key = `${cwd}:${id}`;
  if (!conversations.has(key)) conversations.set(key, []);
  const usage = { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  conversations.get(key).push({ role: 'user', text, branch }, { role: 'assistant', text: `Done: ${text}`, branch, usage });
  const file = writeClaude(cwd, id, conversations.get(key), { title });
  const ref = { provider: 'claude', id, path: file, updatedAt: Date.now() };
  return h.updateHandoff({ cwd, sessions: [{ adapter: getProvider('claude'), ref }], trigger: 'test', config: DEFAULTS, getApiKey: async () => undefined });
}
const panel = (cwd, { currentOnly = false } = {}) => new HandoffTree(() => cwd, () => DEFAULTS, () => currentOnly);
const labels = (rows) => rows.map((r) => r.label);
/** Every row, depth first, with everything expanded. */
async function walk(tree, parent) {
  const rows = [];
  for (const row of await tree.getChildren(parent)) rows.push(row, ...(row.collapsibleState ? await walk(tree, row) : []));
  return rows;
}

test('branches: the checked-out one first and open, idle ones under "Older branches", optional filter', { skip: !hasGit && 'git missing' }, async () => {
  const cwd = env.project({ git: true });
  await save(cwd, 'spike', 'Prototype the importer', { title: 'Importer', branch: 'spike/import' });
  const weeksAgo = (Date.now() - 20 * 86400000) / 1000;
  for (const { file } of h.listSavedHandoffs(cwd)) fs.utimesSync(file, weeksAgo, weeksAgo);
  await save(cwd, 'skeleton', 'Set up the project skeleton', { title: 'Skeleton', branch: 'main' });
  git(cwd, 'checkout', '-q', '-b', 'feature/pay');
  await save(cwd, 'pay', 'Build the payments page', { title: 'Payments', branch: 'feature/pay' });
  await save(cwd, 'tests', 'Write the payment tests', { title: 'Payment tests', branch: 'feature/pay' });
  git(cwd, 'checkout', '-q', 'main');

  const tree = panel(cwd);
  const root = await tree.getChildren();
  assert.deepEqual(labels(root), ['Latest handoff · main', 'main', 'feature/pay', 'Older branches (1)', 'Usage', 'Recent conversations']);
  const [, main, pay, older, usage] = root;
  assert.deepEqual([main.collapsibleState, main.description], [State.Expanded, 'current · 1 session']);
  assert.equal(pay.collapsibleState, State.Collapsed);
  assert.match(pay.description, /^2 sessions · just now$/);
  assert.equal((await tree.resolveTreeItem(pay)).tooltip, 'feature/pay\n2 sessions, last handoff just now\nUsage: 2.0k tokens · $0.04 at API prices · <1m active');
  assert.deepEqual(labels(await tree.getChildren(pay)), ['Payment tests', 'Payments']);
  assert.deepEqual(labels(await tree.getChildren(older)), ['spike/import']);
  assert.equal(usage.command.command, 'carrycontext.usageReport');

  // VS Code refuses a tree with two rows of the same id.
  const ids = (await walk(tree)).map((r) => r.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);

  assert.deepEqual(labels(await panel(cwd, { currentOnly: true }).getChildren()), ['Latest handoff · main', 'main', 'Usage', 'Recent conversations']);
  git(cwd, 'checkout', '-q', '-b', 'feature/empty');
  assert.deepEqual(labels(await panel(cwd, { currentOnly: true }).getChildren()).slice(1, 2), ['No saved handoffs on feature/empty yet']);
});

test('one row per session opens its latest handoff; earlier versions are inside; hover shows the essentials', async () => {
  const cwd = env.project();
  await save(cwd, 'pay', 'Build the payments page', { title: 'Payments' });
  await save(cwd, 'pay', 'Add tests for checkout', { title: 'Payments' });

  const tree = panel(cwd);
  const root = await tree.getChildren();
  assert.deepEqual(labels(root), ['Latest handoff', 'Saved handoffs', 'Usage', 'Recent conversations']);
  const [session] = await tree.getChildren(root[1]);
  assert.equal(session.label, 'Payments');
  assert.equal(session.description, 'Add tests for checkout · just now');
  assert.equal(session.contextValue, 'handoffFile', 'copy and "use as latest" work on it');
  assert.equal(session.command.arguments[0].fsPath, session.resourceUri.fsPath);
  assert.equal(session.collapsibleState, State.Collapsed);
  const [earlier] = await tree.getChildren(session);
  assert.equal(earlier.description, 'Build the payments page');
  assert.equal(earlier.iconPath.id, 'history');

  assert.equal(session.tooltip, undefined, 'built when hovered');
  const hover = (await tree.resolveTreeItem(session)).tooltip.value.replace(/\\/g, '');
  assert.match(hover, /^\*\*Payments\*\*/);
  assert.match(hover, /\*\*Goal:\*\* Build the payments page/);
  assert.match(hover, /\*\*Working on:\*\* Add tests for checkout/);
  assert.match(hover, /\*\*Next steps:\*\*\n\n- Continue from the most recent request/);
  assert.match(hover, /\*\*Usage:\*\* 2\.0k tokens · \$0\.04 at API prices\n/);
  assert.match(hover, /1 earlier version · ~\//);
  assert.ok(!hover.includes(env.home), 'no home folder path in the hover text');
});

test('empty states, and the newest conversations at the bottom', async () => {
  assert.deepEqual(await new HandoffTree(() => undefined, () => DEFAULTS, () => false).getChildren(), [], 'no folder open');
  const cwd = env.project();
  const tree = panel(cwd);
  const root = await tree.getChildren();
  assert.deepEqual(labels(root), ['No handoff yet: click to Compact All', 'Saved handoffs will appear here', 'Usage', 'Recent conversations']);
  assert.deepEqual(labels(await tree.getChildren(root[3])), ['No conversations from claude, codex, gemini in this folder yet']);

  for (let i = 0; i < 7; i++) writeClaude(cwd, `c${i}`, [{ role: 'user', text: `Conversation ${i}` }]);
  const rows = await tree.getChildren(root[3]);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.contextValue === 'session' && r.command.command === 'carrycontext.compactThisSession'));
});
