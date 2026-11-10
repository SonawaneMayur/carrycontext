// @ts-check
// Builds, stores and distributes handoff.md. Shared by the VS Code extension and the CLI/hooks,
// so nothing in here may import 'vscode'.
//
// In a git repo each branch has its own handoff (.carrycontext/branches/<branch>/handoff.md);
// .carrycontext/handoff.md and the provider copies always hold the checked-out branch's one.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { dataDir, storeDir } = require('./config');
const { writeFile, readText, readJson, mtime, upsertManagedBlock, rel } = require('./util');
const { sanitize } = require('./sanitize');
const { listSaved, catalog, pruneHistory } = require('./catalog');
const { SECTIONS, parseSections, heuristicSections, llmSections, shortText, mergeDecisions } = require('./summarize');
const { verifyClaims, countClaims, renderClaims, summaryLine } = require('./claims');
const {
  currentBranch,
  branchAt,
  contains,
  isTracked,
  branchSlug,
  gitView,
  repoState,
  excludeLocally,
  includeLocally,
  gitAvailable,
  mainFolder,
  defaultBase,
  validBranchName,
  branchExists,
  fetchBase,
  addWorktree,
  storyId,
} = require('./git');
const { backup, now, PARTS } = require('./backup');
const { getProvider, listProviders } = require('../providers');
const { getLlm } = require('../llm');

const RENDER_ORDER = ['Goal', 'Background', 'Current state', 'Other recent sessions', 'Verification', 'Recent requests', 'Key decisions', 'Files & code', 'Repository state', 'Commands run', 'Open tasks', 'Next steps', 'Side questions', 'Gotchas'];
const SIDE_QUESTIONS_KEPT = 5;
const MOVED = 'Moved question'; // session name of a question moved out of its chat

/**
 * Where everything lives. The active handoff, state, inbox and hooks belong to this folder (its
 * assistants read them); handoffs per branch and their versions are in the store, which every
 * story folder of the project shares. Outside a story folder the two are the same.
 */
