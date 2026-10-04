import { describe, expect, it, vi } from 'vitest';

// The real journal reads the install's data root; a seam stands in for its fence.
const fence = vi.hoisted(() => ({ fenced: false }));
vi.mock('./databaseMaintenanceJournal.js', () => ({
  assertDatabaseAdmission: () => {
    if (fence.fenced) throw Object.assign(new Error('Persistent database maintenance is active'), { status: 503, code: 'DATABASE_MAINTENANCE' });
  },
}));

import { acquireBackupSnapshotCut, withBackupAssetPublication } from './backupSnapshotBoundary.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

describe('backup snapshot boundary under database maintenance', () => {
  it('lets an admitted workflow finish, then refuses the cut and reopens admission when maintenance fenced while draining', async () => {
    let finishRow;
    let completed = false;
    const admitted = withBackupAssetPublication(() => new Promise(resolve => { finishRow = resolve; })).then(() => { completed = true; });
    const cut = acquireBackupSnapshotCut().catch(error => error);
    await settle();
    fence.fenced = true;
    finishRow();
    await admitted;
    try {
      expect(await cut).toMatchObject({ code: 'DATABASE_MAINTENANCE' });
    } finally {
      fence.fenced = false;
    }
    expect(completed).toBe(true);
    // The refused cut owned nothing: a later one is available and publication is open.
    const release = await acquireBackupSnapshotCut();
    release();
    await expect(withBackupAssetPublication(() => 'admitted')).resolves.toBe('admitted');
  });

  it('marks a competing cut and a drain timeout retryable without disturbing the owner', async () => {
    const release = await acquireBackupSnapshotCut();
    await expect(acquireBackupSnapshotCut()).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY', status: 503 });
    release();

    let finishRow;
    const stuck = withBackupAssetPublication(() => new Promise(resolve => { finishRow = resolve; }));
    await expect(acquireBackupSnapshotCut({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY' });
    finishRow();
    await stuck;
  });
});
