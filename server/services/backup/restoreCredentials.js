/** Stage verified credential records and publish them with owner-only permissions during live restore. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { ServerError } from '../../lib/errorHandler.js';
import { RESTORE_CREDENTIAL_FILES } from './excludes.js';

const OWNER_ONLY = 0o600;
const PRIVATE_DIRECTORY = 'private';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_API_KEYS = `${PRIVATE_DIRECTORY}/api-keys.json`;
const unsafeCredential = name => new ServerError(
  `Cannot restore credential record ${name} from or onto an unsafe filesystem entry.`,
  { status: 409, code: 'BACKUP_RESTORE_UNSAFE_CREDENTIAL' },
);

const entryInfo = path => lstat(path).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

const isCredentialFile = entry => entry.isFile() && entry.nlink === 1;
const isDirectory = entry => entry.isDirectory();
const hasMode = (entry, mode) => process.platform === 'win32' || (entry.mode & 0o7777) === mode;

async function withCheckedEntry(path, name, accepts, use) {
  const entry = await entryInfo(path);
  if (!entry) return null;
  if (!accepts(entry)) throw unsafeCredential(name);
  // Verify the opened inode. O_NONBLOCK avoids a substituted FIFO hanging the
  // restore, and O_NOFOLLOW refuses a substituted symlink where supported.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await open(path, flags).catch(error => {
    if (error.code === 'ELOOP') throw unsafeCredential(name);
    throw error;
  });
  try {
    const info = await file.stat();
    if (!accepts(info) || info.dev !== entry.dev || info.ino !== entry.ino) throw unsafeCredential(name);
    return await use(file, info);
  } finally {
    await file.close();
  }
}

export const readCredentialFile = (path, name = basename(path)) =>
  withCheckedEntry(path, name, isCredentialFile, file => file.readFile());

export function scopeTouchesPrivateDirectory(scope) {
  const normalized = scope?.toLowerCase();
  return !normalized || normalized === PRIVATE_DIRECTORY || normalized.startsWith(`${PRIVATE_DIRECTORY}/`);
}

function selectsCredential(scope, name) {
  const normalized = scope?.toLowerCase();
  return !normalized || normalized === name || name.startsWith(`${normalized}/`);
}

async function readCredentialDirectory(parent, entries, name) {
  const canonical = entries.filter(entry => entry.toLowerCase() === name);
  if (canonical.length === 0) return [];
  if (canonical.some(entry => entry !== name) || !(await entryInfo(join(parent, name)))?.isDirectory()) {
    throw unsafeCredential(name);
  }
  return readdir(join(parent, name));
}

export async function readSnapshotCredentials(srcDir, scope) {
  const credentials = new Map();
  const selected = RESTORE_CREDENTIAL_FILES.filter(name => selectsCredential(scope, name));
  if (selected.length === 0 && !scopeTouchesPrivateDirectory(scope)) return credentials;
  const source = await entryInfo(srcDir);
  if (!source) return credentials;
  if (!source.isDirectory()) throw unsafeCredential(selected[0] ?? PRIVATE_DIRECTORY);

  const rootEntries = await readdir(srcDir);
  const privateEntries = scopeTouchesPrivateDirectory(scope)
    ? await readCredentialDirectory(srcDir, rootEntries, PRIVATE_DIRECTORY)
    : [];
  // Match rsync's case-insensitive excludes while requiring canonical paths for
  // the staged copy, including its parent and any scope selecting the record.
  for (const name of selected) {
    const privateRecord = name === PRIVATE_API_KEYS;
    const filename = privateRecord ? 'api-keys.json' : name;
    const entries = privateRecord ? privateEntries : rootEntries;
    for (const entry of entries) {
      if (entry.toLowerCase() !== filename) continue;
      if (entry !== filename || (scope && scope !== scope.toLowerCase())) throw unsafeCredential(name);
      const bytes = await readCredentialFile(join(srcDir, name), name);
      if (bytes === null) throw unsafeCredential(name);
      credentials.set(name, bytes);
    }
  }
  return credentials;
}

async function securePrivateDirectory(destDir, { dryRun, create = false }) {
  const path = join(destDir, PRIVATE_DIRECTORY);
  let entry = await entryInfo(path);
  if (!entry && create && !dryRun) {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    entry = await entryInfo(path);
  }
  if (!entry) return false;
  if (!isDirectory(entry)) throw unsafeCredential(PRIVATE_DIRECTORY);
  const modeChanged = !hasMode(entry, PRIVATE_DIRECTORY_MODE);
  if (modeChanged && !dryRun) {
    await withCheckedEntry(path, PRIVATE_DIRECTORY, isDirectory, dir => dir.chmod(PRIVATE_DIRECTORY_MODE));
  }
  return modeChanged;
}

export async function transferWithCredentials(credentials, destDir, transfer, { dryRun, scope }) {
  const touchesPrivate = scopeTouchesPrivateDirectory(scope);
  const changes = [];
  if (touchesPrivate && await securePrivateDirectory(destDir, { dryRun })) {
    changes.push({ line: `.d...p..... ${PRIVATE_DIRECTORY}/` });
  }
  // The archive copy can update the parent directory's permissions. Tighten
  // any live keys before it runs, including when only a private sibling is
  // restored, and reinstate directory permissions before publishing new bytes.
  const selected = new Map(credentials);
  if (touchesPrivate && !selected.has(PRIVATE_API_KEYS)) selected.set(PRIVATE_API_KEYS, null);
  for (const [name, bytes] of selected) {
    const path = join(destDir, name);
    const change = await withCheckedEntry(path, name, isCredentialFile, async (file, info) => {
      const modeChanged = !hasMode(info, OWNER_ONLY);
      if (modeChanged && !dryRun) await file.chmod(OWNER_ONLY);
      if (bytes && !bytes.equals(await file.readFile())) return modeChanged ? '>fc..p.....' : '>fc........';
      return modeChanged ? '.f...p.....' : '';
    });
    if (change !== '' && (change !== null || bytes)) changes.push({ path, bytes, line: `${change ?? '>f+++++++++'} ${name}` });
  }

  let changedFiles;
  try {
    changedFiles = await transfer();
  } finally {
    if (touchesPrivate && !dryRun) await securePrivateDirectory(destDir, { dryRun });
  }
  if (!dryRun) {
    if (credentials.has(PRIVATE_API_KEYS)) await securePrivateDirectory(destDir, { dryRun, create: true });
    for (const { path, bytes } of changes) {
      if (bytes) await atomicWrite(path, bytes, { mode: OWNER_ONLY });
    }
  }
  return changedFiles.concat(changes.map(({ line }) => line));
}
