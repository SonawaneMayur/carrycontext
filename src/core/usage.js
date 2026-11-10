// @ts-check
// Token usage, active time and estimated cost by branch, session, model, day and question, read
// only from the assistants' own logs on this computer. Nothing is sent anywhere: prices come
// from the table below or your settings, never from a network call.
//
// Reading a long session's log takes a moment, so each session's totals are cached in
// .carrycontext/usage.json (git-ignored) and recomputed only when its log or the prices change.
// Shared by the extension and the CLI, so nothing in here may import 'vscode'.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { storeDir } = require('./config');
const { readJson, writeFile } = require('./util');
const { sanitize } = require('./sanitize');
const { isSubstantive } = require('./summarize');
const { ensureGitignore } = require('./handoff');
const { gitDir, branchAt, storyId } = require('./git');
const { getProvider } = require('../providers');

const VERSION = 3; // 2: work logged on "HEAD" goes to the branch checked out at the time; 3: context size
const IDLE_MS = 5 * 60000; // longer gaps between replies don't count as active time
const QUESTIONS_KEPT = 20; // per session
const BIG_HANDOFF = 4000; // tokens; the next session reads the handoff with every message

/** When the built-in prices were taken from Anthropic's published API list prices. */
const PRICES_AS_OF = '2026-10';
// $ per million tokens: input, output, cache read. Cache writes cost 1.25x input (5-minute) or
// 2x (1-hour); fast mode costs twice the standard rates. Models not listed show "no price".
const LIST_PRICES = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
};
// Claude Haiku 5.5 costs more for prompts over 100K tokens.
const LONG_PROMPT = { 'claude-haiku-5-5': { over: 100000, rates: [0.5, 2.5, 0.05] } };

/**
 * @typedef {import('../providers/types').UsageRecord} UsageRecord
 * @typedef {import('./config').Price} Price
 * @typedef {{replies: number, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, unpriced: number}} Counts
 * @typedef {Counts & {branch: string, model: string, day: string}} Row
 * @typedef {Counts & {name: string, sessions: number, active: number, kwh?: number}} Group
 * @typedef {Counts & {name: string, branches: string[], sessions: number, machines: string[], active: number, first: string, last: string, kwh: number, models: Group[]}} Feature
 * @typedef {Counts & {provider: string, id: string, title: string, first?: number, last?: number, active: number, branches: string[], models: string[], rows: Row[], context: Record<string, number>, machine: string}} SessionUsage
 * @typedef {{text: string, session: string, branch: string, ts?: string, tokens: number, cost: number, replies?: number, unpriced?: number}} Question
 */

/** A model's price, allowing a date suffix ("claude-haiku-4-5-20251001"); null when unknown. */
function priceOf(model, overrides, promptTokens) {
  const match = (table) => Object.keys(table).find((k) => model === k || model.startsWith(`${k}-2`));
  const custom = match(overrides);
  if (custom) return overrides[custom];
  const id = match(LIST_PRICES);
  if (!id) return null;
  const long = LONG_PROMPT[id];
  const [input, output, cacheRead] = long && promptTokens > long.over ? long.rates : LIST_PRICES[id];
  return { input, output, cacheRead };
}

/**
 * Estimated $ for one reply at API list prices, or null when its model has no price.
 * @param {UsageRecord} r
 * @param {Record<string, Price>} overrides
 */
function replyCost(r, overrides = {}) {
  const p = priceOf(r.model, overrides, r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h);
  if (!p) return null;
  const write5m = p.cacheWrite5m ?? p.input * 1.25;
  const write1h = p.cacheWrite1h ?? p.input * 2;
  const usd = (r.input * p.input + r.output * p.output + r.cacheRead * p.cacheRead + r.cacheWrite5m * write5m + r.cacheWrite1h * write1h) / 1e6;
  return r.fast ? usd * 2 : usd;
}

