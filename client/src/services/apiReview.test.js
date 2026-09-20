import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
  queryString: (params = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const encoded = query.toString();
    return encoded ? `?${encoded}` : '';
  },
}));

let request;
let getReviewQueue;
let resolveReviewQueueItem;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ getReviewQueue, resolveReviewQueueItem } = await import('./apiReview.js'));
  request.mockReset();
});

describe('getReviewQueue', () => {
  it('encodes pagination in the query while preserving request options', async () => {
    request.mockResolvedValue({ items: [] });

    await getReviewQueue({ limit: 25, cursor: 'snapshot/page', silent: true });

    expect(request).toHaveBeenCalledWith('/review/queue?limit=25&cursor=snapshot%2Fpage', { silent: true });
  });

  it('keeps the legacy options-only call query-free', async () => {
    request.mockResolvedValue({ items: [] });

    await getReviewQueue({ silent: true });

    expect(request).toHaveBeenCalledWith('/review/queue', { silent: true });
  });
});

describe('resolveReviewQueueItem', () => {
  it('keeps source operations in the body and transport options separate', async () => {
    request.mockResolvedValue({ resolved: true });

    await resolveReviewQueueItem('memory:memory-1', { operation: 'approve', silent: true });

    expect(request).toHaveBeenCalledWith('/review/queue/resolve', {
      method: 'POST',
      body: JSON.stringify({ id: 'memory:memory-1', operation: 'approve' }),
      silent: true,
    });
  });
});
