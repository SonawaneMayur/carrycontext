// @ts-check
// Pluggable LLM clients used to write the handoff summary.
// Add a provider with registerLlm(id, { defaultModel, envKey, complete }).

/**
 * @typedef {Object} CompleteArgs
 * @property {string} model
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {string} system
 * @property {string} prompt
 * @property {number} [maxTokens]
 *
 * @typedef {Object} LlmClient
 * @property {string} label
 * @property {string} defaultModel
 * @property {string} [envKey]      env var holding the API key (used by the CLI/hooks)
 * @property {boolean} [needsKey]
 * @property {(args: CompleteArgs) => Promise<string>} complete
 */

const TIMEOUT_MS = 120000;

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Only https, or plain http to this machine (Ollama, LM Studio), and never credentials in the
 * URL. Checked before every request, so a bad URL fails before any data leaves.
 */
function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The summarizer URL is not a valid URL');
  }
  if (url.username || url.password) throw new Error('The summarizer URL must not contain a username or password');
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.test(url.hostname))) return;
  throw new Error(`Refusing to send data to ${url.protocol}//${url.hostname}: use https, or a server on localhost`);
}

async function postJson(url, headers, body) {
  assertSafeUrl(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/** @param {CompleteArgs} a */
async function openAiChat(a, defaultBase) {
  const base = (a.baseUrl || defaultBase).replace(/\/$/, '');
  const data = await postJson(
    `${base}/chat/completions`,
    a.apiKey ? { authorization: `Bearer ${a.apiKey}` } : {},
    {
      model: a.model,
      messages: [
        { role: 'system', content: a.system },
        { role: 'user', content: a.prompt },
      ],
    },
  );
  return data.choices?.[0]?.message?.content || '';
}

/** @type {Record<string, LlmClient>} */
const clients = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-5-5',
    envKey: 'ANTHROPIC_API_KEY',
    needsKey: true,
    async complete(a) {
      const base = (a.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
      const data = await postJson(
        `${base}/v1/messages`,
        { 'x-api-key': a.apiKey || '', 'anthropic-version': '2023-06-01' },
        {
          model: a.model,
          max_tokens: a.maxTokens || 8000,
          system: a.system,
          messages: [{ role: 'user', content: a.prompt }],
        },
      );
      return (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5',
    envKey: 'OPENAI_API_KEY',
    needsKey: true,
    complete: (a) => openAiChat(a, 'https://api.openai.com/v1'),
  },
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-pro',
    envKey: 'GEMINI_API_KEY',
    needsKey: true,
    async complete(a) {
      const base = (a.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const data = await postJson(
        `${base}/models/${encodeURIComponent(a.model)}:generateContent`,
        { 'x-goog-api-key': a.apiKey || '' },
        {
          systemInstruction: { parts: [{ text: a.system }] },
          contents: [{ role: 'user', parts: [{ text: a.prompt }] }],
        },
      );
      return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    },
  },
  ollama: {
    label: 'Ollama (local)',
    defaultModel: 'llama3.1',
    async complete(a) {
      const base = (a.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const data = await postJson(`${base}/api/chat`, {}, {
        model: a.model,
        stream: false,
        messages: [
          { role: 'system', content: a.system },
          { role: 'user', content: a.prompt },
        ],
      });
      return data.message?.content || '';
    },
  },
  'openai-compatible': {
    label: 'OpenAI-compatible (OpenRouter, Groq, Mistral, LM Studio, ...)',
    defaultModel: '',
    envKey: 'OPENAI_COMPATIBLE_API_KEY',
    async complete(a) {
      if (!a.baseUrl) throw new Error('carrycontext.summarizer.baseUrl is required for openai-compatible');
      return openAiChat(a, a.baseUrl);
    },
  },
};

/** @param {string} id @param {LlmClient} client */
function registerLlm(id, client) {
  clients[id] = client;
}

function getLlm(id) {
  return clients[id];
}

function listLlms() {
  return Object.entries(clients).map(([id, c]) => ({ id, ...c }));
}

module.exports = { registerLlm, getLlm, listLlms, assertSafeUrl };
