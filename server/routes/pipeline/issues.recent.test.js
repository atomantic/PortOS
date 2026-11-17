import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

const issuesSvc = vi.hoisted(() => ({ listRecentIssues: vi.fn() }));
const seriesSvc = vi.hoisted(() => ({ listSeries: vi.fn() }));
vi.mock('../../services/pipeline/issues.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listRecentIssues: issuesSvc.listRecentIssues,
}));
vi.mock('../../services/pipeline/series.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listSeries: seriesSvc.listSeries,
}));

const { default: issuesRoutes } = await import('./issues.js');

const app = express();
app.use(express.json());
app.use('/api/pipeline', issuesRoutes);
app.use(errorMiddleware);

describe('GET /pipeline/issues/recent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('400s on a repeated limit key and never reads issues', async () => {
    const res = await request(app).get('/api/pipeline/issues/recent?limit=1&limit=2');
    expect(res.status).toBe(400);
    expect(issuesSvc.listRecentIssues).not.toHaveBeenCalled();
  });

  it('forwards the raw limit string so the service owns clamping, and names each issue series', async () => {
    issuesSvc.listRecentIssues.mockResolvedValue([{ id: 'i1', title: 'One', number: 1, seriesId: 's1', updatedAt: 'x' }]);
    seriesSvc.listSeries.mockResolvedValue([{ id: 's1', name: 'Example Series' }]);
    const res = await request(app).get('/api/pipeline/issues/recent?limit=0');
    expect(res.status).toBe(200);
    expect(issuesSvc.listRecentIssues).toHaveBeenCalledWith(expect.objectContaining({ limit: '0' }));
    expect(res.body[0].seriesName).toBe('Example Series');
  });
});
