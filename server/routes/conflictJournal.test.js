import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const resolverMock = {
  ERR_NOT_FOUND: 'CONFLICT_JOURNAL_NOT_FOUND',
  ERR_VALIDATION: 'CONFLICT_JOURNAL_VALIDATION',
  ERR_TARGET_GONE: 'CONFLICT_TARGET_GONE',
  listConflicts: vi.fn(),
  getConflict: vi.fn(),
  resolveConflict: vi.fn(),
  deleteConflict: vi.fn(),
};
vi.mock('../services/conflictJournalResolver.js', () => resolverMock);

// The route's only lib import is the latch flag — doubled so the payload test
// controls it without depending on a real sync_base_hashes.json on disk.
const libMock = { isBaseHashPersistBlocked: vi.fn() };
vi.mock('../lib/conflictJournal.js', () => libMock);

const conflictJournalRoutes = (await import('./conflictJournal.js')).default;

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/conflict-journal', conflictJournalRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('conflict-journal routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    libMock.isBaseHashPersistBlocked.mockResolvedValue(false);
  });

  it('GET / lists conflicts (optionally filtered by status)', async () => {
    resolverMock.listConflicts.mockResolvedValue([{ id: 'e1', status: 'pending' }]);
    const res = await request(makeApp()).get('/api/conflict-journal?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toHaveLength(1);
    expect(resolverMock.listConflicts).toHaveBeenCalledWith({ status: 'pending' });
    // Healthy store → the degraded flag is present and false.
    expect(res.body.conflictDetection).toEqual({ degraded: false });
  });

  it('GET / surfaces conflictDetection.degraded while the base-hash store is latched (#7260)', async () => {
    resolverMock.listConflicts.mockResolvedValue([]);
    libMock.isBaseHashPersistBlocked.mockResolvedValue(true);
    const res = await request(makeApp()).get('/api/conflict-journal');
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toEqual([]);
    // An empty list must not read as "no conflicts" — the flag + reason say
    // detection is degraded instead.
    expect(res.body.conflictDetection.degraded).toBe(true);
    expect(res.body.conflictDetection.reason).toContain('sync_base_hashes.json');
  });

  it('GET / rejects an invalid status with 400', async () => {
    const res = await request(makeApp()).get('/api/conflict-journal?status=bogus');
    expect(res.status).toBe(400);
  });

  it('POST /:id/resolve validates the action enum', async () => {
    const bad = await request(makeApp()).post('/api/conflict-journal/e1/resolve').send({ action: 'nope' });
    expect(bad.status).toBe(400);

    resolverMock.resolveConflict.mockResolvedValue({ id: 'e1', status: 'resolved', resolution: 'discard' });
    const ok = await request(makeApp()).post('/api/conflict-journal/e1/resolve').send({ action: 'discard' });
    expect(ok.status).toBe(200);
    expect(resolverMock.resolveConflict).toHaveBeenCalledWith('e1', { action: 'discard' });
  });

  it('maps ERR_NOT_FOUND to 404', async () => {
    resolverMock.getConflict.mockRejectedValue(Object.assign(new Error('nope'), { code: resolverMock.ERR_NOT_FOUND }));
    const res = await request(makeApp()).get('/api/conflict-journal/missing');
    expect(res.status).toBe(404);
  });

  it('maps ERR_TARGET_GONE to 409 (record deleted since the conflict was archived)', async () => {
    resolverMock.resolveConflict.mockRejectedValue(
      Object.assign(new Error('The universe this conflict targets no longer exists — discard the entry.'), { code: resolverMock.ERR_TARGET_GONE }),
    );
    const res = await request(makeApp()).post('/api/conflict-journal/e1/resolve').send({ action: 'restore-all' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT_TARGET_GONE');
  });

  it('DELETE /:id removes an entry', async () => {
    resolverMock.deleteConflict.mockResolvedValue({ id: 'e1', deleted: true });
    const res = await request(makeApp()).delete('/api/conflict-journal/e1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