function paths(cwd) {
  const dir = dataDir(cwd);
  const store = storeDir(cwd);
  return {
    dir,
    store,
    handoff: path.join(dir, 'handoff.md'),
    handoffs: path.join(store, 'handoffs'),
    branches: path.join(store, 'branches'),
    state: path.join(dir, 'state.json'),
    inbox: path.join(dir, 'inbox'),
    requests: path.join(dir, 'requests'),
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
 * Conversations with work not saved yet, oldest first, for saving automatically: each one once it
 * has been quiet for `idleMs`, so starting another conversation doesn't leave the last one unsaved,
 * and on a branch switch (`switched`) all of them, since the branch you left is done for now.
 * `hooked` assistants save their newest conversation themselves (Claude Code's hooks), except on
 * a branch switch, which fires no hook.
 * @param {string} cwd
 * @param {import('./config').Config} config
 * @param {{idleMs: number, hooked?: string[], switched?: boolean}} opts
 */
async function unsavedSessions(cwd, config, { idleMs, hooked = [], switched = false }) {
  const since = Date.now() - config.lookbackHours * 3600000;
  const state = loadState(cwd);
  const out = [];
  for (const id of config.sources) {
    const adapter = getProvider(id);
    if (!adapter?.listSessions) continue;
    (await adapter.listSessions(cwd, { limit: 5 })).forEach((ref, i) => {
      if (ref.updatedAt < since || lastProcessed(state, ref.path) >= ref.updatedAt) return; // saved since its last change
      const waiting = !switched && ((i === 0 && hooked.includes(id)) || Date.now() - ref.updatedAt < idleMs);
      if (!waiting) out.push({ adapter, ref });
    });
  }
  return out.sort((a, b) => a.ref.updatedAt - b.ref.updatedAt);
}

/** A chat's messages without the questions moved out of it ("Move a Question…"). */
function withoutMoved(state, ref, messages) {
  const spans = state.moved?.[sessionKey(ref.path)] || [];
  const at = (m) => Date.parse(m.ts || '');
  return spans.length ? messages.filter((m) => !spans.some((s) => at(m) >= Date.parse(s.from) && at(m) <= Date.parse(s.to))) : messages;
}

/**
 * Your recent questions in a chat, newest first. Each covers your message and the replies up
 * to your next one. Questions already moved out are left out.
 * @param {string} cwd
 * @param {{adapter: any, ref: import('../providers/types').SessionRef}} session
 * @returns {Promise<{text: string, from: string, to: string}[]>}
 */
async function recentQuestions(cwd, { adapter, ref }, limit = 5) {
  const messages = withoutMoved(loadState(cwd), ref, await adapter.readSession(ref));
  const out = [];
  messages.forEach((m, i) => {
    if (m.role !== 'user' || !m.ts || !m.text.trim()) return;
    const next = messages.findIndex((x, j) => j > i && x.role === 'user');
    const span = messages.slice(i, next === -1 ? undefined : next).filter((x) => x.ts);
    out.push({ text: m.text.trim(), from: m.ts, to: /** @type {string} */ (span[span.length - 1].ts) });
  });
  return out.reverse().slice(0, limit);
}

/**
 * Move a question, and the replies to it, out of a chat: into a new chat, into another branch's
 * handoff, or nowhere. The chat's handoff is rewritten without it and stays that way on later
 * saves. Claude Code's own chat history is never changed.
 * @param {Object} opts
 * @param {string} opts.cwd
 * @param {import('./config').Config} opts.config
 * @param {{adapter: any, ref: import('../providers/types').SessionRef}} opts.session
 * @param {{text: string, from: string, to: string}} opts.question   from recentQuestions()
 * @param {{kind: 'new' | 'branch' | 'drop', branch?: string}} opts.to
 * @param {(provider: string) => Promise<string | undefined>} opts.getApiKey
 * @returns {Promise<{file?: string, prompt?: string}>}  the moved question's handoff, and a prompt for a new chat
 */
async function moveQuestion({ cwd, config, session, question, to, getApiKey }) {
  const { ref } = session;
  const messages = await session.adapter.readSession(ref);
  const here = currentBranch(cwd);
  let file;
  if (to.kind !== 'drop') {
    const target = to.kind === 'branch' && to.branch ? to.branch : here;
    const at = (m) => Date.parse(m.ts || '');
    const span = messages.filter((m) => at(m) >= Date.parse(question.from) && at(m) <= Date.parse(question.to));
    file = writeMovedHandoff(cwd, config, target, here, ref, question, span);
    if (to.kind === 'branch' && to.branch) addSideQuestion(cwd, config, to.branch, here, question, file);
  }
  // Remember the move, so later saves of this chat leave the question out too.
  const state = loadState(cwd);
  const key = sessionKey(ref.path);
  state.moved ||= {};
  state.moved[key] = [...(state.moved[key] || []), { from: question.from, to: question.to }];
  saveState(cwd, state);
  // Rewrite the chat's handoff without it, and remove versions saved since it was asked: they include it.
  if (withoutMoved(state, ref, messages).length) {
    const res = await updateHandoff({ cwd, sessions: [session], trigger: 'moved-question', config, getApiKey });
    removeVersionsSince(cwd, here, res.sessionFile, Date.parse(question.from));
  }
  return file ? { file, prompt: `Read ${rel(cwd, file)}. It is a question moved here from another chat, with the answer so far. Continue from it.` } : {};
}

/** The moved question as a handoff of its own, under the branch it now belongs to. */
function writeMovedHandoff(cwd, config, branch, from, ref, question, span) {
  const facts = heuristicSections(span, {}, cwd);
  const description = shortText(question.text, 8) || 'question';
  // Its own id, so the panel lists it as its own session rather than as part of the chat it came from.
  const id = `m${crypto.createHash('sha256').update(`${ref.path}|${question.from}`).digest('hex').slice(0, 7)}`;
  const doc = renderDoc({
    cwd,
    branch,
    sections: {
      Goal: question.text,
      'Current state': facts['Current state'],
      'Files & code': facts['Files & code'],
      'Commands run': facts['Commands run'],
      'Next steps': '- Continue from this question. It was asked in another chat, so check the current state of the files first.',
    },
    sources: [{ provider: ref.provider, id, messages: span.length }],
    trigger: `moved from a ${ref.provider} chat${from ? ` on ${from}` : ''}`,
    summarizer: 'heuristic',
    session: MOVED,
    description,
  });
  const file = path.join(branchPaths(cwd, branch).saved, handoffFileName([{ ref }], MOVED, description));
  writeFile(file, cleanDoc(doc, cwd, config));
  ensureGitignore(cwd);
  return file;
}

/** List a moved question in a branch's handoff, under "Side questions" (newest first, the last few kept). */
function addSideQuestion(cwd, config, branch, from, question, file) {
  const bp = branchPaths(cwd, branch);
  const doc = readText(bp.handoff) || cleanDoc(emptyDoc(cwd, branch), cwd, config);
  const entry = `- ${question.from.slice(0, 10)}${from ? ` · from \`${from}\`` : ''}: ${shortText(question.text, 14)} ([question and answer](${rel(cwd, file)}))`;
  const earlier = (parseSections(doc)['Side questions'] || '').split('\n').filter((l) => l.startsWith('- '));
  writeFile(bp.handoff, setSection(doc, 'Side questions', [entry, ...earlier].slice(0, SIDE_QUESTIONS_KEPT).join('\n')));
  if (branch === currentBranch(cwd)) activateBranch(cwd, config, branch); // refresh the active copies
}

/** Replace a level-2 section's body, or add the section at the end. */
function setSection(doc, name, body) {
  const re = new RegExp(`\\n## ${name}\\n[\\s\\S]*?(?=\\n## |$)`);
  const block = `\n## ${name}\n\n${body}\n`;
  return re.test(doc) ? doc.replace(re, block) : `${doc.replace(/\n*$/, '\n')}${block}`;
}

/** Remove a session's versions saved since `since` (ms), except `keep`. */
function removeVersionsSince(cwd, branch, keep, since) {
  const slug = branch ? branchSlug(branch) : null;
  const session = catalog(cwd)
    .find((b) => b.slug === slug)
    ?.sessions.find((s) => s.versions.some((v) => v.file === keep));
  for (const v of session?.versions || []) if (v.file !== keep && v.at >= since) fs.rmSync(v.file, { force: true });
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
  const before = loadState(cwd);
  for (const { adapter, ref } of sessions) {
    const msgs = withoutMoved(before, ref, await adapter.readSession(ref));
    messages.push(...msgs);
    sources.push({ provider: ref.provider, id: ref.id, messages: msgs.length });
  }
  if (sessions.length > 1) messages.sort((a, b) => (a.ts && b.ts ? a.ts.localeCompare(b.ts) : 0));

  const current = currentBranch(cwd);
  // Creates the current branch's handoff (inherited from the previous branch) if it is new.
  activateBranch(cwd, config, current);

  /** @type {Map<string | null, import('../providers/types').Message[]>} */
  const groups = new Map();
  const branchOf = current ? branchAt(cwd) : () => undefined;
  for (const m of messages) {
    // Messages without a branch (Gemini CLI records none) belong to the branch checked out when
    // they were sent, so a conversation saved after a switch stays with the branch it was on.
    const at = Date.parse(m.ts || '');
    const branch = current ? m.branch || (at ? branchOf(at) : undefined) || current : null;
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
  const requests = messages.filter((m) => m.role === 'user').map((m) => m.text);
  const claims = isCurrent && config.verify?.enabled !== false ? verifyClaims(messages, { cwd, git: view, branch, requests }) : [];
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
  sections ||= heuristicSections(messages, prev, cwd);
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
  // Questions moved here from other chats stay listed, like the background.
  if (prev['Side questions'] && !sections['Side questions']) sections['Side questions'] = prev['Side questions'];
  // Decisions only accumulate, so repeated compactions can't summarize them away.
  const tag = [new Date().toISOString().slice(0, 10), branch].filter(Boolean).join(' · ');
  sections['Key decisions'] =
    mergeDecisions(prev['Key decisions'], sections['Key decisions'], tag) ||
    '_None recorded yet. Decisions come from an LLM summary, /compact-all, or rule-like statements in your messages ("always…", "don\'t…")._';

  // Other sessions on this branch stay visible, so this save can't hide their work.
  sections['Other recent sessions'] = otherSessions(cwd, branch, sources, config);

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
      // Only a branch made from the previous one (it has that branch's work) starts from its context.
      // Switching back to main from a feature branch gets an empty handoff instead.
      if (contains(cwd, previous)) {
        writeFile(bp.handoff, cleanDoc(inheritedDoc(cwd, branch, previous, activeDoc), cwd, config));
        inheritedFrom = previous;
      } else {
        writeFile(bp.handoff, cleanDoc(emptyDoc(cwd, branch), cwd, config));
      }
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

/**
 * Move a story folder's own handoffs and usage ledger into the shared store: CarryContext 0.8 kept
 * them in each story folder (git worktree). Backs them up first, copies before removing, and never
 * replaces a newer file.
 * @returns {boolean} whether anything was moved
 */
function adoptLocalStore(cwd, config) {
  const { dir, store } = paths(cwd);
  if (dir === store) return false;
  const parts = PARTS.filter((p) => fs.existsSync(path.join(dir, p)));
  if (!parts.length) return false;
  backup(cwd, config, { force: true, name: `${now()}-from-${path.basename(cwd).replace(/[^\w-]/g, '-')}`, from: dir });
  for (const part of parts) {
    const from = path.join(dir, part);
    const to = path.join(store, part);
    if (part === 'usage.json') mergeLedger(from, to);
    else copyNewer(from, to);
    fs.rmSync(from, { recursive: true, force: true });
  }
  return true;
}

/** Copy files that are missing or older at `to`, keeping their times. The catalog's index is rebuilt, not copied. */
function copyNewer(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyNewer(a, b);
    else if (entry.name !== 'index.json' && (!fs.existsSync(b) || mtime(a) > mtime(b))) {
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(a, b);
      const s = fs.statSync(a);
      fs.utimesSync(b, s.atime, s.mtime);
    }
  }
}

/** Add one usage ledger's sessions to another; for a session in both, the one counted from more of its log wins. */
function mergeLedger(from, to) {
  const mine = readJson(from, null);
  const shared = readJson(to, null);
  if (!mine?.sessions) return;
  const sessions = { ...(shared?.sessions || {}) };
  for (const [key, s] of Object.entries(mine.sessions)) if (!sessions[key] || (s.size || 0) > (sessions[key].size || 0)) sessions[key] = s;
  writeFile(to, JSON.stringify({ ...(shared || mine), sessions }) + '\n');
}

/**
 * What starting a story would do, without doing it: its branch (from carrycontext.stories.branchPattern
 * unless given), the base it starts from, and its folder next to the project.
 * @param {string} cwd
 * @param {import('./config').Config} config
 * @param {{id?: string, title?: string, base?: string, branch?: string}} story
 */
function storyPlan(cwd, config, { id = '', title = '', base = '', branch = '' }) {
  const main = mainFolder(cwd);
  const words = slugify(title, 40);
  const name =
    branch ||
    config.stories.branchPattern
      .replace('{id}', id)
      .replace('{title}', title && words !== 'untitled' ? words : '')
      .replace(/-+(?=\/|$)/g, '')
      .replace(/-{2,}/g, '-');
  const label = (storyId(name)?.id || id || branchSlug(name)).replace(/[^\w.-]/g, '-');
  return {
    id: id || storyId(name)?.id || '',
    title,
    branch: name,
    base: base || defaultBase(cwd) || currentBranch(cwd) || 'main',
    folder: path.join(path.dirname(main), `${path.basename(main)}-${label}`),
    exists: gitAvailable() && branchExists(cwd, name),
  };
}

/**
 * Start a story in its own folder: a git worktree next to the project, on a new branch from the
 * base (fetched first, so it starts from the latest; an existing branch is checked out as it is),
 * with a handoff saying which story it is. Then asks VS Code to open it in a new window with a new
 * chat. Nothing in this folder is switched, stashed, committed or deleted.
 * @param {ReturnType<typeof storyPlan>} plan
 * @param {{fetch?: boolean}} [opts]
 * @returns {ReturnType<typeof storyPlan> & {from: string, note: string}}
 */
function startStory(cwd, config, plan, { fetch = true } = {}) {
  if (!gitAvailable()) throw new Error('Starting a story needs git.');
  if (!validBranchName(cwd, plan.branch)) throw new Error(`"${plan.branch}" isn't a valid branch name.`);
  if (fs.existsSync(plan.folder)) throw new Error(`${rel(cwd, plan.folder)} already exists, so it was left alone.`);
  let from = plan.base;
  let note = '';
  if (!plan.exists) {
    // From origin's copy of the base when it can be fetched, else the local base.
    const failed = fetch ? fetchBase(cwd, plan.base) : 'not fetched';
    if (!failed) from = `origin/${plan.base}`;
    else if (fetch) note = `Couldn't fetch ${plan.base} (${failed}), so it starts from your local ${plan.base}.`;
  }
  const failed = addWorktree(cwd, plan.folder, plan.branch, from);
  if (failed) throw new Error(failed);
  seedStory(cwd, config, plan);
  // The VS Code window you're in opens the folder; that folder's window then starts a chat.
  writeFile(path.join(paths(cwd).requests, `open-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`), JSON.stringify({ folder: plan.folder, branch: plan.branch }) + '\n');
  writeFile(path.join(dataDir(plan.folder), 'start-chat'), `${plan.branch}\n`);
  ensureGitignore(plan.folder);
  return { ...plan, from, note };
}

/**
 * The new story's handoff, in the shared store: which story it is, and its base branch's context as
 * background. Not the branch you're on: the story starts from its base, not from your current work.
 */
function seedStory(cwd, config, plan) {
  const bp = branchPaths(cwd, plan.branch);
  if (fs.existsSync(bp.handoff)) return;
  const parentDoc = readText(branchPaths(cwd, plan.base).handoff);
  const goal = [plan.id && `Story ${plan.id}`, plan.title].filter(Boolean).join(': ') || plan.branch;
  const doc = renderDoc({
    cwd: plan.folder,
    branch: plan.branch,
    sections: {
      Goal: goal,
      Background: parentDoc ? parseSections(inheritedDoc(plan.folder, plan.branch, plan.base, parentDoc)).Background : '',
      'Current state': `_A new story on \`${plan.branch}\`, from \`${plan.base}\`. Nothing done yet._`,
      'Next steps': `- Start on ${goal}.`,
    },
    sources: [],
    trigger: `story:start-from:${plan.base}`,
    summarizer: 'none',
    session: plan.branch,
    description: shortText(goal, 8),
  });
  writeFile(bp.handoff, cleanDoc(doc, plan.folder, config));
}

/** A branch's handoff before any work on it is saved, so no assistant reads another branch's context. */
function emptyDoc(cwd, branch) {
  return renderDoc({
    cwd,
    branch,
    // In "Current state", which the branch's first saved session replaces (a Goal would be kept).
    sections: { 'Current state': `_No saved context for \`${branch}\` yet. It appears here once a session on this branch is saved._` },
    sources: [],
    trigger: 'branch:switch',
    summarizer: 'none',
    session: branch,
    description: 'no handoff yet',
  });
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

const OTHER_SESSIONS = 5;

/**
 * The branch's other sessions saved within the lookback window, newest first: one line each
 * with a link to its full handoff, so the newest save doesn't hide earlier work on the branch.
 */
function otherSessions(cwd, branch, sources, config) {
  const slug = branch ? branchSlug(branch) : null;
  const key = sources.map((s) => `${s.provider}:${s.id.slice(0, 8)}`).join('+');
  const since = Date.now() - config.lookbackHours * 3600000;
  const sessions = catalog(cwd).find((b) => b.slug === slug)?.sessions || [];
  return sessions
    // A question moved out of a chat doesn't come back into it this way.
    .filter((s) => s.key !== key && s.at >= since && s.title !== MOVED)
    .slice(0, OTHER_SESSIONS)
    .map((s) => {
      const text = readText(s.file) || '';
      const msgs = [...text.split(/\n## /)[0].matchAll(/\((\d+) msgs\)/g)].reduce((n, m) => n + Number(m[1]), 0);
      const state = stoppedAt(parseSections(text)['Current state']);
      const when = `${new Date(s.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
      return [`- **${s.title}**`, clip(s.description, 80), `${msgs} msgs`, when, state && `stopped at: "${state}"`, `\`${rel(cwd, s.file)}\``].filter(Boolean).join(' · ');
    })
    .join('\n');
}

/** The first line of a Current state section, without the heuristic's "Last assistant update" lead-in. */
function stoppedAt(state = '') {
  const lines = state.split('\n').map((l) => l.replace(/^>\s?/, '').replace(/\*\*/g, '').trim());
  return clip(lines.find((l) => l && !/^Last assistant update\b/.test(l)) || '', 120);
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

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

/** Copy the canonical handoff into each target provider's location, keeping the copies out of git. */
function syncTargets(cwd, config, doc = readText(paths(cwd).handoff)) {
  if (!doc) return [];
  const written = [];
  const hidden = [];
  const shown = [];
  for (const id of config.targets) {
    const target = getProvider(id)?.target;
    if (!target) continue;
    const file = target.handoffFile(cwd);
    writeFile(file, target.render ? target.render(doc) : doc);
    written.push(file);
    if (target.instructionsFile) {
      const instructions = target.instructionsFile(cwd);
      // A file CarryContext alone writes (AGENTS.md, GEMINI.md, Copilot's) stays out of git like
      // the copies, and only then holds the whole handoff inline (Copilot). A file you or your team
      // keep (in git, or with your own text) gets a pointer, so no conversation text lands in a commit.
      const own = !isTracked(cwd, instructions) && !hasOtherText(readText(instructions));
      upsertManagedBlock(instructions, target.inline && own ? doc : pointerBlock(rel(cwd, file)));
      (own ? hidden : shown).push(instructions);
    }
  }
  excludeLocally(cwd, [...written, ...hidden]);
  includeLocally(cwd, shown);
  return written;
}

/** Whether a file has text besides CarryContext's managed block. */
const hasOtherText = (text) => Boolean(text && text.replace(/<!-- carrycontext:start -->[\s\S]*?<!-- carrycontext:end -->/, '').trim());

const pointerBlock = (file) => `## Handoff from a previous AI session
Before starting work, read \`${file}\`. CarryContext wrote it from an earlier session, which may have been run by a different AI assistant.
Treat it as context: check the current state of the files before you edit them, then continue from its "Next steps".`;

function resumePrompt(cwd, providerId) {
  const target = getProvider(providerId)?.target;
  const file = rel(cwd, target ? target.handoffFile(cwd) : paths(cwd).handoff);
  return `Read ${file}. It is a handoff from a previous AI session on this project. Summarize your understanding in 3 bullets, then continue from its "Next steps".`;
}

// Handoffs can contain anything from a conversation, so they stay out of git for now. So does
// usage.json, which holds the start of your most expensive questions.
const GITIGNORED = ['handoff.md', 'handoffs/', 'branches/', 'inbox/', 'requests/', 'start-chat', 'state.json', 'hook.log', 'usage.json'];

/** Add any missing entries; lines the user added are kept. */
function ensureGitignore(cwd) {
  const { dir, store } = paths(cwd);
  for (const folder of new Set([dir, store])) {
    const file = path.join(folder, '.gitignore');
    const existing = readText(file) || '';
    const lines = existing.split('\n').map((l) => l.trim());
    const missing = GITIGNORED.filter((e) => !lines.includes(e));
    if (missing.length) writeFile(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
}

module.exports = {
  paths,
  branchPaths,
  loadState,
  saveState,
  lastProcessed,
  gatherSessions,
  unsavedSessions,
  recentQuestions,
  moveQuestion,
  adoptLocalStore,
  storyPlan,
  startStory,
  updateHandoff,
  activateBranch,
  listSavedHandoffs: listSaved,
  syncTargets,
  resumePrompt,
  ensureGitignore,
  SECTIONS,
};
