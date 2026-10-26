// @ts-check
// Apple's on-device model (Apple Intelligence) through a small Swift helper.
//
// Security, in order of importance:
// - The helper always runs inside a macOS sandbox with no network access, no file writes and
//   no reads in the home folder, and with an empty environment (so API keys in your shell never
//   reach it). If the sandbox can't be applied, CarryContext refuses to run it. It never runs
//   unprotected.
// - Prompts go through stdin, never the command line, so other programs can't see them in the
//   process list. Errors carry codes and token counts only, never prompt text, and nothing
//   here logs prompts or answers.
// - The helper is built on your Mac from the Swift source shipped with CarryContext, into your
//   private per-user cache folder (owner-only permissions, outside your home folder).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const SOURCE = path.join(__dirname, 'apple', 'CarryContextApple.swift');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const TIMEOUT_MS = Number(process.env.CARRYCONTEXT_APPLE_TIMEOUT_MS) || 90000; // override for tests only
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Verified on macOS 26: the model works inside this profile, while curl, file writes and reads
// of ~/.ssh, ~/Library/Keychains and dotfiles fail. The framework only needs to look up the
// home folder entry itself (metadata), not anything inside it.
const PROFILE =
  '(version 1)(allow default)(deny network*)(deny file-write*)' +
  '(deny file-read* (subpath (param "HOME")))(allow file-read-metadata (literal (param "HOME")))';

/** What to tell the user for each reason the model can't be used. */
const FIXES = {
  platform: 'Needs an Apple-silicon Mac with macOS 26 or later.',
  toolchain: 'Install the Xcode Command Line Tools once (run: xcode-select --install). CarryContext builds a small helper with them.',
  sandbox: "macOS's sandbox tool (/usr/bin/sandbox-exec) is missing, so CarryContext won't run the helper unprotected.",
  cache: "CarryContext's private cache folder is not owned by you or is accessible to others, so the helper won't be built there.",
  build: 'Building the helper failed. Run "carrycontext doctor" for details.',
  deviceNotEligible: "This Mac doesn't support Apple Intelligence.",
  appleIntelligenceNotEnabled: 'Turn on Apple Intelligence in System Settings → Apple Intelligence & Siri.',
  modelNotReady: 'The model is still downloading. Try again later.',
  unavailable: "Apple's on-device model is not available right now.",
};

// The real home folder from the user database, not $HOME, so the sandbox always protects it.
const realHome = () => os.userInfo().homedir;

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

/** Unavailable reason code, or null when this Mac can run the helper at all. */
function platformProblem() {
  if (process.platform !== 'darwin' || Number(os.release().split('.')[0]) < 25) return 'platform'; // Darwin 25 = macOS 26
  if (!fs.existsSync(SANDBOX_EXEC)) return 'sandbox';
  return null;
}

let toolchainCache;
/**
 * The Swift compiler's version, found without triggering macOS's "install developer tools"
 * popup: xcode-select -p only succeeds when the tools are installed. Compiling always goes
 * through xcrun, which also points the compiler at the macOS SDK.
 */
function toolchain() {
  if (toolchainCache !== undefined) return toolchainCache;
  const version = run('/usr/bin/xcode-select', ['-p']) && run('/usr/bin/xcrun', ['swiftc', '--version']);
  toolchainCache = version ? { version: version.split('\n')[0] } : null;
  return toolchainCache;
}

/** Private per-user cache folder outside the home folder, e.g. /var/folders/…/C/carrycontext. */
function cacheDir() {
  if (process.env.CARRYCONTEXT_CACHE_DIR) return process.env.CARRYCONTEXT_CACHE_DIR;
  const base = run('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR']) || os.tmpdir();
  return path.join(base, 'carrycontext');
}

/** Create the cache folder owner-only, and refuse one that is a symlink or not ours. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid?.()) return false;
  fs.chmodSync(dir, 0o700);
  return true;
}

/**
 * Path of the built helper, building it first if needed (about 5 seconds, once per
 * CarryContext version). Throws an Error with .code set to a FIXES key.
 */
