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
| A summarizer LLM | `src/llm/index.js` (`registerLlm`) | Its base path in `MOCK_BASE_PATHS` (`test/helpers/mockLlm.js`), and a response shape in `respond()` if the API is new. A client that runs on this machine instead of over HTTP sets `local: true` and gets its own `test/<id>.test.js` (the contract test checks it exists) |
| A secret format | `src/security/secrets.js` (`registerSecretPattern` or the built-in list) | A fake example in `FAKE_SECRETS` (`test/helpers/fakeSecrets.js`), built at runtime so it never looks like a real key in the repo |
| A verification check | `src/core/claims.js` (`registerClaimChecker`: `extract` claims from the session's steps, `verify` each one) | Cases in `test/claims.test.js` for verified, unverified and contradicted |
| A cleaning step for output | `src/core/sanitize.js` (`registerSanitizer`) | A case in `test/secrets.test.js` or `test/security.test.js` |

Rules that keep the project safe:

- Everything written to disk or sent to an LLM goes through `sanitize()`.
- A setting that decides where data goes, how much is sent, or whether it's redacted must be **user-only**: add it to `USER_ONLY` in `src/core/config.js` and give it `"scope": "machine"` in `package.json`. A test fails if the two disagree.
- Never trust paths or URLs that come from a project's files (config, inbox payloads, handoffs): a cloned repo controls them.
- Tests run in a sandbox (`test/helpers/env.js`) with a temporary `HOME`, so they never touch your real `~/.claude`, `~/.codex` or `~/.gemini`. Use it in new test files.
- Test data is synthetic. Never commit real transcripts, handoffs or keys.
- Don't add runtime dependencies; `npm run check` fails if `dependencies` is not empty.

## The Apple on-device helper

`src/llm/apple/CarryContextApple.swift` is compiled on the user's Mac by `src/llm/apple.js` and always run inside the sandbox profile defined there. Keep it free of file and network access; the sandbox blocks both anyway, and the tests check it. Its tests use `test/fixtures/fake-apple-helper.sh`, a plain `/bin/sh` stand-in that speaks the same protocol and probes the sandbox. It is copied to `/tmp` first, because the sandbox blocks reads in the home folder, where your checkout lives. The real-model test only runs on a Mac with Apple Intelligence turned on, never in CI.

## Pull requests

- Keep each pull request to one change, with tests.
- Commit messages: a short imperative summary ("Add Aider session reader"), then a blank line and the why if it isn't obvious.
- Update `CHANGELOG.md` under **Unreleased** for anything users will notice.
- CI must pass: tests on Ubuntu and macOS with Node 22 and 24, the `.vsix` build, and CodeQL.

## Releasing (maintainers)

1. Set `"version"` in `package.json` (for example `0.3.0`).
2. In `CHANGELOG.md`, move the **Unreleased** entries under `## [0.3.0] - <date>` and update the compare links at the bottom.
3. Commit and push, and wait for CI to pass.
4. Tag and push the tag:
   ```sh
   git tag -a v0.3.0 -m "CarryContext 0.3.0"
   git push origin v0.3.0
   ```
   The Release workflow checks that the tag matches `package.json`, runs the tests, builds `carrycontext-0.3.0.vsix` and `SHA256SUMS.txt`, and publishes the GitHub Release.
5. **Marketplace, by hand.** No publishing token is stored anywhere, on purpose:
   - Download the `.vsix` and `SHA256SUMS.txt` from the release and check `shasum -a 256 -c SHA256SUMS.txt`.
   - Go to https://marketplace.visualstudio.com/manage/publishers/sonawanemayur, open **CarryContext → … → Update**, and upload the `.vsix`.
   - Wait for **Verifying** to change to **Published**, then check https://marketplace.visualstudio.com/items?itemName=sonawanemayur.carrycontext.

If releases become frequent, automate step 5 with a short-lived token stored as an environment secret that needs a maintainer's approval, or with Microsoft Entra ID sign-in (no stored token). See SECURITY.md for the risks.

## Reporting bugs and security issues

Bugs: open an issue with the template. Security problems: please follow [SECURITY.md](SECURITY.md) and report privately.
