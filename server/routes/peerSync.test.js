import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/sharing/peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
  subscribePeer: vi.fn(),
  unsubscribePeer: vi.fn(),
  applyIncomingPush: vi.fn(),
  ERR_NOT_FOUND: 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND',
  ERR_VALIDATION: 'PEER_SYNC_SUBSCRIPTION_VALIDATION',
}));

import * as svc from '../services/sharing/peerSync.js';
import peerSyncRoutes from './peerSync.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/peer-sync', peerSyncRoutes);
  app.use(errorMiddleware);
  return app;
};

const serviceError = (msg, code) => Object.assign(new Error(msg), { code });

describe('peer-sync routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/peer-sync/push', () => {
    it('200s with the service result for a valid universe push', async () => {
      svc.applyIncomingPush.mockResolvedValue({
        missingAssets: [],
        reverseSubscriptionCreated: true,
        ackedDeletesUpTo: 0,
      });
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(200);
      expect(res.body.reverseSubscriptionCreated).toBe(true);
      expect(svc.applyIncomingPush).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'universe',
        sourceInstanceId: 'peer-a',
      }));
    });

    it('accepts a series push with bundled issues', async () => {
      svc.applyIncomingPush.mockResolvedValue({ missingAssets: [], reverseSubscriptionCreated: false, ackedDeletesUpTo: 0 });
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'series',
          record: { id: 's1' },
          issues: [{ id: 'i1' }, { id: 'i2' }],
          assetManifest: [{ filename: 'a.png', kind: 'image', sha256: 'a'.repeat(64) }],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(200);
      expect(svc.applyIncomingPush).toHaveBeenCalledWith(expect.objectContaining({
        issues: expect.any(Array),
      }));
    });

    it('400s on an invalid kind (Zod boundary catches before service)', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'mystery',
          record: { id: 'x' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(400);
      expect(svc.applyIncomingPush).not.toHaveBeenCalled();
    });

    it('400s when the record is missing an id', async () => {
      // Stage 1's schema-parity rule: validation must catch the malformed
      // record at the route boundary, not let the service throw.
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { name: 'No ID' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(400);
    });

    it('400s when sourceInstanceId is empty (the service-layer guard ALSO catches this, but the schema should reject first)', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: '',
        });
      expect(res.status).toBe(400);
    });

    it('maps the service-layer ERR_VALIDATION to a 400 (service-side guards beyond Zod)', async () => {
      // sourceInstanceId="unknown" is shape-valid but gets rejected by the
      // service for the cursor-poisoning reason — the route must surface that
      // as a 400, not a 500.
      svc.applyIncomingPush.mockRejectedValue(
        serviceError('sourceInstanceId required (and not "unknown")', 'PEER_SYNC_SUBSCRIPTION_VALIDATION'),
      );
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: 'unknown',
        });
      expect(res.status).toBe(400);
    });

    it('caps assetManifest at 2000 entries (memory-amplification guard)', async () => {
      // An adversarial peer could ship a manifest of 1M filenames and force
      // the receiver to stat each one. The schema caps at 2k entries (well
      // above any realistic universe size).
      const huge = Array.from({ length: 2001 }, (_, i) => ({
        filename: `f${i}.png`, kind: 'image',
      }));
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: huge,
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/peer-sync/subscriptions', () => {
    it('returns subscriptions and honors query filters', async () => {
      svc.listPeerSubscriptions.mockResolvedValue([
        { id: 'peer-universe-u1-peer-a', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
      ]);
      const res = await request(buildApp())
        .get('/api/peer-sync/subscriptions?peerId=peer-a');
      expect(res.status).toBe(200);
      expect(res.body.subscriptions).toHaveLength(1);
      expect(svc.listPeerSubscriptions).toHaveBeenCalledWith({ peerId: 'peer-a' });
    });

    it('ignores non-string query values (no filter applied)', async () => {
      svc.listPeerSubscriptions.mockResolvedValue([]);
      // Repeated `peerId=` keys produce an array under default Express qs
      // parsing — the route guards on `typeof === 'string'` so neither value
      // leaks into the filter.
      const res = await request(buildApp())
        .get('/api/peer-sync/subscriptions?peerId=array&peerId=value');
      expect(res.status).toBe(200);
      expect(svc.listPeerSubscriptions).toHaveBeenCalledWith({});
    });
  });

  describe('POST /api/peer-sync/subscriptions', () => {
    it('200s with the new subscription', async () => {
      svc.subscribePeer.mockResolvedValue({
        id: 'peer-universe-u1-peer-a',
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      });
      const res = await request(buildApp())
        .post('/api/peer-sync/subscriptions')
        .send({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(res.status).toBe(200);
      expect(res.body.subscription.peerId).toBe('peer-a');
    });

    it('400s when recordKind is "issue" (only universe + series subscribable)', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/subscriptions')
        .send({ peerId: 'peer-a', recordKind: 'issue', recordId: 'i1' });
      expect(res.status).toBe(400);
      expect(svc.subscribePeer).not.toHaveBeenCalled();
    });

    it('maps service ERR_VALIDATION to 400', async () => {
      svc.subscribePeer.mockRejectedValue(
        serviceError('boom', 'PEER_SYNC_SUBSCRIPTION_VALIDATION'),
      );
      const res = await request(buildApp())
        .post('/api/peer-sync/subscriptions')
        .send({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/peer-sync/subscriptions/:id', () => {
    it('200s when removed', async () => {
      svc.unsubscribePeer.mockResolvedValue({ id: 'peer-universe-u1-peer-a', removed: true });
      const res = await request(buildApp())
        .delete('/api/peer-sync/subscriptions/peer-universe-u1-peer-a');
      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(true);
    });

    it('404 when the id is unknown', async () => {
      svc.unsubscribePeer.mockRejectedValue(
        serviceError('Peer subscription not found: x', 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND'),
      );
      const res = await request(buildApp())
        .delete('/api/peer-sync/subscriptions/x');
      expect(res.status).toBe(404);
    });
  });
});
