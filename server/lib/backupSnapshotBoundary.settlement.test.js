import { expect, it, vi } from 'vitest';
import { maintenance } from './maintenanceAdmission.js';
import { acquireBackupSnapshotCut, withBackupAssetPublication } from './backupSnapshotBoundary.js';

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
