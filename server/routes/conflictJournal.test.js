import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const resolverMock = {
  ERR_NOT_FOUND: 'CONFLICT_JOURNAL_NOT_FOUND',
  ERR_VALIDATION: 'CONFLICT_JOURNAL_VALIDATION',
  listConflicts: vi.fn(),
  getConflict: vi.fn(),
  resolveConflict: vi.fn(),
  deleteConflict: vi.fn(),
};
vi.mock('../services/conflictJournalResolver.js', () => resolverMock);

const conflictJournalRoutes = (await import('./conflictJournal.js')).default;

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/conflict-journal', conflictJournalRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('conflict-journal routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET / lists conflicts (optionally filtered by status)', async () => {
    resolverMock.listConflicts.mockResolvedValue([{ id: 'e1', status: 'pending' }]);
    const res = await request(makeApp()).get('/api/conflict-journal?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toHaveLength(1);
    expect(resolverMock.listConflicts).toHaveBeenCalledWith({ status: 'pending' });
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

  it('DELETE /:id removes an entry', async () => {
    resolverMock.deleteConflict.mockResolvedValue({ id: 'e1', deleted: true });
    const res = await request(makeApp()).delete('/api/conflict-journal/e1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
