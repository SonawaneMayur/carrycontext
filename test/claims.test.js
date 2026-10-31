const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, hasGit, git, read } = require('./helpers/env');
const { writeClaude } = require('./helpers/sessions');

const env = sandbox();
const { verifyClaims, countClaims, renderClaims, registerClaimChecker, listClaimCheckers, testOrBuild, TEST_COMMAND, BUILD_COMMAND } = require('../src/core/claims');
const { gitView } = require('../src/core/git');
const { DEFAULTS } = require('../src/core/config');
const h = require('../src/core/handoff');
const { getProvider } = require('../src/providers');
test.after(() => env.cleanup());

const skipGit = !hasGit && 'git is not installed';
const at = (min) => `2026-10-25T11:${String(min).padStart(2, '0')}:00Z`;
const edit = (file, min, ok = true) => ({ role: 'assistant', text: '', ts: at(min), tools: [{ name: 'Edit', input: { file_path: file }, ok }] });
const run = (command, min, ok, exitCode) => ({ role: 'assistant', text: '', ts: at(min), tools: [{ name: 'Bash', input: { command }, ok, exitCode }] });
const say = (text, min = 59) => ({ role: 'assistant', text, ts: at(min) });
const byLabel = (claims) => Object.fromEntries(claims.map((c) => [c.label, c]));

test('file edits are checked against git', { skip: skipGit }, () => {
  const repo = env.project({ git: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, '.env'), 'X=1');
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed');
  const claims = byLabel(
    verifyClaims(
      [edit(path.join(repo, 'README.md'), 1), edit(path.join(repo, 'ghost.js'), 2), edit(path.join(repo, '.env'), 3), edit(path.join(repo, 'never.js'), 4, false)],
      { cwd: repo, git: gitView(repo) },
    ),
  );
  assert.equal(claims['`README.md` edited'].status, 'verified');
  assert.equal(claims['`ghost.js` edited'].status, 'contradicted');
  assert.match(claims['`ghost.js` edited'].next, /doesn't exist/);
  assert.equal(claims['`.env` edited'].status, 'verified'); // ignored by git, but exists
  assert.equal(claims['`never.js` edited'], undefined, 'failed edits are not claims');
});

test('an edit with no change in git is unverified, not contradicted', { skip: skipGit }, () => {
  const repo = env.project({ git: true });
  // README.md was last changed more than 10 commits ago, so git shows nothing recent for it.
  for (let i = 0; i < 11; i++) {
    fs.writeFileSync(path.join(repo, 'other.txt'), String(i));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `change ${i}`);
  }
  // The edit happens after every commit, and changes nothing.
  const after = { role: 'assistant', text: '', ts: new Date(Date.now() + 120000).toISOString(), tools: [{ name: 'Edit', input: { file_path: path.join(repo, 'README.md') }, ok: true }] };
  const [claim] = verifyClaims([after], { cwd: repo, git: gitView(repo) });
  assert.equal(claim.status, 'unverified');
  assert.match(claim.evidence, /git shows no change/);
});

test('an edit committed after its time is verified, even many commits ago', { skip: skipGit }, () => {
  const repo = env.project({ git: true });
  const editTime = new Date(Date.now() - 3600000).toISOString();
  fs.appendFileSync(path.join(repo, 'README.md'), 'edit');
  git(repo, 'commit', '-q', '-am', 'Edit README');
  for (let i = 0; i < 11; i++) {
    fs.writeFileSync(path.join(repo, 'other.txt'), String(i));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `change ${i}`);
  }
  const [claim] = verifyClaims([{ role: 'assistant', text: '', ts: editTime, tools: [{ name: 'Edit', input: { file_path: path.join(repo, 'README.md') }, ok: true }] }], {
    cwd: repo,
    git: gitView(repo),
  });
  assert.equal(claim.status, 'verified');
  assert.match(claim.evidence, /committed after the edit \(`[0-9a-f]+`\)/);
});

