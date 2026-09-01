/**
 * GET /api/brain/links — the paginated read path (issue #3509).
 *
 * The route used to pull EVERY link record through `getLinks()`, then filter,
 * sort, and slice in memory: page cost scaled with the size of the whole
 * collection. These tests pin the replacement contract — the route hands the
 * filters and the window to `getLinksPage` and returns what it gets, and never
 * reaches for the whole collection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/brain.js', () => ({
  getLinks: vi.fn(),
  getLinksPage: vi.fn(),
  listLinkIds: vi.fn(),
  getLinkById: vi.fn(),
  getLinkByUrl: vi.fn(),
  createLinkFromUrl: vi.fn(),
  updateLink: vi.fn(),
  reorderLinks: vi.fn(),
  deleteLink: vi.fn(),
  cloneRepoInBackground: vi.fn(),
  getBuckets: vi.fn(),
  getBucketById: vi.fn(),
  createBucketAppended: vi.fn(),
  updateBucket: vi.fn(),
  reorderBuckets: vi.fn(),
  deleteBucketAndUnlinkChildren: vi.fn(),
}));

vi.mock('../services/repoCloner.js', () => ({
  pullRepo: vi.fn(),
}));

vi.mock('../services/cos.js', () => ({ addTask: vi.fn() }));

vi.mock('../services/repoIntake.js', () => ({
  queueMalwareScan: vi.fn(),
  restudyRepoLink: vi.fn(),
}));

vi.mock('../services/malwareScanReports.js', () => ({
  prepareScanReportDirectory: vi.fn(),
  reportPathForId: vi.fn(() => '/tmp/report.md'),
  getScanReport: vi.fn(),
}));

vi.mock('../lib/openFolder.js', () => ({ openFolderInSystemExplorer: vi.fn() }));

import * as brainService from '../services/brain.js';
import { restudyRepoLink } from '../services/repoIntake.js';
import linkRoutes from './brainLinks.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/brain', linkRoutes);
  app.use(errorMiddleware);
  return app;
};

const app = buildApp();

const link = (id, extra = {}) => ({ id, url: `https://example.com/${id}`, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  brainService.getLinksPage.mockResolvedValue({ links: [], total: 0 });
});

describe('GET /api/brain/links', () => {
  it('returns the service page verbatim alongside the echoed window', async () => {
    brainService.getLinksPage.mockResolvedValue({ links: [link('a'), link('b')], total: 137 });

    const res = await request(app).get('/api/brain/links?limit=2&offset=10');

    expect(res.status).toBe(200);
    expect(res.body.links.map(l => l.id)).toEqual(['a', 'b']);
    // `total` is the count of everything MATCHING the filters, not the page size.
    expect(res.body).toMatchObject({ total: 137, limit: 2, offset: 10 });
  });

  it('delegates filtering, ordering, and pagination to getLinksPage', async () => {
    await request(app).get('/api/brain/links?linkType=repo&isRepo=true&limit=25&offset=50');

    expect(brainService.getLinksPage).toHaveBeenCalledTimes(1);
    expect(brainService.getLinksPage).toHaveBeenCalledWith({
      linkType: 'repo',
      isRepo: true,
      limit: 25,
      offset: 50,
    });
  });

  it('never pulls the whole collection to answer a page', async () => {
    brainService.getLinksPage.mockResolvedValue({ links: [link('a')], total: 5000 });

    const res = await request(app).get('/api/brain/links?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(1);
    // The O(N) read path is gone — this is the regression guard for #3509.
    expect(brainService.getLinks).not.toHaveBeenCalled();
  });

  it('applies the schema defaults when no window is given', async () => {
    await request(app).get('/api/brain/links');

    expect(brainService.getLinksPage).toHaveBeenCalledWith({
      linkType: undefined,
      isRepo: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it('passes isRepo=false through as a boolean, not a truthy string', async () => {
    await request(app).get('/api/brain/links?isRepo=false');

    expect(brainService.getLinksPage).toHaveBeenCalledWith(
      expect.objectContaining({ isRepo: false }),
    );
  });

  it('maps the legacy isGitHubRepo query name to the host-neutral filter', async () => {
    await request(app).get('/api/brain/links?isGitHubRepo=true');

    expect(brainService.getLinksPage).toHaveBeenCalledWith(
      expect.objectContaining({ isRepo: true }),
    );
  });

  it('rejects an out-of-range limit before touching the service', async () => {
    const res = await request(app).get('/api/brain/links?limit=999999');

    expect(res.status).toBe(400);
    expect(brainService.getLinksPage).not.toHaveBeenCalled();
  });
});

describe('POST /api/brain/links/reorder', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  const bucket = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('checks batch membership from the id listing, not the full records', async () => {
    const updates = [{ id: idA, bucketId: bucket, bucketOrder: 0 }];
    brainService.listLinkIds.mockResolvedValue([idA, idB]);
    brainService.reorderLinks.mockResolvedValue(updates);

    const res = await request(app).post('/api/brain/links/reorder').send({ updates });

    expect(res.status).toBe(200);
    expect(brainService.getLinks).not.toHaveBeenCalled();
    expect(brainService.reorderLinks).toHaveBeenCalledWith(updates);
  });

  it('still rejects the whole batch when an id is unknown', async () => {
    brainService.listLinkIds.mockResolvedValue([idA]);

    const res = await request(app).post('/api/brain/links/reorder').send({
      updates: [
        { id: idA, bucketId: bucket, bucketOrder: 0 },
        { id: idB, bucketId: bucket, bucketOrder: 1 },
      ],
    });

    expect(res.status).toBe(404);
    expect(brainService.reorderLinks).not.toHaveBeenCalled();
  });
});

describe('POST /api/brain/links/:id/clone', () => {
  const repoLink = (cloneStatus) => ({
    id: 'repo-link',
    url: 'https://github.com/acme/widgets',
    isRepo: true,
    cloneStatus,
  });

  it('starts a new clone for a link boot recovery reset to failed', async () => {
    brainService.getLinkById.mockResolvedValue(repoLink('failed'));
    brainService.cloneRepoInBackground.mockResolvedValue();

    const res = await request(app).post('/api/brain/links/repo-link/clone');

    expect(res.status).toBe(200);
    expect(brainService.cloneRepoInBackground).toHaveBeenCalledWith(
      'repo-link',
      'https://github.com/acme/widgets',
    );
  });

  it('logs rather than crashing when the un-awaited clone kickoff rejects', async () => {
    // The kickoff runs outside the request lifecycle, so its pre-clone steps
    // (identity resolve, the `cloning` stamp) have no `next(err)` to bubble to.
    brainService.getLinkById.mockResolvedValue(repoLink('none'));
    brainService.cloneRepoInBackground.mockRejectedValue(new Error('identity unavailable'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/api/brain/links/repo-link/clone');
    await new Promise(resolve => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('identity unavailable'));
    logged.mockRestore();
  });
});

describe('POST /api/brain/links/:id/study', () => {
  const cloned = () => ({
    id: 'repo-link',
    url: 'https://gitlab.com/example-group/example-repo',
    isRepo: true,
    cloneStatus: 'cloned',
    localPath: '/repos/gitlab.com/example-group/example-repo',
  });

  beforeEach(() => {
    brainService.getLinkById.mockResolvedValue(cloned());
    brainService.updateLink.mockImplementation(async (id, patch) => ({ ...cloned(), ...patch }));
  });

  it('queues the study with the brief and persists the pending run on the link', async () => {
    restudyRepoLink.mockResolvedValue({
      queued: true,
      taskId: 'task-1',
      pulled: { ok: true },
      linkPatch: { repoStudy: { taskId: 'task-1' } },
    });

    const res = await request(app)
      .post('/api/brain/links/repo-link/study')
      .send({ studyContext: 'look at its offline sync', targetAppId: 'portos-default' });

    expect(res.status).toBe(200);
    expect(restudyRepoLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-link' }),
      // `pull` defaults on, so the button refreshes the checkout unless told not to.
      expect.objectContaining({ pull: true, studyContext: 'look at its offline sync', targetAppId: 'portos-default' }),
    );
    expect(brainService.updateLink).toHaveBeenCalledWith('repo-link', { repoStudy: { taskId: 'task-1' } });
    expect(res.body).toMatchObject({ taskId: 'task-1', pulled: { ok: true } });
  });

  it('409s when a study for the repo is already in flight', async () => {
    restudyRepoLink.mockResolvedValue({ queued: false, reason: 'duplicate' });

    const res = await request(app).post('/api/brain/links/repo-link/study').send({});

    expect(res.status).toBe(409);
    expect(brainService.updateLink).not.toHaveBeenCalled();
  });

  it('maps a missing target app and an unknown reason to distinct errors', async () => {
    restudyRepoLink.mockResolvedValue({ queued: false, reason: 'app-not-found' });
    const missingApp = await request(app).post('/api/brain/links/repo-link/study').send({});
    expect(missingApp.status).toBe(400);
    expect(missingApp.body.code).toBe('APP_NOT_FOUND');

    // Anything the table doesn't name falls back to the clone-gone error rather
    // than to whichever branch happened to be last.
    restudyRepoLink.mockResolvedValue({ queued: false, reason: 'not-cloned' });
    const gone = await request(app).post('/api/brain/links/repo-link/study').send({});
    expect(gone.status).toBe(400);
    expect(gone.body.code).toBe('PATH_NOT_FOUND');
    expect(brainService.updateLink).not.toHaveBeenCalled();
  });

  it('rejects a link that has no clone to study', async () => {
    brainService.getLinkById.mockResolvedValue({ ...cloned(), cloneStatus: 'none', localPath: null });

    const res = await request(app).post('/api/brain/links/repo-link/study').send({});

    expect(res.status).toBe(400);
    expect(restudyRepoLink).not.toHaveBeenCalled();
  });
});