const counts = () => ({ replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 });
/** @param {Counts} into @param {Counts} c */
function add(into, c) {
  for (const k of /** @type {(keyof Counts)[]} */ (Object.keys(counts()))) into[k] += c[k];
  return into;
}
const tokens = (c) => c.input + c.output + c.cacheRead + c.cacheWrite;

/**
 * One session's usage, small enough to cache: totals per branch, model and day, active time per
 * branch, and its most expensive questions. Text is cleaned like a handoff (secrets, paths).
 */
function sessionUsage(adapter, ref, prices, ctx) {
  const { title, records } = adapter.readUsage(ref);
  const clean = (text, max) => {
    const t = sanitize(text, ctx).text.replace(/\s+/g, ' ').trim(); // redact before cutting, so no half secret survives
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {Record<string, number>} */
  const active = {};
  /** @type {Record<string, number>} */
  const context = {}; // per branch: what each message re-sent at the end
  const lastAt = {};
  const asked = new Map();
  let topic = '';
  let first;
  let last;
  for (const r of records) {
    const branch = r.branch || ctx.branchAt(Date.parse(r.ts || '')) || '';
    const day = (r.ts || '').slice(0, 10);
    const cost = replyCost(r, prices);
    const reply = { replies: 1, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite5m + r.cacheWrite1h, cost: cost ?? 0, unpriced: cost === null ? 1 : 0 };
    const key = `${branch}\t${r.model}\t${day}`;
    if (!rows.has(key)) rows.set(key, { branch, model: r.model, day, ...counts() });
    add(/** @type {Row} */ (rows.get(key)), reply);
    // The prompt of the branch's last main-thread reply: what continuing the session re-sends per message.
    if (!r.subagent) context[branch] = r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    const at = Date.parse(r.ts || '');
    if (at) {
      first = Math.min(first ?? at, at);
      last = Math.max(last ?? at, at);
      const gap = at - (lastAt[branch] ?? at);
      if (gap > 0 && gap <= IDLE_MS) active[branch] = (active[branch] || 0) + gap;
      lastAt[branch] = at;
    }
    // A reply like "sure" or "send it" continues the request before it, so its work counts there.
    if (r.question && (isSubstantive(r.question) || !topic)) topic = r.question;
    if (topic) {
      const q = asked.get(topic) || { branch, ts: r.ts, tokens: 0, cost: 0, replies: 0, unpriced: 0 };
      q.tokens += tokens(reply);
      q.cost += reply.cost;
      q.replies += 1;
      q.unpriced += reply.unpriced;
      asked.set(topic, q);
    }
  }
  const questions = [...asked]
    .sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)
    .slice(0, QUESTIONS_KEPT)
    .map(([text, q]) => ({ text: clean(text, 120), ...q }));
  return { provider: ref.provider, id: ref.id, title: clean(title || ref.id.slice(0, 8), 80), first, last, rows: [...rows.values()], active, context, questions };
}

function stat(file) {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return { size: -1, mtime: 0 };
  }
}

let machine;
/** This computer's model and chip, e.g. "Mac17,7 · Apple M5 Max · 18 cores". Never its name, which often contains yours. */
function machineLabel() {
  if (machine) return machine;
  let model = '';
  if (process.platform === 'darwin') {
    try {
      model = execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // not available: the OS and architecture stand in
    }
  }
  const cpus = os.cpus();
  machine = [model || `${os.type()} ${os.arch()}`, cpus[0]?.model?.trim(), cpus.length && `${cpus.length} cores`].filter(Boolean).join(' · ');
  return machine;
}

/**
 * This project's usage, totalled by feature, branch, session, model, day and question. Reads only
 * local logs; a session whose log hasn't changed comes from the cache, which is also a ledger: a
 * session whose log is gone keeps the totals it was recorded with.
 * @param {string} cwd
 * @param {import('./config').Config} config
 */
