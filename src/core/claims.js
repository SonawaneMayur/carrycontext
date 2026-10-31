// @ts-check
// Verification of what a session claims it did, against git and the session's own recorded
// results. Checkers are a registry: add one with registerClaimChecker(). Nothing here runs
// project code; it only reads git, the file system and the transcript.
const fs = require('fs');
const path = require('path');
const { EDIT_TOOLS, SHELL_TOOLS } = require('./summarize');

/**
 * @typedef {'verified'|'unverified'|'contradicted'} ClaimStatus
 *
 * @typedef {Object} Claim
 * @property {string} label          what was claimed, e.g. "`src/pay.js` edited"
 * @property {ClaimStatus} [status]
 * @property {string} [evidence]     why it got that status
 * @property {string} [next]         a Next steps item for a contradicted claim
 * @property {any} [data]            checker-specific details
 *
 * @typedef {Object} VerifyContext
 * @property {string} cwd
 * @property {ReturnType<typeof import('./git').gitView>} git   null outside git
 *
 * @typedef {Object} ClaimChecker
 * @property {string} id
 * @property {(steps: Step[], ctx: VerifyContext) => Claim[]} extract
 * @property {(claim: Claim, ctx: VerifyContext, steps: Step[]) => {status: ClaimStatus, evidence: string, next?: string}} verify
 *
 * A tool call or assistant reply in session order, with its position.
 * @typedef {{seq: number, ts?: string, call?: import('../providers/types').ToolCall, text?: string}} Step
 */

const MAX_CLAIMS = 40;
const ORDER = { contradicted: 0, unverified: 1, verified: 2 };

/** Flatten messages into ordered steps, so checkers can ask "did X happen after Y?". */
function toSteps(messages) {
  const steps = [];
  let seq = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.text) steps.push({ seq: seq++, ts: m.ts, text: m.text });
    for (const call of m.tools || []) steps.push({ seq: seq++, ts: m.ts, call });
  }
  return steps;
}

const clock = (ts) => (ts ? new Date(ts).toISOString().slice(11, 16) : 'an unknown time');

/** Files a tool call wrote. Failed calls wrote nothing. */
function editedFiles(call) {
  if (!call || call.ok === false || !EDIT_TOOLS.test(call.name)) return [];
  const input = call.input || {};
  const files = [input.file_path, input.notebook_path, input.path, input.absolute_path].filter(Boolean);
  const patch = typeof input === 'string' ? input : input.input || input.raw || input.patch || '';
  for (const m of String(patch).matchAll(/\*\*\* (Update|Add) File: (.+)/g)) files.push(m[2].trim());
  return files;
}

/** @type {ClaimChecker[]} */
const checkers = [
  {
    id: 'file-edits',
    extract(steps, ctx) {
      const last = new Map(); // relative path -> step of its last edit
      for (const step of steps) {
        for (const f of editedFiles(step.call)) {
          const rel = ctx.git ? ctx.git.relative(f) : path.relative(ctx.cwd, path.resolve(ctx.cwd, f)).split(path.sep).join('/');
          if (rel && !rel.startsWith('..') && !rel.startsWith('.carrycontext/')) last.set(rel, step);
        }
      }
      return [...last].map(([rel, step]) => ({ label: `\`${rel}\` edited`, data: { rel, ts: step.ts } }));
    },
    verify(claim, ctx) {
      const { rel, ts } = claim.data;
      const full = path.join(ctx.git ? ctx.git.root : ctx.cwd, rel);
      const exists = fs.existsSync(full);
      const missing = { status: 'contradicted', evidence: "reported as edited, but the file doesn't exist", next: `Check \`${rel}\`: the session reported editing it, but it doesn't exist.` };
      if (ctx.git) {
        const change = ctx.git.changeOf(rel);
        if (change) return { status: 'verified', evidence: change };
        if (!exists) return missing;
        if (ctx.git.isIgnored(rel)) return { status: 'verified', evidence: "file exists (ignored by git, so changes can't be compared)" };
        // Committed after the edit, possibly many commits ago. A minute of slack for clock skew.
        const sha = ts && ctx.git.committedSince(rel, new Date(Date.parse(ts) - 60000).toISOString());
        if (sha) return { status: 'verified', evidence: `committed after the edit (\`${sha}\`)` };
        return { status: 'unverified', evidence: 'git shows no change: committed earlier, or reverted?' };
      }
      if (!exists) return missing;
      const modified = fs.statSync(full).mtimeMs;
      // A few seconds of slack: the transcript timestamp is written just after the edit.
      if (!ts || modified >= Date.parse(ts) - 5000) return { status: 'verified', evidence: 'file was modified at or after the edit' };
      return { status: 'unverified', evidence: 'file has not changed since before the edit' };
    },
  },

  {
    id: 'test-and-build-runs',
    extract(steps) {
      const last = new Map(); // test or build name -> its last run
      for (const step of steps) {
        const call = step.call;
        if (!call || !SHELL_TOOLS.test(call.name)) continue;
        const raw = call.input?.command ?? call.input?.cmd;
        const run = testOrBuild(Array.isArray(raw) ? raw.join(' ') : String(raw || ''));
        if (run) last.set(run.name, { label: `\`${run.name}\``, data: { kind: run.kind, step } });
      }
      return [...last.values()];
    },
    verify(claim, ctx, steps) {
      const { kind, step } = claim.data;
      const name = claim.label;
      const at = clock(step.ts);
      if (step.call.ok === undefined) return { status: 'unverified', evidence: `${kind} ran at ${at}; no result recorded` };
      if (step.call.ok === false) {
        const code = step.call.exitCode !== undefined ? ` (exit ${step.call.exitCode})` : '';
        return { status: 'contradicted', evidence: `last run failed${code} at ${at}`, next: `Fix the failing ${kind}: ${name} failed${code} on its last run.` };
      }
      const editsAfter = new Set(steps.filter((s) => s.seq > step.seq).flatMap((s) => editedFiles(s.call)));
      if (editsAfter.size) {
        return { status: 'unverified', evidence: `passed at ${at}, but ${editsAfter.size} file${editsAfter.size === 1 ? ' was' : 's were'} edited afterwards` };
      }
      return { status: 'verified', evidence: `passed at ${at}; nothing edited since` };
    },
  },

  {
    id: 'mentioned-commits',
    extract(steps, ctx) {
      if (!ctx.git) return [];
      const shas = new Set();
      for (const step of steps) {
        for (const m of (step.text || '').matchAll(/\bcommit(?:ted|s)?\b[^.\n]{0,40}?`?\b([0-9a-f]{7,40})\b/gi)) shas.add(m[1]);
      }
      return [...shas].slice(0, 10).map((sha) => ({ label: `commit \`${sha}\``, data: { sha } }));
    },
    verify(claim, ctx) {
      if (ctx.git?.commitExists(claim.data.sha)) return { status: 'verified', evidence: 'exists in this repo' };
      // Weak evidence: the hash may belong to another repo, or be an example.
      return { status: 'unverified', evidence: 'not in this repo (from another repo, or an example?)' };
    },
  },
];