test('outside git, edits are checked by existence and modification time', () => {
  const cwd = env.project();
  fs.writeFileSync(path.join(cwd, 'new.js'), 'x');
  const claims = byLabel(verifyClaims([edit(path.join(cwd, 'new.js'), 1), edit(path.join(cwd, 'gone.js'), 2)], { cwd, git: null }));
  assert.equal(claims['`new.js` edited'].status, 'verified');
  assert.equal(claims['`gone.js` edited'].status, 'contradicted');
  const old = path.join(cwd, 'old.js');
  fs.writeFileSync(old, 'x');
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(verifyClaims([edit(old, 1)], { cwd, git: null })[0].status, 'unverified');
});

test('tests: last run wins, failures and stale passes are reported', () => {
  const cwd = env.project();
  fs.writeFileSync(path.join(cwd, 'a.js'), 'x');
  const claims = byLabel(
    verifyClaims(
      [
        run('pytest -q', 1, true, 0),
        edit(path.join(cwd, 'a.js'), 2), // edited after pytest passed
        run('npm test', 3, false, 1),
        run('cd app && npm test', 4, true, 0), // same test, later run passes
        run('cargo test', 5, false, 101),
        run('npm run build', 6, undefined),
        run('echo hello', 7, true, 0), // not a test or build
      ],
      { cwd, git: null },
    ),
  );
  assert.equal(claims['`npm test`'].status, 'verified');
  assert.match(claims['`npm test`'].evidence, /passed at 11:04; nothing edited since/);
  assert.equal(claims['`pytest`'].status, 'unverified');
  assert.match(claims['`pytest`'].evidence, /1 file was edited afterwards/);
  assert.equal(claims['`cargo test`'].status, 'contradicted');
  assert.match(claims['`cargo test`'].evidence, /exit 101/);
  assert.match(claims['`cargo test`'].next, /Fix the failing test/);
  assert.equal(claims['`npm run build`'].status, 'unverified');
  assert.equal(Object.keys(claims).some((l) => l.includes('echo')), false);
});

test('command patterns recognize common test and build tools', () => {
  for (const cmd of ['npm test', 'pnpm run test:unit', 'yarn test', 'pytest', 'uv run pytest', 'go test ./...', 'npx vitest run', 'node --test', 'make test', './gradlew test', 'mvn test', 'swift test']) {
    assert.match(cmd, TEST_COMMAND, cmd);
  }
  for (const cmd of ['npm run build', 'tsc --noEmit', 'cargo build --release', 'go build ./...', 'swift build']) assert.match(cmd, BUILD_COMMAND, cmd);
  for (const cmd of ['ls', 'npm install', 'git status', 'echo test']) {
    assert.doesNotMatch(cmd, TEST_COMMAND, cmd);
    assert.doesNotMatch(cmd, BUILD_COMMAND, cmd);
  }
});

test('only commands that run count, not test commands written inside strings, heredocs or files', () => {
  const runs = {
    'cd app && CI=1 npm test 2>&1 | tail -5': 'npm test',
    "bash -lc 'npm run build && npm test'": 'npm test',
    'bash -lc npm run build': 'npm run build',
    'ELECTRON_RUN_AS_NODE=1 "$NODE" --test "test/**/*.test.js"': 'node --test',
    'node --experimental-test-coverage --test-coverage-lines=90 --test': 'node --test',
    './node_modules/.bin/jest --ci': 'jest',
  };
  for (const [line, name] of Object.entries(runs)) assert.equal(testOrBuild(line)?.name, name, line);
  const mentions = ['echo npm test', 'grep -n "npm test" README.md', "cat > ci.yml <<'EOF'\nrun: npm test\nEOF", `python3 -c "print('ran npm test')"`, 'git commit -m "Fix npm test"'];
  for (const line of mentions) assert.equal(testOrBuild(line), null, line);
  // A failed command that only mentions a test is not a failed test.
  const claims = verifyClaims([run(`./helper --prompt "I edited src/a.js and ran npm test, which passed."`, 1, false, 1)], { cwd: env.project(), git: null });
  assert.deepEqual(claims, []);
});

