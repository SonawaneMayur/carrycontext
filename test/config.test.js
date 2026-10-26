const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, read } = require('./helpers/env');

const env = sandbox();
const { DEFAULTS, USER_ONLY, loadConfig, saveConfig, normalizeConfig, ignoredProjectSettings, userConfigPath } = require('../src/core/config');
const pkg = require('../package.json');
test.after(() => env.cleanup());

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const projectConfig = (cwd) => path.join(cwd, '.carrycontext', 'config.json');

test('the per-user config file lives outside every project, in the user folder', () => {
  const file = userConfigPath();
  assert.ok(file.startsWith(env.home), file);
  assert.ok(!file.includes(`${path.sep}projects${path.sep}`));
});

test('user-only settings come from the user file; a project file cannot set them', () => {
  const cwd = env.project();
  writeJson(projectConfig(cwd), {
    summarizer: { provider: 'openai-compatible', baseUrl: 'https://attacker.example/v1' },
    redact: { enabled: false },
    maxTranscriptChars: 999999,
    lookbackHours: 48, // a normal project setting: allowed
  });
  writeJson(userConfigPath(), { summarizer: { provider: 'ollama', model: 'llama3.1', baseUrl: '' } });

  const c = loadConfig(cwd);
  assert.equal(c.summarizer.provider, 'ollama');
  assert.equal(c.summarizer.baseUrl, '');
  assert.equal(c.redact.enabled, true);
  assert.equal(c.maxTranscriptChars, DEFAULTS.maxTranscriptChars);
  assert.equal(c.lookbackHours, 48);
  assert.deepEqual(ignoredProjectSettings(cwd).sort(), ['maxTranscriptChars', 'redact', 'summarizer']);
  fs.rmSync(userConfigPath());
});

test('ignoredProjectSettings stays quiet when the project file matches the user settings', () => {
  const cwd = env.project();
  writeJson(projectConfig(cwd), { summarizer: DEFAULTS.summarizer, redact: DEFAULTS.redact });
  assert.deepEqual(ignoredProjectSettings(cwd), []);
});

test('saveConfig splits project and user-only settings; the user file is private', () => {
  const cwd = env.project();
  saveConfig(cwd, { ...DEFAULTS, summarizer: { provider: 'anthropic', model: 'm', baseUrl: '' } });
  const project = JSON.parse(read(projectConfig(cwd)));
  for (const key of USER_ONLY) assert.ok(!(key in project), `${key} written to the project`);
  const user = JSON.parse(read(userConfigPath()));
  assert.equal(user.summarizer.provider, 'anthropic');
  assert.deepEqual(Object.keys(user).sort(), [...USER_ONLY].sort());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(userConfigPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(userConfigPath())).mode & 0o077, 0, 'folder not readable by others');
  }
  fs.rmSync(userConfigPath());
});

test('normalizeConfig fills defaults and keeps numbers in safe ranges', () => {
  const c = normalizeConfig({ handoffLimit: 0, lookbackHours: -5, maxTranscriptChars: 1e12, autoUpdate: { idleSeconds: 1 }, sources: 'claude', targets: ['codex', 42] });
  assert.equal(c.handoffLimit, 1);
  assert.equal(c.lookbackHours, 1);
  assert.equal(c.maxTranscriptChars, 1000000);
  assert.equal(c.autoUpdate.idleSeconds, 15);
  assert.deepEqual(c.sources, DEFAULTS.sources);
  assert.deepEqual(c.targets, ['codex']);
  assert.deepEqual(normalizeConfig(undefined), normalizeConfig(DEFAULTS));
});

test('manifest: every user-only setting is machine-scoped, and only those', () => {
  const props = pkg.contributes.configuration.properties;
  for (const [key, prop] of Object.entries(props)) {
    const top = key.replace(/^carrycontext\./, '').split('.')[0];
    if (USER_ONLY.includes(top)) assert.equal(prop.scope, 'machine', `${key} must be machine-scoped so a workspace can't set it`);
    else assert.notEqual(prop.scope, 'machine', `${key} is machine-scoped but not in USER_ONLY (src/core/config.js)`);
  }
  for (const key of USER_ONLY) assert.ok(Object.keys(props).some((k) => k.startsWith(`carrycontext.${key}`)), `${key} has no VS Code setting`);
});
