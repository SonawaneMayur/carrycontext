// @ts-check
// Builds, stores and distributes handoff.md. Shared by the VS Code extension and the CLI/hooks,
// so nothing in here may import 'vscode'.
//
// In a git repo each branch has its own handoff (.carrycontext/branches/<branch>/handoff.md);
// .carrycontext/handoff.md and the provider copies always hold the checked-out branch's one.
const path = require('path');
const fs = require('fs');
const { dataDir } = require('./config');
const { writeFile, readText, readJson, listFiles, mtime, upsertManagedBlock, rel, shortenPaths } = require('./util');
const { SECTIONS, parseSections, heuristicSections, llmSections, shortText, mergeDecisions } = require('./summarize');
const { currentBranch, branchSlug } = require('./git');
const { getProvider } = require('../providers');
const { getLlm } = require('../llm');

const RENDER_ORDER = ['Goal', 'Background', 'Current state', 'Recent requests', 'Key decisions', 'Files & code', 'Commands run', 'Open tasks', 'Next steps', 'Gotchas'];

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
    const r = await writeBranchHandoff({ cwd, branch, messages: msgs, sessions, sources, trigger, config, getApiKey });
    if (branch === current || !result) result = r;
  }
  activateBranch(cwd, config, current);

  const state = loadState(cwd);
  for (const { ref } of sessions) state.processed[ref.path] = mtime(ref.path);
  Object.assign(state, { lastUpdated: new Date().toISOString(), trigger, sources, summarizer: result.summarizer });
  saveState(cwd, state);
  return { ...result, file: paths(cwd).handoff, branches: [...groups.keys()].filter(Boolean) };
}

async function writeBranchHandoff({ cwd, branch, messages, sessions, sources, trigger, config, getApiKey }) {
  const bp = branchPaths(cwd, branch);
  const prevDoc = readText(bp.handoff);
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

  // Never write the user's absolute paths (and so their username) into a handoff.
  const doc = shortenPaths(renderDoc({ cwd, branch, sections, sources, trigger, summarizer, warning, session, description }), cwd);
  const sessionFile = saveHandoff(cwd, doc, config, branch, handoffFileName(sessions, session, description));
  return { doc, sessionFile, warning, summarizer, branch };
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
      writeFile(bp.handoff, inheritedDoc(cwd, branch, previous, activeDoc));
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

function renderDoc({ cwd, branch, sections, sources, trigger, summarizer, warning, session, description }) {
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
- **Summarizer:** ${summarizer}${warning ? `\n- **Note:** ${warning}` : ''}

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
  const old = listFiles(bp.saved, (f) => f.endsWith('.md')).sort((a, b) => mtime(a) - mtime(b));
  for (const f of old.slice(0, Math.max(0, old.length - config.handoffLimit))) fs.rmSync(f, { force: true });
  ensureGitignore(cwd);
  if (!branch) syncTargets(cwd, config, doc);
  return sessionFile;
}

/**
 * Every saved handoff, newest first. `branch` is the folder name (slug) or null for
 * handoffs saved outside git or before branch support.
 * @returns {{file: string, branch: string | null, at: number}[]}
 */
function listSavedHandoffs(cwd) {
  const root = paths(cwd).handoffs;
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      for (const f of listFiles(full, (n) => n.endsWith('.md'))) out.push({ file: f, branch: e.name, at: mtime(f) });
    } else if (e.name.endsWith('.md')) {
      out.push({ file: full, branch: null, at: mtime(full) });
    }
  }
  return out.sort((a, b) => b.at - a.at);
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
  gatherSessions,
  updateHandoff,
  activateBranch,
  listSavedHandoffs,
  syncTargets,
  resumePrompt,
  SECTIONS,
};
