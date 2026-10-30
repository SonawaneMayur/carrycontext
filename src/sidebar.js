// @ts-check
// Activity Bar panel: the latest handoff; saved handoffs by branch (current first), one row
// per session with its earlier versions inside; branches idle for two weeks under "Older
// branches"; usage; and each provider's newest conversations at the bottom.
const vscode = require('vscode');
const fs = require('fs');
const { paths, loadState } = require('./core/handoff');
const { catalog } = require('./core/catalog');
const { usageSummary, describe, sessionOnBranch } = require('./core/usage');
const { currentBranch, branchSlug } = require('./core/git');
const { parseSections } = require('./core/summarize');
const { getProvider } = require('./providers');
const { ago, readText, tildify } = require('./core/util');

const SESSIONS_PER_PROVIDER = 5;
const OLDER_AFTER_MS = 14 * 86400000;
const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;

/**
 * A row, plus what its children are made from.
 * @typedef {import('./core/catalog').Branch} Branch
 * @typedef {import('./core/catalog').Session} Session
 * @typedef {vscode.TreeItem & {kind?: string, branch?: Branch, session?: Session, branches?: Branch[]}} Row
 */

class HandoffTree {
  /**
   * @param {() => string | undefined} cwd
   * @param {() => import('./core/config').Config} config
   * @param {() => boolean} currentOnly   show only the checked-out branch's handoffs
   */
  constructor(cwd, config, currentOnly) {
    this.cwd = cwd;
    this.config = config;
    this.currentOnly = currentOnly;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire(undefined);
  }

  /** @param {Row} item */
  getTreeItem(item) {
    return item;
  }

  /** @param {Row} [parent] */
  async getChildren(parent) {
    const dir = this.cwd();
    if (!dir) return []; // shows the "open a folder" welcome view
    if (!parent) return this.rootItems(dir);
    const { kind, branch, session, branches } = parent;
    if (kind === 'branch' && branch) return branch.sessions.map((s) => sessionItem(s, branch));
    if (kind === 'session' && session) return session.versions.slice(1).map(versionItem);
    if (kind === 'older' && branches) return branches.map((b) => branchItem(b, false));
    if (kind === 'conversations') return this.conversationItems(dir);
    return [];
  }

  /**
   * Hover text for a branch or session, with its usage, built the first time it is hovered.
   * @param {Row} item
   */
  async resolveTreeItem(item) {
    const dir = this.cwd();
    if (!dir || !item.branch || (item.kind !== 'branch' && item.kind !== 'session')) return item;
    const summary = await this.usage(dir);
    const showCost = this.config().usage?.showCost !== false;
    const { branch, session } = item;
    if (session) {
      const used = summary && sessionOnBranch(summary, session.key, branch.name);
      item.tooltip = sessionTooltip(session, branch, used ? describe(used, showCost) : '');
    } else {
      const used = summary?.branches.find((b) => b.name === branch.name);
      item.tooltip = [String(item.label), `${count(branch)}, last handoff ${ago(branch.at)}`, used && `Usage: ${describe(used, showCost)}`].filter(Boolean).join('\n');
    }
    return item;
  }

  /** This project's usage, reused for 30 seconds so hovering several rows reads the logs once. */
  usage(dir) {
    if (!this._usage || this._usage.dir !== dir || Date.now() - this._usage.at > 30000) {
      this._usage = { dir, at: Date.now(), summary: usageSummary(dir, this.config()).catch(() => null) };
    }
    return this._usage.summary;
  }

  rootItems(dir) {
    const current = currentBranch(dir);
    const currentSlug = current ? branchSlug(current) : null;
    const isCurrent = (b) => b.slug !== null && b.slug === currentSlug;
    let branches = catalog(dir);
    if (this.currentOnly() && currentSlug) branches = branches.filter(isCurrent);
    // The checked-out branch first, then the others by their latest handoff.
    const recent = branches.filter((b) => b.slug === null || isCurrent(b) || Date.now() - b.at < OLDER_AFTER_MS);
    recent.sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
    const older = branches.filter((b) => !recent.includes(b));

    /** @type {Row[]} */
    const items = [this.latestItem(dir), ...recent.map((b) => branchItem(b, isCurrent(b)))];
    if (older.length) items.push(group(`Older branches (${older.length})`, 'older', 'archive', 'no handoff for 2 weeks', { branches: older }));
    if (!branches.length) items.push(note(current && this.currentOnly() ? `No saved handoffs on ${current} yet` : 'Saved handoffs will appear here'));
    items.push(usageItem(this.config().usage?.showCost !== false), group('Recent conversations', 'conversations', 'comment-discussion'));
    return items;
  }

  latestItem(dir) {
    const file = paths(dir).handoff;
    if (!fs.existsSync(file)) {
      const item = new vscode.TreeItem('No handoff yet: click to Compact All');
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = { command: 'carrycontext.compactAll', title: 'Compact All' };
      return item;
    }
    const state = loadState(dir);
    const branch = currentBranch(dir);
    const item = new vscode.TreeItem(branch ? `Latest handoff · ${branch}` : 'Latest handoff');
    const v = state.verification;
    const checks = v ? [v.verified && `✅${v.verified}`, v.unverified && `⚠️${v.unverified}`, v.contradicted && `❌${v.contradicted}`].filter(Boolean).join(' ') : '';
    item.description = [checks, state.lastUpdated && ago(state.lastUpdated)].filter(Boolean).join(' · ');
    item.tooltip = `${state.trigger || ''} · ${state.summarizer || ''}\n${tildify(file)}`;
    item.iconPath = new vscode.ThemeIcon('note');
    item.contextValue = 'latest';
    item.resourceUri = vscode.Uri.file(file);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file)] };
    return item;
  }

  async conversationItems(dir) {
    const items = [];
    for (const id of this.config().sources) {
      const adapter = getProvider(id);
      if (!adapter?.listSessions) continue;
      for (const ref of await adapter.listSessions(dir, { limit: SESSIONS_PER_PROVIDER })) {
        const item = new vscode.TreeItem(ref.title || ref.id.slice(0, 8));
        item.description = `${adapter.label} · ${ago(ref.updatedAt)}`;
        item.tooltip = `${tildify(ref.path)}\nClick to create a handoff from this conversation`;
        item.iconPath = new vscode.ThemeIcon('comment');
        item.contextValue = 'session';
        item.command = { command: 'carrycontext.compactThisSession', title: 'Create handoff', arguments: [ref] };
        items.push(item);
      }
    }
    if (!items.length) items.push(note(`No conversations from ${this.config().sources.join(', ')} in this folder yet`));
    return items;
  }
}

