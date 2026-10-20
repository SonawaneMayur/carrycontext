// @ts-check
// Builds, stores and distributes handoff.md. Shared by the VS Code extension and the CLI/hooks,
// so nothing in here may import 'vscode'.
const path = require('path');
const fs = require('fs');
const { dataDir } = require('./config');
const { writeFile, readText, readJson, listFiles, mtime, upsertManagedBlock, rel, shortenPaths } = require('./util');
const { SECTIONS, parseSections, heuristicSections, llmSections, shortText } = require('./summarize');
const { getProvider } = require('../providers');
const { getLlm } = require('../llm');

const RENDER_ORDER = ['Goal', 'Current state', 'Recent requests', 'Key decisions', 'Files & code', 'Commands run', 'Open tasks', 'Next steps', 'Gotchas'];

function paths(cwd) {
  const dir = dataDir(cwd);
  return {
    dir,
    handoff: path.join(dir, 'handoff.md'),
    handoffs: path.join(dir, 'handoffs'),
    state: path.join(dir, 'state.json'),
    inbox: path.join(dir, 'inbox'),
  };
}

const loadState = (cwd) => readJson(paths(cwd).state, { processed: {} });
const saveState = (cwd, state) => writeFile(paths(cwd).state, JSON.stringify(state, null, 2) + '\n');

/**
 * Newest session of each source provider that was active within the lookback window.
 * @returns {Promise<{adapter: import('../providers/types').ProviderAdapter, ref: import('../providers/types').SessionRef}[]>}
 */
async function gatherSessions(cwd, config) {
  const since = Date.now() - config.lookbackHours * 3600000;
  const out = [];
  for (const id of config.sources) {
    const adapter = getProvider(id);
    if (!adapter?.listSessions) continue;
    const [newest] = (await adapter.listSessions(cwd)).filter((s) => s.updatedAt >= since);
    if (newest) out.push({ adapter, ref: newest });
  }
  return out;
}

/**
 * Read sessions, summarize (merging with the previous handoff) and write everywhere.
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {{adapter: any, ref: import('../providers/types').SessionRef}[]} opts.sessions
 * @param {string} opts.trigger           e.g. "compact-all", "claude:precompact", "auto:idle"
 * @param {import('./config').Config} opts.config
 * @param {(provider: string) => Promise<string | undefined>} opts.getApiKey
 */
async function updateHandoff({ cwd, sessions, trigger, config, getApiKey }) {
  if (!sessions.length) throw new Error('No sessions found for this workspace.');
  const messages = [];
  const sources = [];
  for (const { adapter, ref } of sessions) {
    const msgs = await adapter.readSession(ref);
    messages.push(...msgs);
    sources.push({ provider: ref.provider, id: ref.id, messages: msgs.length });
  }
  if (sessions.length > 1) messages.sort((a, b) => (a.ts && b.ts ? a.ts.localeCompare(b.ts) : 0));

  const p = paths(cwd);
  const prevDoc = readText(p.handoff);
  const prev = parseSections(prevDoc);

  let sections;
  let summarizer = 'heuristic';
  let warning;
  if (config.summarizer.provider !== 'none') {
    try {
      const apiKey = await getApiKey(config.summarizer.provider);
      sections = await llmSections(messages, prevDoc, config, apiKey);
      summarizer = `${config.summarizer.provider}:${config.summarizer.model || getLlm(config.summarizer.provider)?.defaultModel}`;
    } catch (e) {
      warning = `Summarizer failed, used heuristic instead: ${e.message}`;
    }
  }
  sections ||= heuristicSections(messages, prev);

  const session = sessionName(sessions, messages);
  const description = shortText(sections['Short description'] || sections.Goal || '', 8) || 'handoff';
  delete sections['Short description'];

  // Never write the user's absolute paths (and so their username) into a handoff.
  const doc = shortenPaths(renderDoc({ cwd, sections, sources, trigger, summarizer, warning, session, description }), cwd);
  const sessionFile = saveHandoff(cwd, doc, config, handoffFileName(sessions, session, description));

  const state = loadState(cwd);
  for (const { ref } of sessions) state.processed[ref.path] = mtime(ref.path);
  Object.assign(state, { lastUpdated: new Date().toISOString(), trigger, sources, summarizer });
  saveState(cwd, state);
  return { doc, file: p.handoff, sessionFile, warning };
}

