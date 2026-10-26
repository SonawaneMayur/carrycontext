// @ts-check
// Activity Bar panel: latest handoff, recent sessions per provider, and saved handoffs.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { paths, loadState, listSavedHandoffs } = require('./core/handoff');
const { currentBranch, branchSlug } = require('./core/git');
const { getProvider } = require('./providers');
const { ago, mtime, tildify } = require('./core/util');

const SESSIONS_PER_PROVIDER = 5;

class HandoffTree {
  /** @param {() => string | undefined} cwd @param {() => import('./core/config').Config} config */
  constructor(cwd, config) {
    this.cwd = cwd;
    this.config = config;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire(undefined);
  }

  /** @param {vscode.TreeItem} item */
  getTreeItem(item) {
    return item;
  }

  /** @param {vscode.TreeItem & {kind?: string}} [parent] */
  async getChildren(parent) {
    const dir = this.cwd();
    if (!dir) return []; // shows the "open a folder" welcome view
    if (!parent) return [this.latestItem(dir), group('Sessions', 'sessions', 'comment-discussion'), group('Saved handoffs', 'handoffs', 'archive')];
    if (parent.kind === 'sessions') return this.sessionItems(dir);
    if (parent.kind === 'handoffs') return this.handoffGroups(dir);
    if (parent.kind === 'branch') return this.handoffItems(dir, parent.branch);
    return [];
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

  async sessionItems(dir) {
    const items = [];
    for (const id of this.config().sources) {
      const adapter = getProvider(id);
      if (!adapter?.listSessions) continue;
      for (const ref of (await adapter.listSessions(dir)).slice(0, SESSIONS_PER_PROVIDER)) {
        const item = new vscode.TreeItem(ref.title || ref.id.slice(0, 8));
        item.description = `${adapter.label} · ${ago(ref.updatedAt)}`;
        item.tooltip = `${tildify(ref.path)}\nClick to create a handoff from this session`;
        item.iconPath = new vscode.ThemeIcon('comment');
        item.contextValue = 'session';
        item.command = { command: 'carrycontext.compactThisSession', title: 'Create handoff', arguments: [ref] };
        items.push(item);
      }
    }
    if (!items.length) items.push(note(`No sessions from ${this.config().sources.join(', ')} in this folder yet`));
    return items;
  }

  /** One folder per branch (current branch first); flat list outside git. */
  handoffGroups(dir) {
    const saved = listSavedHandoffs(dir);
    if (!saved.length) return [note('Saved handoffs will appear here')];
    const branches = [...new Set(saved.map((s) => s.branch))];
    if (branches.length === 1 && branches[0] === null) return this.handoffItems(dir, null);
    const current = currentBranch(dir);
    const currentSlug = current && branchSlug(current);
    branches.sort((a, b) => Number(b === currentSlug) - Number(a === currentSlug));
    return branches.map((slug) => {
      const label = slug ? slug.replace(/__/g, '/') : '(no branch)';
      const item = Object.assign(
        new vscode.TreeItem(label, slug === currentSlug ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed),
        { kind: 'branch', branch: slug },
      );
      item.description = slug === currentSlug ? 'current' : '';
      item.iconPath = new vscode.ThemeIcon('git-branch');
      return item;
    });
  }

  handoffItems(dir, branch) {
    const files = listSavedHandoffs(dir)
      .filter((s) => s.branch === branch)
      .map((s) => s.file);
    if (!files.length) return [note('Saved handoffs will appear here')];
    return files.map((file) => {
      const [session, description] = path.basename(file, '.md').split('--');
      const item = new vscode.TreeItem(description ? description.replace(/-/g, ' ') : session);
      item.description = `${session} · ${ago(mtime(file))}`;
      item.tooltip = tildify(file);
      item.iconPath = new vscode.ThemeIcon('markdown');
      item.contextValue = 'handoffFile';
      item.resourceUri = vscode.Uri.file(file);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file)] };
      return item;
    });
  }
}

function group(label, kind, icon) {
  const item = Object.assign(new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded), { kind });
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function note(label) {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon('info');
  return item;
}

module.exports = { HandoffTree };
