// The parts of the VS Code API the panel uses, so src/sidebar.js runs in tests without VS Code.
// test/sidebar.test.js maps require('vscode') to this file.
class TreeItem {
  constructor(label, collapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => this.listeners.push(listener);
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
}

class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
  appendText(text) {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
    return this;
  }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const Uri = { file: (fsPath) => ({ scheme: 'file', fsPath }) };

module.exports = { TreeItem, ThemeIcon, EventEmitter, MarkdownString, TreeItemCollapsibleState, Uri };
