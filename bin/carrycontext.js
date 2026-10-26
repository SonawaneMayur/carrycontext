#!/usr/bin/env node
// @ts-check
// CarryContext CLI. Claude Code hooks call it, and it also works on its own:
//   carrycontext compact-all | sync | show | prompt <provider> | hook claude --payload FILE
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, ignoredProjectSettings, userConfigPath } = require('../src/core/config');
const { paths, gatherSessions, updateHandoff, activateBranch, syncTargets, resumePrompt } = require('../src/core/handoff');
const { processPayload } = require('../src/core/claudeHooks');
const { readText } = require('../src/core/util');
const { getLlm } = require('../src/llm');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      args[key] = next && !next.startsWith('--') ? argv[++i] : true;
    } else args._.push(argv[i]);
  }
  return args;
}

// The CLI has no access to VS Code's secret storage, so keys come from the environment.
const getApiKey = async (provider) => {
  const env = getLlm(provider)?.envKey;
  return env ? process.env[env] : undefined;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(String(args.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  const config = loadConfig(cwd);
  const ignored = ignoredProjectSettings(cwd);
  if (ignored.length) {
    console.error(`carrycontext: ignored ${ignored.join(', ')} in .carrycontext/config.json; these can only be set in your user config (${userConfigPath()})`);
  }
  const [cmd, sub] = args._;

  switch (cmd) {
    case 'compact-all': {
      const sessions = await gatherSessions(cwd, config);
      const res = await updateHandoff({ cwd, sessions, trigger: 'cli:compact-all', config, getApiKey });
      if (res.warning) console.error(res.warning);
      console.log(`Wrote ${res.file} and ${res.sessionFile} from ${sessions.map((s) => s.ref.provider).join(', ')}`);
      break;
    }
    case 'hook': {
      if (sub !== 'claude') throw new Error(`Unknown hook source "${sub}"`);
      const payload = String(args.payload || '');
      // An LLM summary can outlast the hook timeout, so finish in a detached process.
      if (config.summarizer.provider !== 'none' && !args.foreground) {
        const log = fs.openSync(path.join(paths(cwd).dir, 'hook.log'), 'a');
        spawn(process.execPath, [__filename, ...process.argv.slice(2), '--foreground'], {
          detached: true,
          stdio: ['ignore', log, log],
          env: process.env,
        }).unref();
        break;
      }
      const res = await processPayload(cwd, payload, config, getApiKey);
      if (res && 'ignored' in res) console.log(`${new Date().toISOString()} ignored payload: ${res.ignored}`);
      else if (res) console.log(`${new Date().toISOString()} updated ${res.sessionFile || res.file}${res.warning ? ' (' + res.warning + ')' : ''}`);
      break;
    }
    case 'activate': {
      const res = activateBranch(cwd, config);
      if (res.branch) console.log(`Active handoff: ${res.branch}${res.inheritedFrom ? ` (new, inherited from ${res.inheritedFrom})` : ''}`);
      break;
    }
    case 'sync':
      console.log(syncTargets(cwd, config).map((f) => path.relative(cwd, f)).join('\n') || 'No handoff to sync.');
      break;
    case 'show':
      console.log(readText(paths(cwd).handoff) || 'No handoff yet. Run: carrycontext compact-all');
      break;
    case 'prompt':
      console.log(resumePrompt(cwd, sub || 'claude'));
      break;
    default:
      console.log(`usage: carrycontext <command> [--cwd DIR]

  compact-all          build handoff.md from the newest session of each source provider
  sync                 copy .carrycontext/handoff.md to every target provider
  activate             make the checked-out git branch's handoff the active one
  show                 print the current handoff
  prompt <provider>    print a prompt that tells <provider> to resume from the handoff
  hook claude          used by Claude Code hooks (reads --payload FILE)`);
  }
}

main().catch((e) => {
  console.error(`carrycontext: ${e.message}`);
  process.exit(1);
});
