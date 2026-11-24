import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const buildQueue = vi.fn();
const resolveQueueItem = vi.fn();
const triageQueueItem = vi.fn();
const promoteAskQueueItem = vi.fn();
const getItems = vi.fn();
const MAX_REVIEW_QUEUE_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

vi.mock('../services/review.js', () => ({ reviewEvents: { emit: vi.fn() }, getItems }));
vi.mock('../services/reviewQueue.js', () => ({
  buildQueue,
  MAX_REVIEW_QUEUE_SNOOZE_MS,
  resolveQueueItem,
  triageQueueItem,
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

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/review/items', () => {
  it('rejects a repeated query key with 400 (items, #16428)', async () => {
    const res = await request(makeApp()).get('/api/review/items?status=a&status=b');
    expect(res.status).toBe(400);
  });

  it('preserves the legacy array and opts into the page envelope with an offset alone', async () => {
    const items = [{ id: 'recent' }, { id: 'old' }];
    const page = { items: items.slice(1), total: 2, limit: 50, offset: 1 };
    getItems.mockResolvedValueOnce(items).mockResolvedValueOnce(page);

    const legacy = await request(makeApp()).get('/api/review/items?status=completed');
    expect(legacy.status).toBe(200);
    expect(legacy.body).toEqual(items);
    expect(getItems).toHaveBeenNthCalledWith(1, { status: 'completed' });

    const paginated = await request(makeApp()).get('/api/review/items?status=completed&offset=1');
    expect(paginated.status).toBe(200);
    expect(paginated.body).toEqual(page);
    expect(getItems).toHaveBeenNthCalledWith(2, { status: 'completed', offset: '1' });
  });
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

});

describe('POST /api/review/queue/resolve', () => {
  it('rejects unsupported mutation operations before the service is called', async () => {
    const response = await request(makeApp())
      .post('/api/review/queue/resolve')
      .send({ id: 'memory:m1', operation: 'review' });

    expect(response.status).toBe(400);
    expect(resolveQueueItem).not.toHaveBeenCalled();
  });

  it('requires a rating and forwards it for feedback actions', async () => {
    const missing = await request(makeApp())
      .post('/api/review/queue/resolve')
      .send({ id: 'feedback:agent-1', operation: 'rate' });

    expect(missing.status).toBe(400);
    expect(resolveQueueItem).not.toHaveBeenCalled();

    resolveQueueItem.mockResolvedValue({ source: 'feedback', id: 'feedback:agent-1', operation: 'rate', resolved: true });
    const response = await request(makeApp())
      .post('/api/review/queue/resolve')
      .send({ id: 'feedback:agent-1', operation: 'rate', rating: 'positive', comment: 'Useful result' });

    expect(response.status).toBe(200);
    expect(resolveQueueItem).toHaveBeenCalledWith(
      'feedback:agent-1', 'rate', { rating: 'positive', comment: 'Useful result' },
    );
  });
});

describe('POST /api/review/queue/triage', () => {
  it('validates the snooze timestamp and forwards it to the queue service', async () => {
    const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    triageQueueItem.mockResolvedValue({ id: 'brain:b1', operation: 'snooze', triaged: true });

    const response = await request(makeApp())
      .post('/api/review/queue/triage')
      .send({ id: 'brain:b1', operation: 'snooze', snoozedUntil });

    expect(response.status).toBe(200);
    expect(triageQueueItem).toHaveBeenCalledWith('brain:b1', 'snooze', { snoozedUntil });
  });

  it('requires a timestamp for snooze and rejects timestamps on other operations', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-20T10:00:00.000Z') });
    const missing = await request(makeApp())
      .post('/api/review/queue/triage')
      .send({ id: 'brain:b1', operation: 'snooze' });
    expect(missing.status).toBe(400);
    expect(triageQueueItem).not.toHaveBeenCalled();

    const extra = await request(makeApp())
      .post('/api/review/queue/triage')
      .send({ id: 'ask:a1', operation: 'dismiss', snoozedUntil: '2099-01-01T00:00:00.000Z' });
    expect(extra.status).toBe(400);
    expect(triageQueueItem).not.toHaveBeenCalled();

    const tooFar = await request(makeApp())
      .post('/api/review/queue/triage')
      .send({
        id: 'brain:b1',
        operation: 'snooze',
        snoozedUntil: new Date(Date.now() + MAX_REVIEW_QUEUE_SNOOZE_MS + 1).toISOString(),
      });
    expect(tooFar.status).toBe(400);
    expect(triageQueueItem).not.toHaveBeenCalled();
  });
});
