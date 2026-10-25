const test = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/env');
const { FAKE_SECRETS } = require('./helpers/fakeSecrets');

const env = sandbox();
const { redactSecrets, registerSecretPattern, listSecretPatterns } = require('../src/security/secrets');
const { sanitize, registerSanitizer } = require('../src/core/sanitize');
test.after(() => env.cleanup());

for (const [id, secret] of Object.entries(FAKE_SECRETS)) {
  test(`redacts ${id}`, () => {
    const { text, found } = redactSecrets(`before ${secret} after`);
    assert.ok(!text.includes(secret), `${id} leaked: ${text}`);
    assert.match(text, new RegExp(`\\[REDACTED:${id}\\]`));
    assert.equal(found[id], 1);
    assert.match(text, /^before .* after$/);
  });
}

test('every built-in pattern has a fake secret in the test fixtures', () => {
  const generic = new Set(['url-credentials', 'secret-assignment']);
  for (const p of listSecretPatterns()) {
    if (!generic.has(p.id)) assert.ok(FAKE_SECRETS[p.id], `add a FAKE_SECRETS entry for "${p.id}"`);
  }
});

test('keeps the name in assignments and URLs, hides only the value', () => {
  const { text } = redactSecrets('DB_PASSWORD="hunter2hunter2" and postgres://admin:s3cretpass@db.local/app');
  assert.equal(text, 'DB_PASSWORD="[REDACTED:secret]" and postgres://admin:[REDACTED:url-credentials]@db.local/app');
});

test('leaves ordinary text, short values and placeholders alone', () => {
  const samples = [
    'Set the token in your shell before running.',
    'password: ${DB_PASSWORD}',
    'api_key=<your-key-here>',
    'token = xxxxxxxx',
    'skip-navigation and sk-short are fine',
    'https://example.com/path@v2',
  ];
  for (const sample of samples) assert.equal(redactSecrets(sample).text, sample, sample);
});

test('extra user patterns are applied; invalid ones are ignored', () => {
  const { text, found } = redactSecrets('internal ACME-123456 token', ['ACME-\\d{6}', '([unclosed']);
  assert.equal(text, 'internal [REDACTED:custom-1] token');
  assert.equal(found['custom-1'], 1);
});

test('registerSecretPattern requires the global flag', () => {
  assert.throws(() => registerSecretPattern({ id: 'bad', regex: /x/ }), /g flag/);
  registerSecretPattern({ id: 'acme-id', regex: /\bACMEID\d{4}\b/g });
  assert.equal(redactSecrets('see ACMEID1234').text, 'see [REDACTED:acme-id]');
});

test('sanitize runs secrets then paths, and redaction can be turned off', () => {
  const cwd = `${env.home}/projects/app`;
  const input = `${cwd}/a.js uses ${FAKE_SECRETS['github-token']}`;
  assert.equal(sanitize(input, { cwd }).text, './a.js uses [REDACTED:github-token]');
  assert.equal(sanitize(input, { cwd, redact: { enabled: false } }).text, `./a.js uses ${FAKE_SECRETS['github-token']}`);
});

test('registerSanitizer adds a step to the pipeline', () => {
  registerSanitizer('shout', (text) => ({ text: text.replace(/secret-word/g, '[HIDDEN]'), found: { shout: 1 } }));
  const r = sanitize('a secret-word here', { cwd: '/x' });
  assert.equal(r.text, 'a [HIDDEN] here');
  assert.equal(r.found.shout, 1);
});
