// @ts-check
const path = require('path');
const { readJson, writeFile } = require('./util');

/**
 * @typedef {Object} Config
 * @property {{provider: string, model: string, baseUrl: string}} summarizer
 * @property {string[]} sources   providers whose transcripts are read
 * @property {string[]} targets   providers that receive a copy of handoff.md
 * @property {number} lookbackHours
 * @property {number} handoffLimit   named handoff files kept in .carrycontext/handoffs
 * @property {number} maxTranscriptChars
 * @property {{enabled: boolean, idleSeconds: number}} autoUpdate
 * @property {{enabled: boolean, extraPatterns: string[]}} redact   secret redaction (see src/security/secrets.js)
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
};

const dataDir = (cwd) => path.join(cwd, '.carrycontext');
const configPath = (cwd) => path.join(dataDir(cwd), 'config.json');

/** Config shared by the extension and the CLI (hooks). Never holds API keys. */
function loadConfig(cwd) {
  const file = readJson(configPath(cwd), {});
  return {
    ...DEFAULTS,
    ...file,
    summarizer: { ...DEFAULTS.summarizer, ...(file.summarizer || {}) },
    autoUpdate: { ...DEFAULTS.autoUpdate, ...(file.autoUpdate || {}) },
    redact: { ...DEFAULTS.redact, ...(file.redact || {}) },
  };
}

function saveConfig(cwd, config) {
  writeFile(configPath(cwd), JSON.stringify(config, null, 2) + '\n');
}

module.exports = { DEFAULTS, loadConfig, saveConfig, dataDir };
