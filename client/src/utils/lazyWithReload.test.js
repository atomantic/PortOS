import { describe, it, expect, vi } from 'vitest';
import { importWithRetry } from './lazyWithReload';

describe('importWithRetry', () => {
  it('resolves on the first attempt without retrying', async () => {
    const mod = { default: () => null };
    const importFn = vi.fn().mockResolvedValue(mod);
    await expect(importWithRetry(importFn)).resolves.toBe(mod);
    expect(importFn).toHaveBeenCalledTimes(1);
  });

  it('recovers from a transient failure by retrying (flaky mobile network)', async () => {
    vi.useFakeTimers();
    const mod = { default: () => null };
    const importFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Importing a module script failed'))
      .mockResolvedValueOnce(mod);
    const promise = importWithRetry(importFn);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(mod);
    expect(importFn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('re-throws after exhausting all attempts', async () => {
    vi.useFakeTimers();
    const err = new Error('Importing a module script failed');
    const importFn = vi.fn().mockRejectedValue(err);
    const promise = importWithRetry(importFn);
    // Attach a rejection handler up front so the eventual rejection is never
    // an unhandled promise while fake timers advance.
    const settled = expect(promise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await settled;
    // 1 initial attempt + MAX_RETRIES (2) = 3 total
    expect(importFn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
