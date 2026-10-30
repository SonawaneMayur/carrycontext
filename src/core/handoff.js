// @ts-check
// Builds, stores and distributes handoff.md. Shared by the VS Code extension and the CLI/hooks,
// so nothing in here may import 'vscode'.
//
// In a git repo each branch has its own handoff (.carrycontext/branches/<branch>/handoff.md);
// .carrycontext/handoff.md and the provider copies always hold the checked-out branch's one.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { dataDir } = require('./config');
const { writeFile, readText, readJson, mtime, upsertManagedBlock, rel } = require('./util');
const { sanitize } = require('./sanitize');
const { listSaved, pruneHistory } = require('./catalog');
const { SECTIONS, parseSections, heuristicSections, llmSections, shortText, mergeDecisions } = require('./summarize');
const { verifyClaims, countClaims, renderClaims, summaryLine } = require('./claims');
const { currentBranch, branchSlug, gitView, repoState } = require('./git');
const { getProvider, listProviders } = require('../providers');
const { getLlm } = require('../llm');

const RENDER_ORDER = ['Goal', 'Background', 'Current state', 'Verification', 'Recent requests', 'Key decisions', 'Files & code', 'Repository state', 'Commands run', 'Open tasks', 'Next steps', 'Gotchas'];

function paths(cwd) {
  const dir = dataDir(cwd);
  return {
    dir,
    handoff: path.join(dir, 'handoff.md'),
    handoffs: path.join(dir, 'handoffs'),
    branches: path.join(dir, 'branches'),
    state: path.join(dir, 'state.json'),
    inbox: path.join(dir, 'inbox'),
  };
}

/** Where one branch's handoff and saved copies live (no branch = not a git repo). */
function branchPaths(cwd, branch) {
  const p = paths(cwd);
  if (!branch) return { handoff: p.handoff, saved: p.handoffs };
  const slug = branchSlug(branch);
  return { handoff: path.join(p.branches, slug, 'handoff.md'), saved: path.join(p.handoffs, slug) };
}

const loadState = (cwd) => readJson(paths(cwd).state, { processed: {} });

// state.json records which sessions were summarized. Keys are hashes of the transcript path,
// so the file never contains the user's home folder or username.
const sessionKey = (file) => crypto.createHash('sha256').update(file).digest('hex').slice(0, 16);
const lastProcessed = (state, file) => state.processed?.[sessionKey(file)] || 0;
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
    const [newest] = (await adapter.listSessions(cwd, { limit: 1 })).filter((s) => s.updatedAt >= since);
    if (newest) out.push({ adapter, ref: newest });
  }
  return out;
}

/**
 * Read sessions, summarize (merging with the previous handoff) and write everywhere.
 * Messages are filed under the branch they were sent on, so one session that spans
 * a branch switch updates both branches' handoffs.
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

  const current = currentBranch(cwd);
  // Creates the current branch's handoff (inherited from the previous branch) if it is new.
  activateBranch(cwd, config, current);

  /** @type {Map<string | null, import('../providers/types').Message[]>} */
  const groups = new Map();
  for (const m of messages) {
    const branch = current ? m.branch || current : null; // untagged messages belong to the checked-out branch
    if (!groups.has(branch)) groups.set(branch, []);
    groups.get(branch)?.push(m);
  }

  let result;
  for (const [branch, msgs] of groups) {
    const r = await writeBranchHandoff({ cwd, branch, current, messages: msgs, sessions, sources, trigger, config, getApiKey });
    if (branch === current || !result) result = r;
  }
  activateBranch(cwd, config, current);

  const state = loadState(cwd);
  state.processed ||= {};
  for (const key of Object.keys(state.processed)) if (key.includes('/') || key.includes('\\')) delete state.processed[key]; // pre-0.2 entries
  for (const { ref } of sessions) state.processed[sessionKey(ref.path)] = mtime(ref.path);
  Object.assign(state, { lastUpdated: new Date().toISOString(), trigger, sources, summarizer: result.summarizer, verification: result.verification });
  saveState(cwd, state);
  return { ...result, file: paths(cwd).handoff, branches: [...groups.keys()].filter(Boolean) };
}

