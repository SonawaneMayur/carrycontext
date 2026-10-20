<img src="media/icon.png" alt="CarryContext icon" width="96" align="right">

# CarryContext

By **[Mayur Sonawane](https://github.com/SonawaneMayur)** · [GitHub repo](https://github.com/SonawaneMayur/carrycontext) · MIT License

Compact your AI coding sessions into one portable `handoff.md`, then pick up the work in a new session or in another provider's assistant (Claude Code, Codex, Gemini CLI, Copilot, Cursor, or any chat via the clipboard).

## Run it

No build step and no dependencies. Open this folder in VS Code and press **F5** to start an Extension Development Host. In that window, open a project and run commands from the Command Palette (`CarryContext: …`).

To package it: `npx @vscode/vsce package`, then install the `.vsix` file.

## Commands

| Command | What it does |
|---|---|
| **Compact All** | Reads the newest session of each source provider (default: claude, codex, gemini) from the last 24h, merges them in time order, and writes the handoff everywhere |
| **Create Handoff From a Specific Session…** | Pick one or more sessions by hand |
| **Switch To Provider…** | Optionally refreshes the handoff, writes it where the chosen provider looks, then opens that tool with a "resume from handoff" prompt |
| **Install Claude Code Hooks** | Refreshes the handoff on compact and session end, and loads it into new sessions |
| **Select Summarizer LLM… / Set API Key…** | Choose which LLM writes the handoff (or none) |
| **Open handoff.md / Copy Resume Prompt** | |

The status bar shows how long ago the handoff was updated. Click it to switch provider.

## Where the handoff goes

| Location | Read by |
|---|---|
| `.carrycontext/handoff.md` | Latest handoff; the provider copies below are made from it |
| `.carrycontext/handoffs/<provider>-<session-name>--<short-description>.md` | A named copy of every handoff, kept permanently up to `carrycontext.handoffLimit` (default 50) |
| `.claude/handoff.md` | Claude Code, injected at session start by the SessionStart hook |
| `.codex/handoff.md` + block in `AGENTS.md` | Codex CLI |
| `.gemini/handoff.md` + block in `GEMINI.md` | Gemini CLI |
| `.github/handoff.md` + inlined in `.github/copilot-instructions.md` | Copilot Chat |
| `.cursor/rules/handoff.mdc` (`alwaysApply`) | Cursor |

Named copy examples:

```
.carrycontext/handoffs/claude-vs-code-compact-all-handoff-utility--add-named-handoff-files-per-session.md
.carrycontext/handoffs/codex-add-a-readme-to-carrycontext--write-usage-section.md
.carrycontext/handoffs/claude-codex-gemini-compact-all--fix-failing-tests.md
```

- **Session name:** the session's title in Claude Code (your `/rename` title, otherwise Claude Code's generated one), otherwise the session's first prompt. When Compact All merges several sessions, it is `compact-all`.
- **Short description:** at most 8 words on what was being worked on. An LLM summarizer writes it; the built-in summary uses the most recent request.
- **Overwriting:** another handoff with the same session and description replaces that file; a new description creates a new file. **Open Handoff…** lists every file, newest first.

`carrycontext.targets` decides which of the provider copies are written. Instruction files only get a block between `<!-- carrycontext:start -->` and `<!-- carrycontext:end -->` markers; nothing else in them is changed.

## Claude Code integration

**Install Claude Code Hooks** adds three hooks to `.claude/settings.local.json`:

- **PreCompact** (manual `/compact` and auto-compact) → refresh the handoff
- **SessionEnd** (exit, `/clear`, logout) → refresh the handoff
- **SessionStart** (`startup` and `clear` only) → print `.claude/handoff.md` so the new session starts with it

The command also adds a **`/compact-all`** slash command (`.claude/commands/compact-all.md`). It has Claude write the handoff itself, which gives the best summary, and then copies it to every provider's location. A useful sequence is `/compact-all`, then `/compact` or `/clear`.

Hooks run `.carrycontext/hooks/claude-hook.sh`. That script runs `bin/carrycontext.js` with `node` if it's on your PATH, otherwise with the Node runtime bundled in VS Code. If neither is available, it leaves the hook payload in `.carrycontext/inbox/`, and the extension processes it the next time it runs.

## Providers without hooks

