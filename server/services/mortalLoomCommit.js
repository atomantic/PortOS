/** Host-local revision guard and previous-byte recovery for the shared native store. */
import { createHash, randomUUID } from 'crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFile } from '../lib/childProcess.js';
import { ServerError } from '../lib/errorHandler.js';
import { isUbiquityPath } from '../lib/icloudFile.js';
import { isVitestRunner } from '../lib/runtimeEnv.js';
import { canonicalizePath, isPathAtOrInsideDir } from '../lib/pathContainment.js';

const run = promisify(execFile);
const helperSource = fileURLToPath(new URL('../native/mortalloom-sync/main.swift', import.meta.url));
const SHA = /^[a-f0-9]{64}$/;
const KEEP = 12;
export const MORTALLOOM_MAX_BYTES = 32 * 1024 * 1024;
const HOST_OS = process.platform;
let helper;

// On a managed install there is no bundled compiler binary to trust across
// macOS architectures. Compile our shipped Foundation helper once per process,
// in a private folder. A missing CLT is a refusal, never an uncoordinated write.
async function macHelper() {
  helper ??= (async () => {
    const folder = await mkdtemp(join(tmpdir(), 'portos-mortalloom-helper-'));
    const bin = join(folder, 'mortalloom-sync');
    try {
      await run('/usr/bin/swiftc', ['-O', helperSource, '-o', bin], { timeout: 45_000, maxBuffer: 8192 });
      return bin;
    } catch {
      await rm(folder, { recursive: true, force: true });
      throw storeFailure('helperUnavailable');
    }
  })().catch(error => { helper = null; throw error; });
  return helper;
}

export async function _disposeMortalLoomHelperForTest() {
  if (!isVitestRunner()) return;
  const bin = await helper?.catch(() => null);
  if (!bin) return;
  helper = null;
  await rm(dirname(bin), { recursive: true, force: true });
}

const failures = Object.freeze({
  missing: ['MORTALLOOM_MISSING', 'Open MortalLoom to initialize its iCloud file before editing in PortOS.'],
  notCurrent: ['MORTALLOOM_NOT_CURRENT', 'MortalLoom has not finished syncing on this Mac. Wait for iCloud, then retry.'],
  conflicted: ['MORTALLOOM_CONFLICT', 'iCloud reports conflicting MortalLoom versions. Review them in MortalLoom before writing from PortOS.'],
  revisionChanged: ['MORTALLOOM_REVISION_CHANGED', 'MortalLoom changed while PortOS was saving. Refresh and retry the edit.'],
  unsafePath: ['MORTALLOOM_UNSAFE_PATH', 'Choose the MortalLoom JSON file itself, not a symbolic link or directory.'],
  uncertain: ['MORTALLOOM_COMMIT_UNCERTAIN', 'The edit may have reached iCloud. Refresh before retrying. A private recovery copy was kept.'],
  unavailable: ['MORTALLOOM_UNAVAILABLE', 'Could not verify the MortalLoom revision. The saved backup is available in MortalLoom settings.'],
  helperUnavailable: ['MORTALLOOM_HELPER_UNAVAILABLE', 'MortalLoom edits need the macOS Command Line Tools (xcode-select --install).'],
  unsupported: ['MORTALLOOM_UNSUPPORTED', 'Editing an iCloud MortalLoom file requires a Mac.'],
  reduced: ['MORTALLOOM_HISTORY_REDUCED', 'This file is missing substantial history compared with a verified recovery copy. PortOS paused shared edits. Review the copies in Settings → MortalLoom.'],
  invalid: ['MORTALLOOM_INVALID', 'MortalLoom file is unreadable or incompatible. No replacement was written.'],
  oversized: ['MORTALLOOM_TOO_LARGE', 'MortalLoom file exceeds the safe write size. Export a backup from MortalLoom before retrying.'],
  disabled: ['MORTALLOOM_DISABLED', 'Enable MortalLoom sync before writing to its store.'],
});
export function storeFailure(reason) {
  const [code, message] = failures[reason] ?? failures.unavailable;
  return new ServerError(message, { status: 409, code });
}

export const mortalLoomRevision = bytes => createHash('sha256').update(bytes).digest('hex');

function validateTarget(path) {
  if (!path) throw storeFailure('missing');
  const resolved = canonicalizePath(path);
  if (isVitestRunner() && !isPathAtOrInsideDir(canonicalizePath(tmpdir()), resolved)) {
    throw storeFailure('unsafePath');
  }
  return isUbiquityPath(path) || isUbiquityPath(resolved);
}

async function runMac(action, path, cloud, expected = '', candidate = '') {
  const helperPath = await macHelper();
  try {
    const { stdout } = await run(helperPath, [action, path, cloud ? 'icloud' : 'file', expected, candidate], {
      timeout: 12_000, killSignal: 'SIGKILL', maxBuffer: 1024,
    });
    const result = stdout.trim();
    if (result !== 'ok') throw storeFailure(result);
  } catch (error) {
    if (error instanceof ServerError) throw error;
    throw storeFailure(action === 'commit' ? 'uncertain' : 'unavailable');
  }
}

