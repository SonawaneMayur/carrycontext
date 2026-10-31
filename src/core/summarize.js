// @ts-check
const { truncate } = require('./util');
const { getLlm } = require('../llm');
const { sanitize } = require('./sanitize');

/** Section order of the handoff body. The LLM is asked for exactly these. */
const SECTIONS = ['Goal', 'Current state', 'Key decisions', 'Files & code', 'Open tasks', 'Next steps', 'Gotchas'];

const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|write_file|replace|edit_file|apply_patch)$/i;
const READ_TOOLS = /^(Read|read_file|read_many_files|view)$/i;
const SHELL_TOOLS = /^(Bash|shell|local_shell|local_shell_call|run_shell_command|exec_command)$/i;

/**
 * Pull concrete facts (files, commands, todos) out of tool calls.
 * @param {import('../providers/types').Message[]} messages
 */
function extractFacts(messages) {
  const edited = new Set();
  const read = new Set();
  const commands = [];
  let todos = null;
  for (const m of messages) {
    for (const t of m.tools || []) {
      const input = t.input || {};
      const file = input.file_path || input.notebook_path || input.path || input.absolute_path;
      if (EDIT_TOOLS.test(t.name)) {
        if (file) edited.add(file);
        // Codex apply_patch: "*** Update File: path"
        const patch = typeof input === 'string' ? input : input.input || input.raw || input.patch || '';
        for (const match of String(patch).matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) edited.add(match[1].trim());
      } else if (READ_TOOLS.test(t.name) && file) {
        read.add(file);
      } else if (SHELL_TOOLS.test(t.name)) {
        const cmd = input.command ?? input.cmd;
        const text = Array.isArray(cmd) ? cmd.join(' ') : cmd;
        if (text) commands.push(String(text).replace(/^bash -lc /, ''));
      } else if (t.name === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos;
      }
    }
  }
  for (const f of edited) read.delete(f);
  return { edited: [...edited], read: [...read], commands, todos };
}

/** Render messages as compact plain text, keeping head and tail within budget. */
function condense(messages, budget) {
  const lines = messages.map((m) => {
    const who = `${m.provider || ''}:${m.role}`;
    const tools = (m.tools || []).map((t) => `  → ${t.name}(${truncate(JSON.stringify(t.input ?? {}), 200)})`);
    return [`[${who}${m.ts ? ' ' + m.ts : ''}] ${truncate(m.text, 6000)}`, ...tools].join('\n');
  });
  const total = lines.reduce((n, l) => n + l.length + 2, 0);
  if (total <= budget) return lines.join('\n\n');
  const headBudget = budget * 0.15;
  const head = [];
  const tail = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length > headBudget) break;
    head.push(l);
    used += l.length + 2;
  }
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length > budget) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 2;
  }
  const omitted = lines.length - head.length - tail.length;
  return [...head, `… ${omitted} messages omitted …`, ...tail].join('\n\n');
}

/** Split a handoff markdown doc into { heading: body } on "## " headings. */
function parseSections(doc) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!doc) return out;
  let current = null;
  for (const line of doc.split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) {
      current = h[1];
      out[current] = '';
    } else if (current) {
      out[current] += line + '\n';
    }
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

const bullets = (items, fmt = (x) => x) => (items.length ? items.map((x) => `- ${fmt(x)}`).join('\n') : '');

/**
 * No-LLM handoff. Keeps sections from the previous handoff that a transcript
 * scan cannot reproduce (decisions, gotchas), so it never discards a richer
 * LLM- or agent-written handoff.
 * @returns {Record<string, string>}
 */
