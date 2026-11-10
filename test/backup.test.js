// Daily backups of a project's shared store: once a day, readable only by you, the newest kept,
// never to a synced folder unwarned, and a restore that can itself be undone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, read } = require('./helpers/env');

const env = sandbox();
const { DEFAULTS, normalizeConfig } = require('../src/core/config');
const b = require('../src/core/backup');
test.after(() => env.cleanup());

const config = (backup = {}) => normalizeConfig({ ...DEFAULTS, backup: { ...DEFAULTS.backup, ...backup } });

/** A project whose store has a handoff and a ledger, plus per-folder state that isn't backed up. */
function project() {
  const cwd = env.project();
  const store = path.join(cwd, '.carrycontext');
  fs.mkdirSync(path.join(store, 'branches', 'main'), { recursive: true });
  fs.writeFileSync(path.join(store, 'branches', 'main', 'handoff.md'), '# v1\n');
  fs.writeFileSync(path.join(store, 'usage.json'), '{"sessions":{}}\n');
  fs.writeFileSync(path.join(store, 'state.json'), '{}\n');
  return { cwd, store };
}

test('a backup a day of the shared data, readable only by you, named after the project and never its path', () => {
  const { cwd } = project();
  const first = b.backup(cwd, config());
  assert.equal(first.made, true);
  assert.equal(path.basename(first.dir), b.today());
  assert.equal(read(path.join(first.dir, 'branches', 'main', 'handoff.md')), '# v1\n');
  assert.ok(fs.existsSync(path.join(first.dir, 'usage.json')));
  assert.ok(!fs.existsSync(path.join(first.dir, 'state.json')), "this folder's own state isn't part of it");
  const root = path.dirname(first.dir);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.match(path.basename(root), new RegExp(`^${path.basename(cwd)}-[0-9a-f]{8}$`));
  assert.equal(path.dirname(root), path.join(env.home, '.carrycontext', 'backups'));
  assert.equal(b.backup(cwd, config()).made, false, 'once a day');
  assert.equal(b.backup(cwd, config(), { force: true }).made, true, 'Back Up Now');
});

test('the newest backups are kept; keep 0 turns them off', () => {
  const { cwd } = project();
  const root = path.dirname(b.backup(cwd, config()).dir);
  for (let d = 1; d <= 9; d++) fs.mkdirSync(path.join(root, `2026-10-0${d}`));
  b.backup(cwd, config({ keep: 3 }), { force: true });
  assert.deepEqual(b.listBackups(cwd, config()).map((x) => x.name), [b.today(), '2026-10-09', '2026-10-08']);
  const other = project();
  assert.equal(b.backup(other.cwd, config({ keep: 0 })).made, false);
});

test('a folder that syncs to the cloud gets a warning', () => {
  const { cwd } = project();
  assert.match(b.backup(cwd, config({ folder: path.join(env.home, 'Dropbox', 'backups') })).warning, /syncs to the cloud/);
  assert.match(b.syncedWarning(config({ folder: path.join(env.home, 'Library', 'Mobile Documents', 'x') })), /syncs to the cloud/);
  assert.equal(b.syncedWarning(config()), '', 'the default folder is local');
});

test('restore puts a backup back, after backing up what is there now', () => {
  const { cwd, store } = project();
  const day = b.backup(cwd, config());
  fs.writeFileSync(path.join(store, 'branches', 'main', 'handoff.md'), '# v2\n');
  const res = b.restore(cwd, config(), path.basename(day.dir));
  assert.equal(read(path.join(store, 'branches', 'main', 'handoff.md')), '# v1\n');
  assert.equal(read(path.join(res.safety, 'branches', 'main', 'handoff.md')), '# v2\n', 'the state before, kept, so the restore can be undone');
  assert.throws(() => b.restore(cwd, config(), '../../etc'), /Not a backup name/);
  assert.throws(() => b.restore(cwd, config(), '2020-01-01'), /No backup named/);
});
