const test = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/env');

const env = sandbox();
const s = require('../src/core/summarize');
test.after(() => env.cleanup());

const user = (text) => ({ role: 'user', text, provider: 'claude' });
const assistant = (text, tools = []) => ({ role: 'assistant', text, tools, provider: 'claude' });

test('parseSections splits on level-2 headings', () => {
  const doc = '# Title\n\n- meta\n\n## Goal\n\nShip it\n\n## Next steps\n\n- a\n- b\n';
  assert.deepEqual(s.parseSections(doc), { Goal: 'Ship it', 'Next steps': '- a\n- b' });
  assert.deepEqual(s.parseSections(''), {});
});

test('extractFacts finds edits, reads, commands and todos across tool formats', () => {
  const facts = s.extractFacts([
    assistant('', [
      { name: 'Edit', input: { file_path: '/p/a.js' } },
      { name: 'Read', input: { file_path: '/p/a.js' } },
      { name: 'Read', input: { file_path: '/p/b.js' } },
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'shell', input: { command: ['bash', '-lc', 'ls src'] } },
      { name: 'apply_patch', input: { raw: '*** Update File: c.js\n*** Add File: d.js' } },
      { name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } },
    ]),
  ]);
  assert.deepEqual(facts.edited.sort(), ['/p/a.js', 'c.js', 'd.js']);
  assert.deepEqual(facts.read, ['/p/b.js']); // a.js was edited, so it isn't listed as only read
  assert.deepEqual(facts.commands, ['npm test', 'ls src']);
  assert.equal(facts.todos.length, 1);
});

test('condense keeps the head and tail within budget', () => {
  const msgs = Array.from({ length: 200 }, (_, i) => user(`message ${i} ${'x'.repeat(100)}`));
  const out = s.condense(msgs, 5000);
  assert.ok(out.length <= 5200, `too long: ${out.length}`);
  assert.match(out, /message 0 /);
  assert.match(out, /message 199 /);
  assert.match(out, /messages omitted/);
});

test('heuristicSections uses the first request as goal and the last reply as state', () => {
  const sec = s.heuristicSections([user('Build a CLI'), assistant('Started'), user('Add tests'), assistant('Tests pass')], {});
  assert.equal(sec.Goal, 'Build a CLI');
  assert.match(sec['Current state'], /Tests pass/);
  assert.match(sec['Recent requests'], /Add tests/);
  assert.equal(sec['Short description'], 'Add tests');
});

test('the short description skips replies that say nothing about the work', () => {
  const sec = s.heuristicSections([user('Build the export feature'), assistant('Started'), user('sure, send it'), user('thanks!')], {});
  assert.equal(sec['Short description'], 'Build the export feature');
  assert.equal(s.heuristicSections([user('ok'), user('yes go ahead')], {})['Short description'], '', 'the goal names it instead');
  for (const reply of ['send', 'Sure.', 'ok send it', 'yes do it', 'thank you', 'LGTM', '<task-notification>x</task-notification>', 'yes it looks right', "That's fine for now", 'it works for me']) {
    assert.equal(s.isSubstantive(reply), false, reply);
  }
  for (const request of ['Add tests', 'okay draft emails for the remaining test cases', 'no, use pnpm instead', 'Notice the bug in login', 'yes it looks right, now fix the README', 'रीडमी अपडेट करो']) {
    assert.equal(s.isSubstantive(request), true, request);
  }
});

test('heuristicSections keeps richer sections from the previous handoff', () => {
  const sec = s.heuristicSections([user('more work'), assistant('ok')], { Goal: 'Original goal', Gotchas: 'Watch out' });
  assert.equal(sec.Goal, 'Original goal');
  assert.equal(sec.Gotchas, 'Watch out');
});

test('constraintStatements picks rule-like sentences only', () => {
  const found = s.constraintStatements([user("Build it. Don't publish my email anywhere. Use pnpm instead of npm. Thanks a lot friend.")]);
  assert.deepEqual(
    found.map((f) => f.replace(/ _\(user request\)_$/, '')),
    ["Don't publish my email anywhere.", 'Use pnpm instead of npm.'],
  );
});

test('constraintStatements skips questions and remarks that only contain "don\'t"', () => {
  const found = s.constraintStatements([
    user("How can I solve this, tools don't know the branch? I don't have any branches yet. Do not log tokens. No network calls required here."),
    user('Keep handoff files by session name, always.'),
  ]);
  assert.deepEqual(
    found.map((f) => f.replace(/ _\(user request\)_$/, '')),
    ['Do not log tokens.', 'No network calls required here.', 'Keep handoff files by session name, always.'],
  );
});

test('mergeDecisions drops earlier picks from user requests that are not rules, and keeps the rest as written', () => {
  const kept = ["- Don't publish my email. _(2026-10-29 · main · user request)_", '- How should we store it? Chose JSON over SQLite _(2026-10-29 · main)_'];
  const existing = [
    "- how can I solve this, tools don't know that? _(2026-10-30 · main · user request)_",
    kept[0],
    '- not seeing older branches but I dont have any yet. _(2026-10-30 · main · user request)_',
    kept[1], // written by an LLM summarizer or by hand: never re-checked
  ].join('\n');
  assert.equal(s.mergeDecisions(existing, '', '2026-10-31 · main'), kept.join('\n'));
});

test('mergeDecisions appends new entries, tags them and skips duplicates and placeholders', () => {
  let log = s.mergeDecisions('', '- Use SQLite, zero config\n- _Not captured placeholder_', '2026-10-25 · main');
  assert.equal(log, '- Use SQLite, zero config _(2026-10-25 · main)_');
  log = s.mergeDecisions(log, '- use sqlite zero config.\n- Reverted: use Postgres', '2026-10-26 · main');
  const lines = log.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /2026-10-25/); // the original entry is kept exactly
  assert.match(lines[1], /^- Reverted: use Postgres _\(2026-10-26 · main\)_$/);
});

test('shortText strips markdown and limits words', () => {
  assert.equal(s.shortText('**Add** `named` files for every single session today\nsecond line', 4), 'Add named files for');
});