test('mentioned commits are checked to exist', { skip: skipGit }, () => {
  const repo = env.project({ git: true });
  const sha = git(repo, 'rev-parse', '--short', 'HEAD');
  const claims = byLabel(verifyClaims([say(`Committed as \`${sha}\`. Earlier commit deadbee fixed it.`)], { cwd: repo, git: gitView(repo) }));
  assert.equal(claims[`commit \`${sha}\``].status, 'verified');
  assert.equal(claims['commit `deadbee`'].status, 'unverified');
  assert.match(claims['commit `deadbee`'].evidence, /not in this repo/);
});

test('claims are ordered contradicted, unverified, verified and rendered with icons', () => {
  const cwd = env.project();
  fs.writeFileSync(path.join(cwd, 'ok.js'), 'x');
  const claims = verifyClaims([edit(path.join(cwd, 'ok.js'), 1), run('npm test', 2, undefined), edit(path.join(cwd, 'gone.js'), 3)], { cwd, git: null });
  assert.deepEqual(claims.map((c) => c.status), ['contradicted', 'unverified', 'verified']);
  assert.deepEqual(countClaims(claims), { verified: 1, unverified: 1, contradicted: 1 });
  const md = renderClaims(claims);
  assert.match(md, /^_Checked against git/);
  assert.match(md, /- ❌ `gone\.js` edited: reported as edited, but the file doesn't exist/);
  assert.equal(renderClaims([]), '');
});

test('end to end: handoff gets a Verification section, a header line and fix items', { skip: skipGit }, async () => {
  const repo = env.project({ git: true });
  fs.writeFileSync(path.join(repo, 'pay.js'), 'x');
  const file = writeClaude(repo, 'v', [
    { role: 'user', text: 'Build payments' },
    { role: 'assistant', text: 'Done', edits: [path.join(repo, 'pay.js'), path.join(repo, 'webhook.js')], commands: [{ cmd: 'npm test', exit: 1 }] },
  ]);
  const session = { adapter: getProvider('claude'), ref: { provider: 'claude', id: 'v', path: file, updatedAt: Date.now() } };
  const res = await h.updateHandoff({ cwd: repo, sessions: [session], trigger: 't', config: DEFAULTS, getApiKey: async () => undefined });
  assert.match(res.doc, /\*\*Verification:\*\* 1 verified, 0 unverified, 2 contradicted/);
  assert.match(res.doc, /## Verification\n\n_Checked against git/);
  assert.match(res.doc, /❌ `webhook\.js` edited/);
  assert.match(res.doc, /❌ `npm test`: last run failed \(exit 1\)/);
  assert.match(res.doc, /## Next steps\n\n- ❌ Check `webhook\.js`[\s\S]*- ❌ Fix the failing test/);
  assert.deepEqual(h.loadState(repo).verification, { verified: 1, unverified: 0, contradicted: 2 });

  // The next update replaces the fix items instead of piling them up.
  const again = await h.updateHandoff({ cwd: repo, sessions: [session], trigger: 't', config: DEFAULTS, getApiKey: async () => undefined });
  assert.equal(again.doc.match(/- ❌ Check `webhook\.js`/g).length, 1);

  const off = await h.updateHandoff({ cwd: repo, sessions: [session], trigger: 't', config: { ...DEFAULTS, verify: { enabled: false } }, getApiKey: async () => undefined });
  assert.doesNotMatch(off.doc, /## Verification/);
  assert.doesNotMatch(read(path.join(repo, '.carrycontext', 'handoff.md')), /\*\*Verification:\*\*/);
});

// Last: it adds a checker to the shared registry for the rest of this file.
test('registerClaimChecker adds a checker', () => {
  const before = listClaimCheckers().length;
  registerClaimChecker({
    id: 'always',
    extract: () => [{ label: 'custom claim' }],
    verify: () => ({ status: 'verified', evidence: 'custom evidence' }),
  });
  assert.equal(listClaimCheckers().length, before + 1);
  const claims = verifyClaims([], { cwd: env.project(), git: null });
  assert.ok(claims.some((c) => c.label === 'custom claim' && c.evidence === 'custom evidence'));
});