async function usageSummary(cwd, config) {
  const file = path.join(storeDir(cwd), 'usage.json'); // shared by every story folder of the project
  const prices = config.usage?.prices || {};
  let branches; // the reflog is read only if a session needs recounting
  const ctx = { cwd, redact: config.redact, branchAt: (ms) => (branches ||= branchAt(cwd))(ms) };
  // Cached totals are only valid for the prices and redaction settings they were made with, and
  // a folder that became a git repo can now name the branch of work logged on "HEAD".
  const stamp = crypto
    .createHash('sha256')
    .update(JSON.stringify([VERSION, LIST_PRICES, LONG_PROMPT, prices, config.redact, Boolean(gitDir(cwd))]))
    .digest('hex')
    .slice(0, 16);
  const cache = readJson(file, null);
  const fresh = cache?.stamp === stamp;
  const cached = cache?.sessions || {};
  const sessions = {};
  const notIncluded = [];
  for (const id of config.sources) {
    const adapter = getProvider(id);
    if (!adapter?.listSessions) continue;
    if (!adapter.readUsage) {
      notIncluded.push(adapter.label);
      continue;
    }
    for (const ref of await adapter.listSessions(cwd)) {
      const key = crypto.createHash('sha256').update(ref.path).digest('hex').slice(0, 16); // no paths on disk
      const now = stat(ref.path);
      const hit = cached[key];
      sessions[key] = fresh && hit && hit.size === now.size && hit.mtime === now.mtime ? hit : { ...now, machine: machineLabel(), ...sessionUsage(adapter, ref, prices, ctx) };
    }
  }
  // Sessions not counted here keep the totals they were recorded with: another story folder's,
  // or one whose log is gone (Claude Code deletes logs after about 30 days), so a feature's cost
  // stays complete. Re-read just before saving, so a window saving at the same time isn't overwritten.
  const counted = new Set(Object.keys(sessions));
  const latest = readJson(file, null)?.sessions || cached;
  for (const [key, s] of Object.entries(latest)) {
    if (!counted.has(key) && s.rows && config.sources.includes(s.provider)) sessions[key] = s;
  }
  if (Object.keys(sessions).length && JSON.stringify(sessions) !== JSON.stringify(latest)) {
    ensureGitignore(cwd);
    writeFile(file, JSON.stringify({ version: VERSION, stamp, sessions }) + '\n');
  }
  return summarize(Object.values(sessions), config, notIncluded);
}

/** The feature a branch belongs to: its story ID, so branches for one story count together, or the branch. */
const featureOf = (branch) => storyId(branch)?.id || branch;

/** Estimated kWh your machine used over `ms` of active time. */
const energy = (ms, config) => (ms / 3600000) * (config.usage?.machineWatts ?? 15) / 1000;

