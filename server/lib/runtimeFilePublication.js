/**
 * Admitted runtime recording updates with rollback of the prior file pair on failure, plus the
 * per-file turn a remover shares with them.
 */

import { readFile } from 'fs/promises';
import { atomicWrite, unlinkGuarded } from './fileUtils.js';
import { withBackupAssetPublication } from './backupSnapshotBoundary.js';
import { createKeyCachedQueue } from './createKeyCachedQueue.js';

const queues = createKeyCachedQueue();

/**
 * Run `work` in the same per-file turn `publishRuntimeFiles` takes for a pair
 * keyed by `path`, so a remover cannot land between a publication's read of
 * the record and its rewrite.
 */
export function withRuntimeFileTurn(path, work) {
  return withBackupAssetPublication(() => queues(path, work));
}

/** Publish a bounded runtime recording pair; failure restores its prior bytes. */
export function publishRuntimeFiles(paths, work) {
  return withBackupAssetPublication(() => queues(paths[0], async () => {
    const previous = await Promise.all(paths.map(path => readFile(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    try {
      return await work();
    } catch (error) {
      const rollback = await Promise.allSettled(paths.map((path, i) => previous[i] === null
        ? unlinkGuarded(path).catch(err => { if (err.code !== 'ENOENT') throw err; })
        : atomicWrite(path, previous[i])));
      const failures = rollback.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw Object.assign(
        new AggregateError([error, ...failures], 'Runtime recording publication and rollback failed'),
        { backupPublicationUncertain: true },
      );
      throw error;
    }
  }));
}
