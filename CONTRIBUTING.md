# Contributing to CarryContext

Thanks for helping! This guide covers setup, tests, and how to extend CarryContext.

## Setup

CarryContext has **no dependencies**. You need Node 22+ and git.

```sh
git clone https://github.com/SonawaneMayur/carrycontext.git
cd carrycontext
npm test            # runs the whole suite in under a second
```

To try the extension, open the folder in VS Code and press **F5**. Open a project in the window that appears; a folder that is already open in another window won't open there.

| Command | What it does |
|---|---|
| `npm test` | All tests |
| `npm run test:coverage` | Tests plus coverage minimums (90% lines, 85% functions, 75% branches), as in CI |
| `npm run check` | Syntax check of every file, plus `package.json` sanity checks |
| `npm run package` | Build `carrycontext-<version>.vsix` |

## Project layout

```
bin/carrycontext.js        CLI; Claude Code hooks call it too
src/extension.js           VS Code commands, status bar, polling (only file besides sidebar.js that imports vscode)
src/sidebar.js             Handoffs panel
src/core/                  handoff building, git, hooks, config, sanitizing (no vscode imports)
src/providers/             one file per assistant: read its sessions, say where its handoff goes
src/llm/                   summarizer clients
src/security/secrets.js    secret patterns
test/                      node:test suites; test/helpers/ has shared fixtures
```

Code in `src/core`, `src/providers`, `src/llm` and `src/security` must not import `vscode`, so it runs in the CLI and in tests.

## Extending

Each extension point is a registry with a **contract test**: once you register something, the shared tests run against it automatically and tell you what fixture is missing.

| To add | Register in | Then add to the tests |
|---|---|---|
| An assistant (session reader and/or handoff target) | `src/providers/index.js` (`registerProvider`) | A writer in `SESSION_WRITERS` (`test/helpers/sessions.js`) that saves a session in that assistant's format |
| A summarizer LLM | `src/llm/index.js` (`registerLlm`) | Its base path in `MOCK_BASE_PATHS` (`test/helpers/mockLlm.js`), and a response shape in `respond()` if the API is new |
| A secret format | `src/security/secrets.js` (`registerSecretPattern` or the built-in list) | A fake example in `FAKE_SECRETS` (`test/helpers/fakeSecrets.js`), built at runtime so it never looks like a real key in the repo |
| A cleaning step for output | `src/core/sanitize.js` (`registerSanitizer`) | A case in `test/secrets.test.js` or `test/security.test.js` |

Rules that keep the project safe:

- Everything written to disk or sent to an LLM goes through `sanitize()`.
- Tests run in a sandbox (`test/helpers/env.js`) with a temporary `HOME`, so they never touch your real `~/.claude`, `~/.codex` or `~/.gemini`. Use it in new test files.
- Test data is synthetic. Never commit real transcripts, handoffs or keys.
- Don't add runtime dependencies; `npm run check` fails if `dependencies` is not empty.

## Pull requests

- Keep each pull request to one change, with tests.
- Commit messages: a short imperative summary ("Add Aider session reader"), then a blank line and the why if it isn't obvious.
- Update `CHANGELOG.md` under **Unreleased** for anything users will notice.
- CI must pass: tests on Ubuntu and macOS with Node 22 and 24, the `.vsix` build, and CodeQL.

## Reporting bugs and security issues

Bugs: open an issue with the template. Security problems: please follow [SECURITY.md](SECURITY.md) and report privately.
