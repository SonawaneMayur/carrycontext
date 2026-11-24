// @ts-check
// The search box above the Handoffs list, as a webview view. Locked down: its Content Security
// Policy allows no network, no remote content and only its own nonce'd script and style.
// Results quote chat text, so the page renders them with textContent, never as HTML. The page
// only sends back a query or a result key; files are looked up here, so it can't name one to
// open. No 'vscode' import, so it can be tested without VS Code.
const crypto = require('crypto');
const { buildIndex, searchIndex, askSessions } = require('./core/search');
const { getLlm } = require('./llm');
const { ago } = require('./core/util');

/** How long an index is reused before chats are checked for changes again. */
const INDEX_TTL_MS = 60000;
const MAX_QUERY = 200;

/**
 * @typedef {import('./core/search').Doc} Doc
 * @typedef {Object} SearchDeps
 * @property {() => string | undefined} cwd
 * @property {() => import('./core/config').Config} config
 * @property {(provider: string) => Promise<string | undefined>} getApiKey
 * @property {(file: string) => any} openFile
 * @property {(chat: NonNullable<Doc['chat']>) => Promise<{sessionFile?: string} | undefined>} createHandoff
 * @property {(file: string) => any} [reveal]   select a handoff's row in the Handoffs list
 * @property {(found: {keys: string[], files: string[], words: string[]} | null) => any} [highlight]
 *   highlight the matches in the Handoffs list and open up their parents; null clears it
 * @property {(line: string) => void} [log]
 */

class SearchView {
  /** @param {SearchDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {any} */
    this.view = null;
    /** @type {Map<string, Doc>} result key -> session, for the latest results and answer */
    this.shown = new Map();
    /** @type {{index: import('./core/search').Index, at: number, cwd: string} | null} */
    this.cache = null;
    /** @type {Promise<import('./core/search').Index> | null} */
    this.building = null;
    this.seq = 0;
  }

  /** Called by VS Code when the view is first shown. */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderHtml(crypto.randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  post(message) {
    this.view?.webview.postMessage(message);
  }

  /** The selected summarizer's name, or '' when Ask AI isn't available. */
  aiLabel() {
    const provider = this.deps.config().summarizer.provider;
    return provider === 'none' ? '' : getLlm(provider)?.label || provider;
  }

  /** Handoffs or settings changed: rebuild the index on the next search. */
  invalidate() {
    this.cache = null;
    this.post({ type: 'state', ai: this.aiLabel() });
  }

  async index() {
    const cwd = this.deps.cwd();
    if (!cwd) throw new Error('Open a folder to search its sessions.');
    if (this.cache && this.cache.cwd === cwd && Date.now() - this.cache.at < INDEX_TTL_MS) return this.cache.index;
    if (!this.building) {
      this.post({ type: 'status', text: 'Reading chats…' });
      this.building = buildIndex(cwd, this.deps.config().sources)
        .then((index) => {
          this.cache = { index, at: Date.now(), cwd };
          return index;
        })
        .finally(() => (this.building = null));
    }
    return this.building;
  }

  /** @param {any} m */
  async onMessage(m) {
    try {
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'ready') return this.post({ type: 'state', ai: this.aiLabel() });
      if (m.type === 'search') return await this.search(query(m.q));
      if (m.type === 'ask') return await this.ask(query(m.q));
      const doc = typeof m.key === 'string' ? this.shown.get(m.key) : undefined;
      if (!doc) return;
      if (m.type === 'open' && doc.handoffFile) {
        await this.deps.openFile(doc.handoffFile);
        return await this.deps.reveal?.(doc.handoffFile);
      }
      if ((m.type === 'open' || m.type === 'create') && doc.chat) {
        const saved = await this.deps.createHandoff(doc.chat);
        this.cache = null;
        if (saved?.sessionFile) await this.deps.reveal?.(saved.sessionFile);
      }
    } catch (e) {
      this.deps.log?.(`[error] search: ${e.stack || e.message}`);
      this.post({ type: 'error', text: e.message });
    }
  }

  async search(q) {
    const seq = ++this.seq;
    if (!q) {
      this.shown = new Map();
      this.post({ type: 'results', q, items: [] });
      return await this.deps.highlight?.(null);
    }
    const index = await this.index();
    if (seq !== this.seq) return; // a newer search started while the index was built
    const results = searchIndex(index, q);
    this.shown = new Map(results.map((r, i) => [`r${i}`, r.doc]));
    this.post({ type: 'results', q, items: results.map((r, i) => item(`r${i}`, r.doc, r.snippet, r.partial)) });
    await this.highlight(results);
  }

  /** @param {import('./core/search').Result[]} results */
  async highlight(results) {
    if (!this.deps.highlight) return;
    const found = {
      keys: results.map((r) => r.doc.id),
      files: [...new Set(results.flatMap((r) => r.files))],
      words: [...new Set(results.flatMap((r) => r.words))],
    };
    await this.deps.highlight(results.length ? found : null);
  }

  async ask(q) {
    if (!q) return;
    const seq = ++this.seq;
    const config = this.deps.config();
    const index = await this.index();
    const results = searchIndex(index, q);
    this.post({ type: 'thinking', ai: this.aiLabel() });
    const apiKey = config.summarizer.provider === 'none' ? undefined : await this.deps.getApiKey(config.summarizer.provider);
    const { answer, sources } = await askSessions(index, q, results, { config, apiKey, cwd: /** @type {string} */ (this.deps.cwd()) });
    if (seq !== this.seq) return;
    this.shown = new Map([...results.map((r, i) => [`r${i}`, r.doc]), ...sources.map((doc, i) => [`a${i + 1}`, doc])]);
    this.post({
      type: 'answer',
      q,
      text: answer,
      sources: sources.map((doc, i) => item(`a${i + 1}`, doc, '', false)),
      items: results.map((r, i) => item(`r${i}`, r.doc, r.snippet, r.partial)),
    });
    await this.highlight(results);
  }
}

