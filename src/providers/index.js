// @ts-check
// Provider registry. To support a new assistant, add an adapter (see types.js)
// and register it here or at runtime with registerProvider().
const path = require('path');

/** @type {Map<string, import('./types').ProviderAdapter>} */
const providers = new Map();

function registerProvider(adapter) {
  providers.set(adapter.id, adapter);
}

registerProvider(require('./claude'));
registerProvider(require('./codex'));
registerProvider(require('./gemini'));

// Target-only providers: we can hand context to them but cannot read their sessions.
registerProvider({
  id: 'copilot',
  label: 'GitHub Copilot Chat',
  target: {
    handoffFile: (cwd) => path.join(cwd, '.github', 'handoff.md'),
    instructionsFile: (cwd) => path.join(cwd, '.github', 'copilot-instructions.md'),
    // Copilot's ask mode cannot open files, so the handoff goes into the instructions file itself.
    inline: true,
  },
  launch: { vscodeCommand: 'workbench.action.chat.open' },
});

registerProvider({
  id: 'cursor',
  label: 'Cursor',
  target: {
    handoffFile: (cwd) => path.join(cwd, '.cursor', 'rules', 'handoff.mdc'),
    render: (doc) =>
      `---\ndescription: Handoff from a previous AI session (CarryContext)\nalwaysApply: true\n---\n\n${doc}`,
  },
});

const getProvider = (id) => providers.get(id);
const listProviders = () => [...providers.values()];

module.exports = { registerProvider, getProvider, listProviders };