/**
 * A branch, expanded when it is checked out.
 * @param {Branch} branch
 * @param {boolean} current
 */
function branchItem(branch, current) {
  const name = branch.slug === null ? 'Saved handoffs' : branch.name === 'HEAD' ? 'detached HEAD' : branch.name;
  /** @type {Row} */
  const item = Object.assign(new vscode.TreeItem(name, current || branch.slug === null ? Expanded : Collapsed), { kind: 'branch', branch });
  // A separate id while checked out, so switching to a branch expands it even if it was collapsed.
  item.id = `branch:${branch.slug ?? ''}${current ? ':current' : ''}`;
  item.description = current ? `current · ${count(branch)}` : `${count(branch)} · ${ago(branch.at)}`;
  item.iconPath = new vscode.ThemeIcon(branch.slug === null ? 'archive' : 'git-branch');
  return item;
}

/** @param {Branch} branch */
const count = (branch) => `${branch.sessions.length} session${branch.sessions.length === 1 ? '' : 's'}`;

/** Opens the usage report. */
function usageItem(showCost) {
  const item = new vscode.TreeItem('Usage');
  item.id = 'usage';
  item.description = showCost ? 'tokens, models, time, cost' : 'tokens, models, time';
  item.tooltip = 'Tokens, models, active time and estimated cost by branch, session and question, from the logs on this computer. Nothing is sent anywhere.';
  item.iconPath = new vscode.ThemeIcon('graph');
  item.command = { command: 'carrycontext.usageReport', title: 'Show Usage Report' };
  return item;
}

/**
 * One row per session: opens its latest handoff, with the earlier versions inside.
 * @param {Session} session
 * @param {Branch} branch
 */
function sessionItem(session, branch) {
  /** @type {Row} */
  const item = Object.assign(new vscode.TreeItem(session.title, session.versions.length > 1 ? Collapsed : None), { kind: 'session', session, branch });
  item.id = `session:${branch.slug ?? ''}:${session.key}`;
  item.description = [session.description, ago(session.at)].filter(Boolean).join(' · ');
  item.iconPath = new vscode.ThemeIcon('comment-discussion');
  return opens(item, session.file);
}

/**
 * An earlier version of a session's handoff, named by when it was saved.
 * @param {import('./core/catalog').Version} version
 */
function versionItem(version) {
  const when = new Date(version.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const item = new vscode.TreeItem(when);
  item.id = `version:${version.file}`;
  item.description = version.description;
  item.tooltip = tildify(version.file);
  item.iconPath = new vscode.ThemeIcon('history');
  return opens(item, version.file);
}

/** Make a row open `file`, with the "copy" and "use as latest" actions. */
function opens(item, file) {
  const uri = vscode.Uri.file(file);
  item.contextValue = 'handoffFile';
  item.resourceUri = uri;
  item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
  return item;
}

/**
 * What the session is about, what's next, what was verified and what it used, without opening the file.
 * @param {Session} session
 * @param {Branch} branch
 * @param {string} usage   e.g. "1.2M tokens · $4.10", or '' when unknown
 */
function sessionTooltip(session, branch, usage) {
  const next = (parseSections(readText(session.file) || '')['Next steps'] || '').split('\n').filter((l) => l.trim()).slice(0, 5);
  const v = session.verification;
  const earlier = session.versions.length - 1;
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**').appendText(session.title).appendMarkdown('**\n\n');
  md.appendText([branch.name, session.providers.join(', '), `saved ${ago(session.at)}`].filter(Boolean).join(' · '));
  if (session.goal) md.appendMarkdown('\n\n**Goal:** ').appendText(session.goal);
  if (session.description && session.description !== session.goal) md.appendMarkdown('\n\n**Working on:** ').appendText(session.description);
  if (next.length) md.appendMarkdown(`\n\n**Next steps:**\n\n${next.join('\n')}`);
  if (v) md.appendMarkdown(`\n\n✅ ${v.verified} verified · ⚠️ ${v.unverified} unverified · ❌ ${v.contradicted} contradicted`);
  if (usage) md.appendMarkdown('\n\n**Usage:** ').appendText(usage);
  md.appendMarkdown('\n\n').appendText(`${earlier ? `${earlier} earlier version${earlier === 1 ? '' : 's'} · ` : ''}${tildify(session.file)}`);
  return md;
}

/** A collapsed group row. */
function group(label, kind, icon, description = '', extra = {}) {
  /** @type {Row} */
  const item = Object.assign(new vscode.TreeItem(label, Collapsed), { kind, ...extra });
  item.id = `group:${kind}`;
  item.description = description;
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function note(label) {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon('info');
  return item;
}

module.exports = { HandoffTree };
