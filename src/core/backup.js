// @ts-check
// Daily backups of the data a project's CarryContext keeps: handoffs per branch, their versions
// and the usage ledger. Local only: copies go to a folder on this computer that only you can
// read, named after the project and a hash of its path (never the path itself).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { storeDir } = require('./config');
const { mainFolder } = require('./git');

/** What a backup holds, inside a store. */
const PARTS = ['branches', 'handoffs', 'usage.json'];
// Folders that sync to the cloud: a backup there would upload conversation summaries.
const SYNCED = /[\\/](Library[\\/]Mobile Documents|Library[\\/]CloudStorage|Dropbox|OneDrive[^\\/]*|Google ?Drive|iCloud Drive)([\\/]|$)/i;
const NAME = /^\d{4}-\d\d-\d\d[\w-]*$/;

const backupRoot = (config) => config.backup?.folder || path.join(os.homedir(), '.carrycontext', 'backups');

/** This project's backups: "<project>-<hash of its path>" inside the backup folder. */
function projectBackups(cwd, config) {
  const main = mainFolder(cwd);
  return path.join(backupRoot(config), `${path.basename(main)}-${crypto.createHash('sha256').update(main).digest('hex').slice(0, 8)}`);
}

const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-10" in local time, the name of the day's backup. */
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = (d = new Date()) => `${today(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** A warning when the backup folder syncs to the cloud, or ''. */
const syncedWarning = (config) =>
  SYNCED.test(backupRoot(config)) ? 'CarryContext backups go to a folder that syncs to the cloud, so conversation summaries would be uploaded. Choose another carrycontext.backup.folder.' : '';

/**
 * Copy `from` (the shared store unless given) into a backup: today's, made once a day, or a named
 * one. Keeps the newest `keep` (backup.keep; 0 turns daily backups off, named ones are still made).
 * @param {string} cwd
 * @param {import('./config').Config} config
 * @param {{force?: boolean, name?: string, from?: string}} [opts]
 * @returns {{dir: string | null, made: boolean, warning: string}}
 */
function backup(cwd, config, { force = false, name, from = storeDir(cwd) } = {}) {
  const keep = config.backup?.keep ?? 7;
  const warning = syncedWarning(config);
  if (keep <= 0 && !name) return { dir: null, made: false, warning };
  const parts = PARTS.filter((p) => fs.existsSync(path.join(from, p)));
  if (!parts.length) return { dir: null, made: false, warning };
  const root = projectBackups(cwd, config);
  const dir = path.join(root, name || today());
  if (fs.existsSync(dir) && !force) return { dir, made: false, warning };
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o700); // only you can read your backups
  // Copied to a temporary folder first, so a half-made backup never takes a good one's name.
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of parts) fs.cpSync(path.join(from, p), path.join(tmp, p), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  prune(root, Math.max(keep, 1));
  return { dir, made: true, warning };
}

/** Remove all but the newest `keep` backups. */
function prune(root, keep) {
  const names = fs.readdirSync(root).filter((n) => NAME.test(n)).sort().reverse();
  for (const n of names.slice(keep)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
}

/** This project's backups, newest first. */
function listBackups(cwd, config) {
  const root = projectBackups(cwd, config);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((n) => NAME.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, dir: path.join(root, name) }));
}

/**
 * Put a backup back into the shared store. What's there now is backed up first, so a restore
 * can itself be undone.
 * @returns {{safety: string | null}}  the backup made just before
 */
function restore(cwd, config, name) {
  if (!NAME.test(name)) throw new Error(`Not a backup name: ${name}`);
  const dir = path.join(projectBackups(cwd, config), name);
  if (!fs.existsSync(dir)) throw new Error(`No backup named ${name}`);
  const safety = backup(cwd, config, { force: true, name: `${now()}-before-restore` }).dir;
  const store = storeDir(cwd);
  for (const p of PARTS) {
    if (!fs.existsSync(path.join(dir, p))) continue;
    fs.rmSync(path.join(store, p), { recursive: true, force: true });
    fs.cpSync(path.join(dir, p), path.join(store, p), { recursive: true });
  }
  return { safety };
}

module.exports = { backup, listBackups, restore, projectBackups, syncedWarning, today, now, PARTS };
