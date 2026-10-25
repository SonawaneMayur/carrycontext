// A local HTTP server that speaks each summarizer API closely enough for tests.
// To cover a new LLM client in the contract tests, add its base URL to MOCK_BASE_PATHS
// and, if its API shape is new, a branch in respond().
const http = require('http');

/** client id -> path appended to the mock server URL to form that client's baseUrl. */
const MOCK_BASE_PATHS = {
  anthropic: '',
  openai: '/v1',
  gemini: '/v1beta',
  ollama: '',
  'openai-compatible': '/v1',
};

function respond(url, text) {
  if (url.endsWith('/v1/messages')) return { content: [{ type: 'text', text }] };
  if (url.endsWith('/chat/completions')) return { choices: [{ message: { content: text } }] };
  if (url.includes(':generateContent')) return { candidates: [{ content: { parts: [{ text }] } }] };
  if (url.endsWith('/api/chat')) return { message: { content: text } };
  return null;
}

/**
 * @param {{reply?: string | ((n: number) => string), status?: number}} [opts]
 * @returns {Promise<{url: string, requests: {url: string, headers: any, body: any}[], close: () => Promise<void>}>}
 */
function startMockLlm({ reply = '## Short description\nMock work\n\n## Goal\nMock goal\n\n## Next steps\n- Mock step', status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ url: req.url, headers: req.headers, body });
      const text = typeof reply === 'function' ? reply(requests.length) : reply;
      const payload = respond(req.url || '', text);
      res.setHeader('content-type', 'application/json');
      if (status !== 200 || !payload) {
        res.statusCode = payload ? status : 404;
        return res.end(JSON.stringify({ error: 'mock error' }));
      }
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (server.address());
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** Everything the summarizer sent, as one string, for leak checks. */
const sentText = (requests) => requests.map((r) => JSON.stringify(r.body)).join('\n');

module.exports = { startMockLlm, MOCK_BASE_PATHS, sentText };
