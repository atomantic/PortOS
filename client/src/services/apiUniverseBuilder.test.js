// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./apiCore.js', () => ({ request }));

import { patchUniverseCanonEntry, updateUniverse, waitForUniverseWrites } from './apiUniverseBuilder.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('Universe Builder write tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('waits for a tracked write to settle before resolving', async () => {
    const pending = deferred();
    request.mockReturnValueOnce(pending.promise);
    const write = updateUniverse('u-1', { name: 'Example World' });
    let waited = false;
    const wait = waitForUniverseWrites('u-1').then((ready) => {
      waited = true;
      return ready;
    });

    await Promise.resolve();
    expect(waited).toBe(false);
    pending.resolve({ id: 'u-1' });
    await expect(write).resolves.toEqual({ id: 'u-1' });
    await expect(wait).resolves.toBe(true);
    expect(waited).toBe(true);
  });

  it('clears rejected writes so a later export is not left waiting forever', async () => {
    const pending = deferred();
    request.mockReturnValueOnce(pending.promise);
    const write = updateUniverse('u-1', { name: 'Example World' });
    const wait = waitForUniverseWrites('u-1');
    pending.reject(new Error('write failed'));

    await expect(write).rejects.toThrow('write failed');
    await expect(wait).resolves.toBe(true);
    await expect(waitForUniverseWrites('u-1')).resolves.toBe(true);
  });

  it('resolves immediately when no universe id is supplied', async () => {
    await expect(waitForUniverseWrites()).resolves.toBe(true);
  });

  it('orders canon edits across callers and keeps queued edits in the export wait after a failed write', async () => {
    const first = deferred();
    const second = deferred();
    request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = patchUniverseCanonEntry('u-1', 'place', 'p-1', { timeOfDay: 'DAY' });
    const b = patchUniverseCanonEntry('u-1', 'place', 'p-1', { timeOfDay: 'NIGHT' });
    let ready = false;
    const wait = waitForUniverseWrites('u-1').then(value => { ready = value; });
    // Queue the rejection assertion before rejecting, so it owns the failure.
    const rejected = expect(a).rejects.toThrow('offline');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    first.reject(new Error('offline'));
    await rejected;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(ready).toBe(false);
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ timeOfDay: 'NIGHT' });
    second.resolve({ entry: { id: 'p-1', timeOfDay: 'NIGHT' } });
    await b;
    await wait;
    expect(ready).toBe(true);
  });

  it('gives up when a tracked write outlives the wait bound', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred();
      request.mockReturnValueOnce(pending.promise);
      const write = updateUniverse('u-1', { name: 'Example World' });
      const wait = waitForUniverseWrites('u-1', { timeoutMs: 50 });

      await vi.advanceTimersByTimeAsync(60);
      await expect(wait).resolves.toBe(false);
      pending.resolve({ id: 'u-1' });
      await expect(write).resolves.toEqual({ id: 'u-1' });
    } finally {
      vi.useRealTimers();
    }
  });
});
