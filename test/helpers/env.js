// Isolated environment for one test file: a temp HOME and assistant data folders, so tests
// never read or write the real ~/.claude, ~/.codex or ~/.gemini. node --test runs each file in
// its own process, so setting process.env here is safe.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Set up a sandbox. Call once at the top of a test file, before requiring src/. */
function sandbox() {
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) and paths must compare equal.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carrycontext-test-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.CODEX_HOME = path.join(home, '.codex');
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.XDG_CONFIG_HOME; // the per-user config file must land in the sandbox
  delete process.env.APPDATA;

  let n = 0;
  return {
    root,
    home,
    /** A new empty project folder (optionally a git repo with one commit on `branch`). */
    project({ git: withGit = false, branch = 'main', name } = {}) {
      const dir = path.join(home, 'projects', name || `project-${++n}`);
      fs.mkdirSync(dir, { recursive: true });
      if (withGit) {
        git(dir, 'init', '-q', '-b', branch);
        fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'Initial commit');
      }
      return dir;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Every file under dir (recursively), for "nothing leaked anywhere" assertions. */
function allFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '.git') out.push(...allFiles(full));
    } else out.push(full);
  }
  return out;
}

const read = (file) => fs.readFileSync(file, 'utf8');

module.exports = { sandbox, hasGit, git, allFiles, read };
