import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the service layer so we can assert the route's request → svc-call
// → response wiring without standing up the real file-backed store.
const stubs = {
  bulkUpdateCollectionItems: vi.fn(),
};

vi.mock('../services/mediaCollections.js', async () => {
  const actual = await vi.importActual('../services/mediaCollections.js');
  return {
    ...actual,
    bulkUpdateCollectionItems: (...args) => stubs.bulkUpdateCollectionItems(...args),
  };
});

const router = (await import('./mediaCollections.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/media/collections', router);
  app.use(errorMiddleware);
  return app;
}

describe('mediaCollections routes — POST /:id/items/bulk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400s when both add and remove are empty', async () => {
    const r = await request(makeApp()).post('/api/media/collections/c1/items/bulk').send({});
    expect(r.status).toBe(400);
    expect(stubs.bulkUpdateCollectionItems).not.toHaveBeenCalled();
  });

  it('400s for unknown body fields (strict schema)', async () => {
    const r = await request(makeApp()).post('/api/media/collections/c1/items/bulk').send({
      add: [{ kind: 'image', ref: 'a.png' }],
      bogus: true,
    });
    expect(r.status).toBe(400);
    expect(stubs.bulkUpdateCollectionItems).not.toHaveBeenCalled();
  });

  it('400s when an add item carries an invalid kind', async () => {
    const r = await request(makeApp()).post('/api/media/collections/c1/items/bulk').send({
      add: [{ kind: 'movie', ref: 'x.mp4' }],
    });
    expect(r.status).toBe(400);
  });

  it('400s when an add ref contains ":"', async () => {
    const r = await request(makeApp()).post('/api/media/collections/c1/items/bulk').send({
      add: [{ kind: 'image', ref: 'bad:ref.png' }],
    });
    expect(r.status).toBe(400);
  });

  it('200s and returns { collection, added, removed } on success', async () => {
    stubs.bulkUpdateCollectionItems.mockResolvedValueOnce({
      collection: { id: 'c1', name: 'A', items: [], coverKey: null },
      added: 2,
      removed: 1,
    });
    const r = await request(makeApp()).post('/api/media/collections/c1/items/bulk').send({
      add: [{ kind: 'image', ref: 'a.png' }, { kind: 'video', ref: 'v1' }],
      remove: ['image:b.png'],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, removed: 1 });
    expect(stubs.bulkUpdateCollectionItems).toHaveBeenCalledWith('c1', {
      add: [{ kind: 'image', ref: 'a.png' }, { kind: 'video', ref: 'v1' }],
      remove: ['image:b.png'],
    });
  });

  it('404s when the service throws NOT_FOUND', async () => {
    stubs.bulkUpdateCollectionItems.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { code: 'NOT_FOUND' }),
    );
    const r = await request(makeApp()).post('/api/media/collections/ghost/items/bulk').send({
      add: [{ kind: 'image', ref: 'a.png' }],
    });
    expect(r.status).toBe(404);
  });

  it('409s when the service throws DUPLICATE (defensive — bulk path is idempotent today)', async () => {
    stubs.bulkUpdateCollectionItems.mockRejectedValueOnce(
      Object.assign(new Error('dup'), { code: 'DUPLICATE' }),
    );
    const r = await request(makeApp()).post('/api/media/collections/c1/items/bulk').send({
      add: [{ kind: 'image', ref: 'a.png' }],
    });
    expect(r.status).toBe(409);
  });
});
