const test = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('./helpers/env');
const { startMockLlm, MOCK_BASE_PATHS } = require('./helpers/mockLlm');

const env = sandbox();
const fs = require('fs');
const path = require('path');
const { listLlms, getLlm, registerLlm } = require('../src/llm');
test.after(() => env.cleanup());

// Clients that run on this machine (no HTTP) are tested in their own file instead.
for (const llm of listLlms().filter((l) => l.local)) {
  test(`contract: local client ${llm.id} has its own test file`, () => {
    assert.ok(fs.existsSync(path.join(__dirname, `${llm.id}.test.js`)), `add test/${llm.id}.test.js`);
  });
}

// Contract: every registered HTTP summarizer client must work against the mock server.
for (const llm of listLlms().filter((l) => !l.local)) {
  test(`contract: ${llm.id} sends system + prompt and returns the reply`, async () => {
    assert.ok(llm.id in MOCK_BASE_PATHS, `add a base path for "${llm.id}" to test/helpers/mockLlm.js`);
    const mock = await startMockLlm({ reply: 'hello from mock' });
    try {
      const text = await llm.complete({
        model: llm.defaultModel || 'test-model',
        baseUrl: mock.url + MOCK_BASE_PATHS[llm.id],
        apiKey: 'test-key',
        system: 'SYSTEM-MARKER',
        prompt: 'PROMPT-MARKER',
      });
      assert.equal(text, 'hello from mock');
      assert.equal(mock.requests.length, 1);
      const sent = JSON.stringify(mock.requests[0].body);
      assert.match(sent, /SYSTEM-MARKER/);
      assert.match(sent, /PROMPT-MARKER/);
      if (llm.needsKey) {
        const h = mock.requests[0].headers;
        assert.ok(h['x-api-key'] === 'test-key' || h['x-goog-api-key'] === 'test-key' || h.authorization === 'Bearer test-key', 'sends the key');
      }
    } finally {
      await mock.close();
    }
  });

  test(`contract: ${llm.id} turns an HTTP error into an exception`, async () => {
    const mock = await startMockLlm({ status: 500 });
    try {
      await assert.rejects(
        llm.complete({ model: 'm', baseUrl: mock.url + MOCK_BASE_PATHS[llm.id], apiKey: 'k', system: 's', prompt: 'p' }),
        /500/,
      );
    } finally {
      await mock.close();
    }
  });
}

test('openai-compatible requires a base URL', async () => {
  await assert.rejects(getLlm('openai-compatible').complete({ model: 'm', system: 's', prompt: 'p' }), /baseUrl is required/);
});

test('registerLlm adds a client', async () => {
  registerLlm('echo', { label: 'Echo', defaultModel: 'e', complete: async (a) => a.prompt });
  assert.equal(await getLlm('echo').complete({ model: 'e', system: '', prompt: 'ping' }), 'ping');
});
