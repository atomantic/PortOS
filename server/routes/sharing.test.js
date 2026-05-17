import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/sharing/buckets.js', () => ({
  listBuckets: vi.fn(),
  getBucket: vi.fn(),
  createBucket: vi.fn(),
  updateBucket: vi.fn(),
  deleteBucket: vi.fn(),
  readBucketJson: vi.fn(),
}));

vi.mock('../services/sharing/watcher.js', () => ({
  attachWatcher: vi.fn(),
  detachWatcher: vi.fn(),
}));

vi.mock('../services/sharing/exporter.js', () => ({
  exportByKind: vi.fn(),
}));

vi.mock('../services/sharing/importer.js', () => ({
  listInbox: vi.fn(),
  promoteInboxItem: vi.fn(),
  dismissInboxItem: vi.fn(),
  processBacklog: vi.fn(),
}));

vi.mock('../services/sharing/subscriptions.js', () => ({
  listSubscriptions: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../services/sharing/manifest.js', () => ({
  listManifestFilenames: vi.fn(),
  readManifest: vi.fn(),
}));

import * as buckets from '../services/sharing/buckets.js';
import * as watcher from '../services/sharing/watcher.js';
import * as exporter from '../services/sharing/exporter.js';
import * as importer from '../services/sharing/importer.js';
import * as subs from '../services/sharing/subscriptions.js';
import * as manifest from '../services/sharing/manifest.js';
import { SHARING_SCHEMA_VERSION } from '../services/sharing/version.js';
import sharingRoutes from './sharing.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sharing', sharingRoutes);
  app.use(errorMiddleware);
  return app;
};

const makeBucket = (over = {}) => ({
  id: 'b1',
  name: 'Bucket One',
  path: '/tmp/bucket-one',
  mode: 'inbox',
  displayNameOverride: null,
  bioOverride: null,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  ...over,
});

const makeServiceError = (message, code) => Object.assign(new Error(message), { code });

