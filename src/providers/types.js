// @ts-check
// Shared shapes for provider adapters. No runtime code.

/**
 * A normalized chat message, independent of which tool produced it.
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} text
 * @property {ToolCall[]} [tools]                   tool calls made in this turn
 * @property {string} [ts]                            ISO timestamp
 * @property {string} [provider]
 * @property {string} [branch]                        git branch checked out when the message was sent
 */

/**
 * A tool call, with its outcome when the transcript records one.
 * @typedef {Object} ToolCall
 * @property {string} name
 * @property {any} input
 * @property {string} [id]        provider's call id, used to match the result
 * @property {boolean} [ok]       true = succeeded, false = failed, undefined = unknown
 * @property {number} [exitCode]  for shell commands, when recorded
 */

/**
 * @typedef {Object} SessionRef
 * @property {string} provider
 * @property {string} id
 * @property {string} path
 * @property {number} updatedAt   epoch ms
 * @property {string} [title]    session name; readSession may fill it in (e.g. Claude's ai-title)
 */

/**
 * Where a provider expects to find the handoff in a new session.
 * - handoffFile: copy of handoff.md for this provider
 * - instructionsFile: file the provider always loads (AGENTS.md, GEMINI.md, ...);
 *   CarryContext adds a managed block pointing at handoffFile
 * - inline: put the whole handoff inside instructionsFile instead of pointing at it
 * - render: custom file format (e.g. Cursor .mdc frontmatter)
 * @typedef {Object} HandoffTarget
 * @property {(cwd: string) => string} handoffFile
 * @property {(cwd: string) => string} [instructionsFile]
 * @property {boolean} [inline]
 * @property {(doc: string) => string} [render]
 */

/**
 * @typedef {Object} ProviderAdapter
 * @property {string} id
 * @property {string} label
 * @property {(cwd: string, opts?: {limit?: number}) => Promise<SessionRef[]>} [listSessions]  newest first, at most `limit`; omit for target-only providers
 * @property {(ref: SessionRef) => Promise<Message[]>} [readSession]
 * @property {HandoffTarget} [target]
 * @property {{terminal?: (prompt: string, quote: (s: string) => string) => string, vscodeCommand?: string}} [launch]
 */

module.exports = {};
