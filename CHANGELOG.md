# Changelog

All notable changes to CarryContext are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **A cloned repo could redirect summaries and the API key sent with them.** The summarizer provider, model and URL were read from workspace settings and from a project's `.carrycontext/config.json`, so a malicious repo could point them at its own server. They are now user-only: machine-scoped in VS Code, and read by the CLI and hooks from a per-user config file, never from the project. Redaction settings and the transcript size limit are user-only too. Only matters if you had set a summarizer API key; the default (`none`) sends nothing.
- Summaries are only sent over https, or http to localhost (Ollama, LM Studio); URLs with credentials are refused before any request.
- Hook payloads in `.carrycontext/inbox/` are only processed when their transcript is in Claude Code's folder for the same project (symlinks resolved), and oversized payloads are ignored, so a planted file can't make CarryContext read another project's conversation.
- Numeric settings are kept in safe ranges; a handoff limit of 0 can no longer delete every saved handoff.

### Changed

- **Select Summarizer** saves to user settings. If you chose a summarizer before, choose it once more; CarryContext warns when a workspace tries to set these settings.

## [0.3.0] - 2026-10-25

### Added

- **Verified handoffs:** each handoff checks the session's claims against git and the session's recorded results: file edits, the last run of each test and build command, and commits it mentions. Results appear as a **Verification** section (✅ verified, ⚠️ unverified, ❌ contradicted) and a header line, and contradicted claims become the first **Next steps**. Never runs project code. Setting: `carrycontext.verify.enabled`.
- Transcript readers now record whether each tool call succeeded, and the exit code for shell commands (Claude Code, Codex, Gemini).
- Checker registry (`registerClaimChecker`) so new kinds of checks plug in without other changes.

### Changed

- "Check these" moved from **Repository state** into the new **Verification** section.

## [0.2.1] - 2026-10-25

### Changed

- Marketplace listing is marked **Preview** and has search keywords (Claude, Codex, Gemini, Copilot, Cursor, handoff, context, ...).
- The `.vsix` no longer includes development scripts.

## [0.2.0] - 2026-10-25

### Added

- **Secret redaction:** API keys, tokens, private keys, JWTs, passwords and URL credentials are replaced with `[REDACTED:<kind>]` in handoffs and in text sent to the summarizer LLM. Settings: `carrycontext.redact.enabled`, `carrycontext.redact.extraPatterns`.
- **Per-branch handoffs:** each git branch keeps its own handoff; switching branches switches the active one. New branches inherit the previous branch's context as Background.
- **Repository state from git** in every handoff, including a warning for files the session claims it edited that git shows no change for.
- **Append-only decision log:** Key decisions accumulate with date and branch tags and are never re-summarized away.
- **Reload after compaction:** the Claude Code SessionStart hook also runs after `/compact`.
- Test suite (`node:test`, no dependencies) with contract tests for providers, LLM clients and secret patterns; CI on Ubuntu and macOS; CodeQL scanning; Dependabot.
- `SECURITY.md`, `CONTRIBUTING.md`, issue and pull request templates.

### Changed

- Handoffs no longer contain absolute paths or the username: project paths become `./`, the home folder `~`, the username `<user>`.
- `state.json` stores hashes of transcript paths instead of the paths.
- Paths written into the Claude Code hook script are shell-quoted.

## [0.1.0] - 2026-10-20

### Added

- First release: Compact All, Claude Code hooks (PreCompact, SessionEnd, SessionStart), `/compact-all` command, named handoffs, sidebar panel, status bar menu, Switch To Provider for Claude Code, Codex, Gemini CLI, Copilot and Cursor, optional LLM summarizers (Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible).

[Unreleased]: https://github.com/SonawaneMayur/carrycontext/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/SonawaneMayur/carrycontext/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/SonawaneMayur/carrycontext/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/SonawaneMayur/carrycontext/compare/4a22e03...v0.2.0
[0.1.0]: https://github.com/SonawaneMayur/carrycontext/commit/4a22e03
