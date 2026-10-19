// Serializes the shared build outputs (`dist/`, `management/character-app/`) between concurrent
// workers. `npm run build` and `npm run build:character-ui` both rewrite whole trees; two of them
// running at once can leave a half-written artifact that later tests read as a real failure.
//
// This is a cooperative lock for the agent/CI workflow, not a correctness primitive for the shipped
// product: nothing in the app reads it. Usage:
//
//   node tools/build-lock.mjs npm run build
//   node tools/build-lock.mjs npm run build:character-ui
//
// A lock whose owner PID is gone, or that is older than STALE_MS, is reclaimed rather than wedging the
// queue. The child runs with inherited stdio so its exit code and output stay the caller's.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const lockFile = resolve(codeRoot, '.local/build.lock');
const STALE_MS = 15 * 60 * 1000;
const WAIT_MS = 20 * 60 * 1000;
const POLL_MS = 1000;

const sleep = ms => new Promise(done => setTimeout(done, ms));

function ownerAlive(record) {
  try { process.kill(record.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Try to take the lock once. Returns true when this process owns it. */
function tryAcquire() {
  try {
    const fd = openSync(lockFile, 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: process.argv.slice(2).join(' ') }));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Somebody holds it. Reclaim only when the holder is provably gone or the lock is ancient.
  let record;
  try { record = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { record = null; }
  let age = 0;
  try { age = Date.now() - statSync(lockFile).mtimeMs; } catch { return tryAcquire(); }
  const dead = !record || !Number.isSafeInteger(record.pid) || !ownerAlive(record);
  if (!dead && age < STALE_MS) return false;
  rmSync(lockFile, { force: true });
  return tryAcquire();
}

async function acquire() {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (tryAcquire()) return;
    if (Date.now() > deadline) throw Error('Timed out waiting for ' + lockFile + '; another build has been running for over ' + Math.round(WAIT_MS / 60000) + ' minutes.');
    await sleep(POLL_MS);
  }
}

function release() {
  try {
    const record = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (record?.pid === process.pid) rmSync(lockFile, { force: true });
  } catch { /* the lock is already gone or unreadable; nothing to release */ }
}

const command = process.argv.slice(2);
if (!command.length) {
  console.error('usage: node tools/build-lock.mjs <command> [args...]');
  process.exit(2);
}
mkdirSync(dirname(lockFile), { recursive: true });
await acquire();
process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { release(); process.exit(1); });
// On Windows an npm shim is `npm.cmd`, a batch file. Node refuses to spawn a `.cmd` directly without a
// shell (EINVAL), and `shell: true` concatenates arguments unescaped. `cmd.exe /d /s /c` is used instead:
// `/d` skips AutoRun, `/s` keeps the rest of the line verbatim, so the argument vector stays as passed.
// Non-npm commands are spawned directly, with no shell involved.
const useCmdShim = process.platform === 'win32' && /^npm(\.cmd)?$/i.test(command[0]);
const child = useCmdShim
  ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...command.slice(1)], { cwd: codeRoot, stdio: 'inherit', windowsHide: true })
  : spawn(command[0], command.slice(1), { cwd: codeRoot, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); release(); process.exitCode = 1; });
child.on('exit', code => { release(); process.exitCode = code ?? 1; });