const query = (q) => (typeof q === 'string' ? q.trim().slice(0, MAX_QUERY) : '');

/** What the page shows for one session. */
function item(key, doc, snippet, partial) {
  return {
    key,
    title: doc.title,
    meta: [doc.providers.join(' + '), doc.branch, ago(doc.at)].filter(Boolean).join(' · '),
    snippet,
    partial,
    hasHandoff: Boolean(doc.handoffFile),
    canCreate: Boolean(doc.chat),
  };
}

function renderHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body { padding: 6px 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .bar { display: flex; gap: 4px; }
  input { flex: 1; min-width: 0; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button { font: inherit; cursor: pointer; }
  .ask { padding: 3px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 2px; white-space: nowrap; }
  .ask:hover { background: var(--vscode-button-hoverBackground); }
  .status { margin: 6px 0 2px; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .status.error { color: var(--vscode-errorForeground); }
  .answer { margin: 6px 0; padding: 6px 8px; border-left: 2px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); white-space: pre-wrap; }
  .cite { padding: 0 2px; color: var(--vscode-textLink-foreground); background: none; border: none; text-decoration: underline; }
  ul { list-style: none; margin: 4px 0 0; padding: 0; }
  li { padding: 5px 4px; border-radius: 3px; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  .sep { margin-top: 8px; padding: 2px 4px; color: var(--vscode-descriptionForeground); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; }
  .title { display: block; width: 100%; padding: 0; text-align: left; color: var(--vscode-foreground); background: none; border: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .snippet { color: var(--vscode-descriptionForeground); font-size: 0.9em; overflow-wrap: anywhere; }
  .create { margin-top: 3px; padding: 1px 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; border-radius: 2px; font-size: 0.9em; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="bar">
  <input id="q" type="search" maxlength="${MAX_QUERY}" placeholder="Search sessions (typos are fine)" aria-label="Search sessions">
  <button id="ask" class="ask" hidden>Ask AI</button>
</div>
<div id="status" class="status" role="status"></div>
<div id="answer" class="answer" hidden></div>
<ul id="results"></ul>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const q = $('q'), ask = $('ask'), status = $('status'), answer = $('answer'), list = $('results');
  let ai = '';
  let timer;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const setStatus = (text, error) => { status.textContent = text || ''; status.classList.toggle('error', Boolean(error)); };
  const send = (type) => vscode.postMessage({ type, q: q.value });

  function row(it) {
    const li = el('li');
    const title = el('button', 'title', it.title);
    title.title = it.hasHandoff ? 'Open its handoff' : 'Create a handoff from this chat';
    title.addEventListener('click', () => vscode.postMessage({ type: 'open', key: it.key }));
    li.append(title, el('div', 'meta', it.meta + (it.hasHandoff ? '' : ' · no handoff yet')));
    if (it.snippet) li.append(el('div', 'snippet', it.snippet));
    if (it.hasHandoff && it.canCreate) {
      const again = el('button', 'create', 'Refresh handoff from chat');
      again.addEventListener('click', () => vscode.postMessage({ type: 'create', key: it.key }));
      li.append(again);
    }
    return li;
  }

  function showResults(items) {
    list.replaceChildren();
    let partial = false;
    for (const it of items) {
      if (it.partial && !partial) { partial = true; list.append(el('li', 'sep', 'Partly matching')); }
      list.append(row(it));
    }
  }

  function showAnswer(text, sources) {
    answer.replaceChildren();
    const keys = new Map(sources.map((s) => [s.key, s]));
    for (const part of text.split(/(\\[\\d+\\])/)) {
      const s = keys.get('a' + (part.match(/^\\[(\\d+)\\]$/) || [])[1]);
      if (!s) { answer.append(document.createTextNode(part)); continue; }
      const cite = el('button', 'cite', part);
      cite.title = s.title;
      cite.addEventListener('click', () => vscode.postMessage({ type: 'open', key: s.key }));
      answer.append(cite);
    }
    answer.hidden = false;
  }

  q.addEventListener('input', () => {
    clearTimeout(timer);
    vscode.setState({ q: q.value });
    answer.hidden = true;
    timer = setTimeout(() => send('search'), 200);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ai && q.value.trim()) send('ask');
  });
  ask.addEventListener('click', () => { if (q.value.trim()) send('ask'); else q.focus(); });

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') {
      ai = m.ai;
      ask.hidden = !ai;
      ask.title = ai ? 'Ask ' + ai + ' which sessions answer your question (Cmd/Ctrl+Enter)' : '';
    } else if (m.type === 'status') setStatus(m.text);
    else if (m.type === 'error') setStatus(m.text, true);
    else if (m.type === 'thinking') { setStatus('Asking ' + m.ai + '…'); answer.hidden = true; }
    else if (m.type === 'results' && m.q === q.value.trim()) {
      setStatus(m.q ? (m.items.length ? '' : 'No matching sessions.' + (ai ? ' Try Ask AI.' : '')) : '');
      showResults(m.items);
    } else if (m.type === 'answer') {
      setStatus('');
      showAnswer(m.text, m.sources);
      showResults(m.items);
    }
  });

  const saved = vscode.getState();
  if (saved && saved.q) { q.value = saved.q; send('search'); }
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { SearchView, renderHtml };
