/** Stage and publish the two root credential records with owner-only permissions during live restore. */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { ServerError } from '../../lib/errorHandler.js';
import { RESTORE_CREDENTIAL_FILES } from './excludes.js';

const OWNER_ONLY = 0o600;
const unsafeCredential = name => new ServerError(
  `Cannot restore credential record ${name} from or onto an unsafe filesystem entry.`,
  { status: 409, code: 'BACKUP_RESTORE_UNSAFE_CREDENTIAL' },
);

const entryInfo = path => lstat(path).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function withCredentialFile(path, read) {
  const entry = await entryInfo(path);
  if (!entry) return null;
  if (!entry.isFile()) throw unsafeCredential(basename(path));
  // Inspect the open inode too. O_NONBLOCK avoids waiting on a FIFO if the
  // entry was replaced after lstat and O_NOFOLLOW rejects a substituted link.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) throw unsafeCredential(basename(path));
    return await read(file, info);
  } finally {
    await file.close();
  }
}

export async function readSnapshotCredentials(srcDir, scope) {
  const credentials = new Map();
  const selected = RESTORE_CREDENTIAL_FILES.filter(name => !scope || scope.toLowerCase() === name);
  if (selected.length === 0) return credentials;
  const source = await entryInfo(srcDir);
  if (!source) return credentials;
  if (!source.isDirectory()) throw unsafeCredential(selected[0]);

  // Match rsync's root excludes on case-insensitive volumes. Refuse aliases
  // so a manifest entry cannot be verified yet silently skipped by the copy.
  for (const name of await readdir(srcDir)) {
    if (!selected.includes(name.toLowerCase())) continue;
    if (name !== name.toLowerCase() || (scope && scope !== name)) throw unsafeCredential(name);
    const bytes = await withCredentialFile(join(srcDir, name), file => file.readFile());
    if (bytes === null) throw unsafeCredential(name);
    credentials.set(name, bytes);
  }
  return credentials;
}

export async function transferWithCredentials(credentials, destDir, transfer, { dryRun }) {
  const changes = [];
  for (const [name, bytes] of credentials) {
    const path = join(destDir, name);
    const change = await withCredentialFile(path, async (file, info) => {
      const modeChanged = process.platform !== 'win32' && (info.mode & 0o7777) !== OWNER_ONLY;
      if (modeChanged) {
        if (info.nlink !== 1) throw unsafeCredential(name);
        // Secure pre-existing legacy bytes before the bulk transfer starts.
        // If it fails, the live record retains its old bytes at 0600.
        if (!dryRun) await file.chmod(OWNER_ONLY);
      }
      const bytesChanged = !bytes.equals(await file.readFile());
      if (bytesChanged) return modeChanged ? '>fc..p.....' : '>fc........';
      return modeChanged ? '.f...p.....' : '';
    });
    if (change !== '') changes.push({ path, bytes, line: `${change ?? '>f+++++++++'} ${name}` });
  }

  const changedFiles = await transfer();
  if (!dryRun) {
    for (const { path, bytes } of changes) {
      await atomicWrite(path, bytes, { mode: OWNER_ONLY });
    }
  }
  return changedFiles.concat(changes.map(({ line }) => line));
}
