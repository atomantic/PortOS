import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/sharing/peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
  subscribePeer: vi.fn(),
  unsubscribePeer: vi.fn(),
  applyIncomingPush: vi.fn(),
  forcePushRecord: vi.fn(),
  getRecordPayloadForPeer: vi.fn(),
  pullRecordFromPeer: vi.fn(),
  syncNowForPeer: vi.fn(),
  ERR_NOT_FOUND: 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND',
  ERR_VALIDATION: 'PEER_SYNC_SUBSCRIPTION_VALIDATION',
  ERR_SCHEMA_VERSION_AHEAD: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
  PEER_SUBSCRIBABLE_KINDS: Object.freeze(['universe', 'series', 'mediaCollection']),
}));

vi.mock('../services/sharing/integrity.js', () => ({
  buildLocalManifest: vi.fn(),
  getPeerIntegrity: vi.fn(),
}));

vi.mock('../services/sharing/sidecarSync.js', () => ({
  backfillMissingSidecars: vi.fn(),
}));

import * as svc from '../services/sharing/peerSync.js';
import * as integritySvc from '../services/sharing/integrity.js';
import * as sidecarSvc from '../services/sharing/sidecarSync.js';
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
    integritySvc.buildLocalManifest.mockResolvedValue([]);
    integritySvc.getPeerIntegrity.mockResolvedValue({ available: false, reason: 'peer-not-found', records: [] });
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

    it('accepts a universe push that bundles a linkedCollection (Stage 5 media-collections sync)', async () => {
      // Regression: peerSyncPushSchema's strict() branches must include
      // `linkedCollection` — without it, every production push from a
      // universe/series with images 400s because peerSync.js's
      // buildPushPayload spreads `linkedCollection` into the payload.
      svc.applyIncomingPush.mockResolvedValue({ missingAssets: [], reverseSubscriptionCreated: false, ackedDeletesUpTo: 0 });
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          linkedCollection: { id: 'col-1', name: 'Universe: Foo', items: [] },
        });
      expect(res.status).toBe(200);
      expect(svc.applyIncomingPush).toHaveBeenCalledWith(expect.objectContaining({
        linkedCollection: expect.objectContaining({ id: 'col-1' }),
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

    it('accepts an image manifest entry carrying sidecarSha256', async () => {
      svc.applyIncomingPush.mockResolvedValue({ missingAssets: [], reverseSubscriptionCreated: false, ackedDeletesUpTo: 0 });
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [{ filename: 'a.png', kind: 'image', sha256: 'a'.repeat(64), sidecarSha256: 'b'.repeat(64) }],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(200);
    });

    it('accepts a video/image-ref manifest entry without a sidecar hash', async () => {
      svc.applyIncomingPush.mockResolvedValue({ missingAssets: [], reverseSubscriptionCreated: false, ackedDeletesUpTo: 0 });
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'mediaCollection',
          record: { id: 'c1' },
          assetManifest: [
            { filename: 'v.mp4', kind: 'video', sha256: 'c'.repeat(64) },
            { filename: 'r.png', kind: 'image-ref', sha256: 'd'.repeat(64) },
          ],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(200);
    });

    it('accepts linkedCollection on a universe push (parent-bundled collection)', async () => {
      svc.applyIncomingPush.mockResolvedValue({ missingAssets: [], reverseSubscriptionCreated: false, ackedDeletesUpTo: 0 });
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          linkedCollection: { id: 'col-bundled' },
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(200);
    });

    it('400s when a mediaCollection push carries linkedCollection (no smuggled extra collection)', async () => {
      // A mediaCollection push IS the collection — accepting linkedCollection
      // would be a side-channel to overwrite an unrelated collection.
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'mediaCollection',
          record: { id: 'c1' },
          assetManifest: [],
          linkedCollection: { id: 'col-smuggled' },
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(400);
      expect(svc.applyIncomingPush).not.toHaveBeenCalled();
    });

    it('400s when a non-image manifest entry carries sidecarSha256 (discriminated union)', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'mediaCollection',
          record: { id: 'c1' },
          assetManifest: [{ filename: 'v.mp4', kind: 'video', sha256: 'c'.repeat(64), sidecarSha256: 'e'.repeat(64) }],
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

    it('maps the service-layer ERR_SCHEMA_VERSION_AHEAD to a 409 with the diff in body.context.details', async () => {
      // Sender is on a newer storage layout. The route must return 409 (NOT
      // 400 or 500) and the JSON body must surface the diff so the sender's
      // pushRecordToPeer can persist the gap on the subscription.
      const details = {
        ahead: [{ category: 'universes', senderV: 6, receiverV: 5 }],
        behind: [],
        senderPortosVersion: '99.0.0',
        receiverSchemaVersions: { universes: 5 },
      };
      const err = Object.assign(new Error('schema ahead'), {
        code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
        details,
      });
      svc.applyIncomingPush.mockRejectedValue(err);
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 6 } },
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
      expect(res.body.context.details).toEqual(details);
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

    it('rejects a universe push that smuggles an issues[] field (discriminated union)', async () => {
      // Regression: peerSyncPushSchema is a discriminated union on `kind`.
      // Only the series branch accepts `issues`; the universe branch is
      // .strict() so any `issues` field — even a single entry — fails Zod
      // parsing. Without this guard, a malicious peer could send
      // kind='universe' with a large issues array and force the receiver to
      // iterate it via computeAckedDeletesFromPayload before realizing the
      // kind mismatch. Body-parser limits catch the genuinely huge case;
      // the schema catches the moderately-sized-but-still-malicious case.
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'universe',
          record: { id: 'u1' },
          issues: [{ id: 'i1' }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
      expect(res.status).toBe(400);
      expect(svc.applyIncomingPush).not.toHaveBeenCalled();
    });

    it('caps the series-push issues[] at 1000 entries (defense in depth alongside body limit)', async () => {
      // Series can carry issues, but 1001+ is rejected by the schema. Body
      // parser limits would also catch genuinely huge payloads; this cap
      // catches the moderately-sized-but-still-too-big case (e.g. ~50k that
      // fits under the 55mb body cap but is still 50× larger than any
      // realistic series).
      const res = await request(buildApp())
        .post('/api/peer-sync/push')
        .send({
          kind: 'series',
          record: { id: 's1' },
          issues: Array.from({ length: 1001 }, (_, i) => ({ id: `i${i}` })),
          assetManifest: [],
          sourceInstanceId: 'peer-a',
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
    it('201s with the new subscription (matches share-bucket subscribe convention)', async () => {
      svc.subscribePeer.mockResolvedValue({
        id: 'peer-universe-u1-peer-a',
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      });
      const res = await request(buildApp())
        .post('/api/peer-sync/subscriptions')
        .send({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(res.status).toBe(201);
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

  describe('GET /api/peer-sync/manifest', () => {
    it('200 with records for a valid kind', async () => {
      const records = [
        { id: 'col-1', name: 'My Collection', updatedAt: '2026-05-23T00:00:00.000Z', deleted: false, assetHashes: [] },
      ];
      integritySvc.buildLocalManifest.mockResolvedValue(records);

      const res = await request(buildApp())
        .get('/api/peer-sync/manifest?kind=mediaCollection');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ records });
      expect(integritySvc.buildLocalManifest).toHaveBeenCalledWith('mediaCollection');
    });

    it('400 when kind is missing', async () => {
      const res = await request(buildApp())
        .get('/api/peer-sync/manifest');
      expect(res.status).toBe(400);
      expect(integritySvc.buildLocalManifest).not.toHaveBeenCalled();
    });

    it('400 when kind is invalid', async () => {
      const res = await request(buildApp())
        .get('/api/peer-sync/manifest?kind=unknown');
      expect(res.status).toBe(400);
      expect(integritySvc.buildLocalManifest).not.toHaveBeenCalled();
    });

    it('accepts all valid subscribable kinds', async () => {
      for (const kind of ['universe', 'series', 'mediaCollection']) {
        integritySvc.buildLocalManifest.mockResolvedValue([]);
        const res = await request(buildApp())
          .get(`/api/peer-sync/manifest?kind=${kind}`);
        expect(res.status).toBe(200);
      }
    });

    it('trims surrounding whitespace from kind before validation + the service call', async () => {
      integritySvc.buildLocalManifest.mockResolvedValue([]);
      const res = await request(buildApp())
        .get('/api/peer-sync/manifest?kind=%20universe%20');
      expect(res.status).toBe(200);
      expect(integritySvc.buildLocalManifest).toHaveBeenCalledWith('universe');
    });
  });

  describe('GET /api/peer-sync/integrity', () => {
    it('200 with available:false when peer is not found', async () => {
      integritySvc.getPeerIntegrity.mockResolvedValue({
        available: false,
        reason: 'peer-not-found',
        records: [],
      });

      const res = await request(buildApp())
        .get('/api/peer-sync/integrity?peerId=no-such-peer&kind=mediaCollection');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ available: false, reason: 'peer-not-found', records: [] });
      expect(integritySvc.getPeerIntegrity).toHaveBeenCalledWith({
        peerId: 'no-such-peer',
        kind: 'mediaCollection',
      });
    });

    it('200 with available:true and records when peer responds', async () => {
      integritySvc.getPeerIntegrity.mockResolvedValue({
        available: true,
        records: [{ id: 'col-1', name: 'My Collection', status: 'in-parity' }],
      });

      const res = await request(buildApp())
        .get('/api/peer-sync/integrity?peerId=peer-x&kind=mediaCollection');
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.records).toHaveLength(1);
    });

    it('trims surrounding whitespace from peerId and kind before the service call', async () => {
      integritySvc.getPeerIntegrity.mockResolvedValue({ available: true, records: [] });
      const res = await request(buildApp())
        .get('/api/peer-sync/integrity?peerId=%20peer-x%20&kind=%20mediaCollection%20');
      expect(res.status).toBe(200);
      // Service receives the trimmed values — otherwise ' peer-x ' silently
      // fails to match the peer registry and returns peer-not-found.
      expect(integritySvc.getPeerIntegrity).toHaveBeenCalledWith({
        peerId: 'peer-x',
        kind: 'mediaCollection',
      });
    });

    it('400 when peerId is missing', async () => {
      const res = await request(buildApp())
        .get('/api/peer-sync/integrity?kind=mediaCollection');
      expect(res.status).toBe(400);
      expect(integritySvc.getPeerIntegrity).not.toHaveBeenCalled();
    });

    it('400 when peerId is an empty / whitespace string', async () => {
      for (const peerId of ['', '%20%20']) {
        const res = await request(buildApp())
          .get(`/api/peer-sync/integrity?peerId=${peerId}&kind=mediaCollection`);
        expect(res.status).toBe(400);
      }
      expect(integritySvc.getPeerIntegrity).not.toHaveBeenCalled();
    });

    it('400 when kind is missing', async () => {
      const res = await request(buildApp())
        .get('/api/peer-sync/integrity?peerId=peer-x');
      expect(res.status).toBe(400);
      expect(integritySvc.getPeerIntegrity).not.toHaveBeenCalled();
    });

    it('400 when kind is invalid', async () => {
      const res = await request(buildApp())
        .get('/api/peer-sync/integrity?peerId=peer-x&kind=issue');
      expect(res.status).toBe(400);
      expect(integritySvc.getPeerIntegrity).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/peer-sync/sync-record', () => {
    it('200 with the result when body is valid', async () => {
      svc.forcePushRecord.mockResolvedValue({ pushed: true, hash: 'abc' });
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-record')
        .send({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(res.status).toBe(200);
      expect(res.body.pushed).toBe(true);
      expect(svc.forcePushRecord).toHaveBeenCalledWith('peer-a', 'universe', 'u1');
    });

    it('400 when recordId is missing', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-record')
        .send({ peerId: 'peer-a', recordKind: 'universe' });
      expect(res.status).toBe(400);
      expect(svc.forcePushRecord).not.toHaveBeenCalled();
    });

    it('400 when recordKind is invalid', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-record')
        .send({ peerId: 'peer-a', recordKind: 'issue', recordId: 'i1' });
      expect(res.status).toBe(400);
      expect(svc.forcePushRecord).not.toHaveBeenCalled();
    });

    it('400 when peerId is missing', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-record')
        .send({ recordKind: 'universe', recordId: 'u1' });
      expect(res.status).toBe(400);
      expect(svc.forcePushRecord).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/peer-sync/record', () => {
    it('200 with the record payload for a valid kind + id', async () => {
      svc.getRecordPayloadForPeer.mockResolvedValue({ kind: 'universe', record: { id: 'u1' }, assetManifest: [], sourceInstanceId: 'me' });
      const res = await request(buildApp()).get('/api/peer-sync/record?kind=universe&id=u1');
      expect(res.status).toBe(200);
      expect(res.body.record.id).toBe('u1');
      expect(svc.getRecordPayloadForPeer).toHaveBeenCalledWith('universe', 'u1');
    });

    it('trims kind + id before the lookup', async () => {
      svc.getRecordPayloadForPeer.mockResolvedValue({ kind: 'universe', record: { id: 'u1' }, assetManifest: [], sourceInstanceId: 'me' });
      await request(buildApp()).get('/api/peer-sync/record?kind=%20universe%20&id=%20u1%20');
      expect(svc.getRecordPayloadForPeer).toHaveBeenCalledWith('universe', 'u1');
    });

    it('404 when the record does not exist locally', async () => {
      svc.getRecordPayloadForPeer.mockResolvedValue(null);
      const res = await request(buildApp()).get('/api/peer-sync/record?kind=universe&id=ghost');
      expect(res.status).toBe(404);
    });

    it('400 on invalid kind or missing id', async () => {
      expect((await request(buildApp()).get('/api/peer-sync/record?kind=issue&id=x')).status).toBe(400);
      expect((await request(buildApp()).get('/api/peer-sync/record?kind=universe&id=%20%20')).status).toBe(400);
      expect(svc.getRecordPayloadForPeer).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/peer-sync/pull-record', () => {
    it('200 with the pull result for a valid body', async () => {
      svc.pullRecordFromPeer.mockResolvedValue({ pulled: true, missingAssets: 3 });
      const res = await request(buildApp())
        .post('/api/peer-sync/pull-record')
        .send({ peerId: 'peer-a', recordKind: 'mediaCollection', recordId: 'uc-7' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ pulled: true, missingAssets: 3 });
      expect(svc.pullRecordFromPeer).toHaveBeenCalledWith('peer-a', 'mediaCollection', 'uc-7');
    });

    it('400 on invalid body (missing recordId / bad kind / missing peerId)', async () => {
      expect((await request(buildApp()).post('/api/peer-sync/pull-record').send({ peerId: 'p', recordKind: 'universe' })).status).toBe(400);
      expect((await request(buildApp()).post('/api/peer-sync/pull-record').send({ peerId: 'p', recordKind: 'issue', recordId: 'i' })).status).toBe(400);
      expect((await request(buildApp()).post('/api/peer-sync/pull-record').send({ recordKind: 'universe', recordId: 'u1' })).status).toBe(400);
      expect(svc.pullRecordFromPeer).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/peer-sync/sync-now', () => {
    it('200 with {ok:true} for a valid peerId', async () => {
      svc.syncNowForPeer.mockResolvedValue({ ok: true });
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-now')
        .send({ peerId: 'peer-a' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(svc.syncNowForPeer).toHaveBeenCalledWith('peer-a');
    });

    it('200 with {ok:false} when peer has no instanceId', async () => {
      svc.syncNowForPeer.mockResolvedValue({ ok: false });
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-now')
        .send({ peerId: 'ghost-peer' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
    });

    it('400 when peerId is missing', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/sync-now')
        .send({});
      expect(res.status).toBe(400);
      expect(svc.syncNowForPeer).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/peer-sync/pull-metadata', () => {
    it('200 with backfill result for valid body', async () => {
      sidecarSvc.backfillMissingSidecars.mockResolvedValue({ attempted: 3, recovered: 2 });
      const res = await request(buildApp())
        .post('/api/peer-sync/pull-metadata')
        .send({ filenames: ['a.png', 'b.png', 'c.png'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ attempted: 3, recovered: 2 });
      expect(sidecarSvc.backfillMissingSidecars).toHaveBeenCalledWith({ filenames: ['a.png', 'b.png', 'c.png'] });
    });

    it('trims surrounding whitespace from filenames before the service call', async () => {
      sidecarSvc.backfillMissingSidecars.mockResolvedValue({ attempted: 1, recovered: 1 });
      const res = await request(buildApp())
        .post('/api/peer-sync/pull-metadata')
        .send({ filenames: ['  a.png  ', 'b.png'] });
      expect(res.status).toBe(200);
      // Whitespace would otherwise yield a real-but-different name that fails
      // disk lookup (confusing attempted>0, recovered=0).
      expect(sidecarSvc.backfillMissingSidecars).toHaveBeenCalledWith({ filenames: ['a.png', 'b.png'] });
    });

    it('400 when filenames is not an array', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/pull-metadata')
        .send({ filenames: 'not-an-array' });
      expect(res.status).toBe(400);
      expect(sidecarSvc.backfillMissingSidecars).not.toHaveBeenCalled();
    });

    it('400 when filenames is missing', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/pull-metadata')
        .send({});
      expect(res.status).toBe(400);
      expect(sidecarSvc.backfillMissingSidecars).not.toHaveBeenCalled();
    });

    it('400 when filenames exceeds 5000 entries', async () => {
      const res = await request(buildApp())
        .post('/api/peer-sync/pull-metadata')
        .send({ filenames: Array.from({ length: 5001 }, (_, i) => `f${i}.png`) });
      expect(res.status).toBe(400);
      expect(sidecarSvc.backfillMissingSidecars).not.toHaveBeenCalled();
    });
  });
});
