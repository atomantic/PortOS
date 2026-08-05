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
  deleteBucketAndUnlinkChildren: vi.fn(),
}));

vi.mock('../services/githubCloner.js', () => ({
  parseGitHubUrl: vi.fn(() => null),
  pullRepo: vi.fn(),
}));

vi.mock('../services/cos.js', () => ({ addTask: vi.fn() }));

vi.mock('../services/malwareScanReports.js', () => ({
  prepareScanReportDirectory: vi.fn(),
  reportPathForId: vi.fn(() => '/tmp/report.md'),
  getScanReport: vi.fn(),
}));

vi.mock('../lib/openFolder.js', () => ({ openFolderInSystemExplorer: vi.fn() }));

import * as brainService from '../services/brain.js';
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
    await request(app).get('/api/brain/links?linkType=github&isGitHubRepo=true&limit=25&offset=50');

    expect(brainService.getLinksPage).toHaveBeenCalledTimes(1);
    expect(brainService.getLinksPage).toHaveBeenCalledWith({
      linkType: 'github',
      isGitHubRepo: true,
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
      isGitHubRepo: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it('passes isGitHubRepo=false through as a boolean, not a truthy string', async () => {
    await request(app).get('/api/brain/links?isGitHubRepo=false');

    expect(brainService.getLinksPage).toHaveBeenCalledWith(
      expect.objectContaining({ isGitHubRepo: false }),
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
