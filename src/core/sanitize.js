// @ts-check
// Everything CarryContext writes or sends to an LLM goes through sanitize(). Add a step with
// registerSanitizer(); each step gets the text and returns it cleaned, plus what it found.
const { shortenPaths } = require('./util');
const { redactSecrets } = require('../security/secrets');

/**
 * @typedef {Object} SanitizeContext
 * @property {string} cwd
 * @property {{enabled?: boolean, extraPatterns?: string[]}} [redact]
 *
 * @typedef {(text: string, ctx: SanitizeContext) => {text: string, found?: Record<string, number>}} Sanitizer
 */

/** @type {{id: string, fn: Sanitizer}[]} */
const sanitizers = [
  // Secrets first, so a key inside a path or URL is caught before paths are rewritten.
  {
    id: 'secrets',
    fn: (text, ctx) => (ctx.redact?.enabled === false ? { text } : redactSecrets(text, ctx.redact?.extraPatterns)),
  },
  { id: 'paths', fn: (text, ctx) => ({ text: shortenPaths(text, ctx.cwd) }) },
];

/** @param {string} id @param {Sanitizer} fn */
function registerSanitizer(id, fn) {
  sanitizers.push({ id, fn });
}

/**
 * @param {string} text
 * @param {SanitizeContext} ctx
 * @returns {{text: string, found: Record<string, number>}}
 */
function sanitize(text, ctx) {
  const found = {};
  let out = text;
  for (const { fn } of sanitizers) {
    const r = fn(out, ctx);
    out = r.text;
    for (const [k, v] of Object.entries(r.found || {})) found[k] = (found[k] || 0) + v;
  }
  return { text: out, found };
}

module.exports = { sanitize, registerSanitizer };