/** Canonical health data never becomes an uncoordinated cloud-path write. */
export async function inspectMortalLoomTarget(path) {
  const cloud = validateTarget(path);
  if (cloud && HOST_OS !== 'darwin') throw storeFailure('unsupported');
  const st = await lstat(path).catch(error => { throw storeFailure(error.code === 'ENOENT' ? 'missing' : 'unavailable'); });
  if (!st.isFile() || st.isSymbolicLink()) throw storeFailure('unsafePath');
  if (st.size > MORTALLOOM_MAX_BYTES) throw storeFailure('oversized');
  if (cloud) return runMac('inspect', path, cloud);
}

function snapshotFolder(path) {
  const root = isVitestRunner() ? join(dirname(path), '.mortal-loom-audit-snapshots') : join(homedir(), '.portos', 'mortalloom-snapshots');
  return join(root, mortalLoomRevision(resolve(path)));
}

export async function listMortalLoomSnapshots(path) {
  validateTarget(path);
  const files = await readdir(snapshotFolder(path), { withFileTypes: true })
    .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return files.flatMap(file => {
    const [date, id] = file.name.split('--');
    if (!file.isFile() || !id?.endsWith('.json') || !SHA.test(id.slice(0, -5))) return [];
    const time = Number(date);
    if (!Number.isSafeInteger(time) || time <= 0 || time > 8.64e15) return [];
    return [{ name: file.name, id: id.slice(0, -5), savedAt: new Date(time).toISOString() }];
  }).sort((a, b) => b.name.localeCompare(a.name));
}

export async function readMortalLoomSnapshot(path, id) {
  if (typeof id !== 'string' || !SHA.test(id)) throw storeFailure('invalid');
  const row = (await listMortalLoomSnapshots(path)).find(entry => entry.id === id);
  if (!row) throw storeFailure('missing');
  const st = await lstat(join(snapshotFolder(path), row.name));
  if (!st.isFile() || st.size > MORTALLOOM_MAX_BYTES) throw storeFailure('invalid');
  const bytes = await readFile(join(snapshotFolder(path), row.name));
  if (bytes.length > MORTALLOOM_MAX_BYTES || mortalLoomRevision(bytes) !== id) throw storeFailure('invalid');
  return bytes;
}

async function snapshot(path, expected) {
  const folder = snapshotFolder(path);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const id = mortalLoomRevision(expected);
  const existing = (await listMortalLoomSnapshots(path)).find(row => row.id === id);
  if (existing) {
    await readMortalLoomSnapshot(path, id); // verify rather than trusting a filename
    return;
  }
  const target = join(folder, `${Date.now()}--${id}.json`);
  await writeFile(target, expected, { mode: 0o600, flag: 'wx', flush: true });
  const bytes = await readFile(target);
  if (!bytes.equals(expected)) throw storeFailure('unavailable');
}

async function commitRegularFile(path, expected, candidate) {
  // Non-macOS custom paths have no NSFileCoordinator. Check the exact
  // preimage immediately before rename. This is not a multi-host lock.
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) throw storeFailure('unsafePath');
    await writeFile(temp, candidate, { flag: 'wx', mode: existing.mode & 0o600, flush: true });
    if (!(await readFile(path)).equals(expected)) throw storeFailure('revisionChanged');
    await rename(temp, path);
    if (!(await readFile(path).catch(() => null))?.equals(candidate)) throw storeFailure('uncertain');
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function commitMortalLoomRevision(path, expected, candidate, { preservePreimage = true } = {}) {
  const cloud = validateTarget(path);
  if (cloud && HOST_OS !== 'darwin') throw storeFailure('unsupported');
  if (expected.length > MORTALLOOM_MAX_BYTES || candidate.length > MORTALLOOM_MAX_BYTES) throw storeFailure('oversized');
  if (expected.equals(candidate)) return;
  // Outside iCloud and outside the PortOS served/federated data directory.
  // Never publish first and hope a usable preimage was preserved afterward.
  if (preservePreimage) await snapshot(path, expected);
  try {
    await publish(path, cloud, expected, candidate);
  } finally {
    const backups = await listMortalLoomSnapshots(path).catch(() => []);
    await Promise.all(backups.slice(KEEP).map(row => rm(join(snapshotFolder(path), row.name), { force: true }).catch(() => {})));
  }
}

async function publish(path, cloud, expected, candidate) {
  if (HOST_OS === 'darwin') {
    const stage = await mkdtemp(join(tmpdir(), 'portos-mortalloom-stage-'));
    try {
      const before = join(stage, 'expected');
      const after = join(stage, 'candidate');
      await Promise.all([writeFile(before, expected, { mode: 0o600 }), writeFile(after, candidate, { mode: 0o600 })]);
      await runMac('commit', path, cloud, before, after);
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    await commitRegularFile(path, expected, candidate);
  }
}
