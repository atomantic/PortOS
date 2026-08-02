import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the service layer so we can assert the route's request → svc-call
// → response wiring without standing up the real file-backed store.
const stubs = {
  bulkUpdateCollectionItems: vi.fn(),
  updateCollection: vi.fn(async (id, patch) => ({ id, ...patch })),
  createCollection: vi.fn(async (input) => ({ id: 'new', ...input })),
  listCollections: vi.fn(async () => []),
};

vi.mock('../services/mediaCollections.js', async () => {
  const actual = await vi.importActual('../services/mediaCollections.js');
  return {
    ...actual,
    bulkUpdateCollectionItems: (...args) => stubs.bulkUpdateCollectionItems(...args),
    updateCollection: (...args) => stubs.updateCollection(...args),
    createCollection: (...args) => stubs.createCollection(...args),
    listCollections: (...args) => stubs.listCollections(...args),
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

describe('mediaCollections routes — provenance (#3311)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a valid source through PATCH and rejects an unknown one', async () => {
    const ok = await request(makeApp()).patch('/api/media/collections/c1').send({ source: 'user' });
    expect(ok.status).toBe(200);
    expect(stubs.updateCollection).toHaveBeenCalledWith('c1', { source: 'user' });

    const bad = await request(makeApp()).patch('/api/media/collections/c1').send({ source: 'robot' });
    expect(bad.status).toBe(400);
  });

  it('strips source from a create body so a client cannot claim provenance', async () => {
    await request(makeApp()).post('/api/media/collections').send({ name: 'Concept Art', source: 'auto' });
    // Zod drops the unknown key → the service applies its own 'user' default.
    expect(stubs.createCollection).toHaveBeenCalledWith({ name: 'Concept Art', description: '' });
  });
});

describe('mediaCollections routes — GET / pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression guard: every client caller (apiImageVideo.listMediaCollections)
  // calls this with no query params. If it ever returns an envelope instead of
  // a bare array, those pickers silently render empty.
  it('without pagination params returns the unbounded bare array', async () => {
    stubs.listCollections.mockResolvedValueOnce(
      Array.from({ length: 120 }, (_, i) => ({ id: `c-${i}`, name: `C${i}` }))
    );
    const r = await request(makeApp()).get('/api/media/collections');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(120);
  });

  it('returns a bounded envelope when pagination is requested', async () => {
    stubs.listCollections.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `c-${i}`, name: `C${i}` }))
    );
    const r = await request(makeApp()).get('/api/media/collections?limit=2&offset=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].id).toBe('c-1');
    expect(r.body.total).toBe(5);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(1);
  });
});
