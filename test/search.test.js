const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers/env');
const { writeClaude, writeCodex } = require('./helpers/sessions');
const { startMockLlm, MOCK_BASE_PATHS } = require('./helpers/mockLlm');

const env = sandbox();
const { DEFAULTS } = require('../src/core/config');
const h = require('../src/core/handoff');
const s = require('../src/core/search');
const { SearchView, renderHtml } = require('../src/searchView');
const { getProvider } = require('../src/providers');
test.after(() => env.cleanup());

const config = (over = {}) => ({ ...DEFAULTS, ...over, summarizer: { ...DEFAULTS.summarizer, ...(over.summarizer || {}) } });
const noKey = async () => undefined;
const SOURCES = ['claude', 'codex', 'gemini'];

/** A folder with three Claude chats (one saved as a handoff) and a Codex chat. */
async function project() {
  const cwd = env.project();
  const payments = writeClaude(cwd, 'aaaa1111-pay', [
    { role: 'user', text: 'Build the payments page with Stripe checkout' },
    { role: 'assistant', text: 'The webhook handler now verifies signatures.' },
  ], { title: 'Payments page' });
  writeClaude(cwd, 'bbbb2222-exp', [
    { role: 'user', text: 'Add a CSV export to the reports screen' },
    { role: 'assistant', text: 'Export streams rows so memory stays flat.' },
  ], { title: 'Reports export' });
  writeClaude(cwd, 'cccc3333-log', [{ role: 'user', text: 'Why does login fail on Safari?' }, { role: 'assistant', text: 'A cookie SameSite issue.' }], { title: 'Login bug' });
  writeCodex(cwd, 'dddd4444-codex', [{ role: 'user', text: 'Tune the database indexes for the reports query' }, { role: 'assistant', text: 'Added a composite index.' }]);
  const ref = { provider: 'claude', id: 'aaaa1111-pay', path: payments, updatedAt: Date.now() };
  const saved = await h.updateHandoff({ cwd, sessions: [{ adapter: getProvider('claude'), ref }], trigger: 't', config: config(), getApiKey: noKey });
  return { cwd, handoff: saved.sessionFile };
}

test('wordScore: exact, prefix, inside, typos, and no typos for short words', () => {
  assert.equal(s.wordScore('compact', 'compact'), 1);
  assert.equal(s.wordScore('comp', 'compaction'), 0.9);
  assert.equal(s.wordScore('pact', 'compaction'), 0.75);
  assert.equal(s.wordScore('compoact', 'compact'), 0.85, 'one extra letter');
  assert.equal(s.wordScore('relese', 'release'), 0.85, 'one missing letter');
  assert.equal(s.wordScore('hokk', 'hook'), 0.85, 'one wrong letter');
  assert.equal(s.wordScore('sesison', 'session'), 0.85, 'two swapped letters count as one typo');
  assert.equal(s.wordScore('worktre', 'worktrees'), 0.9, 'the start of a longer word');
  assert.equal(s.wordScore('compcat', 'compaction'), 0.6, 'a typo in the start of a longer word');
  assert.equal(s.wordScore('export', 'reports'), 0, 'six letters allow one typo, not two');
  assert.equal(s.wordScore('on', 'in'), 0, 'short words must match exactly');
  assert.equal(s.wordScore('cat', 'cut'), 0);
  assert.equal(s.wordScore('payments', 'database'), 0);
});

test('editDistance gives up past its limit', () => {
  assert.equal(s.editDistance('kitten', 'sitting', 3), 3);
  assert.equal(s.editDistance('kitten', 'sitting', 1), 2, 'stops at limit + 1');
  assert.equal(s.editDistance('a', 'abcdef', 2), 3, 'length difference alone is too much');
});

test('queryWords lower-cases, drops duplicates and one-letter words, and caps the count', () => {
  assert.deepEqual(s.queryWords('Fix the  FIX a bug'), ['fix', 'the', 'bug']);
  assert.equal(s.queryWords('one two three four five six seven eight nine ten').length, 8);
});

test('search finds chats with or without a handoff, across providers, despite typos', async () => {
  const { cwd, handoff } = await project();
  const index = await s.buildIndex(cwd, SOURCES);
  const sessions = index.docs.filter((d) => !d.id.startsWith('file:'));
  assert.equal(sessions.length, 4, 'the saved chat, its handoff and the latest-handoff copy are one result');
  assert.ok(sessions.find((d) => d.handoffFile === handoff).files.some((f) => f.endsWith('handoff.md')));

  const [pay] = s.searchIndex(index, 'paymnts stripe');
  assert.equal(pay.doc.title, 'Payments page');
  assert.equal(pay.doc.handoffFile, handoff);
  assert.equal(pay.doc.chat.provider, 'claude');
  assert.equal(pay.partial, false);
  assert.match(pay.snippet, /payments page with Stripe/i);

  const codex = s.searchIndex(index, 'databse indexes');
  assert.equal(codex[0].doc.providers[0], 'codex');
  assert.equal(codex[0].doc.handoffFile, undefined, 'never saved');

  assert.deepEqual(s.searchIndex(index, ''), []);
  assert.deepEqual(s.searchIndex(index, 'kubernetes helm'), []);
});

