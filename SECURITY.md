# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Open https://github.com/SonawaneMayur/carrycontext/security/advisories/new (GitHub's private vulnerability reporting).
2. Describe the problem, how to reproduce it, and what an attacker could do.

You'll get a reply within 7 days. Fixes for confirmed issues are released as soon as possible, and you'll be credited in the release notes unless you prefer not to be.

## Supported versions

Only the latest release gets security fixes while CarryContext is in beta (0.x).

## What CarryContext does with your data

CarryContext reads AI assistant transcripts on your machine and writes handoff files into your project. Here is what it protects against, so reports can be checked against it.

| Concern | What CarryContext does |
|---|---|
| **Secrets in conversations** | API keys, tokens, private keys, JWTs, passwords in assignments and credentials in URLs are replaced with `[REDACTED:<kind>]` before anything is written or sent to a summarizer LLM. The handoff header says how many were removed. Patterns live in [`src/security/secrets.js`](src/security/secrets.js); add your own with `carrycontext.redact.extraPatterns`. |
| **Personal paths** | Absolute paths become `./` (project) and `~` (home); the bare username becomes `<user>`. `state.json` stores hashes of transcript paths, not the paths themselves. |
| **API keys** | Stored only in VS Code's secret storage, or read from your environment by the CLI. Never written to `config.json` or any handoff. |
| **Data sent off your machine** | Nothing, unless you choose an LLM summarizer. Then the sanitized, condensed transcript goes to that provider only, over https (plain http only to a server on your own machine, such as Ollama), never to a URL with a username or password in it. |
| **Settings from a cloned repo** | The settings that decide where data goes (summarizer, model, URL, transcript size) and redaction are **user-only**: VS Code ignores them in a workspace's `.vscode/settings.json` (machine scope), and the CLI and hooks read them from your per-user config file (`~/Library/Application Support/carrycontext/config.json` on macOS, private to you), never from a project's `.carrycontext/config.json`. A repo can't redirect your summaries or the API key sent with them, or turn redaction off. Numbers such as the handoff limit are kept in safe ranges. |
| **Files planted in a repo** | A hook payload in `.carrycontext/inbox/` is only processed if its transcript is in Claude Code's folder for that same project (symlinks resolved) and the payload is small, so a repo can't make CarryContext read another project's conversation. |
| **Shell injection** | Paths written into the Claude Code hook script are single-quoted, so they can't run commands. Branch names are reduced to safe folder names. |
| **Your files** | Instruction files (`AGENTS.md`, `GEMINI.md`, Copilot instructions) are only changed between `<!-- carrycontext:start -->` and `<!-- carrycontext:end -->` markers. Claude settings are merged; only CarryContext's own hook entries are changed. |
| **Committing handoffs** | `.carrycontext/.gitignore` keeps handoffs, history and state out of git. Provider copies (`.claude/handoff.md`, `.codex/handoff.md`, ...) are outside that folder; review them before committing. |

Redaction is pattern-based, so it can miss secrets in unusual formats. Treat handoffs like the conversations they come from.

Each of these is covered by tests in [`test/security.test.js`](test/security.test.js), and CodeQL scans every change.
