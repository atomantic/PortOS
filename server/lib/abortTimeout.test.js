import { describe, it, expect } from 'vitest';
import { withAbortTimeout } from './abortTimeout.js';

describe('withAbortTimeout', () => {
  it('passes a live signal to fn and leaves it un-aborted when fn settles in time', async () => {
    let captured;
    const result = await withAbortTimeout(10_000, async (signal) => {
      captured = signal;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured.aborted).toBe(false);
  });

  it('aborts the signal when fn outlives the timeout', async () => {
    const aborted = await withAbortTimeout(20, (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(signal.aborted));
    }));
    expect(aborted).toBe(true);
  });

  it('propagates the rejection from fn (and still clears the timer)', async () => {
    await expect(
      withAbortTimeout(10_000, async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
  });
});