/** Claude's session title, else the first prompt; "compact-all" when sessions are merged. */
function sessionName(sessions, messages) {
  if (sessions.length > 1) return 'compact-all';
  const { ref } = sessions[0];
  const firstPrompt = messages.find((m) => m.role === 'user' && m.text.trim())?.text || '';
  return ref.title || shortText(firstPrompt, 6) || ref.id.slice(0, 8);
}

/** e.g. "claude-vs-code-compact-all-handoff-utility--add-readme-and-tests.md" */
function handoffFileName(sessions, session, description) {
  const providers = [...new Set(sessions.map((s) => s.ref.provider))].join('-');
  return `${providers}-${slugify(session)}--${slugify(description)}.md`;
}

function slugify(text, max = 50) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug || 'untitled';
  return slug.slice(0, max).replace(/-[^-]*$/, '');
}

function renderDoc({ cwd, sections, sources, trigger, summarizer, warning, session, description }) {
  const keys = [...RENDER_ORDER, ...Object.keys(sections).filter((k) => !RENDER_ORDER.includes(k))];
  const body = keys
    .filter((k) => sections[k] && sections[k].trim())
    .map((k) => `## ${k}\n\n${sections[k].trim()}`)
    .join('\n\n');
  const providers = [...new Set(sources.map((s) => s.provider))].join(', ');
  return `<!-- carrycontext:handoff v1 -->
# Handoff: ${path.basename(cwd)}

> **To the assistant reading this:** this is a handoff from an earlier AI session (${providers}).
> Read it fully, check the current state of the files before you edit them, then continue from **Next steps**.
> Ask the user only if something here is unclear or out of date. Paths are relative to the project root.

- **Session:** ${session}
- **Description:** ${description}
- **Updated:** ${new Date().toISOString()}
- **Trigger:** ${trigger}
- **Sources:** ${sources.map((s) => `${s.provider} \`${s.id.slice(0, 8)}\` (${s.messages} msgs)`).join(', ')}
- **Summarizer:** ${summarizer}${warning ? `\n- **Note:** ${warning}` : ''}

${body}
`;
}

/**
 * Write the canonical handoff.md (latest, read by providers), a named copy in
 * handoffs/, and mirror it to every target provider. Returns the named copy's path.
 */
function saveHandoff(cwd, doc, config, fileName) {
  const p = paths(cwd);
  const sessionFile = path.join(p.handoffs, fileName);
  writeFile(p.handoff, doc);
  writeFile(sessionFile, doc);
  const old = listFiles(p.handoffs, (f) => f.endsWith('.md')).sort((a, b) => mtime(a) - mtime(b));
  for (const f of old.slice(0, Math.max(0, old.length - config.handoffLimit))) fs.rmSync(f, { force: true });
  ensureGitignore(cwd);
  syncTargets(cwd, config, doc);
  return sessionFile;
}

/** Copy the canonical handoff into each target provider's location. */
function syncTargets(cwd, config, doc = readText(paths(cwd).handoff)) {
  if (!doc) return [];
  const written = [];
  for (const id of config.targets) {
    const target = getProvider(id)?.target;
    if (!target) continue;
    const file = target.handoffFile(cwd);
    writeFile(file, target.render ? target.render(doc) : doc);
    written.push(file);
    if (target.instructionsFile) {
      upsertManagedBlock(target.instructionsFile(cwd), target.inline ? doc : pointerBlock(rel(cwd, file)));
    }
  }
  return written;
}

const pointerBlock = (file) => `## Handoff from a previous AI session
Before starting work, read \`${file}\`. CarryContext wrote it from an earlier session, which may have been run by a different AI assistant.
Treat it as context: check the current state of the files before you edit them, then continue from its "Next steps".`;

function resumePrompt(cwd, providerId) {
  const target = getProvider(providerId)?.target;
  const file = rel(cwd, target ? target.handoffFile(cwd) : paths(cwd).handoff);
  return `Read ${file}. It is a handoff from a previous AI session on this project. Summarize your understanding in 3 bullets, then continue from its "Next steps".`;
}

// Handoffs can contain anything from a conversation, so they stay out of git for now.
const GITIGNORED = ['handoff.md', 'handoffs/', 'inbox/', 'state.json', 'hook.log'];

/** Add any missing entries; lines the user added are kept. */
function ensureGitignore(cwd) {
  const file = path.join(paths(cwd).dir, '.gitignore');
  const existing = readText(file) || '';
  const lines = existing.split('\n').map((l) => l.trim());
  const missing = GITIGNORED.filter((e) => !lines.includes(e));
  if (missing.length) writeFile(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

module.exports = { paths, loadState, saveState, gatherSessions, updateHandoff, syncTargets, resumePrompt, SECTIONS };
