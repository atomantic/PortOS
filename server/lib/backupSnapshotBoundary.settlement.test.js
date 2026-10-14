import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from './mockPathsDataRoot.js';
import { expect, it, vi, afterAll } from 'vitest';
import { maintenance } from './maintenanceAdmission.js';
import { acquireBackupSnapshotCut, withBackupAssetPublication } from './backupSnapshotBoundary.js';

// The admission lease is minted from PATHS.data (backupSharedAdmission.js). Redirect
// PATHS so it lands in an OS temp dir: a checkout nested under the install's data/
// (a CoS claim worktree) would otherwise resolve PATHS.data to its own data/, and the
// real-data write guard refuses the lease write. Lazy because these suites import
// their SUT statically and vi.mock is hoisted above any const here.
vi.mock('./paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-backup-boundary-'),
}));

afterAll(cleanupTempDataRoots);

it('keeps waiting publication owned, retires only refused admission, and retains a started failed write', async () => {
  vi.useFakeTimers();
  const parent = maintenance.admit('agent', 'fixture-agent');
  const unrelated = maintenance.admit('provider', 'fixture-other');
  const release = await acquireBackupSnapshotCut();
  const work = vi.fn();
  try {
    const pending = parent.run(() => withBackupAssetPublication(work, { timeoutMs: 50 }));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY' });
    const hold = maintenance.begin({ reason: 'Fixture drain', owner: 'Test' }).hold;
    await parent.finish();
    expect(maintenance.status().blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'settlement', resource: 'Output publication' }),
      expect.objectContaining({ resource: 'fixture-other' }),
    ]));
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(work).not.toHaveBeenCalled();
    expect(maintenance.status().blockers).toEqual([expect.objectContaining({ resource: 'fixture-other' })]);
    release();
    await unrelated.finish();
    expect(maintenance.status().state).toBe('ready');
    maintenance.resume({ id: hold.id, revision: hold.revision });

    const retry = maintenance.admit('agent', 'fixture-retry');
    await expect(retry.run(() => withBackupAssetPublication(work))).resolves.toBeUndefined();
    expect(work).toHaveBeenCalledOnce();
    // The code alone is never proof: a callback can fail after writing with
    // exactly the same retryable error code as an admission timeout.
    const failure = Object.assign(new Error('failed after write'), { code: 'BACKUP_SNAPSHOT_BUSY' });
    let wrote = false;
    await expect(retry.run(() => withBackupAssetPublication(() => {
      wrote = true;
      throw failure;
    }))).rejects.toBe(failure);
    await retry.finish();
    maintenance.begin({ reason: 'Fixture final drain', owner: 'Test' });
    expect(wrote).toBe(true);
    expect(maintenance.status()).toMatchObject({ state: 'draining', blockers: [
      { kind: 'settlement', resource: 'Output publication', unsettled: true },
    ] });
  } finally {
    release();
    vi.useRealTimers();
  }
});