function heuristicSections(messages, prev) {
  const facts = extractFacts(messages);
  const users = messages.filter((m) => m.role === 'user' && m.text.trim());
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim());
  const openTodos = (facts.todos || []).filter((t) => t.status !== 'completed');
  const inProgress = openTodos.find((t) => t.status === 'in_progress');

  return {
    'Short description': shortText(latestRequest(users), 8),
    Goal: prev.Goal || truncate(users[0]?.text.trim() || '_Unknown_', 1500),
    'Current state': lastAssistant
      ? `Last assistant update (${lastAssistant.provider}${lastAssistant.ts ? ', ' + lastAssistant.ts : ''}):\n\n${quote(truncate(lastAssistant.text.trim(), 2500))}`
      : prev['Current state'] || '_No assistant output yet._',
    'Recent requests': bullets(users.slice(-6), (m) => truncate(m.text.trim().replace(/\s+/g, ' '), 400)),
    // Only new candidates; handoff.js merges them into the existing log.
    'Key decisions': bullets(constraintStatements(users)),
    'Files & code': [
      facts.edited.length ? `**Edited**\n${bullets(facts.edited.slice(-40), (f) => '`' + f + '`')}` : '',
      facts.read.length ? `**Read**\n${bullets(facts.read.slice(-20), (f) => '`' + f + '`')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n') || prev['Files & code'] || '',
    'Commands run': bullets(facts.commands.slice(-12), (c) => '`' + truncate(c.replace(/\n/g, ' '), 200) + '`'),
    'Open tasks': openTodos.length
      ? openTodos.map((t) => `- [ ] ${t.content}${t.status === 'in_progress' ? ' _(in progress)_' : ''}`).join('\n')
      : prev['Open tasks'] || '',
    'Next steps':
      (inProgress && `- Finish: ${inProgress.content}`) ||
      prev['Next steps'] ||
      '- Continue from the most recent request above.',
    Gotchas: prev.Gotchas || '',
  };
}

// Sentences in user messages that state a rule or a choice: an instruction ("Don't publish my
// email", "Keep it local"), a requirement ("must", "no network calls required") or a preference.
// Questions don't count, and neither does "don't" in a plain statement ("I don't have any yet").
const RULE_START = /^(?:(?:please|and|but|so)\s+)?(?:always|never|don'?t|do not|avoid|only|make sure|keep|stop)\b/i;
const RULE =
  /\b(?:always|never|must(?: not)?|should(?:n'?t| not)?|instead of|let'?s (?:use|keep|go with)|we'?ll use|i'?d rather|prefer|only use|keep\b.{1,40}?\b(?:out|private|local)|(?:i|we) (?:don'?t|do not) (?:want|need|like)|no\b[^.,;]{0,40}\b(?:required|needed|allowed))\b/i;
const QUESTION = /\?\s*$|^(?:how|what|why|which|where|when|who|can|could|should|would|will|is|are|does|did|do(?!\s+not\b))\b/i;
const MAX_CONSTRAINTS = 5;

const isRule = (sentence) => !QUESTION.test(sentence) && (RULE_START.test(sentence) || RULE.test(sentence));

/** Rule-like statements from the user ("don't publish my email", "use X instead of Y"). */
function constraintStatements(userMessages) {
  const out = [];
  for (const m of userMessages.slice(-30)) {
    for (const sentence of m.text.split(/(?<=[.!?])\s+|\n+/)) {
      const t = sentence.trim().replace(/\s+/g, ' ');
      if (t.length >= 15 && t.length <= 220 && isRule(t) && !/^[<`]/.test(t)) out.push(`${t} _(user request)_`);
    }
  }
  return out.slice(-MAX_CONSTRAINTS);
}

