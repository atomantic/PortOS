import { describe, expect, it, vi } from 'vitest';
import { navigateWithRetry } from './open-ui-in-browser.js';

const baseOpts = {
  totalTimeoutMs: 10_000,
  intervalMs: 1_000,
  sleep: vi.fn().mockResolvedValue(undefined),
};

describe('navigateWithRetry', () => {
  it('resolves immediately when the first attempt succeeds', async () => {
    const navigateFn = vi.fn().mockResolvedValue({ id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' });
    const result = await navigateWithRetry({ ...baseOpts, navigateFn });
    expect(result).toEqual({ ok: true, page: { id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' } });
    expect(navigateFn).toHaveBeenCalledTimes(1);
    expect(baseOpts.sleep).not.toHaveBeenCalled();
  });

  it('retries past a cold-launching browser (Chrome not up yet) and eventually succeeds', async () => {
    // Simulates the update.sh race: Chrome is still cold-launching so the first
    // couple of navigate attempts fail (CDP connection refused), then it comes up.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const navigateFn = vi.fn()
      .mockRejectedValueOnce(new Error('CDP open-blank failed: connect ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('CDP open-blank failed: connect ECONNREFUSED'))
      .mockResolvedValueOnce({ id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' });

    const result = await navigateWithRetry({ ...baseOpts, sleep, navigateFn });

    expect(result).toEqual({ ok: true, page: { id: 'tab-1', url: 'https://host.example-tailnet.ts.net:5555' } });
    expect(navigateFn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('gives up once the total retry budget is exhausted, returning the last failure', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms) => { now += ms; });
    const navigateFn = vi.fn().mockRejectedValue(new Error('CDP open-blank failed: connect ECONNREFUSED'));

    const result = await navigateWithRetry({
      ...baseOpts,
      totalTimeoutMs: 3_000,
      intervalMs: 1_000,
      sleep,
      navigateFn,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('CDP open-blank failed: connect ECONNREFUSED');
    // Budget of 3000ms at 1000ms/attempt: attempts stop once the next sleep
    // would cross the deadline, so it must not spin forever.
    expect(navigateFn.mock.calls.length).toBeGreaterThan(0);
    expect(navigateFn.mock.calls.length).toBeLessThan(10);

    vi.restoreAllMocks();
  });

  it('surfaces a thrown refusal (e.g. the SSRF pin rejecting a redirect) as a retryable failure, not a crash', async () => {
    const navigateFn = vi.fn().mockRejectedValue(new Error('refusing to ingest: response IP not allowed'));
    const result = await navigateWithRetry({ ...baseOpts, totalTimeoutMs: 500, intervalMs: 1000, navigateFn });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to ingest');
  });
});