describe('sharing routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buckets.readBucketJson.mockResolvedValue(null);
  });

  describe('GET /api/sharing/buckets', () => {
    it('returns hydrated buckets plus the local schema version', async () => {
      buckets.listBuckets.mockResolvedValue([makeBucket(), makeBucket({ id: 'b2', name: 'Two' })]);
      buckets.readBucketJson
        .mockResolvedValueOnce({ id: 'b1', sharingSchemaVersion: SHARING_SCHEMA_VERSION })
        .mockResolvedValueOnce(null);

      const res = await request(buildApp()).get('/api/sharing/buckets');
      expect(res.status).toBe(200);
      expect(res.body.localSchemaVersion).toBe(SHARING_SCHEMA_VERSION);
      expect(res.body.buckets).toHaveLength(2);
      expect(res.body.buckets[0]).toMatchObject({
        id: 'b1',
        bucketSchemaVersion: SHARING_SCHEMA_VERSION,
        schemaCompatible: true,
      });
      expect(res.body.buckets[1]).toMatchObject({
        id: 'b2',
        bucketSchemaVersion: null,
        schemaCompatible: true,
      });
    });

    it('marks a bucket with a future remote schema as incompatible', async () => {
      buckets.listBuckets.mockResolvedValue([makeBucket()]);
      buckets.readBucketJson.mockResolvedValue({ id: 'b1', sharingSchemaVersion: SHARING_SCHEMA_VERSION + 99 });

      const res = await request(buildApp()).get('/api/sharing/buckets');
      expect(res.status).toBe(200);
      expect(res.body.buckets[0].schemaCompatible).toBe(false);
    });
  });

  describe('GET /api/sharing/buckets/:id', () => {
    it('returns a single hydrated bucket', async () => {
      buckets.getBucket.mockResolvedValue(makeBucket());
      const res = await request(buildApp()).get('/api/sharing/buckets/b1');
      expect(res.status).toBe(200);
      expect(res.body.bucket.id).toBe('b1');
      expect(res.body.localSchemaVersion).toBe(SHARING_SCHEMA_VERSION);
      expect(buckets.getBucket).toHaveBeenCalledWith('b1');
    });

    it('maps SHARING_BUCKET_NOT_FOUND to HTTP 404', async () => {
      buckets.getBucket.mockRejectedValue(makeServiceError('Bucket not found: nope', 'SHARING_BUCKET_NOT_FOUND'));
      const res = await request(buildApp()).get('/api/sharing/buckets/nope');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SHARING_BUCKET_NOT_FOUND');
      expect(res.body.error).toContain('not found');
    });
  });

  describe('POST /api/sharing/buckets', () => {
    it('rejects an empty body with VALIDATION_ERROR', async () => {
      const res = await request(buildApp()).post('/api/sharing/buckets').send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(buckets.createBucket).not.toHaveBeenCalled();
      expect(watcher.attachWatcher).not.toHaveBeenCalled();
    });

    it('rejects unknown fields (strict)', async () => {
      const res = await request(buildApp())
        .post('/api/sharing/buckets')
        .send({ name: 'x', path: '/tmp', bogus: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('creates a bucket, attaches the watcher, processes backlog, and 201s', async () => {
      const created = makeBucket({ id: 'new1', name: 'Fresh' });
      buckets.createBucket.mockResolvedValue(created);
      watcher.attachWatcher.mockResolvedValue();
      importer.processBacklog.mockResolvedValue({ processed: 0 });

      const res = await request(buildApp())
        .post('/api/sharing/buckets')
        .send({ name: 'Fresh', path: '/tmp/fresh', mode: 'auto-merge' });

      expect(res.status).toBe(201);
      expect(res.body.bucket).toMatchObject({ id: 'new1', name: 'Fresh' });
      expect(buckets.createBucket).toHaveBeenCalledWith({
        name: 'Fresh',
        path: '/tmp/fresh',
        mode: 'auto-merge',
      });
      expect(watcher.attachWatcher).toHaveBeenCalledWith('new1');
      expect(importer.processBacklog).toHaveBeenCalledWith('new1');
    });

    it('maps SHARING_BUCKET_PATH_UNUSABLE to HTTP 400', async () => {
      buckets.createBucket.mockRejectedValue(
        makeServiceError('Bucket path is not a directory: /tmp/missing', 'SHARING_BUCKET_PATH_UNUSABLE'),
      );
      const res = await request(buildApp())
        .post('/api/sharing/buckets')
        .send({ name: 'X', path: '/tmp/missing' });
      // Client-correctable: the path is invalid/unwritable.
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SHARING_BUCKET_PATH_UNUSABLE');
      expect(watcher.attachWatcher).not.toHaveBeenCalled();
    });

    it('maps SHARING_BUCKET_VALIDATION to HTTP 400', async () => {
      buckets.createBucket.mockRejectedValue(
        makeServiceError('A bucket is already registered at: /tmp/dup', 'SHARING_BUCKET_VALIDATION'),
      );
      const res = await request(buildApp())
        .post('/api/sharing/buckets')
        .send({ name: 'X', path: '/tmp/dup' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SHARING_BUCKET_VALIDATION');
    });
  });

  describe('PUT /api/sharing/buckets/:id', () => {
    it('forwards a partial patch', async () => {
      buckets.updateBucket.mockResolvedValue(makeBucket({ name: 'Renamed' }));
      const res = await request(buildApp())
        .put('/api/sharing/buckets/b1')
        .send({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.bucket.name).toBe('Renamed');
      expect(buckets.updateBucket).toHaveBeenCalledWith('b1', { name: 'Renamed' });
    });

    it('rejects an unknown mode', async () => {
      const res = await request(buildApp())
        .put('/api/sharing/buckets/b1')
        .send({ mode: 'broadcast' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(buckets.updateBucket).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/sharing/buckets/:id', () => {
    it('detaches the watcher then deletes the bucket', async () => {
      watcher.detachWatcher.mockResolvedValue();
      // Real service contract: `buckets.deleteBucket` resolves with `{ id }`.
      buckets.deleteBucket.mockResolvedValue({ id: 'b1' });
      const res = await request(buildApp()).delete('/api/sharing/buckets/b1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'b1' });
      // Order matters: watcher must be detached before the bucket entry is removed
      // (otherwise the watcher leaks a chokidar handle to an unregistered id).
      const detachOrder = watcher.detachWatcher.mock.invocationCallOrder[0];
      const deleteOrder = buckets.deleteBucket.mock.invocationCallOrder[0];
      expect(detachOrder).toBeLessThan(deleteOrder);
    });

    it('maps SHARING_BUCKET_NOT_FOUND to HTTP 404', async () => {
      watcher.detachWatcher.mockResolvedValue();
      buckets.deleteBucket.mockRejectedValue(
        makeServiceError('Bucket not found: gone', 'SHARING_BUCKET_NOT_FOUND'),
      );
      const res = await request(buildApp()).delete('/api/sharing/buckets/gone');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SHARING_BUCKET_NOT_FOUND');
    });
  });

  describe('POST /api/sharing/buckets/:id/export', () => {
    it('rejects when neither ids nor items are present', async () => {
      const res = await request(buildApp())
        .post('/api/sharing/buckets/b1/export')
        .send({ kind: 'series' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(exporter.exportByKind).not.toHaveBeenCalled();
    });

    it('rejects an unknown kind', async () => {
      const res = await request(buildApp())
        .post('/api/sharing/buckets/b1/export')
        .send({ kind: 'comic', ids: ['s1'] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('forwards a valid series export with bucketId merged in', async () => {
      exporter.exportByKind.mockResolvedValue({ manifestId: 'm-1', recordIds: { series: ['s1'] } });
      const res = await request(buildApp())
        .post('/api/sharing/buckets/b1/export')
        .send({ kind: 'series', ids: ['s1', 's2'] });
      expect(res.status).toBe(200);
      expect(res.body.manifestId).toBe('m-1');
      expect(exporter.exportByKind).toHaveBeenCalledWith({
        kind: 'series',
        ids: ['s1', 's2'],
        bucketId: 'b1',
      });
    });

    it('accepts a media export shape (items, no ids)', async () => {
      exporter.exportByKind.mockResolvedValue({ manifestId: 'm-media' });
      const res = await request(buildApp())
        .post('/api/sharing/buckets/b1/export')
        .send({ kind: 'media', items: [{ kind: 'image', ref: 'foo.png' }] });
      expect(res.status).toBe(200);
      expect(res.body.manifestId).toBe('m-media');
      expect(exporter.exportByKind).toHaveBeenCalledWith({
        kind: 'media',
        items: [{ kind: 'image', ref: 'foo.png' }],
        bucketId: 'b1',
      });
    });
  });

  describe('GET /api/sharing/buckets/:id/inbox', () => {
    it('returns the inbox items', async () => {
      importer.listInbox.mockResolvedValue([{ manifestId: 'm-1' }, { manifestId: 'm-2' }]);
      const res = await request(buildApp()).get('/api/sharing/buckets/b1/inbox');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(importer.listInbox).toHaveBeenCalledWith('b1');
    });
  });

  describe('POST /api/sharing/buckets/:id/inbox/:manifestId/promote', () => {
    it('forwards the promote call', async () => {
      importer.promoteInboxItem.mockResolvedValue({ promoted: true });
      const res = await request(buildApp()).post('/api/sharing/buckets/b1/inbox/m-1/promote');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ promoted: true });
      expect(importer.promoteInboxItem).toHaveBeenCalledWith('b1', 'm-1');
    });

    it('maps SHARING_INBOX_NOT_FOUND to HTTP 404', async () => {
      importer.promoteInboxItem.mockRejectedValue(
        makeServiceError('Inbox item not found: m-x', 'SHARING_INBOX_NOT_FOUND'),
      );
      const res = await request(buildApp()).post('/api/sharing/buckets/b1/inbox/m-x/promote');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SHARING_INBOX_NOT_FOUND');
    });

    it('maps SHARING_RECORDS_PENDING to HTTP 409 (transient sync conflict)', async () => {
      importer.promoteInboxItem.mockRejectedValue(
        makeServiceError('Manifest records are still syncing (3 missing)', 'SHARING_RECORDS_PENDING'),
      );
      const res = await request(buildApp()).post('/api/sharing/buckets/b1/inbox/m-1/promote');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SHARING_RECORDS_PENDING');
    });

    it('maps SHARING_ASSETS_PENDING to HTTP 409', async () => {
      importer.promoteInboxItem.mockRejectedValue(
        makeServiceError('Manifest assets are still syncing (2 missing)', 'SHARING_ASSETS_PENDING'),
      );
      const res = await request(buildApp()).post('/api/sharing/buckets/b1/inbox/m-1/promote');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SHARING_ASSETS_PENDING');
    });
  });

  describe('POST /api/sharing/buckets/:id/inbox/:manifestId/dismiss', () => {
    it('forwards the dismiss call', async () => {
      importer.dismissInboxItem.mockResolvedValue({ dismissed: true });
      const res = await request(buildApp()).post('/api/sharing/buckets/b1/inbox/m-1/dismiss');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ dismissed: true });
      expect(importer.dismissInboxItem).toHaveBeenCalledWith('b1', 'm-1');
    });
  });

  describe('GET /api/sharing/subscriptions', () => {
    it('returns all subscriptions when no filter is given', async () => {
      subs.listSubscriptions.mockResolvedValue([{ id: 'sub-1' }]);
      const res = await request(buildApp()).get('/api/sharing/subscriptions');
      expect(res.status).toBe(200);
      expect(res.body.subscriptions).toEqual([{ id: 'sub-1' }]);
      expect(subs.listSubscriptions).toHaveBeenCalledWith({});
    });

    it('forwards bucketId / recordKind / recordId query filters', async () => {
      subs.listSubscriptions.mockResolvedValue([]);
      await request(buildApp()).get(
        '/api/sharing/subscriptions?bucketId=b1&recordKind=series&recordId=s1',
      );
      expect(subs.listSubscriptions).toHaveBeenCalledWith({
        bucketId: 'b1',
        recordKind: 'series',
        recordId: 's1',
      });
    });
  });

  describe('POST /api/sharing/subscriptions', () => {
    it('rejects when recordKind is missing', async () => {
      const res = await request(buildApp())
        .post('/api/sharing/subscriptions')
        .send({ bucketId: 'b1', recordId: 's1' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(subs.subscribe).not.toHaveBeenCalled();
    });

    it('rejects when recordKind is not subscribable (media)', async () => {
      const res = await request(buildApp())
        .post('/api/sharing/subscriptions')
        .send({ bucketId: 'b1', recordKind: 'media', recordId: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('creates a subscription and returns 201', async () => {
      const created = {
        id: 'sub:b1:series:s1',
        bucketId: 'b1',
        recordKind: 'series',
        recordId: 's1',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
        lastManifestId: 'm-init',
        lastExportedAt: '2026-05-01T00:00:00Z',
      };
      subs.subscribe.mockResolvedValue(created);
      const res = await request(buildApp())
        .post('/api/sharing/subscriptions')
        .send({ bucketId: 'b1', recordKind: 'series', recordId: 's1' });
      expect(res.status).toBe(201);
      expect(res.body.subscription).toEqual(created);
    });

    it('maps SHARING_BUCKET_NOT_FOUND from subscribe → HTTP 404', async () => {
      // subscribe() calls getBucket() which can throw SHARING_BUCKET_NOT_FOUND.
      subs.subscribe.mockRejectedValue(
        makeServiceError('Bucket not found: b-x', 'SHARING_BUCKET_NOT_FOUND'),
      );
      const res = await request(buildApp())
        .post('/api/sharing/subscriptions')
        .send({ bucketId: 'b-x', recordKind: 'series', recordId: 's1' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SHARING_BUCKET_NOT_FOUND');
    });

    it('maps SHARING_SUBSCRIPTION_VALIDATION from subscribe → HTTP 400', async () => {
      subs.subscribe.mockRejectedValue(
        makeServiceError('bucketId and recordId are required', 'SHARING_SUBSCRIPTION_VALIDATION'),
      );
      const res = await request(buildApp())
        .post('/api/sharing/subscriptions')
        .send({ bucketId: 'b1', recordKind: 'series', recordId: 's1' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SHARING_SUBSCRIPTION_VALIDATION');
    });
  });

  describe('DELETE /api/sharing/subscriptions/:id', () => {
    it('forwards the unsubscribe call', async () => {
      // Real service contract: `subs.unsubscribe` resolves with `{ id, removed: true }`.
      subs.unsubscribe.mockResolvedValue({ id: 'sub-1', removed: true });
      const res = await request(buildApp()).delete('/api/sharing/subscriptions/sub-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'sub-1', removed: true });
      expect(subs.unsubscribe).toHaveBeenCalledWith('sub-1');
    });

    it('maps SHARING_SUBSCRIPTION_NOT_FOUND to HTTP 404', async () => {
      subs.unsubscribe.mockRejectedValue(
        makeServiceError('Subscription not found: sub-x', 'SHARING_SUBSCRIPTION_NOT_FOUND'),
      );
      const res = await request(buildApp()).delete('/api/sharing/subscriptions/sub-x');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SHARING_SUBSCRIPTION_NOT_FOUND');
    });
  });

  describe('GET /api/sharing/buckets/:id/activity', () => {
    it('returns manifests filtered through readManifest with the filename attached', async () => {
      buckets.getBucket.mockResolvedValue(makeBucket());
      manifest.listManifestFilenames.mockResolvedValue(['a.json', 'b.json', 'c.json']);
      manifest.readManifest
        .mockResolvedValueOnce({ manifestId: 'a', kind: 'series' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ manifestId: 'c', kind: 'universe' });

      const res = await request(buildApp()).get('/api/sharing/buckets/b1/activity');
      expect(res.status).toBe(200);
      expect(res.body.manifests).toEqual([
        { filename: 'a.json', manifestId: 'a', kind: 'series' },
        { filename: 'c.json', manifestId: 'c', kind: 'universe' },
      ]);
      expect(manifest.listManifestFilenames).toHaveBeenCalledWith('/tmp/bucket-one');
    });

    it('caps at the first 50 filenames before reading', async () => {
      buckets.getBucket.mockResolvedValue(makeBucket());
      const filenames = Array.from({ length: 75 }, (_, i) => `m-${i}.json`);
      manifest.listManifestFilenames.mockResolvedValue(filenames);
      manifest.readManifest.mockImplementation(async (_path, f) => ({ manifestId: f.replace('.json', '') }));

      const res = await request(buildApp()).get('/api/sharing/buckets/b1/activity');
      expect(res.status).toBe(200);
      expect(res.body.manifests).toHaveLength(50);
      expect(manifest.readManifest).toHaveBeenCalledTimes(50);
    });
  });
});
