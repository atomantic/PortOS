import { describe, it, expect, vi, afterEach } from 'vitest';
import { sleep } from './sleep.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = sleep(500).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('resolves with undefined', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});
