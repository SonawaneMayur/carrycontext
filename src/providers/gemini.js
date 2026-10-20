// @ts-check
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, listFiles, mtime } = require('../core/util');

// Gemini CLI keeps per-project data in ~/.gemini/tmp/<sha256(cwd)>/
const projectTmp = (cwd) =>
  path.join(os.homedir(), '.gemini', 'tmp', crypto.createHash('sha256').update(cwd).digest('hex'));

/** @type {import('./types').ProviderAdapter} */
module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',

  async listSessions(cwd) {
    const dir = projectTmp(cwd);
    const chats = listFiles(path.join(dir, 'chats'), (f) => f.endsWith('.json'));
    // Older CLI versions only write logs.json (user prompts only).
    const files = chats.length ? chats : listFiles(dir, (f) => f === 'logs.json');
    return files
      .map((file) => ({ provider: 'gemini', id: path.basename(file, '.json'), path: file, updatedAt: mtime(file) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async readSession(ref) {
    const data = readJson(ref.path, null);
    if (!data) return [];
    /** @type {import('./types').Message[]} */
    const out = [];
    if (Array.isArray(data)) {
      for (const m of data) {
        if (m.message) out.push({ role: 'user', text: String(m.message), ts: m.timestamp, provider: 'gemini' });
      }
      return out;
    }
    for (const m of data.messages || []) {
      if (m.type !== 'user' && m.type !== 'gemini') continue;
      const text = typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n');
      const tools = (m.toolCalls || []).map((t) => ({ name: t.name, input: t.args }));
      if (!text && !tools.length) continue;
      out.push({ role: m.type === 'user' ? 'user' : 'assistant', text, tools, ts: m.timestamp, provider: 'gemini' });
    }
    return out;
  },

  target: {
    handoffFile: (cwd) => path.join(cwd, '.gemini', 'handoff.md'),
    instructionsFile: (cwd) => path.join(cwd, 'GEMINI.md'),
  },

  launch: {
    terminal: (prompt, quote) => `gemini -i ${quote(prompt)}`,
  },
};