// Matched against one simple command (see simpleCommands), from its start; group 1 names it.
const TEST_COMMAND =
  /^(?:\S*\/)?((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?|(?:uv\s+run\s+)?pytest|python3?\s+-m\s+pytest|go\s+test|cargo\s+test|npx\s+(?:jest|vitest|mocha|playwright\s+test)|jest|vitest|mocha|node\s+--test|make\s+(?:test|check)|gradlew?\s+test|mvn\s+test|rspec|phpunit|dotnet\s+test|swift\s+test|tox)\b/;
const BUILD_COMMAND =
  /^(?:\S*\/)?((?:npm|pnpm|yarn|bun)\s+run\s+build(?::[\w-]+)?|tsc(?:\s+-[-\w]+)*|cargo\s+build|go\s+build|gradlew?\s+build|mvn\s+(?:package|install)|swift\s+build|dotnet\s+build)\b/;
// Node's test runner from any Node binary: `node --test`, `"$NODE" --test`, `node --experimental-test-coverage --test`.
const NODE_TEST = /^(?:(?:\S*\/)?node(?:js)?|""|\$\{?\w+\}?)\s+(?:--[\w-]+(?:=\S+)?\s+)*--test(?=\s|$)/;

/**
 * The simple commands a shell line runs, so "npm test" inside a heredoc, a quoted string or a
 * file being written isn't taken for a test run. Quoted text becomes "", and leading variable
 * assignments are dropped: `CI=1 "$NODE" --test x` -> `"" --test x`.
 */
function simpleCommands(line) {
  return line
    .replace(/^(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/, '$2') // bash -lc '…'
    .replace(/^(?:ba|z)?sh\s+-l?c\s+/, '') // Codex's ['bash', '-lc', '…'], joined
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '$3') // heredoc bodies
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""')
    .split(/&&|\|\||[;|&\n()`]/)
    .map((c) => c.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/^(?:time|env|exec|nohup)\s+/, ''))
    .filter(Boolean);
}

/** The test or build a shell line runs, e.g. {kind: 'test', name: 'npm test'}, or null. A test wins over a build. */
function testOrBuild(line) {
  const commands = simpleCommands(line);
  for (const c of commands) {
    if (NODE_TEST.test(c)) return { kind: 'test', name: 'node --test' };
    const test = c.match(TEST_COMMAND);
    if (test) return { kind: 'test', name: test[1] };
  }
  for (const c of commands) {
    const build = c.match(BUILD_COMMAND);
    if (build) return { kind: 'build', name: build[1] };
  }
  return null;
}

/** @param {ClaimChecker} checker */
function registerClaimChecker(checker) {
  checkers.push(checker);
}

const listClaimCheckers = () => [...checkers];

/**
 * Extract and verify every claim in a session.
 * @param {import('../providers/types').Message[]} messages
 * @param {VerifyContext} ctx
 * @returns {Claim[]} contradicted first, then unverified, then verified
 */
function verifyClaims(messages, ctx) {
  const steps = toSteps(messages);
  const claims = [];
  for (const checker of checkers) {
    for (const claim of checker.extract(steps, ctx)) claims.push({ ...claim, ...checker.verify(claim, ctx, steps) });
  }
  return claims.sort((a, b) => ORDER[a.status] - ORDER[b.status]).slice(0, MAX_CLAIMS);
}

function countClaims(claims) {
  const counts = { verified: 0, unverified: 0, contradicted: 0 };
  for (const c of claims) counts[c.status]++;
  return counts;
}

const ICONS = { verified: '✅', unverified: '⚠️', contradicted: '❌' };
const SHOWN = 15;

/** Markdown for the Verification section, or '' when there is nothing to check. */
function renderClaims(claims) {
  if (!claims.length) return '';
  const lines = claims.slice(0, SHOWN).map((c) => `- ${ICONS[c.status]} ${c.label}: ${c.evidence}`);
  if (claims.length > SHOWN) lines.push(`- … ${claims.length - SHOWN} more`);
  return `_Checked against git and the session's recorded results when this handoff was written._\n\n${lines.join('\n')}`;
}

const summaryLine = (counts) => `${counts.verified} verified, ${counts.unverified} unverified, ${counts.contradicted} contradicted`;

module.exports = { registerClaimChecker, listClaimCheckers, verifyClaims, countClaims, renderClaims, summaryLine, testOrBuild, TEST_COMMAND, BUILD_COMMAND };
