import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Stub the service surface — route tests assert wiring (status codes,
// validation, body forwarding), not the service layer (which has its own
// dedicated tests).
vi.mock('../services/referenceRepos.js', () => ({
  listReferenceRepos: vi.fn(async () => [{ id: 'r1', name: 'phosphene' }]),
  addReferenceRepo: vi.fn(async (_appId, body) => ({ id: 'r-new', ...body })),
  updateReferenceRepo: vi.fn(async (_appId, refId, patch) => ({ id: refId, ...patch })),
  deleteReferenceRepo: vi.fn(async () => ({ ok: true })),
  checkReferenceRepo: vi.fn(async () => ({ head: 'a'.repeat(40), commitCount: 2, commits: [] })),
  markReferenceRepoReviewed: vi.fn(async (_appId, refId, sha) => ({ id: refId, lastReviewedSha: sha })),
  triggerReferenceAnalysis: vi.fn(async () => ({ queued: true, taskId: 'ref-analysis-1' })),
}));

vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(async () => ({
    id: 'app-1',
    name: 'TestApp',
    repoPath: '/mock/repo',
    referenceRepos: [{ id: 'r1', name: 'phosphene', repoUrl: 'https://github.com/x/y.git' }],
  })),
}));

import * as svc from '../services/referenceRepos.js';
import referenceReposRoutes from './referenceRepos.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  // Same nested mount the production server uses — :appId is the parent param.
  app.use('/api/apps/:appId/reference-repos', referenceReposRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('reference repos routes', () => {
  let app;
  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  describe('GET /', () => {
    it('returns the list under {referenceRepos}', async () => {
      const r = await request(app).get('/api/apps/app-1/reference-repos');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ referenceRepos: [{ id: 'r1', name: 'phosphene' }] });
      expect(svc.listReferenceRepos).toHaveBeenCalledWith('app-1');
    });
  });

  describe('POST /', () => {
    it('creates a ref from a valid body', async () => {
      const r = await request(app).post('/api/apps/app-1/reference-repos').send({
        name: 'phosphene',
        repoUrl: 'https://github.com/x/y.git',
        notes: 'video gen',
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ id: 'r-new', name: 'phosphene' });
      expect(svc.addReferenceRepo).toHaveBeenCalledWith('app-1', expect.objectContaining({ name: 'phosphene' }));
    });

    it('rejects missing name with 400', async () => {
      const r = await request(app).post('/api/apps/app-1/reference-repos').send({
        repoUrl: 'https://github.com/x/y.git',
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Validation failed/);
    });

    it('rejects oversized notes', async () => {
      const r = await request(app).post('/api/apps/app-1/reference-repos').send({
        name: 'x',
        repoUrl: 'y',
        notes: 'a'.repeat(5000),
      });
      expect(r.status).toBe(400);
    });
  });

  describe('PATCH /:refId', () => {
    it('forwards the patch to the service', async () => {
      const r = await request(app).patch('/api/apps/app-1/reference-repos/r1').send({
        name: 'renamed',
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: 'r1', name: 'renamed' });
      expect(svc.updateReferenceRepo).toHaveBeenCalledWith('app-1', 'r1', { name: 'renamed' });
    });

    it('rejects malformed lastReviewedSha (must be 40 chars)', async () => {
      const r = await request(app).patch('/api/apps/app-1/reference-repos/r1').send({
        lastReviewedSha: 'short',
      });
      expect(r.status).toBe(400);
    });

    it('rejects 40-char non-hex lastReviewedSha (validation regex)', async () => {
      // Length-only validation would accept 'g'.repeat(40) and persist it,
      // then `git log <bad>..HEAD` would fail later in a confusing way.
      const r = await request(app).patch('/api/apps/app-1/reference-repos/r1').send({
        lastReviewedSha: 'g'.repeat(40),
      });
      expect(r.status).toBe(400);
    });
  });

  describe('DELETE /:refId', () => {
    it('returns ok=true', async () => {
      const r = await request(app).delete('/api/apps/app-1/reference-repos/r1');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect(svc.deleteReferenceRepo).toHaveBeenCalledWith('app-1', 'r1');
    });
  });

  describe('POST /:refId/check', () => {
    it('returns the snapshot the service produces', async () => {
      const r = await request(app).post('/api/apps/app-1/reference-repos/r1/check');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ commitCount: 2 });
      expect(svc.checkReferenceRepo).toHaveBeenCalledWith('app-1', 'r1');
    });

    it('triggers analysis when new commits exist', async () => {
      const r = await request(app).post('/api/apps/app-1/reference-repos/r1/check');
      expect(r.status).toBe(200);
      expect(r.body.analysis).toEqual({ queued: true, taskId: 'ref-analysis-1' });
      expect(svc.triggerReferenceAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'app-1', name: 'TestApp' }),
        expect.objectContaining({ id: 'r1' }),
        expect.objectContaining({ commitCount: 2 }),
      );
    });

    it('returns stable reason code when analysis trigger throws', async () => {
      svc.triggerReferenceAnalysis.mockRejectedValueOnce(new Error('something internal'));
      const r = await request(app).post('/api/apps/app-1/reference-repos/r1/check');
      expect(r.status).toBe(200);
      expect(r.body.analysis).toEqual({ queued: false, reason: 'analysis-trigger-failed' });
    });

    it('skips analysis when no new commits', async () => {
      svc.checkReferenceRepo.mockResolvedValueOnce({ head: 'a'.repeat(40), commitCount: 0, commits: [] });
      const r = await request(app).post('/api/apps/app-1/reference-repos/r1/check');
      expect(r.status).toBe(200);
      expect(r.body.analysis).toEqual({ queued: false, reason: 'no-new-commits' });
      expect(svc.triggerReferenceAnalysis).not.toHaveBeenCalled();
    });
  });

  describe('POST /:refId/reviewed', () => {
    it('forwards the SHA to the service', async () => {
      const sha = 'a'.repeat(40);
      const r = await request(app).post('/api/apps/app-1/reference-repos/r1/reviewed').send({ sha });
      expect(r.status).toBe(200);
      expect(svc.markReferenceRepoReviewed).toHaveBeenCalledWith('app-1', 'r1', sha);
    });
  });
});
