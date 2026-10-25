#!/usr/bin/env node
// Print the release notes for one version: its CHANGELOG.md section plus install steps.
// Usage: node scripts/release-notes.js 0.2.0
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/release-notes.js <version>');
  process.exit(1);
}

const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(1).search(/^## \[|^\[[^\]]+\]: /m);
const section = (next === -1 ? rest : rest.slice(0, next + 1)).split('\n').slice(1).join('\n').trim();

console.log(`${section}

## Install

1. Download \`carrycontext-${version}.vsix\` below.
2. In VS Code: Extensions view → **…** → **Install from VSIX…** → pick the file, then reload the window.

Or from a terminal: \`code --install-extension carrycontext-${version}.vsix\`

Verify the download: \`shasum -a 256 carrycontext-${version}.vsix\` should match \`SHA256SUMS.txt\`.`);
