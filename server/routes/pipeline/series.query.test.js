import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

const listSeries = vi.fn();
vi.mock('../../services/pipeline/series.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listSeries: (...a) => listSeries(...a),
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
