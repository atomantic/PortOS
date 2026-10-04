import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireBackupSnapshotCut, withBackupAssetPublication } from './backupSnapshotBoundary.js';

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
});