/** Totals across sessions. */
function summarize(sessions, config, notIncluded) {
  const total = { ...counts(), active: 0 };
  /** @type {(map: Map<string, Group>, name: string) => Group} */
  const group = (map, name) => map.get(name) || /** @type {Group} */ (map.set(name, { name, sessions: 0, active: 0, ...counts() }).get(name));
  const branches = new Map();
  const models = new Map();
  const days = new Map();
  /** @type {Map<string, Feature>} */
  const features = new Map();
  /** @type {(name: string) => Feature} */
  const feature = (name) =>
    features.get(name) || /** @type {Feature} */ (features.set(name, { name, branches: [], sessions: 0, machines: [], active: 0, first: '', last: '', kwh: 0, models: [], ...counts() }).get(name));
  /** @type {SessionUsage[]} */
  const list = [];
  /** @type {Question[]} */
  const questions = [];
  const unpriced = new Set();
  for (const s of sessions) {
    const mine = { ...counts(), active: 0 };
    const mineFeatures = new Set();
    for (const row of s.rows) {
      add(total, row);
      add(mine, row);
      add(group(branches, row.branch), row);
      add(group(models, row.model), row);
      add(group(days, row.day), row);
      if (row.unpriced) unpriced.add(row.model);
      const f = feature(featureOf(row.branch));
      add(f, row);
      let llm = f.models.find((m) => m.name === row.model);
      if (!llm) f.models.push((llm = { name: row.model, sessions: 0, active: 0, ...counts() }));
      add(llm, row);
      if (!f.branches.includes(row.branch)) f.branches.push(row.branch);
      if (row.day && (!f.first || row.day < f.first)) f.first = row.day;
      if (row.day > f.last) f.last = row.day;
      const where = s.machine || machineLabel();
      if (!f.machines.includes(where)) f.machines.push(where);
      mineFeatures.add(f);
    }
    for (const f of mineFeatures) f.sessions++;
    for (const [branch, ms] of Object.entries(s.active)) {
      group(branches, branch).active += ms;
      feature(featureOf(branch)).active += ms;
      mine.active += ms;
    }
    total.active += mine.active;
    const onBranches = [...new Set(s.rows.map((r) => r.branch))];
    for (const b of onBranches) group(branches, b).sessions++;
    for (const m of new Set(s.rows.map((r) => r.model))) group(models, m).sessions++;
    list.push({ ...mine, provider: s.provider, id: s.id, title: s.title, first: s.first, last: s.last, branches: onBranches, models: [...new Set(s.rows.map((r) => r.model))], rows: s.rows, context: s.context || {}, machine: s.machine || machineLabel() });
    questions.push(...s.questions.map((q) => ({ ...q, session: s.title })));
  }
  const costly = (a, b) => b.cost - a.cost || tokens(b) - tokens(a);
  for (const b of branches.values()) b.kwh = energy(b.active, config);
  for (const f of features.values()) {
    f.kwh = energy(f.active, config);
    f.models.sort(costly);
    f.branches.sort();
  }
  return {
    asOf: PRICES_AS_OF,
    showCost: config.usage?.showCost !== false,
    machine: machineLabel(),
    watts: config.usage?.machineWatts ?? 15,
    electricityPrice: config.usage?.electricityPrice || 0,
    total: { ...total, first: Math.min(...list.map((s) => s.first ?? Infinity)), last: Math.max(...list.map((s) => s.last ?? 0)) },
    features: [...features.values()].sort(costly),
    branches: [...branches.values()].sort(costly),
    sessions: list.sort((a, b) => (b.last ?? 0) - (a.last ?? 0)),
    models: [...models.values()].sort(costly),
    days: [...days.values()].sort((a, b) => a.name.localeCompare(b.name)),
    questions: questions.sort(costly).slice(0, 10),
    unpriced: [...unpriced],
    notIncluded,
  };
}

/** @typedef {Awaited<ReturnType<typeof usageSummary>>} Summary */

