// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./apiCore.js', () => ({ request }));

import { updateUniverse, waitForUniverseWrites } from './apiUniverseBuilder.js';

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
