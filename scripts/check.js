#!/usr/bin/env node
// Syntax-check every JavaScript file and validate package.json. Run with: npm run check
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dirs = ['bin', 'src', 'test', 'scripts'];

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

let failed = 0;
for (const file of dirs.flatMap((d) => jsFiles(path.join(root, d)))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✖ ${path.relative(root, file)}\n${e.stderr}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const field of ['name', 'version', 'publisher', 'main', 'engines', 'license']) {
  if (!pkg[field]) {
    failed++;
    console.error(`✖ package.json is missing "${field}"`);
  }
}
if (Object.keys(pkg.dependencies || {}).length) {
  failed++;
  console.error('✖ package.json has runtime dependencies; CarryContext is dependency-free by design');
}

if (failed) process.exit(1);
console.log('✔ all files pass the syntax check; package.json is valid');