function ensureHelper() {
  if (process.env.CARRYCONTEXT_APPLE_HELPER) return process.env.CARRYCONTEXT_APPLE_HELPER; // tests only
  const tools = toolchain();
  if (!tools) throw problem('toolchain');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).update(tools.version).digest('hex').slice(0, 16);
  const dir = cacheDir();
  if (!privateDir(dir)) throw problem('cache');
  const target = path.join(dir, `carrycontext-apple-${hash}`);
  if (fs.existsSync(target)) return target;

  const tmp = `${target}.${process.pid}.tmp`;
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-parse-as-library', SOURCE, '-o', tmp], { stdio: 'pipe', timeout: 180000 });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const err = problem('build');
    err.detail = String(e.stderr || e.message).split('\n').find((l) => /error/.test(l)) || '';
    throw err;
  }
  fs.chmodSync(tmp, 0o700);
  fs.renameSync(tmp, target); // atomic: a parallel build can't leave a half-written helper
  for (const old of fs.readdirSync(dir)) {
    if (old.startsWith('carrycontext-apple-') && old !== path.basename(target)) fs.rmSync(path.join(dir, old), { force: true });
  }
  return target;
}

function problem(code) {
  const err = /** @type {Error & {code?: string, detail?: string, tokens?: number, limit?: number}} */ (new Error(FIXES[code] || FIXES.unavailable));
  err.code = code;
  return err;
}

/**
 * Run the helper inside the sandbox with an empty environment. The request goes in on stdin.
 * @returns {Promise<any>} the helper's JSON response
 */
function runHelper(args, request) {
  const issue = platformProblem();
  if (issue) return Promise.reject(problem(issue));
  let helper;
  try {
    helper = ensureHelper();
  } catch (e) {
    return Promise.reject(e);
  }
  const home = realHome();
  return new Promise((resolve, reject) => {
    const child = spawn(SANDBOX_EXEC, ['-D', `HOME=${home}`, '-p', PROFILE, helper, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Apple model timed out'), { code: 'timeout' }));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > MAX_OUTPUT_BYTES) child.kill('SIGKILL');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`Could not start the Apple model helper: ${e.message}`), { code: 'failed' }));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop() || '';
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(Object.assign(new Error('The Apple model helper returned an unreadable answer'), { code: 'failed' }));
      }
    });
    child.stdin.on('error', () => {}); // the helper may exit before reading everything
    child.stdin.end(request ? JSON.stringify(request) : '');
  });
}

const ERRORS = {
  context: 'The text is too long for the on-device model',
  guardrail: "Apple's on-device model declined this content",
  'unsupported-language': 'The on-device model does not support this language',
  'rate-limited': 'The on-device model is busy; try again shortly',
  busy: 'The on-device model is busy; try again shortly',
  'bad-request': 'CarryContext sent the helper an invalid request',
  'bad-schema': 'CarryContext sent the helper an invalid answer schema',
  failed: 'The on-device model could not answer',
};

function toError(res) {
  if (res.error === 'unavailable') return problem(res.reason || 'unavailable');
  const err = /** @type {Error & {code?: string, tokens?: number, limit?: number}} */ (new Error(ERRORS[res.error] || ERRORS.failed));
  err.code = res.error;
  if (res.error === 'context') Object.assign(err, { tokens: res.tokens, limit: res.limit });
  return err;
}

/**
 * Whether the model can be used right now. Builds the helper if needed, so the first call
 * can take a few seconds.
 * @returns {Promise<{ready: boolean, code?: string, reason?: string, detail?: string, contextSize?: number}>}
 */
async function status() {
  try {
    const res = await runHelper(['--status']);
    if (res.ok && res.available) return { ready: true, contextSize: res.contextSize };
    const code = res.reason || 'unavailable';
    return { ready: false, code, reason: FIXES[code] || FIXES.unavailable };
  } catch (e) {
    return { ready: false, code: e.code, reason: e.message, detail: e.detail };
  }
}

/**
 * A structured answer: the reply is forced to match the JSON-Schema-like `schema`.
 * @param {{system: string, prompt: string, schema: object, maxTokens?: number, temperature?: number}} a
 */
async function completeJson(a) {
  const res = await runHelper([], { system: a.system, prompt: a.prompt, schema: a.schema, maxTokens: a.maxTokens, temperature: a.temperature ?? 0 });
  if (!res.ok) throw toError(res);
  return JSON.parse(res.json);
}

/** @type {import('./index').LlmClient & {completeJson: typeof completeJson}} */
module.exports = {
  label: 'Apple on-device (Apple Intelligence)',
  defaultModel: 'system',
  local: true,
  // 4,096 tokens in total. About 8,000 characters leaves room for instructions and the answer;
  // too-long requests are retried once, shrunk using the token count the model reports.
  contextChars: 8000,
  status,
  completeJson,
  async complete(a) {
    const res = await runHelper([], { system: a.system, prompt: a.prompt, maxTokens: a.maxTokens || 900, temperature: 0.2 });
    if (!res.ok) throw toError(res);
    return res.text;
  },
};