test('search ranks full matches first, then partial ones, and title matches above text matches', async () => {
  const { cwd } = await project();
  const index = await s.buildIndex(cwd, SOURCES);
  const results = s.searchIndex(index, 'reports export');
  assert.equal(results[0].doc.title, 'Reports export', 'both words, in the title');
  const partial = results.filter((r) => r.partial).map((r) => r.doc.providers[0]);
  assert.deepEqual(partial, ['codex'], 'mentions reports but not export');
  assert.ok(results.findIndex((r) => r.partial) > results.findIndex((r) => !r.partial));
});

test('every folder of .carrycontext is searched: earlier versions, copies, and .json/.log files', async () => {
  const { cwd, handoff } = await project();
  const store = path.join(cwd, '.carrycontext');
  // An earlier version that mentions something the newest one doesn't.
  const earlier = handoff.replace(/\.md$/, '.v1.md');
  fs.writeFileSync(earlier, fs.readFileSync(handoff, 'utf8').replace('## Goal', '## Goal\n\nMigrate the ledger to Postgres.\n\n## Old goal'));
  fs.utimesSync(earlier, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  // A copy in the inbox, a log in a nested folder, and a stray note.
  fs.mkdirSync(path.join(store, 'inbox'), { recursive: true });
  fs.copyFileSync(handoff, path.join(store, 'inbox', 'copy.md'));
  fs.mkdirSync(path.join(store, 'hooks', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(store, 'hooks', 'logs', 'run.log'), 'hook fired: zebracorn timeout after 30s\n');
  fs.writeFileSync(path.join(store, 'notes.md'), '# Team notes\n\nThe zebracorn flag is off in staging.\n');
  fs.writeFileSync(path.join(store, 'ignored.txt'), 'zebracorn');

  const index = await s.buildIndex(cwd, SOURCES);
  const pay = index.docs.find((d) => d.handoffFile === handoff);
  assert.ok(pay.files.some((f) => f.endsWith('copy.md')), 'a copy joins its session');
  assert.equal(index.docs.filter((d) => d.files.some((f) => f.endsWith('copy.md'))).length, 1);

  const [ledger] = s.searchIndex(index, 'ledger postgres');
  assert.equal(ledger.doc, pay, 'an earlier version is searched');
  assert.ok(ledger.files.includes(earlier), 'and named as the file that matches');
  assert.ok(!ledger.files.includes(handoff), 'the newest version does not mention it');

  const zebra = s.searchIndex(index, 'zebracorn');
  assert.deepEqual(zebra.map((r) => r.doc.title).sort(), ['Team notes', 'run.log']);
  assert.equal(zebra.find((r) => r.doc.title === 'run.log').doc.description, '.carrycontext/hooks/logs/run.log');
  assert.ok(index.docs.some((d) => d.title === 'state.json'), '.json files too');
  assert.ok(!index.docs.some((d) => d.title === 'index.json'), 'but not the cache of every handoff\'s header');
});

test('the index re-reads a chat only when it changes', async () => {
  const { cwd } = await project();
  const first = await s.buildIndex(cwd, SOURCES);
  const login = first.docs.find((d) => d.title === 'Login bug');
  const again = await s.buildIndex(cwd, SOURCES);
  assert.equal(again.docs.find((d) => d.title === 'Login bug').words, login.words, 'cached');
  const file = login.chat.ref.path;
  fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: 'x', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Also check Firefox' } }) + '\n');
  const later = await s.buildIndex(cwd, SOURCES);
  assert.equal(s.searchIndex(later, 'firefox')[0].doc.title, 'Login bug');
});

test('askSessions sends redacted excerpts of the best matches to the summarizer and returns its answer', async () => {
  const { cwd } = await project();
  const secret = 'sk-ant-api03-' + 'x'.repeat(40);
  writeClaude(cwd, 'eeee5555-key', [{ role: 'user', text: `Rotate the payments webhook key ${secret}` }], { title: 'Key rotation' });
  const index = await s.buildIndex(cwd, SOURCES);
  const results = s.searchIndex(index, 'payments webhook');
  const mock = await startMockLlm({ reply: 'The Stripe work is in [1].' });
  try {
    const cfg = config({ summarizer: { provider: 'ollama', model: 'm', baseUrl: mock.url + MOCK_BASE_PATHS.ollama } });
    const { answer, sources } = await s.askSessions(index, 'where did we verify webhook signatures?', results, { config: cfg, cwd });
    assert.equal(answer, 'The Stripe work is in [1].');
    assert.equal(sources[0], results[0].doc);
    assert.equal(sources.length, index.docs.length, 'topped up with the newest sessions');
    const sent = JSON.stringify(mock.requests[0].body);
    assert.match(sent, /where did we verify webhook signatures/);
    assert.match(sent, /\[[12]\] Payments page/, 'both chats mention payments and webhooks; the newer one is first');
    assert.doesNotMatch(sent, /To the assistant reading this/, 'the handoff header is not searched or sent');
    assert.doesNotMatch(sent, new RegExp(secret), 'secrets are redacted');
  } finally {
    await mock.close();
  }
});

test('askSessions needs a summarizer, and a key for hosted ones', async () => {
  const { cwd } = await project();
  const index = await s.buildIndex(cwd, SOURCES);
  await assert.rejects(s.askSessions(index, 'q', [], { config: config(), cwd }), /needs a summarizer LLM/);
  await assert.rejects(s.askSessions(index, 'q', [], { config: config({ summarizer: { provider: 'anthropic' } }), cwd }), /No API key for anthropic/);
});

/** A SearchView on a fake webview that records what it posts. */
function view(cwd, over = {}) {
  const posted = [];
  const calls = { opened: [], created: [], revealed: [], highlighted: [] };
  const v = new SearchView({
    cwd: () => cwd,
    config: () => config(over.config),
    getApiKey: noKey,
    openFile: (f) => calls.opened.push(f),
    createHandoff: async (chat) => {
      calls.created.push(chat.ref.id);
      return { sessionFile: `/saved/${chat.ref.id}.md` };
    },
    reveal: (f) => calls.revealed.push(f),
    highlight: (found) => calls.highlighted.push(found),
    log: () => {},
  });
  let handler;
  const webview = { options: null, html: '', postMessage: (m) => posted.push(m), onDidReceiveMessage: (fn) => (handler = fn) };
  v.resolveWebviewView({ webview });
  return { v, webview, posted, calls, send: (m) => handler(m) };
}

test('the search page is locked down: nonce\'d script and style only, no network', () => {
  const html = renderHtml('abc123');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.equal(csp, "default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123';");
  assert.doesNotMatch(html, /innerHTML|unsafe-inline|https?:\/\//);
  assert.equal((html.match(/<script/g) || []).length, 1);
});

test('SearchView answers searches and opens results by key only', async () => {
  const { cwd, handoff } = await project();
  const { webview, posted, calls, send } = view(cwd);
  assert.deepEqual(webview.options, { enableScripts: true, localResourceRoots: [] });

  await send({ type: 'ready' });
  assert.deepEqual(posted.pop(), { type: 'state', ai: '' }, 'no Ask AI without a summarizer');

  await send({ type: 'search', q: '  stripe  ' });
  const res = posted.filter((m) => m.type === 'results').pop();
  assert.equal(res.q, 'stripe');
  assert.equal(res.items[0].title, 'Payments page');
  assert.equal(res.items[0].hasHandoff, true);
  const lit = calls.highlighted.pop();
  assert.ok(lit.keys.includes('claude:aaaa1111'), 'matches are highlighted in the Handoffs list');
  assert.ok(lit.files.includes(handoff));
  assert.deepEqual(lit.words, ['stripe']);

  await send({ type: 'open', key: res.items[0].key });
  assert.deepEqual(calls.opened, [handoff]);

  await send({ type: 'search', q: 'kubernetes' });
  assert.equal(calls.highlighted.pop(), null, 'nothing found clears the highlights');
  await send({ type: 'search', q: '' });
  assert.equal(calls.highlighted.pop(), null, 'so does an empty box');

  await send({ type: 'search', q: 'safari' });
  const login = posted.filter((m) => m.type === 'results').pop().items[0];
  assert.equal(login.hasHandoff, false);
  await send({ type: 'open', key: login.key });
  assert.deepEqual(calls.created, ['cccc3333-log'], 'a chat without a handoff gets one');
  assert.deepEqual(calls.revealed, [handoff, '/saved/cccc3333-log.md'], 'and is selected in the Handoffs list');

  await send({ type: 'open', key: '../../etc/passwd' });
  await send({ type: 'open', file: handoff });
  await send(null);
  assert.equal(calls.opened.length, 1, 'unknown keys and file paths from the page are ignored');
  assert.equal(calls.revealed.length, 2);
});

test('SearchView shows Ask AI only with a summarizer and reports errors to the page', async () => {
  const { cwd } = await project();
  const mock = await startMockLlm({ reply: 'See [1] and [9].' });
  try {
    const { posted, send } = view(cwd, { config: { summarizer: { provider: 'ollama', model: 'm', baseUrl: mock.url + MOCK_BASE_PATHS.ollama } } });
    await send({ type: 'ready' });
    assert.equal(posted.pop().ai, 'Ollama (local)');
    await send({ type: 'ask', q: 'stripe checkout' });
    const answer = posted.find((m) => m.type === 'answer');
    assert.equal(answer.text, 'See [1] and [9].');
    assert.equal(answer.sources[0].key, 'a1');
    assert.equal(answer.sources[0].title, 'Payments page');
  } finally {
    await mock.close();
  }
  const { posted, send } = view(cwd);
  await send({ type: 'ask', q: 'anything' });
  assert.match(posted.find((m) => m.type === 'error').text, /needs a summarizer LLM/);
});

test('SearchView without a folder says so', async () => {
  const { posted, send } = view(undefined);
  await send({ type: 'search', q: 'x' });
  assert.match(posted.find((m) => m.type === 'error').text, /Open a folder/);
});
