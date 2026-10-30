// Builders that write synthetic sessions in each assistant's on-disk format.
// To support a new provider in the shared contract tests, add a writer to SESSION_WRITERS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Provider-neutral description of a conversation. `commands` are shell runs with their outcome.
 * @typedef {{cmd: string, exit: number}} Command
 * `usage` is a Claude API usage object, written with the reply as Claude Code logs it.
 * @typedef {{role: 'user'|'assistant', text: string, ts?: string, branch?: string, edits?: string[], commands?: Command[], failedEdits?: string[], usage?: object, model?: string}} Turn
 */

let callId = 0;
const nextId = () => `call_${++callId}`;

let clock = Date.parse('2026-10-25T10:00:00Z');
const nextTs = () => new Date((clock += 60000)).toISOString();

/** A standard conversation the contract tests expect every reader to understand. */
function standardConversation(cwd) {
  return [
    { role: 'user', text: 'Build the payments page' },
    { role: 'assistant', text: 'Added the payments page.', edits: [path.join(cwd, 'src', 'pay.js')] },
    { role: 'user', text: 'Now add tests' },
    { role: 'assistant', text: 'Tests added and passing.', commands: [{ cmd: 'npm test', exit: 0 }] },
  ];
}

/** Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl */
function writeClaude(cwd, id, turns, { title } = {}) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  for (const t of turns) {
    const ts = t.ts || nextTs();
    const content = [{ type: 'text', text: t.text }];
    const results = [];
    const call = (name, input, isError, output) => {
      const callIdValue = nextId();
      content.push({ type: 'tool_use', id: callIdValue, name, input });
      results.push({ type: 'tool_result', tool_use_id: callIdValue, is_error: isError, content: output });
    };
    for (const file of t.edits || []) call('Edit', { file_path: file }, false, 'The file has been updated.');
    for (const file of t.failedEdits || []) call('Edit', { file_path: file }, true, 'String to replace not found in file.');
    for (const c of t.commands || []) call('Bash', { command: c.cmd }, c.exit !== 0, c.exit ? `Exit code ${c.exit}\nfailed` : 'ok');
    const base = { sessionId: id, cwd, gitBranch: t.branch, timestamp: ts };
    const reply = t.usage ? { id: `msg_${nextId()}`, model: t.model || 'claude-opus-5-5', usage: t.usage } : {};
    lines.push({ ...base, type: t.role, ...(t.usage && { requestId: `req_${reply.id}` }), message: { role: t.role, content, ...reply } });
    if (results.length) lines.push({ ...base, type: 'user', message: { role: 'user', content: results } });
  }
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl */
function writeCodex(cwd, id, turns, { branch } = {}) {
  const d = new Date();
  const dir = path.join(
    process.env.CODEX_HOME,
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const lines = [{ timestamp: nextTs(), type: 'session_meta', payload: { id, cwd, git: branch ? { branch } : undefined } }];
  lines.push({
    timestamp: nextTs(),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>noise</environment_context>' }] },
  });
  for (const t of turns) {
    const type = t.role === 'user' ? 'input_text' : 'output_text';
    lines.push({ timestamp: t.ts || nextTs(), type: 'response_item', payload: { type: 'message', role: t.role, content: [{ type, text: t.text }] } });
    for (const file of t.edits || []) {
      const call_id = nextId();
      lines.push({
        timestamp: nextTs(),
        type: 'response_item',
        payload: { type: 'custom_tool_call', call_id, name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` },
      });
      lines.push({ timestamp: nextTs(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output: JSON.stringify({ output: 'Success', metadata: { exit_code: 0 } }) } });
    }
    for (const c of t.commands || []) {
      const call_id = nextId();
      lines.push({ timestamp: nextTs(), type: 'response_item', payload: { type: 'function_call', call_id, name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', c.cmd] }) } });
      lines.push({ timestamp: nextTs(), type: 'response_item', payload: { type: 'function_call_output', call_id, output: JSON.stringify({ output: '', metadata: { exit_code: c.exit } }) } });
    }
  }
  const file = path.join(dir, `rollout-2026-10-25T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** Gemini CLI: ~/.gemini/tmp/<sha256(cwd)>/chats/session-<id>.json */
function writeGemini(cwd, id, turns) {
  const dir = path.join(process.env.HOME, '.gemini', 'tmp', crypto.createHash('sha256').update(cwd).digest('hex'), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const messages = turns.map((t) => ({
    type: t.role === 'user' ? 'user' : 'gemini',
    content: t.text,
    timestamp: t.ts || nextTs(),
    toolCalls: [
      ...(t.edits || []).map((file) => ({ id: nextId(), name: 'replace', args: { file_path: file }, status: 'success' })),
      ...(t.commands || []).map((c) => ({ id: nextId(), name: 'run_shell_command', args: { command: c.cmd }, status: c.exit ? 'error' : 'success' })),
    ],
  }));
  const file = path.join(dir, `session-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ sessionId: id, messages }));
  return file;
}

/** provider id -> (cwd, id, turns, opts) => file. The contract test fails for readers missing here. */
const SESSION_WRITERS = { claude: writeClaude, codex: writeCodex, gemini: writeGemini };

module.exports = { standardConversation, writeClaude, writeCodex, writeGemini, SESSION_WRITERS };
