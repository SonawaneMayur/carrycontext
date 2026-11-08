// Usage stats from the assistants' own logs: exact token counts (each reply once), sub-agents
// included, cost at list prices or your own, cached per session, private, and nothing sent anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('./helpers/env');
const { FAKE_SECRETS } = require('./helpers/fakeSecrets');

const env = sandbox();
const { DEFAULTS, normalizeConfig } = require('../src/core/config');
const { usageSummary, renderReport, renderCsv, replyCost, describe, sessionOnBranch, handoffSize } = require('../src/core/usage');
const { getProvider } = require('../src/providers');
test.after(() => env.cleanup());

const config = (over = {}) => normalizeConfig({ ...DEFAULTS, ...over });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const projectLogs = (cwd) => path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

/** Write a Claude Code log from raw entries. */
function writeLog(dir, id, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
let n = 0;
const ask = (text, ts, branch = 'main') => ({ type: 'user', timestamp: ts, gitBranch: branch, message: { role: 'user', content: text } });
const reply = (usage, ts, { branch = 'main', model = 'claude-opus-5-5', sidechain = false } = {}) => {
  const id = `msg_${++n}`;
  return { type: 'assistant', timestamp: ts, gitBranch: branch, isSidechain: sidechain, requestId: `req_${n}`, message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage } };
};
/** A usage object as the API returns it. */
const usage = (output, { input = 0, cacheRead = 0, write5m = 0, write1h = 0, speed } = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: write5m + write1h,
  cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
  speed,
});

test('Claude: each reply counts once, sub-agents count, "HEAD" stays on the branch, noise is not a question', () => {
  const cwd = env.project();
  const first = reply(usage(100), '2026-10-30T10:00:10Z');
  const file = writeLog(projectLogs(cwd), 's1', [
    { type: 'ai-title', aiTitle: 'Payments' },
    ask('Build the payments page', '2026-10-30T10:00:00Z'),
    first,
    // The same reply's second content block, logged as its own line with the same usage.
    { ...first, message: { ...first.message, content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }] } },
    reply(usage(50), '2026-10-30T10:01:00Z', { sidechain: true }),
    ask('<task-notification>done</task-notification>', '2026-10-30T10:01:30Z'),
    reply(usage(20), '2026-10-30T10:02:00Z', { branch: 'HEAD' }), // mid-rebase
    reply(usage(0), '2026-10-30T10:02:30Z', { model: '<synthetic>' }), // not from a model
  ]);
  writeLog(path.join(path.dirname(file), 's1', 'subagents'), 'agent-1', [reply(usage(30), '2026-10-30T10:01:10Z')]);

  const { title, records } = getProvider('claude').readUsage({ provider: 'claude', id: 's1', path: file, updatedAt: 0 });
  assert.equal(title, 'Payments');
  assert.deepEqual(
    records.map((r) => [r.output, r.branch, r.subagent, r.question]),
    [
      [100, 'main', false, 'Build the payments page'],
      [50, 'main', true, 'Build the payments page'],
      [30, 'main', true, 'Build the payments page'],
      [20, 'main', false, 'Build the payments page'],
    ],
  );
});

