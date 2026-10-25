// Builders that write synthetic sessions in each assistant's on-disk format.
// To support a new provider in the shared contract tests, add a writer to SESSION_WRITERS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Provider-neutral description of a conversation.
 * @typedef {{role: 'user'|'assistant', text: string, ts?: string, branch?: string, edits?: string[]}} Turn
 */

let clock = Date.parse('2026-10-25T10:00:00Z');
const nextTs = () => new Date((clock += 60000)).toISOString();

/** A standard conversation the contract tests expect every reader to understand. */
function standardConversation(cwd) {
  return [
    { role: 'user', text: 'Build the payments page' },
    { role: 'assistant', text: 'Added the payments page.', edits: [path.join(cwd, 'src', 'pay.js')] },
    { role: 'user', text: 'Now add tests' },
    { role: 'assistant', text: 'Tests added and passing.' },
  ];
}

/** Claude Code: ~/.claude/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl */
function writeClaude(cwd, id, turns, { title } = {}) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  if (title) lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  for (const t of turns) {
    const content = [{ type: 'text', text: t.text }];
    for (const file of t.edits || []) content.push({ type: 'tool_use', name: 'Edit', input: { file_path: file } });
    lines.push({
      type: t.role,
      sessionId: id,
      cwd,
      gitBranch: t.branch,
      timestamp: t.ts || nextTs(),
      message: { role: t.role, content },
    });
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
      lines.push({
        timestamp: nextTs(),
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` },
      });
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
    toolCalls: (t.edits || []).map((file) => ({ name: 'replace', args: { file_path: file } })),
  }));
  const file = path.join(dir, `session-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ sessionId: id, messages }));
  return file;
}

/** provider id -> (cwd, id, turns, opts) => file. The contract test fails for readers missing here. */
const SESSION_WRITERS = { claude: writeClaude, codex: writeCodex, gemini: writeGemini };

module.exports = { standardConversation, writeClaude, writeCodex, writeGemini, SESSION_WRITERS };