const DECISION_TAG = /\s*_\([^)]*\)_\s*$/;
const normalize = (entry) => entry.replace(DECISION_TAG, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Bullet entries of a decisions section, ignoring italic placeholders like "_Not captured…_". */
function decisionEntries(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter((l) => l && !/^_.*_$/.test(l) && !/^\*\*[^*]+:\*\*$/.test(l));
}

/**
 * Merge decisions into an append-only log: existing entries are kept as written,
 * new ones are added with a date and branch tag, duplicates (by text) are skipped.
 * Entries the built-in summary took from user requests are checked again, so a question
 * or a remark an earlier version picked by mistake drops out.
 */
function mergeDecisions(existing, incoming, tag) {
  const log = decisionEntries(existing).filter((e) => !/\buser request\)_$/.test(e) || isRule(e.replace(DECISION_TAG, '')));
  const seen = new Set(log.map(normalize));
  for (const entry of decisionEntries(incoming)) {
    const key = normalize(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const base = entry.replace(DECISION_TAG, '');
    const source = entry.match(DECISION_TAG)?.[0].trim().slice(2, -2);
    log.push(`${base} _(${[tag, source].filter(Boolean).join(' · ')})_`);
  }
  return log.map((e) => `- ${e}`).join('\n');
}

/** First `words` words of the first line, without markdown. */
const shortText = (text, words) =>
  text
    .trim()
    .split('\n')[0]
    .replace(/[`*_#>[\]]/g, '')
    .split(/\s+/)
    .slice(0, words)
    .join(' ');

// Replies that say nothing about the work: "sure", "ok send it", "yes go ahead", "thanks".
const REPLY =
  /^(?:(?:yes|yeah|yep|yup|no|nope|ok|okay|sure|right|correct|agreed|fine|alright|got it|thanks|thank you|thx|please|pls|go ahead|go on|go for it|do it|do that|sounds good|looks good|lgtm|great|perfect|cool|nice|awesome|done|send|sent|continue|proceed)\b[\s,.!]*)+/i;

// Words that only acknowledge ("it looks right", "that works for me"), so they don't say what the work is.
const ACK = new Set('it its that thats this all is are looks look seems sounds right good fine great ok okay correct perfect works work now me to for so far then both yes no as well too'.split(' '));

/** Whether a request says what the work is, so it can name a handoff: "Add tests" does, "sure, send it" and "yes it looks right" don't. */
function isSubstantive(text) {
  const t = text.trim();
  if (t.startsWith('<')) return false;
  const words = shortText(t.replace(REPLY, ''), 12).toLowerCase().replace(/['’]/g, '').split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  return words.length >= 2 && words.some((w) => !ACK.has(w));
}

/** The newest request that says what the work is, or '' (the goal then names the handoff). */
const latestRequest = (users) => [...users].reverse().find((m) => isSubstantive(m.text))?.text || '';

const quote = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');

const SYSTEM_PROMPT = `You write handoff documents that let a different AI coding assistant (possibly from another vendor, with no access to this conversation) resume the work with zero loss of context.

Rules:
- Be concrete: file paths, function names, commands, error messages, versions, decisions and WHY they were made.
- Record what is done, what is half-done, and what is not started. Never claim something works unless the transcript shows it verified.
- If a previous handoff is given, UPDATE it: keep what is still true, drop what is obsolete, add what is new.
- Start with "## Short description" containing one line of at most 8 words naming what is being worked on right now.
- Under "## Key decisions", list only decisions and constraints NOT already in the previous handoff, one bullet each with the reason. Earlier ones are kept automatically. If an earlier decision was reversed, add a new bullet saying so.
- Then output only markdown with exactly these level-2 headings, in this order: ${SECTIONS.map((s) => `"## ${s}"`).join(', ')}.
- No preamble, no closing remarks.`;

/**
 * LLM-written handoff sections.
 * @returns {Promise<Record<string, string>>}
 */
// Sections of the previous handoff worth keeping when the model's context is small.
// Key decisions are merged separately (mergeDecisions), so nothing is lost by leaving them out.
const ESSENTIAL_SECTIONS = ['Goal', 'Open tasks', 'Next steps'];

/**
 * The summarizer prompt, fitted to `budget` characters. Small budgets keep the transcript's
 * head and tail, an essentials-only previous handoff, and a shortened ground truth.
 */
function buildPrompt(messages, prevDoc, groundTruth, budget, small) {
  const facts = extractFacts(messages);
  const prev = small
    ? Object.entries(parseSections(prevDoc))
        .filter(([k]) => ESSENTIAL_SECTIONS.includes(k))
        .map(([k, v]) => `## ${k}\n${v}`)
        .join('\n\n')
    : prevDoc;
  const parts = [
    prev ? `<previous_handoff>\n${small ? truncate(prev, budget * 0.2) : prev}\n</previous_handoff>` : '',
    `<extracted_facts>\nEdited files: ${facts.edited.join(', ') || 'none'}\nCommands: ${facts.commands.slice(-20).join(' ; ') || 'none'}\nTodos: ${JSON.stringify(facts.todos || [])}\n</extracted_facts>`,
    groundTruth
      ? `<ground_truth>\nChecked against git and the session's recorded results right now. Prefer this over the transcript where they disagree, and never describe a contradicted claim as done.\n${small ? truncate(groundTruth, budget * 0.2) : groundTruth}\n</ground_truth>`
      : '',
  ].filter(Boolean);
  const used = parts.reduce((n, p) => n + p.length, 0);
  const transcriptBudget = Math.max(1000, budget - used - 200);
  return [...parts, `<transcript>\n${condense(messages, transcriptBudget)}\n</transcript>`, 'Write the handoff now.'].join('\n\n');
}

/** Remove a code fence some models wrap their whole answer in. */
const unfence = (text) => text.trim().replace(/^```[\w-]*\n/, '').replace(/\n```$/, '');

async function llmSections(messages, prevDoc, { summarizer, maxTranscriptChars, redact }, apiKey, groundTruth = '', cwd = '') {
  const client = getLlm(summarizer.provider);
  if (!client) throw new Error(`Unknown summarizer provider "${summarizer.provider}"`);
  if (client.needsKey && !apiKey) throw new Error(`No API key for ${summarizer.provider} (set it via "CarryContext: Set API Key" or ${client.envKey})`);
  const small = Boolean(client.contextChars);
  const ask = (budget) =>
    client.complete({
      model: summarizer.model || client.defaultModel,
      baseUrl: summarizer.baseUrl,
      apiKey,
      system: SYSTEM_PROMPT,
      // Secrets and personal paths never leave the process, even to the user's own model.
      prompt: sanitize(buildPrompt(messages, prevDoc, groundTruth, budget, small), { cwd, redact }).text,
    });
  const budget = small ? Math.min(maxTranscriptChars, client.contextChars) : maxTranscriptChars;
  let text;
  try {
    text = await ask(budget);
  } catch (e) {
    // The model reports exactly how far over it was: shrink to fit and try once more.
    if (e.code !== 'context' || !e.tokens || !e.limit) throw e;
    text = await ask(Math.floor((budget * e.limit * 0.8) / e.tokens));
  }
  const sections = parseSections(unfence(text));
  if (!Object.keys(sections).length) throw new Error('Summarizer returned no sections');
  return sections;
}

module.exports = {
  SECTIONS,
  EDIT_TOOLS,
  SHELL_TOOLS,
  extractFacts,
  condense,
  parseSections,
  heuristicSections,
  llmSections,
  shortText,
  isSubstantive,
  mergeDecisions,
  constraintStatements,
};