test('work logged on "HEAD" goes to the branch checked out at the time, read from the reflog', async () => {
  const cwd = env.project();
  // A repo written by hand, so the test needs no git: on main until 10:00, then feature/pay.
  fs.mkdirSync(path.join(cwd, '.git', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/feature/pay\n');
  const switched = Date.parse('2026-10-30T10:00:00Z') / 1000;
  fs.writeFileSync(path.join(cwd, '.git', 'logs', 'HEAD'), `${'0'.repeat(40)} ${'1'.repeat(40)} A U Thor <author@example.com> ${switched} +0000\tcheckout: moving from main to feature/pay\n`);
  const head = { branch: 'HEAD' }; // what Claude Code logs for a session started before `git init`
  writeLog(projectLogs(cwd), 's', [ask('Start the app', '2026-10-30T09:00:00Z', 'HEAD'), reply(usage(100), '2026-10-30T09:00:10Z', head), reply(usage(200), '2026-10-30T11:00:00Z', head)]);
  const s = await usageSummary(cwd, config());
  assert.deepEqual(s.branches.map((b) => [b.name, b.replies]).sort(), [['feature/pay', 1], ['main', 1]]);
});

test('context per message comes from the main conversation, not sub-agents', async () => {
  const cwd = env.project();
  writeLog(projectLogs(cwd), 'c', [
    ask('Refactor the cart', '2026-10-30T10:00:00Z'),
    reply(usage(10, { cacheRead: 200000 }), '2026-10-30T10:00:10Z'),
    reply(usage(10, { cacheRead: 5000 }), '2026-10-30T10:00:20Z', { sidechain: true }), // a sub-agent's own small context
  ]);
  const s = await usageSummary(cwd, config());
  assert.equal(sessionOnBranch(s, 'claude:c', 'main').context, 200000);
});

test('handoff size: next to what continuing the session re-sent per message; large ones flagged', () => {
  assert.equal(handoffSize('x'.repeat(8800), 313000), '~2.2k tokens, vs ~313.0k per message to continue the session');
  assert.equal(handoffSize('x'.repeat(400)), '~100 tokens', 'no usage known');
  assert.equal(handoffSize('x'.repeat(400), 50), '~100 tokens', 'a session smaller than its handoff');
  assert.equal(handoffSize('x'.repeat(20000), 900000), '~5.0k tokens, vs ~900.0k per message to continue the session. Large: the next session reads it with every message');
});

/** A Codex log in today's folder, where Codex keeps its recent sessions. */
function writeRollout(id, lines) {
  const d = new Date();
  const dir = path.join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l, i) => JSON.stringify({ timestamp: new Date(Date.parse('2026-11-05T10:00:00Z') + i * 60000).toISOString(), ...l })).join('\n') + '\n');
  return file;
}
const codexUsage = (response_id, input, cached, output) => ({ type: 'token_usage_record', payload: { response_id, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, total_tokens: input + output } } });