const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const duration = (ms) => (ms < 60000 ? '<1m' : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`);
/** "$4.10", "$4.10+" when some replies had no price, "no price" when none had one. */
const money = (c) => (c.unpriced === c.replies ? 'no price' : `$${c.cost.toFixed(2)}${c.unpriced ? '+' : ''}`);
/** money(), saying what the figure is, since on a subscription it isn't what you pay: "$4.10 at API prices". */
const atApiPrices = (c) => (c.unpriced === c.replies ? money(c) : `${money(c)} at API prices`);
const branchName = (name) => name || '(no branch recorded)';
/** "0.8 Wh", "42 Wh", "1.25 kWh", or '' for next to nothing. */
const energyText = (kwh = 0) => {
  const wh = kwh * 1000;
  if (wh < 0.05) return '';
  return wh >= 1000 ? `${kwh.toFixed(2)} kWh` : `${wh < 10 ? wh.toFixed(1) : Math.round(wh)} Wh`;
};

/** One line, e.g. "1.2M tokens · $4.10 at API prices · 2h 10m active · ~32 Wh", for tooltips. */
function describe(c, showCost) {
  const used = energyText(c.kwh);
  return [`${short(tokens(c))} tokens`, showCost && atApiPrices(c), c.active !== undefined && `${duration(c.active)} active`, used && `~${used}`].filter(Boolean).join(' · ');
}

/** Usage of one session on one branch, for the panel; key is "provider:id8" as in the catalog. */
function sessionOnBranch(summary, key, branch) {
  const s = summary.sessions.find((x) => key.split('+').includes(`${x.provider}:${x.id.slice(0, 8)}`));
  const rows = s?.rows.filter((r) => r.branch === branch) || [];
  return rows.length ? { ...rows.reduce((c, r) => add(c, r), counts()), context: s?.context[branch] } : null;
}

/** Rough token count, about 4 characters a token. */
const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * A handoff's size next to what continuing its session re-sent per message, e.g. "~2.2k tokens,
 * vs ~313.0k per message to continue the session". The gap is what starting fresh saves on every
 * message. A large handoff is flagged, since the next session reads it with every message.
 * @param {string} text  the handoff
 * @param {number} [context]  the session's last prompt size on the handoff's branch
 */
function handoffSize(text, context = 0) {
  const n = estimateTokens(text);
  const line = [`~${short(n)} tokens`, context > n && `vs ~${short(context)} per message to continue the session`].filter(Boolean).join(', ');
  return n > BIG_HANDOFF ? `${line}. Large: the next session reads it with every message` : line;
}

/**
 * The summary as Markdown, for the Usage Report tab and `carrycontext usage`.
 * @param {Summary} s
 * @param {string} project
 */
function renderReport(s, project) {
  const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  // Numbers right-aligned, text left-aligned.
  const TEXT = ['Feature', 'Branches', 'LLM', 'Span', 'Branch', 'Session', 'Model', 'Day', 'Question', 'When', 'Last'];
  const table = (head, rows) =>
    [`| ${head.join(' | ')} |`, `|${head.map((h) => (TEXT.includes(h) ? '---' : '---:')).join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
  const cost = (c) => (s.showCost ? [money(c)] : []);
  const costHead = s.showCost ? ['At API prices'] : [];
  const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '');
  // Energy, and what it cost when you've set a price per kWh.
  const power = (kwh) => {
    const used = energyText(kwh);
    return used && s.electricityPrice ? `${used} · $${(kwh * s.electricityPrice).toFixed(2)}` : used;
  };
  // One row per feature and LLM; the feature's own figures on its first row, a total when it used several LLMs.
  const featureRows = s.features.flatMap((f) => {
    const branches = f.branches.length === 1 && f.branches[0] === f.name ? '' : f.branches.map(branchName).join(', ');
    const span = f.first === f.last ? f.first : `${f.first} → ${f.last}`;
    const rows = f.models.map((m, i) => (i ? ['', '', m.name, short(tokens(m)), ...cost(m), '', '', ''] : [branchName(f.name), branches, m.name, short(tokens(m)), ...cost(m), duration(f.active), span, power(f.kwh)]));
    if (f.models.length > 1) rows.push(['', '', 'all LLMs', short(tokens(f)), ...cost(f), '', '', '']);
    return rows;
  });
  const out = [`# Usage · ${project}`, ''];
  out.push(
    `From the assistants' logs on this computer; nothing was sent anywhere.${
      s.showCost
        ? ` Costs are what this work would cost through Anthropic's API at list prices (as of ${s.asOf}), not what you pay: a Claude subscription doesn't charge per token.`
        : ''
    }`,
    '',
  );
  if (!s.total.replies) {
    out.push('No usage found for this folder yet.');
  } else {
    out.push(
      `**${s.total.replies} repl${s.total.replies === 1 ? 'y' : 'ies'} · ${short(tokens(s.total))} tokens${s.showCost ? ` · ${atApiPrices(s.total)}` : ''} · ${duration(s.total.active)} active** (${day(s.total.first)} to ${day(s.total.last)})`,
      '',
      `Machine: ${s.machine}`,
      '',
      '## By feature',
      '',
      'A feature is a story ID from the branch name, so `feature/24114362` and `bugfix/24114362-x` count together; a branch without one is its own feature.',
      '',
      table(['Feature', 'Branches', 'LLM', 'Tokens', ...costHead, 'Active', 'Span', 'Energy'], featureRows),
      '',
      '## By branch',
      '',
      table(['Branch', 'Sessions', 'Replies', 'Tokens', 'Active', ...costHead, 'Energy'], s.branches.map((b) => [branchName(b.name), b.sessions, b.replies, short(tokens(b)), duration(b.active), ...cost(b), power(b.kwh)])),
      '',
      '## By session',
      '',
      table(
        ['Session', 'Branch', 'Model', 'Replies', 'Tokens', 'Active', ...costHead, 'Last'],
        s.sessions.map((x) => [x.title, x.branches.map(branchName).join(', '), x.models.join(', '), x.replies, short(tokens(x)), duration(x.active), ...cost(x), day(x.last)]),
      ),
      '',
      '## By model',
      '',
      table(['Model', 'Replies', 'Input', 'Output', 'Cache write', 'Cache read', ...costHead], s.models.map((m) => [m.name, m.replies, short(m.input), short(m.output), short(m.cacheWrite), short(m.cacheRead), ...cost(m)])),
      '',
      '## By day',
      '',
      table(['Day', 'Replies', 'Tokens', ...costHead], s.days.map((d) => [d.name || '(no date)', d.replies, short(tokens(d)), ...cost(d)])),
      '',
      '## Most expensive questions',
      '',
      table([...costHead, 'Tokens', 'Question', 'Session', 'When'], s.questions.map((q) => [...(s.showCost ? [q.replies ? money(q) : `$${q.cost.toFixed(2)}`] : []), short(q.tokens), q.text, q.session, (q.ts || '').slice(0, 10)])),
      '',
      'Tokens are input + output + cache writes + cache reads. Cache reads cost a small fraction of input, so they can dominate the count without dominating the cost.',
    );
  }
  const notes = [];
  if (s.total.replies) {
    notes.push(
      `Energy is your machine's, during active AI time, estimated at ${s.watts} W (\`carrycontext.usage.machineWatts\`)${s.electricityPrice ? ` and priced at $${s.electricityPrice}/kWh` : ''}. The AI's own data-center energy isn't included: it isn't published per request.`,
    );
  }
  if (s.unpriced.length) notes.push(`No built-in price for ${s.unpriced.join(', ')}: set \`carrycontext.usage.prices\` to include them.`);
  if (s.notIncluded.length) notes.push(`Not included yet: ${s.notIncluded.join(', ')}. Copilot and Cursor keep no usage logs on this computer.`);
  if (notes.length) out.push('', ...notes.map((n) => `- ${n}`));
  return out.join('\n') + '\n';
}

/**
 * One CSV row per session, branch, model and day, for spreadsheets.
 * @param {Summary} s
 */
function renderCsv(s) {
  // Cells starting with =, +, - or @ would run as formulas in a spreadsheet, so they get a quote.
  const cell = (v) => {
    const t = typeof v === 'number' ? String(v) : String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&");
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ['provider', 'session_id', 'session', 'feature', 'branch', 'model', 'day', 'machine', 'replies', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', ...(s.showCost ? ['estimated_cost_usd'] : [])];
  const lines = [head.join(',')];
  for (const x of s.sessions) {
    for (const r of x.rows) {
      const price = s.showCost ? [r.unpriced === r.replies ? '' : r.cost.toFixed(4)] : [];
      lines.push([x.provider, x.id, x.title, featureOf(r.branch), r.branch, r.model, r.day, x.machine, r.replies, r.input, r.output, r.cacheWrite, r.cacheRead, ...price].map(cell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { PRICES_AS_OF, replyCost, usageSummary, renderReport, renderCsv, describe, sessionOnBranch, handoffSize };
