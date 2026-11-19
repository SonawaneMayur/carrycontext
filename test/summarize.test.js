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

test('"Files & code" lists only files in the project, not scratch folders, /tmp or the assistant\'s memory', () => {
  const touched = assistant('', [
    { name: 'Edit', input: { file_path: '/p/app/src/a.js' } },
    { name: 'Edit', input: { file_path: '/home/u/.claude/projects/app/memory/rule.md' } },
    { name: 'Read', input: { file_path: '/tmp/scratch/notes.txt' } },
    { name: 'Read', input: { file_path: '/p/app/README.md' } },
    { name: 'apply_patch', input: { raw: '*** Update File: src/b.js' } },
  ]);
  const files = s.heuristicSections([user('Fix it'), touched], {}, '/p/app')['Files & code'];
  assert.match(files, /\/p\/app\/src\/a\.js/);
  assert.match(files, /src\/b\.js/, 'relative paths are project files');
  assert.match(files, /README\.md/);
  assert.doesNotMatch(files, /memory|\/tmp/);
  assert.match(s.heuristicSections([user('Fix it'), touched], {})['Files & code'], /\/tmp\/scratch/, 'without a project folder, nothing is dropped');
});

test('constraintStatements skips markdown table rows', () => {
  const found = s.constraintStatements([user('| Rule | Never edit generated files |\n| Owner | Must be the platform team |\nNever push to main directly.')]);
  assert.deepEqual(
    found.map((f) => f.replace(/ _\(user request\)_$/, '')),
    ['Never push to main directly.'],
  );
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

// A compaction summary in Claude Code's format, as the Claude reader passes it on.
const compacted = (ts = '2026-11-10T19:01:55.537Z') => ({
  role: 'system',
  provider: 'claude',
  ts,
  text: `[Earlier compaction summary]
This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

<system-reminder>
<tools-used-before-summary>Bash, Edit</tools-used-before-summary>
</system-reminder>
Summary:
1. Primary Request and Intent:
   Build an export feature for the reports page, CSV first.

2. Key Technical Concepts:
   - Streams

3. Files and Code Sections (repo \`/p/app\`):
   - src/export.js
     \`\`\`js
     secretCode()
     \`\`\`

4. Errors and fixes:
   - The CSV header was missing. Fixed by writing it before the first row.

5. Problem Solving:
   Chose streaming to keep memory flat.

6. All user messages:
   - "my private aside"

7. Pending Tasks:
   1. Add an Excel export.
   2. Update the README.

8. Current Work:
   CSV export works and its tests pass.

9. Optional Next Step:
   Start the Excel export.

If you need specific details from before compaction (like exact code snippets), read the full transcript at: /x.jsonl
Continue the conversation from where it left off without asking the user any further questions.`,
});

test('compactionSummary maps the assistant\'s summary onto handoff sections and leaves the rest out', () => {
  const c = s.compactionSummary([user('Build the export'), compacted(), assistant('Looking at Excel libraries')]);
  assert.equal(c.ts, '2026-11-10T19:01:55.537Z');
  assert.equal(c.after.length, 1);
  assert.deepEqual(c.sections, {
    Goal: 'Build an export feature for the reports page, CSV first.',
    Gotchas: '- The CSV header was missing. Fixed by writing it before the first row.',
    'Open tasks': '1. Add an Excel export.\n2. Update the README.', // nested lists are kept, not taken as headings
    'Current state': 'CSV export works and its tests pass.',
    'Next steps': 'Start the Excel export.',
  });
  const all = Object.values(c.sections).join('\n');
  assert.doesNotMatch(all, /private aside|secretCode|tools-used|full transcript|Continue the conversation/);
  assert.equal(s.compactionSummary([user('a'), assistant('b')]), null, 'never compacted');
});

test('compactionSummary uses the newest summary when a session was compacted more than once', () => {
  const older = compacted('2026-10-27T20:36:04.250Z');
  older.text = older.text.replace('CSV export works', 'Nothing works yet');
  const c = s.compactionSummary([older, user('more'), compacted()]);
  assert.equal(c.sections['Current state'], 'CSV export works and its tests pass.');
});

test('heuristicSections prefers the compaction summary over the first prompt and keeps newer work first', () => {
  const sec = s.heuristicSections(
    [user('build export pls'), assistant('Started'), compacted(), user('Now add the Excel export'), assistant('Excel export is half done')],
    { Goal: 'build export pls', Gotchas: 'Old gotcha' },
  );
  assert.equal(sec.Goal, 'Build an export feature for the reports page, CSV first.');
  assert.match(sec['Current state'], /^Last assistant update \(claude[^]*Excel export is half done[^]*At the last compaction \(claude, 2026-11-10T19:01:55\.537Z\)[^]*CSV export works/);
  assert.match(sec['Open tasks'], /Add an Excel export/);
  assert.match(sec['Next steps'], /^Start the Excel export\.\n\n_From the last compaction\. The recent requests above are newer/);
  assert.equal(sec.Gotchas, '- The CSV header was missing. Fixed by writing it before the first row.');
});

test('heuristicSections uses the compaction state alone when nothing came after it', () => {
  const sec = s.heuristicSections([user('build export'), assistant('Before the compaction'), compacted(), user('ok')], {});
  assert.match(sec['Current state'], /^At the last compaction/);
  assert.doesNotMatch(sec['Current state'], /Before the compaction/, 'replies before the summary are older than it');
  assert.equal(sec['Next steps'], 'Start the Excel export.', '"ok" is not a newer request');
});

test('a newer todo list beats the compaction summary for tasks and next step', () => {
  const todos = { name: 'TodoWrite', input: { todos: [{ content: 'Write Excel tests', status: 'in_progress' }] } };
  const sec = s.heuristicSections([compacted(), assistant('', [todos])], {});
  assert.equal(sec['Open tasks'], '- [ ] Write Excel tests _(in progress)_');
  assert.equal(sec['Next steps'], '- Finish: Write Excel tests');
});
