#!/usr/bin/env node
// Syntax-check every JavaScript file, validate package.json, and check the citation names the
// current release. Run with: npm run check
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

// The citation must name the current release and the date CHANGELOG.md gives it, so it can't
// fall behind again.
const text = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const heading = `## [${pkg.version}] - `;
const released = text('CHANGELOG.md').split('\n').find((l) => l.startsWith(heading))?.slice(heading.length);
if (!/^\d{4}-\d{2}-\d{2}$/.test(released || '')) {
  failed++;
  console.error(`✖ CHANGELOG.md needs a "${heading}YYYY-MM-DD" heading for the current version`);
}
const cff = text('CITATION.cff');
for (const [where, found, expected] of [
  ['CITATION.cff version', cff.match(/^version: (.+)$/m)?.[1], pkg.version],
  ['CITATION.cff date-released', cff.match(/^date-released: (.+)$/m)?.[1], released],
  ['The README BibTeX version', text('README.md').match(/^ *version *= *\{(.+)\},?$/m)?.[1], pkg.version],
]) {
  if (expected && found !== expected) {
    failed++;
    console.error(`✖ ${where} is ${found || 'missing'}, expected ${expected}`);
  }
}

if (failed) process.exit(1);
console.log('✔ all files pass the syntax check; package.json and the citation are valid');
