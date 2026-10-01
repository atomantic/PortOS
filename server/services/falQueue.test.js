import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitFalCompletion, createFalRequestEntry } from './falQueue.js';

afterEach(() => vi.unstubAllGlobals());

describe('awaitFalCompletion', () => {
  // A cancel that lands while submit is in flight finds no cancel_url, so the
  // remote cancel is a no-op; the receipt arrives afterwards. The paid render
  // must still be cancelled remotely instead of left queued at fal.ai.
  it('sends the remote cancel when the job was cancelled before the receipt arrived', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const entry = createFalRequestEntry('test-key');
    entry.aborted = true;
    entry.cancelUrl = 'https://queue.fal.run/example/requests/abc/cancel';

    const result = await awaitFalCompletion({
      entry, statusUrl: 'https://queue.fal.run/example/requests/abc/status',
      apiKey: 'test-key', deadline: Date.now() + 60_000, timeoutMs: 60_000,
    });

    expect(result).toEqual({ outcome: 'canceled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(entry.cancelUrl);
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
  });
});