test('Codex: tokens per reply from its log, each reply once, the cached part as cache reads', () => {
  const cwd = env.project();
  const file = writeRollout('cx', [
    { type: 'session_meta', payload: { id: 'cx', cwd, git: { branch: 'feature/24114362' } } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>noise</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add the Outlook export' }] } },
    codexUsage('r1', 17886, 11776, 341),
    codexUsage('r1', 17886, 11776, 341), // the same response logged twice
    codexUsage('r2', 20000, 18000, 500),
  ]);
  const { title, records } = getProvider('codex').readUsage({ provider: 'codex', id: 'cx', path: file, updatedAt: 0 });
  assert.equal(title, 'Add the Outlook export');
  assert.deepEqual(
    records.map((r) => [r.model, r.branch, r.question, r.input, r.cacheRead, r.output]),
    [
      ['gpt-6-luna', 'feature/24114362', 'Add the Outlook export', 6110, 11776, 341],
      ['gpt-6-luna', 'feature/24114362', 'Add the Outlook export', 2000, 18000, 500],
    ],
  );
});

test('features: branches for one story count together, with tokens and cost per LLM, active time, span and energy', async () => {
  const cwd = env.project();
  const story = { branch: 'feature/24114362' };
  const fix = { branch: 'bugfix/24114362-export', model: 'claude-sonnet-5-5' };
  writeLog(projectLogs(cwd), 'f1', [
    ask('Build the Outlook export', '2026-11-01T09:00:00Z', story.branch),
    reply(usage(1000), '2026-11-01T09:00:30Z', story),
    reply(usage(1000), '2026-11-01T09:02:30Z', story), // 2 minutes active
  ]);
  writeLog(projectLogs(cwd), 'f2', [
    ask('Fix the export bug', '2026-11-03T10:00:00Z', fix.branch),
    reply(usage(500), '2026-11-03T10:00:20Z', fix),
    reply(usage(500), '2026-11-03T10:04:20Z', fix), // 4 minutes active
  ]);
  writeLog(projectLogs(cwd), 'o', [ask('Tidy the README', '2026-11-02T08:00:00Z'), reply(usage(100), '2026-11-02T08:00:10Z')]);
  writeRollout('cx2', [
    { type: 'session_meta', payload: { id: 'cx2', cwd, git: { branch: 'feature/24114362' } } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the export' }] } },
    codexUsage('r9', 3000, 0, 200),
  ]);

  const s = await usageSummary(cwd, config({ usage: { machineWatts: 60, electricityPrice: 10 } }));
  const f = s.features.find((x) => x.name === '24114362');
  assert.deepEqual(f.branches, ['bugfix/24114362-export', 'feature/24114362']);
  assert.equal(f.sessions, 3, 'two Claude chats and one Codex chat');
  assert.deepEqual(f.models.map((m) => m.name), ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-luna'], 'costliest first; Codex has no built-in price');
  assert.equal(f.models[2].unpriced, 1);
  assert.equal(f.active, 6 * 60000);
  assert.deepEqual([f.first, f.last], ['2026-11-01', '2026-11-05']);
  near(f.kwh, (6 / 60) * 60 / 1000); // 6 minutes at 60 W
  assert.ok(s.features.some((x) => x.name === 'main'), 'a branch without a story ID is its own feature');

  const md = renderReport(s, 'app');
  assert.match(md, /^Machine: .+ · \d+ cores$/m);
  assert.match(md, /\| 24114362 \| bugfix\/24114362-export, feature\/24114362 \| claude-opus-5-5 \| [\d.]+k \| \$0\.04 \| 6m \| 2026-11-01 → 2026-11-05 \| 6\.0 Wh · \$0\.06 \|/);
  assert.match(md, /\|  \|  \| gpt-6-luna \| 3\.2k \| no price \|  \|  \|  \|/);
  assert.match(md, /\|  \|  \| all LLMs \| [\d.]+k \| \$0\.05\+ \|  \|  \|  \|/);
  assert.match(md, /\| no price \| 3\.2k \| Review the export \|/, 'a question with no price says so');
  assert.match(md, /estimated at 60 W .*priced at \$10\/kWh\. The AI's own data-center energy isn't included/);
  assert.match(renderCsv(s), /,24114362,bugfix\/24114362-export,claude-sonnet-5-5,2026-11-03,"[^"]+ cores",/);
});

test("a chat whose log is gone keeps the totals it was recorded with, even after a price change", async () => {
  const cwd = env.project();
  const file = writeLog(projectLogs(cwd), 'old', [ask('Build search', '2026-10-01T09:00:00Z'), reply(usage(1000), '2026-10-01T09:00:30Z')]);
  assert.equal((await usageSummary(cwd, config())).total.replies, 1);
  fs.rmSync(file); // Claude Code deletes logs after about 30 days
  const s = await usageSummary(cwd, config({ usage: { prices: JSON.parse('{"claude-opus-5-5": {"input": 1, "output": 1}}') } }));
  assert.equal(s.total.replies, 1);
  near(s.total.cost, 0.02); // 1,000 output tokens at the list price when it was recorded
});

test('cost at list prices: cache reads and writes, fast mode, long Haiku prompts, unknown models, your own prices', () => {
  const r = (model, { input = 0, output = 0, cacheRead = 0, w5 = 0, w1 = 0, fast = false } = {}) => ({ model, input, output, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1, fast });
  const M = 1e6;
  // Claude Opus 5.5: $4 in, $20 out, $0.20 cache read; cache writes 1.25x (5 min) and 2x (1 hour) input.
  near(replyCost(r('claude-opus-5-5', { input: M, output: M, cacheRead: M, w5: M, w1: M })), 4 + 20 + 0.2 + 5 + 8);
  near(replyCost(r('claude-opus-5-5', { input: M, fast: true })), 8);
  near(replyCost(r('claude-haiku-4-5-20251001', { input: M })), 1); // dated ids match
  near(replyCost(r('claude-haiku-5-5', { input: 50000, output: M })), 0.005 + 0.5);
  near(replyCost(r('claude-haiku-5-5', { input: 200000, output: M })), 0.1 + 2.5); // over 100K tokens
  assert.equal(replyCost(r('claude-sonnet-4-5', { input: M })), null, 'no built-in price');
  // JSON, as settings arrive: a "__proto__" key is a real key there.
  const prices = JSON.parse('{"claude-sonnet-4-5": {"input": 3, "output": 15}, "__proto__": {"input": 1, "output": 1}, "bad": {"input": -1, "output": 2}}');
  const mine = config({ usage: { prices } });
  assert.deepEqual(Object.keys(mine.usage.prices), ['claude-sonnet-4-5'], 'malformed prices are dropped');
  near(replyCost(r('claude-sonnet-4-5', { input: M, output: M, cacheRead: M }), mine.usage.prices), 3 + 15 + 0.3);
});

test('summary: by branch, session, model, day and question; breaks are not active time; "sure" counts toward the request before it', async () => {
  const cwd = env.project();
  const pay = { branch: 'feature/pay' };
  writeLog(projectLogs(cwd), 'a', [
    { type: 'custom-title', customTitle: 'Checkout' },
    ask('Build the checkout flow', '2026-10-29T09:00:00Z', 'feature/pay'),
    reply(usage(1000, { cacheRead: 100000, write1h: 10000 }), '2026-10-29T09:00:30Z', pay),
    reply(usage(1000, { cacheRead: 100000 }), '2026-10-29T09:03:30Z', pay), // 3 minutes later: active
    ask('sure', '2026-10-29T10:00:00Z', 'feature/pay'),
    reply(usage(2000, { cacheRead: 100000 }), '2026-10-29T10:00:30Z', pay), // 57 minutes later: a break
    ask('Fix the login bug', '2026-10-30T08:00:00Z'),
    reply(usage(1000), '2026-10-30T08:00:20Z', { model: 'claude-sonnet-5-5' }),
  ]);
  writeLog(projectLogs(cwd), 'b', [ask('Write the release notes', '2026-10-30T09:00:00Z'), reply(usage(100), '2026-10-30T09:00:10Z', { model: 'claude-sonnet-4-5' })]);

  const s = await usageSummary(cwd, config());
  assert.equal(s.total.replies, 5);
  assert.deepEqual(s.branches.map((b) => [b.name, b.sessions, b.replies]), [['feature/pay', 1, 3], ['main', 2, 2]], 'most expensive first');
  assert.equal(s.branches[0].active, 3 * 60000, 'the 57-minute gap is a break');
  near(s.branches[0].cost, 0.12 + 0.04 + 0.06);
  assert.deepEqual(s.sessions.map((x) => x.title), ['Write the release notes', 'Checkout'], 'newest first');
  assert.deepEqual(s.models.map((m) => m.name), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-5']);
  assert.deepEqual(s.days.map((d) => d.name), ['2026-10-29', '2026-10-30']);
  assert.deepEqual(s.unpriced, ['claude-sonnet-4-5']);
  assert.deepEqual(s.questions.map((q) => q.text), ['Build the checkout flow', 'Fix the login bug', 'Write the release notes']);
  assert.equal(s.questions[0].tokens, 111000 + 101000 + 102000, '"sure" counts toward the checkout flow');
  assert.deepEqual(s.notIncluded, ['Gemini CLI'], 'Gemini is listed as not included yet; Codex usage is read');

  const md = renderReport(s, 'app');
  assert.match(md, /^# Usage · app\n/);
  assert.match(md, /\| feature\/pay \| 1 \| 3 \| 314\.0k \| 3m \| \$0\.22 \|/);
  assert.match(md, /No built-in price for claude-sonnet-4-5/);
  assert.match(md, /Not included yet: Gemini CLI\./);
  const hidden = await usageSummary(cwd, config({ usage: { showCost: false } }));
  assert.doesNotMatch(renderReport(hidden, 'app'), /\$\d/, 'no costs when turned off');
  assert.doesNotMatch(renderCsv(hidden), /estimated_cost_usd/);

  // The panel's figures.
  assert.equal(describe(s.branches[0], true), '314.0k tokens · $0.22 at API prices · 3m active · ~0.8 Wh', '3 minutes at 15 W');
  assert.equal(describe(s.branches[1], false), '1.1k tokens · <1m active');
  assert.equal(describe({ ...s.branches[1], active: undefined }, true), '1.1k tokens · $0.01+ at API prices', '"+": some replies had no price');
  const a = s.sessions[1];
  assert.equal(sessionOnBranch(s, `claude:${a.id.slice(0, 8)}`, 'feature/pay').replies, 3);
  assert.equal(sessionOnBranch(s, `claude:${a.id.slice(0, 8)}`, 'feature/pay').context, 100000, "the branch's last reply re-sent 100k tokens");
  assert.equal(sessionOnBranch(s, `claude:${a.id.slice(0, 8)}`, 'nope'), null);
});

test('private: no home folder, username or secret in the report, CSV or cache, and the CSV is spreadsheet-safe', async () => {
  const cwd = env.project();
  writeLog(projectLogs(cwd), 'leak', [
    { type: 'custom-title', customTitle: '=HYPERLINK("http://example.com")' },
    ask(`Deploy with ${FAKE_SECRETS['openai-key']} from ${env.home}/keys`, '2026-10-30T09:00:00Z'),
    reply(usage(10), '2026-10-30T09:00:05Z'),
  ]);
  const s = await usageSummary(cwd, config());
  const cacheFile = path.join(cwd, '.carrycontext', 'usage.json');
  for (const [name, text] of [['report', renderReport(s, 'app')], ['csv', renderCsv(s)], ['cache', fs.readFileSync(cacheFile, 'utf8')]]) {
    assert.ok(!text.includes(FAKE_SECRETS['openai-key']), `${name}: secret redacted`);
    assert.ok(!text.includes(env.home), `${name}: no home folder`);
  }
  assert.ok(renderCsv(s).includes(`"'=HYPERLINK(""http://example.com"")"`), 'a title starting with = cannot run as a formula');
  assert.match(fs.readFileSync(path.join(cwd, '.carrycontext', '.gitignore'), 'utf8'), /^usage\.json$/m, 'the cache is never committed');
});

test('cache: an unchanged log is not read again; a changed log or new prices are', async () => {
  const cwd = env.project();
  const file = writeLog(projectLogs(cwd), 'c', [ask('Tune the cache', '2026-10-30T09:00:00Z'), reply(usage(1000), '2026-10-30T09:00:05Z')]);
  assert.equal((await usageSummary(cwd, config())).total.output, 1000);

  // Edit the cached figure: an unchanged log is served from the cache.
  const cacheFile = path.join(cwd, '.carrycontext', 'usage.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  for (const session of Object.values(cache.sessions)) session.rows[0].output = 7;
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  assert.equal((await usageSummary(cwd, config())).total.output, 7);

  assert.equal((await usageSummary(cwd, config({ usage: { prices: { 'claude-opus-5-5': { input: 1, output: 1 } } } }))).total.output, 1000);
  fs.appendFileSync(file, JSON.stringify(reply(usage(500), '2026-10-30T09:01:00Z')) + '\n');
  assert.equal((await usageSummary(cwd, config())).total.output, 1500);
  assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes(path.dirname(file)), 'no log paths in the cache');
});

test('a folder with no usage gets a short report and no files', async () => {
  const cwd = env.project();
  const s = await usageSummary(cwd, config());
  assert.match(renderReport(s, 'empty'), /No usage found for this folder yet/);
  assert.equal(renderCsv(s).split('\n').filter(Boolean).length, 1, 'header only');
  assert.equal(fs.existsSync(path.join(cwd, '.carrycontext')), false);
});

test('usage stats cannot reach the network', () => {
  for (const file of ['src/core/usage.js', 'src/providers/claude.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?(https?|http2|net|tls|dgram|dns)['"]\)|\bfetch\(/, file);
  }
});
