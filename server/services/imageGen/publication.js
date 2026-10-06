import { readFile } from 'node:fs/promises';
import { atomicWrite, unlinkGuarded } from '../../lib/fileCore.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';

const publications = createKeyCachedQueue();

/** Replace an image/sketch pair together, restoring its previous bytes on failure. */
export function publishImageFiles(paths, work) {
  return withBackupAssetPublication(() => publications(paths[0], async () => {
    const previous = await Promise.all(paths.map(path => readFile(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })));
    try {
      return await work();
    } catch (error) {
      // Settle every rollback; a failed rollback retains the durable admission owner.
      const restored = await Promise.allSettled(paths.map((path, i) => previous[i] === null
        ? unlinkGuarded(path).catch(err => { if (err.code !== 'ENOENT') throw err; })
        : atomicWrite(path, previous[i])));
      const failures = restored.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw Object.assign(new AggregateError([error, ...failures], 'Image publication and rollback failed'), { backupPublicationUncertain: true });
      throw error;
    }
  }));
}
