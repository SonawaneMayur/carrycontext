# Changelog

All notable changes to CarryContext are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/SonawaneMayur/carrycontext/compare/4a22e03...HEAD
[0.1.0]: https://github.com/SonawaneMayur/carrycontext/commit/4a22e03
