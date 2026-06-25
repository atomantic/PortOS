import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';

// Only the finding-locate route is under test here, so stub the resolver and let
// every other manuscript dependency pass through.
const locateComment = vi.fn();
vi.mock('../../services/pipeline/manuscriptReview.js', async (importOriginal) => ({
  ...(await importOriginal()),
  locateComment: (...a) => locateComment(...a),
}));

const manuscriptRoutes = (await import('./manuscript.js')).default;

const app = express();
app.use(express.json());
app.use('/api/pipeline', manuscriptRoutes);
app.use(errorMiddleware);

describe('GET /pipeline/findings/:commentId/locate (#1608)', () => {
  it('returns the owning series + comment when the id resolves', async () => {
    locateComment.mockResolvedValueOnce({ seriesId: 'ser-7', comment: { id: 'c-1', issueNumber: 3 } });
    const res = await request(app).get('/api/pipeline/findings/c-1/locate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seriesId: 'ser-7', comment: { id: 'c-1', issueNumber: 3 } });
    expect(locateComment).toHaveBeenCalledWith('c-1');
  });

  it('404s with a PIPELINE_FINDING_NOT_FOUND code when no series owns the id', async () => {
    locateComment.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/pipeline/findings/missing/locate');
    expect(res.status).toBe(404);
    expect(res.body.error?.code || res.body.code).toBe('PIPELINE_FINDING_NOT_FOUND');
  });
});