async function writeBranchHandoff({ cwd, branch, current, messages, sessions, sources, trigger, config, getApiKey }) {
  const bp = branchPaths(cwd, branch);
  const prevDoc = readText(bp.handoff);
  const prev = parseSections(prevDoc);
  // git only describes the checked-out branch; other branches keep their last snapshot.
  const isCurrent = branch === current;
  const view = isCurrent ? gitView(cwd, ownFiles(cwd)) : null;
  const repo = view ? repoState(cwd, view) : '';
  const claims = isCurrent && config.verify?.enabled !== false ? verifyClaims(messages, { cwd, git: view }) : [];
  const verification = renderClaims(claims);
  const groundTruth = [repo, verification && `Verification of the session's claims:\n${verification}`].filter(Boolean).join('\n\n');

  let sections;
  let summarizer = 'heuristic';
  let warning;
  if (config.summarizer.provider !== 'none') {
    try {
      const apiKey = await getApiKey(config.summarizer.provider);
      sections = await llmSections(messages, prevDoc, config, apiKey, groundTruth, cwd);
      summarizer = `${config.summarizer.provider}:${config.summarizer.model || getLlm(config.summarizer.provider)?.defaultModel}`;
    } catch (e) {
      warning = `Summarizer failed, used heuristic instead: ${e.message}`;
    }
  }
  sections ||= heuristicSections(messages, prev);
  sections['Repository state'] = repo || prev['Repository state'] || '';
  sections.Verification = verification || (isCurrent ? '' : prev.Verification || '');
  // Contradicted claims become the first next steps, so the next assistant fixes them instead
  // of building on them. Earlier fix items are replaced, not repeated.
  const fixes = claims.filter((c) => c.next).map((c) => `- ❌ ${c.next}`);
  if (isCurrent) {
    const rest = (sections['Next steps'] || '').split('\n').filter((l) => !l.startsWith('- ❌ ')).join('\n').trim();
    sections['Next steps'] = [...fixes, rest].filter(Boolean).join('\n');
  }
  // Context inherited from the parent branch is kept until the branch's own work replaces it.
  if (prev.Background && !sections.Background) sections.Background = prev.Background;
  // Decisions only accumulate, so repeated compactions can't summarize them away.
  const tag = [new Date().toISOString().slice(0, 10), branch].filter(Boolean).join(' · ');
  sections['Key decisions'] =
    mergeDecisions(prev['Key decisions'], sections['Key decisions'], tag) ||
    '_None recorded yet. Decisions come from an LLM summary, /compact-all, or rule-like statements in your messages ("always…", "don\'t…")._';

  const session = sessionName(sessions, messages);
  const description = shortText(sections['Short description'] || sections.Goal || '', 8) || 'handoff';
  delete sections['Short description'];

  const counts = claims.length ? countClaims(claims) : null;
  const doc = cleanDoc(renderDoc({ cwd, branch, sections, sources, trigger, summarizer, warning, session, description, counts }), cwd, config);
  const sessionFile = saveHandoff(cwd, doc, config, branch, handoffFileName(sessions, session, description));
  return { doc, sessionFile, warning, summarizer, branch, verification: counts };
}

/**
 * Make the checked-out branch's handoff the active one (handoff.md + provider copies).
 * A branch without a handoff starts from the previously active branch's, as background.
 * @returns {{branch: string | null, changed: boolean, inheritedFrom?: string}}
 */
function activateBranch(cwd, config, branch = currentBranch(cwd)) {
  if (!branch) return { branch: null, changed: false };
  const p = paths(cwd);
  const bp = branchPaths(cwd, branch);
  const state = loadState(cwd);
  const previous = state.activeBranch;
  let inheritedFrom;

  if (!fs.existsSync(bp.handoff)) {
    const activeDoc = readText(p.handoff);
    if (activeDoc && previous && previous !== branch) {
      writeFile(bp.handoff, cleanDoc(inheritedDoc(cwd, branch, previous, activeDoc), cwd, config));
      inheritedFrom = previous;
    } else if (activeDoc) {
      // First run with branch support: the existing handoff belongs to this branch.
      writeFile(bp.handoff, activeDoc);
    }
  }

  const doc = readText(bp.handoff);
  if (doc && readText(p.handoff) !== doc) {
    writeFile(p.handoff, doc);
    syncTargets(cwd, config, doc);
  }
  if (previous !== branch) {
    state.activeBranch = branch;
    saveState(cwd, state);
  }
  ensureGitignore(cwd);
  return { branch, changed: previous !== undefined && previous !== branch, inheritedFrom };
}

/**
 * Remove secrets, absolute paths and the username before anything is written, and note
 * what was redacted in the header so the reader knows something was removed.
 */
function cleanDoc(doc, cwd, config) {
  const { text, found } = sanitize(doc, { cwd, redact: config.redact });
  const kinds = Object.entries(found);
  if (!kinds.length) return text;
  const total = kinds.reduce((n, [, c]) => n + c, 0);
  const note = `- **Redacted:** ${total} secret${total === 1 ? '' : 's'} (${kinds.map(([k]) => k).join(', ')})`;
  return text.replace(/^(- \*\*Summarizer:\*\* .*)$/m, `$1\n${note}`);
}

