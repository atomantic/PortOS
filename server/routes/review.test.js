import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const buildQueue = vi.fn();
const resolveQueueItem = vi.fn();
const promoteAskQueueItem = vi.fn();

vi.mock('../services/review.js', () => ({}));
vi.mock('../services/reviewQueue.js', () => ({
  buildQueue,
  resolveQueueItem,
  promoteAskQueueItem,
}));

const { default: routes } = await import('./review.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/review', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/review/queue', () => {
  it('passes the requested page through without reapplying the old source cap', async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ id: `brain:b${index}` }));
    buildQueue.mockResolvedValue({
      items,
      total: 40,
      totalsBySource: { brain: 40 },
      sources: { brain: { total: 40, shown: 40, availability: 'available', error: null, truncation: false } },
      nextCursor: null,
      partial: false,
    });

    const response = await request(makeApp()).get('/api/review/queue?limit=40');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(40);
    expect(buildQueue).toHaveBeenCalledWith({ limit: 40, cursor: undefined, query: {} });
  });

  it('rejects invalid pagination before the queue service is called', async () => {
    const response = await request(makeApp()).get('/api/review/queue?limit=0');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(buildQueue).not.toHaveBeenCalled();
  });

  it('forwards an opaque cursor unchanged for the next snapshot page', async () => {
    buildQueue.mockResolvedValue({ items: [], total: 0, totalsBySource: {}, sources: {}, nextCursor: null, partial: false });

    const response = await request(makeApp()).get('/api/review/queue?cursor=opaque-token');

    expect(response.status).toBe(200);
    expect(buildQueue).toHaveBeenCalledWith({ limit: undefined, cursor: 'opaque-token', query: {} });
  });
});

describe('POST /api/review/queue/resolve', () => {
  it('passes an explicit source operation to the queue service', async () => {
    resolveQueueItem.mockResolvedValue({ source: 'memory', id: 'memory:m1', operation: 'approve', resolved: true });

    const response = await request(makeApp())
      .post('/api/review/queue/resolve')
      .send({ id: 'memory:m1', operation: 'approve' });

    expect(response.status).toBe(200);
    expect(resolveQueueItem).toHaveBeenCalledWith('memory:m1', 'approve');
  });

  it('rejects unsupported mutation operations before the service is called', async () => {
    const response = await request(makeApp())
      .post('/api/review/queue/resolve')
      .send({ id: 'memory:m1', operation: 'review' });

    expect(response.status).toBe(400);
    expect(resolveQueueItem).not.toHaveBeenCalled();
  });
});
