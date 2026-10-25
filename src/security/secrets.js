// @ts-check
// Secret detection and redaction. Patterns are a registry: add one with registerSecretPattern().
// Keep patterns specific (known token formats) so ordinary text isn't redacted.

/**
 * @typedef {Object} SecretPattern
 * @property {string} id            short name shown in the redaction marker, e.g. "github-token"
 * @property {RegExp} regex         must have the g flag
 * @property {(match: string, ...groups: string[]) => string} [replace]  keep parts of the match (e.g. a key name)
 */

const marker = (id) => `[REDACTED:${id}]`;

// Values that are obviously placeholders, not real secrets.
const PLACEHOLDER = /^(?:\$\{?[A-Z_]+\}?|<[^>]+>|x{4,}|\*{4,}|your[-_].*|changeme|example.*|\[REDACTED:[^\]]+\])$/i;

/** @type {SecretPattern[]} */
const patterns = [
  { id: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', regex: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack-token', regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-key', regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'url-credentials',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replace: (m, scheme, user, pass) => (PLACEHOLDER.test(pass) ? m : `${scheme}${user}:${marker('url-credentials')}@`),
  },
  {
    // password = "...", API_KEY: ..., client_secret=... (keeps the name, hides the value)
    id: 'secret-assignment',
    regex: /\b((?:[A-Z0-9_]*_)?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b["']?\s*[:=]\s*)(["']?)([^\s"'`,;)]{8,})\2/gi,
    replace: (m, prefix, quote, value) => (PLACEHOLDER.test(value) ? m : `${prefix}${quote}${marker('secret')}${quote}`),
  },
];

/** @param {SecretPattern} pattern */
function registerSecretPattern(pattern) {
  if (!pattern.regex.global) throw new Error(`Secret pattern "${pattern.id}" needs the g flag`);
  patterns.push(pattern);
}

const listSecretPatterns = () => [...patterns];

/**
 * Replace secrets in text with [REDACTED:<id>] markers.
 * @param {string} text
 * @param {string[]} [extra]  additional regex sources from user settings
 * @returns {{text: string, found: Record<string, number>}}
 */
function redactSecrets(text, extra = []) {
  const found = {};
  const all = [...patterns, ...extra.map((source, i) => ({ id: `custom-${i + 1}`, regex: toRegex(source) })).filter((p) => p.regex)];
  let out = text;
  for (const p of all) {
    out = out.replace(p.regex, (...args) => {
      const match = args[0];
      const replaced = p.replace ? p.replace(...args) : marker(p.id);
      if (replaced !== match) found[p.id] = (found[p.id] || 0) + 1;
      return replaced;
    });
  }
  return { text: out, found };
}

function toRegex(source) {
  try {
    return new RegExp(source, 'g');
  } catch {
    return null; // an invalid user pattern must not break handoffs
  }
}

module.exports = { registerSecretPattern, listSecretPatterns, redactSecrets };