While VS Code is open, the extension checks every 30s for Codex and Gemini sessions in this folder. Once a session has been idle for `carrycontext.autoUpdate.idleSeconds` (default 120), it refreshes the handoff. Claude is also checked this way when its hooks aren't installed.

## Summarizers

| `carrycontext.summarizer.provider` | Notes |
|---|---|
| `none` (default) | Free and offline. Pulls the goal, latest state, recent requests, files touched, commands run, and todos from the transcript. Keeps the decisions and gotchas from an earlier LLM-written handoff instead of discarding them |
| `anthropic`, `openai`, `gemini` | API keys entered with **Set API Key** go into VS Code secret storage. Hooks run outside VS Code, so they read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` from your environment |
| `ollama` | Local model, no key |
| `openai-compatible` | OpenRouter, Groq, Mistral, DeepSeek, LM Studio… Set `summarizer.baseUrl` and `OPENAI_COMPATIBLE_API_KEY` |

LLM summaries update the previous handoff rather than rewriting it from scratch. If the LLM call fails, the heuristic summary is used and the failure is noted in the handoff.

## CLI

```sh
node bin/carrycontext.js compact-all --cwd /path/to/project
node bin/carrycontext.js sync          # copy .carrycontext/handoff.md to all targets
node bin/carrycontext.js show
node bin/carrycontext.js prompt codex  # print a resume prompt for codex
```

## Extending

**New assistant.** Write an adapter (shape in [src/providers/types.js](src/providers/types.js)) and register it in [src/providers/index.js](src/providers/index.js):

```js
registerProvider({
  id: 'aider',
  label: 'Aider',
  listSessions: async (cwd) => [/* { provider, id, path, updatedAt } newest first */],
  readSession: async (ref) => [/* { role, text, tools, ts, provider } */],
  target: {
    handoffFile: (cwd) => path.join(cwd, '.aider', 'handoff.md'),
    instructionsFile: (cwd) => path.join(cwd, 'CONVENTIONS.md'), // optional pointer block
  },
  launch: { terminal: (prompt, quote) => `aider --message ${quote(prompt)}` },
});
```

Leave out `listSessions`/`readSession` for a target-only provider (like Copilot and Cursor): context can be handed to it, but its sessions can't be read.

**New summarizer LLM.** Call `registerLlm(id, { label, defaultModel, envKey, needsKey, complete })` in [src/llm/index.js](src/llm/index.js).

## Layout

```
bin/carrycontext.js        CLI, also the entry point for Claude Code hooks
src/extension.js           VS Code commands, status bar, idle polling
src/core/handoff.js        gather sessions → summarize → write and mirror (no vscode import)
src/core/summarize.js      heuristic + LLM summaries, transcript condensing
src/core/claudeHooks.js    hook script, settings.local.json merge, /compact-all, inbox
src/providers/*.js         transcript readers and handoff targets per assistant
src/llm/index.js           Anthropic, OpenAI, Gemini, Ollama, OpenAI-compatible clients
```

## Caveats

- Codex and Gemini transcript formats aren't documented and change between versions. Their readers are best-effort and were tested only against sample files. Claude Code's reader was tested against real transcripts.
- `.carrycontext/.gitignore` excludes `handoff.md`, `handoffs/`, the inbox, state and logs. The provider copies (`.claude/handoff.md`, `.codex/handoff.md`, ...) are outside that folder and not ignored. Handoffs can contain anything from your conversations, so check them before committing.

## Author

**Mayur Sonawane** ([@SonawaneMayur](https://github.com/SonawaneMayur)) created and maintains CarryContext. Issues and pull requests are welcome at [github.com/SonawaneMayur/carrycontext](https://github.com/SonawaneMayur/carrycontext/issues).

## Citation

If you use CarryContext in research, a write-up, or a derived project, please credit it. The repository includes [CITATION.cff](CITATION.cff), so GitHub's **"Cite this repository"** button gives APA and BibTeX formats.

```bibtex
@software{sonawane_carrycontext_2026,
  author  = {Sonawane, Mayur},
  title   = {CarryContext: portable AI coding session handoffs across LLM providers},
  year    = {2026},
  version = {0.1.0},
  url     = {https://github.com/SonawaneMayur/carrycontext},
  license = {MIT}
}
```

## License

[MIT](LICENSE) © 2026 Mayur Sonawane
