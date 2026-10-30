// @ts-check
const os = require('os');
const path = require('path');
const { readJsonl, readFirstLine, listFiles, mtime } = require('../core/util');

const sessionsRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const LOOKBACK_DAYS = 7;

// Codex stores rollouts in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl; only scan recent days.
function recentRollouts() {
  const files = [];
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = path.join(
      sessionsRoot(),
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    files.push(...listFiles(dir, (f) => f.startsWith('rollout-') && f.endsWith('.jsonl')));
  }
  return files;
}

function sessionMeta(file) {
  try {
    const e = JSON.parse(readFirstLine(file));
    return e.type === 'session_meta' ? e.payload : e; // older rollouts had no wrapper
  } catch {
    return null;
  }
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .map((c) => c.text || '')
    .filter(Boolean)
    .join('\n');
}

/** Codex outputs are JSON like {"output": "...", "metadata": {"exit_code": 0}} or plain text. */
function attachResult(call, output) {
  if (!call) return;
  let exit;
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;
    exit = parsed?.metadata?.exit_code ?? parsed?.exit_code;
  } catch {
    const m = String(output).match(/exit[ _]code:?\s*(\d+)/i);
    if (m) exit = Number(m[1]);
  }
  if (typeof exit === 'number') {
    call.exitCode = exit;
    call.ok = exit === 0;
  } else if (/^\s*(error|failed)\b/i.test(String(output))) {
    call.ok = false;
  }
}

/** @type {import('./types').ProviderAdapter} */
module.exports = {
  id: 'codex',
  label: 'OpenAI Codex CLI',

  async listSessions(cwd, { limit = Infinity } = {}) {
    return recentRollouts()
      .map((file) => ({ file, meta: sessionMeta(file) }))
      .filter(({ meta }) => meta && path.resolve(meta.cwd || '') === path.resolve(cwd))
      .map(({ file, meta }) => ({
        provider: 'codex',
        id: meta.id || path.basename(file, '.jsonl'),
        path: file,
        updatedAt: mtime(file),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  },

  async readSession(ref) {
    /** @type {import('./types').Message[]} */
    const out = [];
    let branch;
    /** @type {Map<string, import('./types').ToolCall>} */
    const calls = new Map();
    for (const line of readJsonl(ref.path)) {
      if (line.type === 'session_meta') branch = line.payload?.git?.branch || branch;
      const item = line.type === 'response_item' ? line.payload : line;
      if (!item) continue;
      const ts = line.timestamp;
      if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
        const text = contentText(item.content);
        // Codex injects <environment_context>/<user_instructions> as user messages.
        if (!text || /^\s*<(environment_context|user_instructions)/.test(text)) continue;
        out.push({ role: item.role, text, ts, provider: 'codex', tools: [], branch });
      } else if (item.type === 'function_call' || item.type === 'local_shell_call' || item.type === 'custom_tool_call') {
        let input = item.arguments ?? item.action ?? item.input;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = { raw: input };
          }
        }
        const last = out[out.length - 1];
        const call = { name: item.name || item.type, input, id: item.call_id };
        if (item.call_id) calls.set(item.call_id, call);
        if (last && last.role === 'assistant') (last.tools ||= []).push(call);
        else out.push({ role: 'assistant', text: '', ts, provider: 'codex', tools: [call], branch });
      } else if (/_output$/.test(item.type || '') && item.call_id) {
        attachResult(calls.get(item.call_id), item.output);
      }
    }
    return out;
  },

  target: {
    handoffFile: (cwd) => path.join(cwd, '.codex', 'handoff.md'),
    instructionsFile: (cwd) => path.join(cwd, 'AGENTS.md'),
  },

  launch: {
    terminal: (prompt, quote) => `codex ${quote(prompt)}`,
  },
};
