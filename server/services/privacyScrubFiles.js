/** File admission and regular-file reads shared by local Privacy Vault cleanup operations. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ServerError } from '../lib/errorHandler.js';

const scrubQueue = createFileWriteQueue();

async function missingAsNull(work) {
  return work.catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function readArtifact(path) {
  const stat = await missingAsNull(lstat(path));
  if (!stat?.isFile()) return null;
  return missingAsNull(readFile(path, 'utf8'));
}

export async function* childDirectories(root, pattern) {
  const entries = await missingAsNull(readdir(root, { withFileTypes: true }));
  for (const entry of entries || []) {
    if (entry.isDirectory() && pattern.test(entry.name)) yield join(root, entry.name);
  }
}

export async function withPrivacyScrub(work, prepare) {
  try {
    // Vault revocations already hold a DB connection while waiting for the
    // scrub queue. Acquire a manual cleanup's ciphertext before taking that
    // queue so it never waits for the pool while blocking those transactions.
    const input = await prepare?.();
    return await scrubQueue(() => withBackupAssetPublication(() => work(input)));
  } catch (error) {
    if (error instanceof ServerError && error.code === 'PRIVACY_ARTIFACT_NOT_FOUND') throw error;
    const failure = new ServerError('Could not scrub local Digital Twin run artifacts', {
      status: 500, code: 'PRIVACY_RUN_SCRUB_FAILED',
    });
    // The route error handler logs a 500's stack, including absolute install paths.
    failure.stack = failure.message;
    throw failure;
  }
}
