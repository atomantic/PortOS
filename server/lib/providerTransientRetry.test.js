import { describe, it, expect, vi } from 'vitest';
import { isTransientProviderError, runWithTransientRetry } from './providerTransientRetry.js';

describe('isTransientProviderError', () => {
  it.each([
    "I'm sorry, I'm experiencing unusually high traffic right now generating videos and am at full capacity. Please try again later.",
    'The model is overloaded. Please try again shortly.',
    'HTTP 503 Service Unavailable',
    'Error 429: Too Many Requests',
    'You are being rate limited',
    'The service is temporarily unavailable',
  ])('treats a busy provider as transient: %s', (text) => {
    expect(isTransientProviderError(text)).toBe(true);
    expect(isTransientProviderError(new Error(text))).toBe(true);
  });

  it.each([
    'you reached your limit',
    "You've reached your daily video limit. Try again tomorrow.",
    'You exceeded your current quota, please check your plan',
    'Upgrade to Pro for more videos, then try again later',
    'Something went wrong',
    'Content blocked by safety filters',
    '',
  ])('does not resend a hard limit or an unrelated failure: %s', (text) => {
    expect(isTransientProviderError(text)).toBe(false);
  });

  it('lets a lane override the text with an explicit transient flag', () => {
    expect(isTransientProviderError(Object.assign(new Error('opaque'), { transient: true }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error('at full capacity'), { transient: false }))).toBe(false);
  });
});

describe('runWithTransientRetry', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, wait: async (ms) => { t += ms; } };
  };

  it('waits out each delay with countdown ticks, then returns the first success', async () => {
    const { now, wait } = clock();
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('at capacity'))
      .mockRejectedValueOnce(new Error('at capacity'))
      .mockResolvedValueOnce('clip');
    const waits = [];
    const result = await runWithTransientRetry(attempt, {
      delaysMs: [10, 20], tickMs: 5, now, wait, onRetryWait: ({ retry, retries, remainingMs }) => waits.push([retry, retries, remainingMs]),
    });
    expect(result).toBe('clip');
    expect(attempt.mock.calls.map(([n]) => n)).toEqual([0, 1, 2]);
    expect(waits).toEqual([[1, 2, 10], [1, 2, 5], [2, 2, 20], [2, 2, 15], [2, 2, 10], [2, 2, 5]]);
  });

  it('rethrows a non-transient failure at once', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('reached your limit'));
    await expect(runWithTransientRetry(attempt, { delaysMs: [10], ...clock() })).rejects.toThrow('reached your limit');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('marks the last error with the resends made when the retries run out', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('overloaded'));
    const err = await runWithTransientRetry(attempt, { delaysMs: [10, 10], ...clock() }).catch((e) => e);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(err.transientRetriesExhausted).toBe(2);
  });

  it('stops waiting when the signal aborts and rethrows the busy error', async () => {
    const controller = new AbortController();
    const attempt = vi.fn().mockRejectedValue(new Error('at capacity'));
    const pending = runWithTransientRetry(attempt, { delaysMs: [60_000], signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow('at capacity');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