/** Starting handoff for a new branch: the parent's essentials, kept as background. */
function inheritedDoc(cwd, branch, parent, parentDoc) {
  const prev = parseSections(parentDoc);
  const background = [
    `Branched from \`${parent}\`. Context from that branch at the time:`,
    prev.Goal && `**Goal there:** ${prev.Goal}`,
    prev['Key decisions'] && `**Decisions:**\n\n${prev['Key decisions']}`,
    prev.Gotchas && `**Gotchas:**\n\n${prev.Gotchas}`,
    prev.Background,
  ]
    .filter(Boolean)
    .join('\n\n');
  return renderDoc({
    cwd,
    branch,
    sections: { Background: background },
    sources: [],
    trigger: `branch:new-from:${parent}`,
    summarizer: 'none',
    session: branch,
    description: `new branch from ${parent}`,
  });
}

/**
 * Files CarryContext writes in the project: provider handoff copies, instruction files that
 * contain nothing but our block, and the /compact-all command.
 */
function ownFiles(cwd) {
  const files = [path.join(cwd, '.claude', 'commands', 'compact-all.md')];
  for (const p of listProviders()) {
    if (!p.target) continue;
    files.push(p.target.handoffFile(cwd));
    const instructions = p.target.instructionsFile?.(cwd);
    const text = instructions && readText(instructions);
    if (text && /^<!-- carrycontext:start -->[\s\S]*<!-- carrycontext:end -->$/.test(text.trim())) files.push(instructions);
  }
  return files;
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

function renderDoc({ cwd, branch, sections, sources, trigger, summarizer, warning, session, description, counts = null }) {
  const keys = [...RENDER_ORDER, ...Object.keys(sections).filter((k) => !RENDER_ORDER.includes(k))];
  const body = keys
    .filter((k) => sections[k] && sections[k].trim())
    .map((k) => `## ${k}\n\n${sections[k].trim()}`)
    .join('\n\n');
  const providers = [...new Set(sources.map((s) => s.provider))].join(', ') || 'none yet';
  return `<!-- carrycontext:handoff v1 -->
# Handoff: ${path.basename(cwd)}${branch ? ` (${branch})` : ''}

> **To the assistant reading this:** this is a handoff from an earlier AI session (${providers}).
> Read it fully, check the current state of the files before you edit them, then continue from **Next steps**.
> Ask the user only if something here is unclear or out of date. Paths are relative to the project root.

- **Session:** ${session}
- **Description:** ${description}${branch ? `\n- **Branch:** ${branch}` : ''}
- **Updated:** ${new Date().toISOString()}
- **Trigger:** ${trigger}
- **Sources:** ${sources.map((s) => `${s.provider} \`${s.id.slice(0, 8)}\` (${s.messages} msgs)`).join(', ') || 'none'}
- **Summarizer:** ${summarizer}${counts ? `\n- **Verification:** ${summaryLine(counts)}` : ''}${warning ? `\n- **Note:** ${warning}` : ''}

${body}
`;
}

/**
 * Write a branch's handoff and a named copy of it. Outside git this is also the active
 * handoff; inside git, activateBranch() publishes the checked-out branch's one.
 * Returns the named copy's path.
 */
function saveHandoff(cwd, doc, config, branch, fileName) {
  const bp = branchPaths(cwd, branch);
  const sessionFile = path.join(bp.saved, fileName);
  writeFile(bp.handoff, doc);
  writeFile(sessionFile, doc);
  // The limit counts each session's versions, and every session keeps its latest.
  pruneHistory(cwd, branch ? branchSlug(branch) : null, Number(config.handoffLimit) || 50);
  ensureGitignore(cwd);
  if (!branch) syncTargets(cwd, config, doc);
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
const GITIGNORED = ['handoff.md', 'handoffs/', 'branches/', 'inbox/', 'state.json', 'hook.log'];

/** Add any missing entries; lines the user added are kept. */
function ensureGitignore(cwd) {
  const file = path.join(paths(cwd).dir, '.gitignore');
  const existing = readText(file) || '';
  const lines = existing.split('\n').map((l) => l.trim());
  const missing = GITIGNORED.filter((e) => !lines.includes(e));
  if (missing.length) writeFile(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

module.exports = {
  paths,
  branchPaths,
  loadState,
  saveState,
  lastProcessed,
  gatherSessions,
  updateHandoff,
  activateBranch,
  listSavedHandoffs: listSaved,
  syncTargets,
  resumePrompt,
  SECTIONS,
};
