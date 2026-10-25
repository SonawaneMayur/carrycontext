// @ts-check
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { saveConfig } = require('./core/config');
const { paths, loadState, lastProcessed, gatherSessions, updateHandoff, activateBranch, listSavedHandoffs, syncTargets, resumePrompt } = require('./core/handoff');
const { currentBranch, headFile } = require('./core/git');
const { installClaudeHooks, updateHookSettings, writeHookScript, hooksInstalled, processPayload, pendingPayloads } = require('./core/claudeHooks');
const { getProvider, listProviders } = require('./providers');
const { getLlm, listLlms } = require('./llm');
const { ago, readText, shellQuote: posixQuote } = require('./core/util');
const { HandoffTree } = require('./sidebar');

const POLL_MS = 30000;

/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.StatusBarItem} */
let status;
let busy = false;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  output = vscode.window.createOutputChannel('CarryContext');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'carrycontext.menu';
  context.subscriptions.push(output, status);

  const cliPath = path.join(context.extensionPath, 'bin', 'carrycontext.js');
  const getApiKey = async (provider) =>
    (await context.secrets.get(`carrycontext.apiKey.${provider}`)) || process.env[getLlm(provider)?.envKey || ''];

  const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const config = () => {
    const c = vscode.workspace.getConfiguration('carrycontext');
    return {
      summarizer: {
        provider: c.get('summarizer.provider', 'none'),
        model: c.get('summarizer.model', ''),
        baseUrl: c.get('summarizer.baseUrl', ''),
      },
      sources: c.get('sources', ['claude', 'codex', 'gemini']),
      targets: c.get('targets', ['claude', 'codex', 'gemini']),
      lookbackHours: c.get('lookbackHours', 24),
      handoffLimit: c.get('handoffLimit', 50),
      maxTranscriptChars: c.get('maxTranscriptChars', 150000),
      autoUpdate: { enabled: c.get('autoUpdate.enabled', true), idleSeconds: c.get('autoUpdate.idleSeconds', 120) },
      redact: { enabled: c.get('redact.enabled', true), extraPatterns: c.get('redact.extraPatterns', []) },
    };
  };
  const tree = new HandoffTree(cwd, config);
  context.subscriptions.push(vscode.window.createTreeView('carrycontext.handoffs', { treeDataProvider: tree }));

  // Hooks run the CLI outside VS Code, so it reads the same settings from .carrycontext/config.json.
  const persistConfig = () => cwd() && saveConfig(cwd(), config());

  async function run(label, fn) {
    if (busy) return vscode.window.showInformationMessage('CarryContext is already updating the handoff.');
    busy = true;
    status.text = '$(sync~spin) Handoff';
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `CarryContext: ${label}` },
        fn,
      );
    } catch (e) {
      output.appendLine(`[error] ${label}: ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`CarryContext: ${e.message}`);
    } finally {
      busy = false;
      refreshStatus();
    }
  }

  async function compact(sessions, trigger, { open = true } = {}) {
    const dir = cwd();
    if (!dir) return vscode.window.showWarningMessage('Open a folder first.');
    const res = await updateHandoff({ cwd: dir, sessions, trigger, config: config(), getApiKey });
    output.appendLine(`${new Date().toISOString()} ${trigger}: ${sessions.map((s) => `${s.ref.provider}:${s.ref.id}`).join(', ')}`);
    if (res.warning) {
      output.appendLine(`[warn] ${res.warning}`);
      vscode.window.showWarningMessage(`CarryContext: ${res.warning}`);
    }
    if (open) await vscode.window.showTextDocument(vscode.Uri.file(res.sessionFile), { preview: true });
    return res;
  }

  function refreshStatus() {
    tree.refresh();
    const dir = cwd();
    if (!dir) {
      status.text = '$(history) Handoff: no folder';
      status.tooltip = 'CarryContext needs an open folder. Click to open one.';
      status.command = 'vscode.openFolder';
      return status.show();
    }
    status.command = 'carrycontext.menu';
    const state = loadState(dir);
    const branch = currentBranch(dir);
    status.text = ['$(history) Handoff', branch, state.lastUpdated && ago(state.lastUpdated)].filter(Boolean).join(' · ');
    status.tooltip = [
      state.lastUpdated ? `Last handoff: ${state.lastUpdated} (${state.trigger}, ${state.summarizer})` : 'No handoff yet.',
      branch && `Branch: ${branch} (each branch keeps its own handoff)`,
      'Click for CarryContext actions',
    ]
      .filter(Boolean)
      .join('\n');
    status.show();
  }

  async function drainInbox(minAgeMs) {
    const dir = cwd();
    if (!dir) return;
    for (const file of pendingPayloads(dir, minAgeMs)) {
      const res = await processPayload(dir, file, config(), getApiKey).catch((e) => output.appendLine(`[error] inbox: ${e.message}`));
      if (res) output.appendLine(`${new Date().toISOString()} processed hook payload ${path.basename(file)}`);
    }
  }

  // Auto-update for providers without hooks: compact a session once it has been idle long enough.
  async function poll() {
    const dir = cwd();
    const c = config();
    if (!dir || busy || !c.autoUpdate.enabled) return;
    await drainInbox(10000);
    const state = loadState(dir);
    const claudeHooked = hooksInstalled(dir);
    const idleMs = c.autoUpdate.idleSeconds * 1000;
    for (const { adapter, ref } of await gatherSessions(dir, c)) {
      if (adapter.id === 'claude' && claudeHooked) continue; // hooks already cover Claude
      if (Date.now() - ref.updatedAt < idleMs || lastProcessed(state, ref.path) >= ref.updatedAt) continue;
      busy = true;
      try {
        await compact([{ adapter, ref }], `auto:idle:${adapter.id}`, { open: false });
      } catch (e) {
        output.appendLine(`[error] auto-update ${adapter.id}: ${e.message}`);
      } finally {
        busy = false;
        refreshStatus();
      }
    }
  }

  const commands = {
    'carrycontext.menu': async () => {
      const actions = [
        { label: '$(sync) Compact All', detail: 'Create a handoff from the latest session of every provider', command: 'carrycontext.compactAll' },
        { label: '$(arrow-swap) Switch To Provider…', detail: 'Continue this work in another assistant', command: 'carrycontext.switchProvider' },
        { label: '$(note) Open Handoff…', detail: 'Latest handoff or a saved one', command: 'carrycontext.openHandoff' },
        { label: '$(comment-discussion) Create Handoff From a Session…', detail: 'Pick specific sessions', command: 'carrycontext.compactSession' },
        { label: '$(clippy) Copy Resume Prompt', command: 'carrycontext.copyResumePrompt' },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(sparkle) Select Summarizer LLM…', detail: `Now: ${config().summarizer.provider}`, command: 'carrycontext.selectSummarizer' },
        { label: '$(key) Set API Key…', command: 'carrycontext.setApiKey' },
        {
          label: '$(plug) Install Claude Code Hooks',
          detail: cwd() && hooksInstalled(cwd() || '') ? 'Installed' : 'Not installed',
          command: 'carrycontext.installClaudeHooks',
        },
        { label: '$(layout-sidebar-left) Show CarryContext Panel', command: 'carrycontext.handoffs.focus' },
      ];
      const pick = await vscode.window.showQuickPick(actions, { placeHolder: 'CarryContext' });
      if (pick?.command) await vscode.commands.executeCommand(pick.command);
    },

    'carrycontext.refreshView': () => refreshStatus(),

    'carrycontext.compactThisSession': (ref) => {
      const adapter = ref && getProvider(ref.provider);
      if (adapter) return run('Create handoff', () => compact([{ adapter, ref }], 'vscode:session'));
    },

    // Make a saved handoff the latest one again, and copy it to every provider.
    'carrycontext.restoreHandoff': async (item) => {
      const dir = cwd();
      const file = item?.resourceUri?.fsPath;
      if (!dir || !file) return;
      fs.copyFileSync(file, paths(dir).handoff);
      syncTargets(dir, config());
      refreshStatus();
      vscode.window.showInformationMessage(`CarryContext: "${path.basename(file, '.md')}" is now the latest handoff for every provider.`);
    },

    'carrycontext.copyHandoff': async (item) => {
      const dir = cwd();
      const file = item?.resourceUri?.fsPath || (dir && paths(dir).handoff);
      const text = file && readText(file);
      if (!text) return;
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Handoff copied. Paste it into any LLM chat.');
    },

    'carrycontext.compactAll': () =>
      run('Compact All', async () => {
        const sessions = await gatherSessions(cwd() || '', config());
        if (!sessions.length) throw new Error(`No sessions from ${config().sources.join(', ')} in the last ${config().lookbackHours}h for this folder.`);
        await compact(sessions, 'vscode:compact-all');
      }),

    'carrycontext.compactSession': async () => {
      const dir = cwd();
      if (!dir) return;
      const items = [];
      for (const id of config().sources) {
        const adapter = getProvider(id);
        if (!adapter?.listSessions) continue;
        for (const ref of (await adapter.listSessions(dir)).slice(0, 15)) {
          items.push({ label: ref.title || ref.id, description: `${adapter.label} · ${ago(ref.updatedAt)}`, adapter, ref });
        }
      }
      if (!items.length) return vscode.window.showInformationMessage('No sessions found for this folder.');
      const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Sessions to include in the handoff' });
      if (picked?.length) await run('Create handoff', () => compact(picked, 'vscode:manual'));
    },

    'carrycontext.switchProvider': async () => {
      const dir = cwd();
      if (!dir) return;
      const targets = listProviders().filter((p) => p.target);
      const pick = await vscode.window.showQuickPick(
        [
          ...targets.map((p) => ({ label: p.label, description: p.id, id: p.id })),
          { label: 'Clipboard (any other LLM)', description: 'copy handoff text', id: 'clipboard' },
        ],
        { placeHolder: 'Continue this work in…' },
      );
      if (!pick) return;
      const fresh = await vscode.window.showQuickPick(['Refresh handoff from latest sessions first', 'Use current handoff'], {
        placeHolder: `Handoff last updated ${loadState(dir).lastUpdated ? ago(loadState(dir).lastUpdated) : 'never'}`,
      });
      if (!fresh) return;
      if (fresh.startsWith('Refresh')) {
        const sessions = await gatherSessions(dir, config());
        if (sessions.length) await run('Compact All', () => compact(sessions, `vscode:switch:${pick.id}`, { open: false }));
      }
      if (!fs.existsSync(paths(dir).handoff)) return vscode.window.showWarningMessage('No handoff yet. Run "CarryContext: Compact All" first.');
      await launch(dir, pick.id);
    },

    'carrycontext.openHandoff': async () => {
      const dir = cwd();
      if (!dir) return;
      const p = paths(dir);
      if (!fs.existsSync(p.handoff)) return vscode.window.showInformationMessage('No handoff yet. Run "CarryContext: Compact All".');
      const named = listSavedHandoffs(dir).map(({ file, branch, at }) => ({
        label: path.basename(file, '.md'),
        description: [branch && branch.replace(/__/g, '/'), ago(at)].filter(Boolean).join(' · '),
        file,
      }));
      const branch = currentBranch(dir);
      const pick = await vscode.window.showQuickPick(
        [{ label: `Latest (handoff.md)${branch ? ` · ${branch}` : ''}`, description: 'what providers read', file: p.handoff }, ...named],
        { placeHolder: 'Open which handoff?' },
      );
      if (pick) await vscode.window.showTextDocument(vscode.Uri.file(pick.file));
    },

    'carrycontext.copyResumePrompt': async () => {
      const dir = cwd();
      if (!dir) return;
      await vscode.env.clipboard.writeText(resumePrompt(dir, 'claude'));
      vscode.window.showInformationMessage('Resume prompt copied.');
    },

    'carrycontext.installClaudeHooks': () => {
      const dir = cwd();
      if (!dir) return;
      persistConfig();
      installClaudeHooks(dir, cliPath, process.execPath);
      vscode.window.showInformationMessage(
        'Claude Code hooks installed in .claude/settings.local.json: the handoff now refreshes on compact and session end, and new sessions load it. /compact-all is available in Claude Code.',
      );
    },

    'carrycontext.selectSummarizer': async () => {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'None (heuristic, offline)', id: 'none' }, ...listLlms().map((l) => ({ label: l.label, description: l.defaultModel, id: l.id }))],
        { placeHolder: 'Which LLM should write handoffs?' },
      );
      if (!pick) return;
      const c = vscode.workspace.getConfiguration('carrycontext');
      await c.update('summarizer.provider', pick.id, vscode.ConfigurationTarget.Workspace);
      if (pick.id === 'none') return;
      const llm = getLlm(pick.id);
      const model = await vscode.window.showInputBox({ prompt: `Model for ${llm.label}`, value: c.get('summarizer.model') || llm.defaultModel });
      if (model !== undefined) await c.update('summarizer.model', model, vscode.ConfigurationTarget.Workspace);
      if (pick.id === 'openai-compatible' || pick.id === 'ollama') {
        const baseUrl = await vscode.window.showInputBox({ prompt: 'Base URL', value: c.get('summarizer.baseUrl') || (pick.id === 'ollama' ? 'http://localhost:11434' : 'https://openrouter.ai/api/v1') });
        if (baseUrl !== undefined) await c.update('summarizer.baseUrl', baseUrl, vscode.ConfigurationTarget.Workspace);
      }
      if (llm.needsKey || pick.id === 'openai-compatible') await commands['carrycontext.setApiKey'](pick.id);
    },

    'carrycontext.setApiKey': async (providerId) => {
      const id =
        typeof providerId === 'string'
          ? providerId
          : (await vscode.window.showQuickPick(listLlms().filter((l) => l.envKey).map((l) => ({ label: l.label, id: l.id }))))?.id;
      if (!id) return;
      const key = await vscode.window.showInputBox({ prompt: `API key for ${getLlm(id).label}`, password: true, ignoreFocusOut: true });
      if (!key) return;
      await context.secrets.store(`carrycontext.apiKey.${id}`, key);
      vscode.window.showInformationMessage(
        `Key saved in VS Code secret storage. Claude Code hooks run outside VS Code, so they read ${getLlm(id).envKey} from your shell environment instead.`,
      );
    },
  };

  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('carrycontext')) return;
      persistConfig();
      if (e.affectsConfiguration('carrycontext.targets') && cwd()) syncTargets(cwd(), config());
    }),
  );

  const dir = cwd();
  output.appendLine(`${new Date().toISOString()} CarryContext activated. Folder: ${dir || '(none open)'}`);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refreshStatus));
  if (dir) {
    persistConfig();
    // The extension path and Node path change on updates, so keep the hook script current.
    if (hooksInstalled(dir)) {
      writeHookScript(dir, cliPath, process.execPath);
      updateHookSettings(dir, false); // e.g. adds the "compact" matcher to older installs
    }
    else if (config().sources.includes('claude') && !context.workspaceState.get('claudeHooksPrompted')) {
      context.workspaceState.update('claudeHooksPrompted', true);
      vscode.window
        .showInformationMessage('CarryContext: auto-update the handoff when Claude Code compacts or a session ends?', 'Install hooks', 'Not now')
        .then((a) => a === 'Install hooks' && commands['carrycontext.installClaudeHooks']());
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '.carrycontext/{state.json,handoff.md,handoffs/**/*.md}'));
    watcher.onDidChange(refreshStatus);
    watcher.onDidCreate(refreshStatus);
    watcher.onDidDelete(refreshStatus);
    context.subscriptions.push(watcher);
    drainInbox(0);
    const timer = setInterval(() => poll().catch((e) => output.appendLine(`[error] poll: ${e.message}`)), POLL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    const tick = setInterval(refreshStatus, 60000);
    context.subscriptions.push({ dispose: () => clearInterval(tick) });

    // Each git branch keeps its own handoff: swap the active one when HEAD changes.
    const onBranchChange = () => {
      const res = activateBranch(dir, config());
      refreshStatus();
      if (!res.changed) return;
      output.appendLine(`${new Date().toISOString()} branch ${res.branch}: handoff activated${res.inheritedFrom ? ` (new, from ${res.inheritedFrom})` : ''}`);
      vscode.window.setStatusBarMessage(
        res.inheritedFrom
          ? `CarryContext: new handoff for ${res.branch}, started from ${res.inheritedFrom}`
          : `CarryContext: switched to the ${res.branch} handoff`,
        5000,
      );
    };
    const head = headFile(dir);
    if (head) {
      onBranchChange();
      fs.watchFile(head, { interval: 2000 }, onBranchChange);
      context.subscriptions.push({ dispose: () => fs.unwatchFile(head, onBranchChange) });
    }
  }
  refreshStatus();
}

/** Hand the current handoff to the chosen provider. */
async function launch(cwd, providerId) {
  const handoffFile = paths(cwd).handoff;
  if (providerId === 'clipboard') {
    await vscode.env.clipboard.writeText(fs.readFileSync(handoffFile, 'utf8'));
    return vscode.window.showInformationMessage('Handoff copied. Paste it as the first message in any LLM chat.');
  }
  const provider = getProvider(providerId);
  // Make sure this provider has its copy even if it is not in carrycontext.targets.
  const cfg = vscode.workspace.getConfiguration('carrycontext');
  syncTargets(cwd, { targets: [providerId], handoffLimit: cfg.get('handoffLimit', 50) });
  const prompt = resumePrompt(cwd, providerId);

  if (provider.launch?.terminal) {
    const term = vscode.window.createTerminal({ name: `${provider.label} (CarryContext)`, cwd });
    term.show();
    // Hides user@host from the prompt, e.g. for screen recordings.
    if (vscode.workspace.getConfiguration('carrycontext').get('plainTerminalPrompt', false) && process.platform !== 'win32') {
      term.sendText(`PROMPT='$ '; PS1='$ '; clear`);
    }
    term.sendText(provider.launch.terminal(prompt, shellQuote));
  } else if (provider.launch?.vscodeCommand) {
    try {
      await vscode.commands.executeCommand(provider.launch.vscodeCommand, { query: prompt });
    } catch {
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(`Open ${provider.label} and paste. The resume prompt is in your clipboard.`);
    }
  } else {
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(`Handoff written for ${provider.label}. The resume prompt is in your clipboard.`);
  }
}

const shellQuote = (s) => (process.platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : posixQuote(s));

function deactivate() {}

module.exports = { activate, deactivate };
