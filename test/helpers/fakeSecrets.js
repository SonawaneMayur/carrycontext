// Fake credentials in real token formats, assembled at runtime so no literal that looks like a
// live secret is ever committed (GitHub push protection and secret scanners would flag it).
const rep = (ch, n) => ch.repeat(n);

const FAKE_SECRETS = {
  'anthropic-key': ['sk', 'ant', 'api03', rep('A', 40)].join('-'),
  'openai-key': ['sk', 'proj', rep('B', 40)].join('-'),
  'github-token': ['ghp', rep('C', 36)].join('_'),
  'aws-access-key': 'AKIA' + rep('D', 16),
  'google-api-key': 'AIza' + rep('E', 35),
  'slack-token': ['xoxb', '1234567890', rep('F', 20)].join('-'),
  'stripe-key': ['sk', 'live', rep('G', 24)].join('_'),
  jwt: ['eyJ' + rep('H', 20), rep('I', 20), rep('J', 20)].join('.'),
  'private-key': ['-----BEGIN RSA PRIVATE KEY-----', rep('K', 64), '-----END RSA PRIVATE KEY-----'].join('\n'),
};

module.exports = { FAKE_SECRETS };
