import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { backupPublicationAdmissionStatus, acquireBackupSnapshotCut, runOutsideBackupAssetPublication, withBackupAssetPublication } from './backupSnapshotBoundary.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => vi.useRealTimers());

describe('backup snapshot publication admission', () => {
  it('drains a whole admitted workflow and holds a new one through the cut', async () => {
    const rowWrite = deferred();
    const first = withBackupAssetPublication(async () => {
      await withBackupAssetPublication(async () => rowWrite.promise);
      return 'published';
    });
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => {
      cutReady = true;
      return release;
    });
    let secondStarted = false;
    const second = withBackupAssetPublication(() => { secondStarted = true; });
    await Promise.resolve();
    expect(cutReady).toBe(false);
    expect(secondStarted).toBe(false);

    rowWrite.resolve();
    expect(await first).toBe('published');
    const release = await cut;
    expect(secondStarted).toBe(false);
    release();
    await second;
    expect(secondStarted).toBe(true);
  });

  it('lets only the current owner reopen admission and refuses a competing or nested cut', async () => {
    const releaseFirst = await acquireBackupSnapshotCut();
    await expect(acquireBackupSnapshotCut()).rejects.toThrow('already owned');
    releaseFirst();
    releaseFirst();

    const releaseSecond = await acquireBackupSnapshotCut();
    releaseFirst(); // a stale release from the earlier cut must not open this one
    let admitted = false;
    const waiting = withBackupAssetPublication(() => { admitted = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(admitted).toBe(false);
    releaseSecond();
    await waiting;
    expect(admitted).toBe(true);

    await withBackupAssetPublication(async () => {
      await expect(acquireBackupSnapshotCut()).rejects.toThrow('inside an asset publication');
    });
  });

  it('reopens admission when an admitted workflow cannot drain', async () => {
    vi.useFakeTimers();
    const rowWrite = deferred();
    const first = withBackupAssetPublication(() => rowWrite.promise);
    const cut = acquireBackupSnapshotCut({ timeoutMs: 100 });
    const rejected = expect(cut).rejects.toThrow('Timed out draining asset publications');
    const next = vi.fn();
    const waiting = withBackupAssetPublication(next);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    await waiting;
    expect(next).toHaveBeenCalledOnce();
    rowWrite.resolve();
    await first;
  });

  it.each([false, true])('retains explicit rollback uncertainty after local callbacks settle (caught nested=%s)', async nested => {
    const error = Object.assign(new Error('rollback incomplete'), { backupPublicationUncertain: true });
    try {
      if (nested) {
        await withBackupAssetPublication(async () => {
          await withBackupAssetPublication(async () => { throw error; }).catch(() => {});
        });
      } else {
        await expect(withBackupAssetPublication(async () => { throw error; })).rejects.toBe(error);
      }
      const owners = backupPublicationAdmissionStatus().publications;
      expect(owners).toEqual([expect.objectContaining({ kind: 'publication', uncertain: true })]);
      expect(error).toMatchObject({ recoveryPath: owners[0].path, backupPublicationOwner: { id: owners[0].id, path: owners[0].path } });
      await expect(acquireBackupSnapshotCut({ timeoutMs: 10 })).rejects.toMatchObject({
        code: 'BACKUP_SNAPSHOT_BUSY', blockers: [expect.objectContaining({ id: owners[0].id, uncertain: true })],
      });
      // Successful rollback failures do not leave another recovery owner.
      await expect(withBackupAssetPublication(async () => { throw new Error('rolled back'); })).rejects.toThrow('rolled back');
      expect(backupPublicationAdmissionStatus().publications).toHaveLength(1);
    } finally {
      // Explicit fixture teardown, never a production stale-owner recovery.
      for (const owner of backupPublicationAdmissionStatus().publications) rmSync(owner.path, { recursive: true });
    }
    const release = await acquireBackupSnapshotCut();
    release();
  });

  it('bounds a local publication wait without releasing the cut or leaving a queued callback', async () => {
    vi.useFakeTimers();
    const release = await acquireBackupSnapshotCut();
    const work = vi.fn();
    try {
      const pending = withBackupAssetPublication(work, { timeoutMs: 50 });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY',
        owner: expect.objectContaining({ kind: 'snapshot' }) });
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(work).not.toHaveBeenCalled();
      await expect(acquireBackupSnapshotCut()).rejects.toMatchObject({ code: 'BACKUP_SNAPSHOT_BUSY' });
    } finally { release(); }
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    await expect(withBackupAssetPublication(() => 'recovered')).resolves.toBe('recovered');
  });

  it('lets a listener spawned by an admitted workflow join it only while that workflow holds its lease', async () => {
    const listenerWrite = deferred();
    let listener;
    let later;
    const emitter = withBackupAssetPublication(async () => {
      runOutsideBackupAssetPublication(() => {
        listener = withBackupAssetPublication(async () => listenerWrite.promise);
        later = new Promise(resolve => setImmediate(resolve)).then(() => withBackupAssetPublication(() => 'late'));
      });
    });
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => {
      cutReady = true;
      return release;
    });
    await emitter;
    await new Promise(resolve => setImmediate(resolve));
    expect(cutReady).toBe(false); // the cut also waits for the spawned listener
    listenerWrite.resolve();
    await listener;
    const release = await cut;
    let lateRan = false;
    later.then(() => { lateRan = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(lateRan).toBe(false); // admitted after the spawner finished: waits behind the cut
    release();
    expect(await later).toBe('late');
  });
});
