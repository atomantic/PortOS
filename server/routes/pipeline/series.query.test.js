import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

const listSeries = vi.fn();
const getSeries = vi.fn();
vi.mock('../../services/pipeline/series.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listSeries: (...a) => listSeries(...a),
  getSeries: (...a) => getSeries(...a),
}));
const createIssue = vi.fn();
vi.mock('../../services/pipeline/issues.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createIssue: (...a) => createIssue(...a),
}));

const seriesRoutes = (await import('./series.js')).default;

const app = express();
app.use(express.json());
app.use('/api/pipeline', seriesRoutes);
app.use(errorMiddleware);

describe('GET /api/pipeline/series list paging (#16428)', () => {
  beforeEach(() => listSeries.mockReset());

  it('returns the bare array when no paging key is sent', async () => {
    listSeries.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
    const res = await request(app).get('/api/pipeline/series');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 's1' }, { id: 's2' }]);
  });

  it('wraps a page in the shared envelope once limit or offset is sent', async () => {
    listSeries.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const res = await request(app).get('/api/pipeline/series?limit=1&offset=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ id: 's2' }], total: 3, limit: 1, offset: 1 });
  });

  it('refuses a repeated paging key with 400 before listing', async () => {
    const res = await request(app).get('/api/pipeline/series?limit=1&limit=2');
    expect(res.status).toBe(400);
    expect(listSeries).not.toHaveBeenCalled();
  });
});

describe('POST /api/pipeline/series/:id/issues arc pointers (#17719)', () => {
  const series = { id: 's1', seasons: [{ id: 'sea-1', number: 1 }, { id: 'sea-lock', number: 2, locked: true }] };
  beforeEach(() => {
    getSeries.mockReset().mockResolvedValue(series);
    createIssue.mockReset().mockImplementation(async (input) => ({ id: 'iss-1', ...input }));
  });

  it('forwards seasonId/arcPosition/arcRole to createIssue with the preloaded series', async () => {
    const res = await request(app).post('/api/pipeline/series/s1/issues')
      .send({ title: 'Ep', seasonId: 'sea-1', arcPosition: null, arcRole: 'pilot' });
    expect(res.status).toBe(201);
    expect(res.body.seasonId).toBe('sea-1');
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ seriesId: 's1', seasonId: 'sea-1', arcPosition: null, arcRole: 'pilot' }),
      { preloadedSeries: series },
    );
  });

  it('rejects a seasonId that is not on the series with 400', async () => {
    const res = await request(app).post('/api/pipeline/series/s1/issues').send({ title: 'Ep', seasonId: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PIPELINE_SEASON_NOT_FOUND');
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('rejects a locked season with 409', async () => {
    const res = await request(app).post('/api/pipeline/series/s1/issues').send({ title: 'Ep', seasonId: 'sea-lock' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PIPELINE_ISSUE_SEASON_LOCKED');
    expect(createIssue).not.toHaveBeenCalled();
  });
});
