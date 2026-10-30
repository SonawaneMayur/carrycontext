// @ts-check
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, writeFile } = require('./util');

/**
 * @typedef {Object} Config
 * @property {{provider: string, model: string, baseUrl: string}} summarizer
 * @property {string[]} sources   providers whose transcripts are read
 * @property {string[]} targets   providers that receive a copy of handoff.md
 * @property {number} lookbackHours
 * @property {number} handoffLimit   versions of each session's handoff kept in .carrycontext/handoffs
 * @property {number} maxTranscriptChars
 * @property {{enabled: boolean, idleSeconds: number}} autoUpdate
 * @property {{enabled: boolean, extraPatterns: string[]}} redact   secret redaction (see src/security/secrets.js)
 * @property {{enabled: boolean}} verify   check the session's claims against git and recorded results
 * @property {{showCost: boolean, prices: Record<string, Price>}} usage   token stats (see src/core/usage.js)
 *
 * $ per million tokens for one model. Cache writes default to 1.25x input (5-minute) and 2x (1-hour).
 * @typedef {{input: number, output: number, cacheRead: number, cacheWrite5m?: number, cacheWrite1h?: number}} Price
 */

/** @type {Config} */
const DEFAULTS = {
  summarizer: { provider: 'none', model: '', baseUrl: '' },
  sources: ['claude', 'codex', 'gemini'],
  targets: ['claude', 'codex', 'gemini'],
  lookbackHours: 24,
  handoffLimit: 50,
  maxTranscriptChars: 150000,
  autoUpdate: { enabled: true, idleSeconds: 120 },
  redact: { enabled: true, extraPatterns: [] },
  verify: { enabled: true },
  usage: { showCost: true, prices: {} },
};

/**
 * Settings that decide where conversation data is sent, how much, and whether secrets are
 * redacted. Only the user can set them: in VS Code they are machine-scoped (a repo's
 * .vscode/settings.json is ignored), and the CLI reads them from the per-user config file,
 * never from a project's .carrycontext/config.json. Otherwise a cloned repo could redirect
 * summaries, and the API key sent with them, to its own server.
 */
const USER_ONLY = ['summarizer', 'redact', 'maxTranscriptChars'];

const dataDir = (cwd) => path.join(cwd, '.carrycontext');
const configPath = (cwd) => path.join(dataDir(cwd), 'config.json');

/** Per-user config file, outside every project. */
function userConfigPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'carrycontext', 'config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'carrycontext', 'config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'carrycontext', 'config.json');
}

const pick = (obj, keep) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keep(k)));
const isUserOnly = (k) => USER_ONLY.includes(k);

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
const strings = (value, fallback) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : fallback);

/**
 * Fill in defaults and keep values in safe ranges, whoever wrote them. For example a
 * handoffLimit of 0 would otherwise delete every saved handoff.
 * @returns {Config}
 */
function normalizeConfig(raw) {
  const c = raw || {};
  return {
    summarizer: { ...DEFAULTS.summarizer, ...(c.summarizer || {}) },
    sources: strings(c.sources, DEFAULTS.sources),
    targets: strings(c.targets, DEFAULTS.targets),
    lookbackHours: clamp(c.lookbackHours, 1, 24 * 90, DEFAULTS.lookbackHours),
    handoffLimit: clamp(c.handoffLimit, 1, 1000, DEFAULTS.handoffLimit),
    maxTranscriptChars: clamp(c.maxTranscriptChars, 2000, 1000000, DEFAULTS.maxTranscriptChars),
    autoUpdate: {
      enabled: c.autoUpdate?.enabled !== false,
      idleSeconds: clamp(c.autoUpdate?.idleSeconds, 15, 86400, DEFAULTS.autoUpdate.idleSeconds),
    },
    redact: { enabled: c.redact?.enabled !== false, extraPatterns: strings(c.redact?.extraPatterns, []) },
    verify: { enabled: c.verify?.enabled !== false },
    usage: { showCost: c.usage?.showCost !== false, prices: prices(c.usage?.prices) },
  };
}

const rate = (v) => Number.isFinite(v) && v >= 0;

/** Price overrides by model id, numbers only; anything malformed is dropped. */
function prices(value) {
  /** @type {Record<string, Price>} */
  const out = {};
  for (const [model, p] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (!/^[a-z0-9][\w.:@-]*$/i.test(model) || !p || !rate(p.input) || !rate(p.output)) continue;
    out[model] = { input: p.input, output: p.output, cacheRead: rate(p.cacheRead) ? p.cacheRead : p.input / 10 };
    if (rate(p.cacheWrite5m)) out[model].cacheWrite5m = p.cacheWrite5m;
    if (rate(p.cacheWrite1h)) out[model].cacheWrite1h = p.cacheWrite1h;
  }
  return out;
}

/** Config shared by the extension and the CLI (hooks). Never holds API keys. */
function loadConfig(cwd) {
  const project = pick(readJson(configPath(cwd), {}), (k) => !isUserOnly(k));
  const user = pick(readJson(userConfigPath(), {}), isUserOnly);
  return normalizeConfig({ ...project, ...user });
}

/**
 * User-only settings in the project's config.json that differ from the user's own, i.e.
 * ones a project tried to change. They are ignored; callers can warn about them.
 */
function ignoredProjectSettings(cwd) {
  const project = pick(readJson(configPath(cwd), {}), isUserOnly);
  const effective = loadConfig(cwd);
  return Object.keys(project).filter((k) => JSON.stringify(normalizeConfig({ ...effective, [k]: project[k] })[k]) !== JSON.stringify(effective[k]));
}

/** Write project settings to the project and user-only settings to the per-user file. */
function saveConfig(cwd, config) {
  writeFile(configPath(cwd), JSON.stringify(pick(config, (k) => !isUserOnly(k)), null, 2) + '\n');
  saveUserConfig(pick(config, isUserOnly));
}

function saveUserConfig(values) {
  const file = userConfigPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFile(file, JSON.stringify(values, null, 2) + '\n');
  if (process.platform !== 'win32') {
    // mkdir's mode only applies to a new folder, so tighten an existing one too.
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
  }
}

module.exports = { DEFAULTS, USER_ONLY, loadConfig, saveConfig, normalizeConfig, ignoredProjectSettings, userConfigPath, dataDir };
