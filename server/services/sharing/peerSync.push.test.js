import { tmp, acceptsPush, enableMusicVideoPeer, installPeerSyncHooks } from './peerSync.test.fixture.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import {
  subscribePeer,
  pushRecordToPeer,
  retryPendingPushesForPeer,
  forcePushRecord,
  getRecordPayloadForPeer,
  triggerPushForRecord,
  __drainForTests,
  installPeerSyncListener,
  uninstallPeerSyncListener,
} from './peerSync.js';
import { findPeerSubscription } from './peerSubscriptions.js';
import { __resetPushFailureLogForTests } from './peerSyncPush.js';
import { DEBOUNCE_MS } from './peerSyncShared.js';
import { getPeers } from '../instances.js';
import { getInstanceId } from '../instanceIdentity.js';
import { getUniverse, listUniverses } from '../universeBuilder.js';
import { getSeries } from '../pipeline/series.js';
import { listIssues, listIssuesForSeries } from '../pipeline/issues.js';
import { getReview } from '../pipeline/manuscriptReview.js';
import { getStoredOutline } from '../pipeline/reverseOutline.js';
import { getCollection, findCollectionByUniverseId } from '../mediaCollections.js';
import { getArtist } from '../artists/index.js';
import { getAlbum } from '../albums/index.js';
import { getTrack } from '../tracks/index.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getLoom } from '../fableLoom/records.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { listCursors } from './peerTombstoneCursors.js';
import { contentHashForRecord, getSyncBaseHash } from '../../lib/conflictJournal.js';

installPeerSyncHooks();

describe('peerSync', () => {
  describe('retryPendingPushesForPeer', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(listIssues).mockResolvedValue([]);
    });

    it('re-pushes subs with lastPushedAt=null and walks all subs on subsequent retries (hash short-circuits unchanged ones)', async () => {
      // Create a sub with the initial push FAILING — leaves lastPushedAt=null.
      vi.mocked(peerFetch).mockResolvedValueOnce(null);
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      // Wait for the fire-and-forget initial push to settle so the persisted
      // lastPushedAt is final before we re-check it. Deterministic drain, not a
      // fixed sleep — the assertion below is a negative (lastPushedAt stayed
      // null), which vi.waitFor cannot poll for.
      await __drainForTests();
      const stale = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(stale.lastPushedAt).toBeNull();
      // Peer comes back — retry must succeed and stamp lastPushedAt.
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const result = await retryPendingPushesForPeer('peer-a');
      expect(result.walked).toBe(1);
      expect(result.pushed).toBe(1); // network call landed
      const updated = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(updated.lastPushedAt).toBeTruthy();
      // Subsequent retry now walks every sub regardless of lastPushedAt
      // (the lastPushedHash short-circuit inside pushRecordToPeer is what
      // skips the actual HTTP call for unchanged records). This is the
      // mechanism that lets out-of-band file edits (e.g., a cleanup script
      // that wrote tombstones directly to disk) re-propagate via peer:online
      // without needing a per-record edit. A server restart reaches this path
      // too: instances.js emits peer:online on the first probe of each peer per
      // process even when the persisted status was already online (#11750; see
      // the boot-convergence test below).
      vi.mocked(peerFetch).mockClear();
      const second = await retryPendingPushesForPeer('peer-a');
      expect(second.walked).toBe(1); // walked, not skipped by the helper
      expect(second.pushed).toBe(0); // hash short-circuited, no HTTP call
      // The hash short-circuit inside pushRecordToPeer prevents the actual
      // HTTP call because the record content is unchanged since the first push.
      expect(vi.mocked(peerFetch)).not.toHaveBeenCalled();
    });

    it('boot convergence: the first peer:online after a restart pushes an edit stranded by the restart exactly once, a converged peer costs zero HTTP calls (#11750)', async () => {
      const { instanceEvents } = await import('../instanceEvents.js');
      const { installPeerSyncListener } = await import('./peerSync.js');
      installPeerSyncListener();
      const peer = {
        id: 'local-a', instanceId: 'peer-a', enabled: true, syncEnabled: true, status: 'online',
        directions: ['outbound'], syncCategories: { universe: true },
      };
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await __drainForTests();

      // Converged peer: the boot-time event walks the sub but sends nothing.
      vi.mocked(peerFetch).mockClear();
      instanceEvents.emit('peer:online', peer);
      await __drainForTests();
      expect(vi.mocked(peerFetch)).not.toHaveBeenCalled();

      // The record changed after the last push but the debounce never fired
      // (the process restarted); the first boot event delivers it once.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Edited just before restart' });
      instanceEvents.emit('peer:online', peer);
      await __drainForTests();
      const pushCalls = () => vi.mocked(peerFetch).mock.calls.length;
      expect(pushCalls()).toBeGreaterThan(0);

      // A repeat event with the record unchanged since that push sends nothing.
      const afterFirst = pushCalls();
      instanceEvents.emit('peer:online', peer);
      await __drainForTests();
      expect(pushCalls()).toBe(afterFirst);
    });

    it('shutdown mid-walk stops pushing the remaining subscriptions and logs nothing (#12585)', async () => {
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
      vi.mocked(getUniverse).mockImplementation(async (id) => ({ id }));
      // Initial pushes fail so every sub is still unpushed when the walk starts.
      vi.mocked(peerFetch).mockResolvedValue(null);
      for (const id of ['u1', 'u2', 'u3']) await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: id });
      await __drainForTests();

      // Shutdown lands while the first retry push is in flight; the later pushes
      // would hit a closed pool in production.
      vi.mocked(peerFetch).mockReset();
      vi.mocked(peerFetch).mockImplementation(async () => {
        uninstallPeerSyncListener();
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await retryPendingPushesForPeer('peer-a');
        expect(vi.mocked(peerFetch)).toHaveBeenCalledTimes(1);
        expect(result.pushed).toBe(1);
        // A walk that starts after shutdown does nothing at all.
        expect(await retryPendingPushesForPeer('peer-a')).toEqual({ walked: 0, pushed: 0 });
        expect(vi.mocked(peerFetch)).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('returns {walked: 0, pushed: 0} when the peer has no subscriptions', async () => {
      const result = await retryPendingPushesForPeer('peer-without-subs');
      expect(result).toEqual({ walked: 0, pushed: 0 });
    });

    it('returns {walked: 0, pushed: 0} for invalid peerId', async () => {
      expect(await retryPendingPushesForPeer('')).toEqual({ walked: 0, pushed: 0 });
      expect(await retryPendingPushesForPeer(null)).toEqual({ walked: 0, pushed: 0 });
    });
  });

  describe('scheduled push retry while the peer stays online', () => {
    const MINUTE = 60_000;
    const BACKOFF = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE];
    const examplePeer = (status) => ({
      instanceId: 'peer-a',
      name: 'Example Peer',
      host: null,
      address: '192.0.2.10',
      port: 5555,
      enabled: true,
      syncEnabled: true,
      status,
      directions: ['outbound', 'inbound'],
      syncCategories: { universe: true, pipeline: true },
    });
    const httpStatus = (status, body = { error: 'no' }) => {
      const res = { ok: false, status, json: async () => body };
      res.clone = () => res;
      return res;
    };
    const settled = () => ({ ok: true, status: 200, json: async () => ({ missingAssets: [] }) });

    beforeEach(() => {
      vi.mocked(getPeers).mockResolvedValue([examplePeer('online')]);
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function subscribed(recordId = 'u1') {
      return subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId },
        { adoptedFromReverse: true },
      );
    }

    async function advance(ms) {
      await vi.advanceTimersByTimeAsync(ms);
      await __drainForTests();
    }

    async function withFakeTimers(run) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await run();
      } finally {
        vi.useRealTimers();
      }
    }

    it('delivers a network failure on the scheduled retry without a peer:online event', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch)
          .mockRejectedValueOnce(new Error('ECONNRESET'))
          .mockResolvedValue(settled());
        expect(await pushRecordToPeer(sub)).toMatchObject({ pushed: false, reason: 'network' });
        expect(peerFetch).toHaveBeenCalledTimes(1);

        await advance(MINUTE - 1);
        expect(peerFetch).toHaveBeenCalledTimes(1);
        await advance(1);

        expect(peerFetch).toHaveBeenCalledTimes(2);
        expect((await findPeerSubscription('peer-a', 'universe', 'u1')).lastPushedAt).toBeTruthy();
        await advance(30 * MINUTE);
        expect(peerFetch).toHaveBeenCalledTimes(2);
      });
    });

    it.each([500, 408, 429])('retries HTTP %s on the same schedule', async (status) => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch)
          .mockResolvedValueOnce(httpStatus(status, { error: 'unavailable' }))
          .mockResolvedValue(settled());
        expect(await pushRecordToPeer(sub)).toMatchObject({ pushed: false, reason: `http-${status}` });
        await advance(MINUTE);
        expect(peerFetch).toHaveBeenCalledTimes(2);
        expect((await pushRecordToPeer(await findPeerSubscription('peer-a', 'universe', 'u1'))).reason).toBe('unchanged');
      });
    });

    it('does not retry a 400 or a schema 409', async () => {
      await withFakeTimers(async () => {
        const rejected = await subscribed('u-400');
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u-400', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
        vi.mocked(peerFetch).mockResolvedValue(httpStatus(400, { error: 'bad record' }));
        expect(await pushRecordToPeer(rejected)).toMatchObject({ pushed: false, reason: 'http-400' });

        vi.mocked(getUniverse).mockResolvedValue({ id: 'u-409', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
        const blocked = await subscribed('u-409');
        vi.mocked(peerFetch).mockResolvedValue(httpStatus(409, {
          code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
          context: {
            details: {
              ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
              behind: [],
              receiverPortosVersion: '0.0.0',
            },
          },
        }));
        expect(await pushRecordToPeer(blocked)).toMatchObject({ pushed: false, reason: 'peer-schema-behind' });

        await advance(MINUTE);
        await advance(30 * MINUTE);
        expect(peerFetch).toHaveBeenCalledTimes(2);
      });
    });

    it('backs off through 5 min and 15 min to the 30 min cap', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNRESET'));
        await pushRecordToPeer(sub);
        for (const delay of BACKOFF) {
          const before = vi.mocked(peerFetch).mock.calls.length;
          await advance(delay - 1);
          expect(vi.mocked(peerFetch).mock.calls.length).toBe(before);
          await advance(1);
          expect(vi.mocked(peerFetch).mock.calls.length).toBe(before + 1);
        }
        const atCap = vi.mocked(peerFetch).mock.calls.length;
        await advance(15 * MINUTE);
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(atCap);
        await advance(15 * MINUTE);
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(atCap + 1);
      });
    });

    it('a landed push cancels further retries for that peer', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch)
          .mockRejectedValueOnce(new Error('ECONNRESET'))
          .mockResolvedValue(settled());
        await pushRecordToPeer(sub);
        expect(await pushRecordToPeer(await findPeerSubscription('peer-a', 'universe', 'u1'))).toMatchObject({ pushed: true });
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Edited after delivery', updatedAt: '2026-01-02T00:00:00Z' });
        vi.mocked(peerFetch).mockClear();
        await advance(MINUTE);
        await advance(30 * MINUTE);
        expect(peerFetch).not.toHaveBeenCalled();
      });
    });

    it('skips the retry tick while the peer is offline', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNRESET'));
        await pushRecordToPeer(sub);
        vi.mocked(getPeers).mockResolvedValue([examplePeer('offline')]);
        await advance(MINUTE);
        await advance(30 * MINUTE);
        expect(peerFetch).toHaveBeenCalledTimes(1);
      });
    });

    it('skips the retry tick while a walk for that peer is already running', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch).mockRejectedValueOnce(new Error('ECONNRESET'));
        await pushRecordToPeer(sub);
        vi.mocked(peerFetch).mockClear();

        let resolveFetch = () => {};
        let markFetchEntered = () => {};
        const fetchEntered = new Promise((resolve) => { markFetchEntered = resolve; });
        vi.mocked(peerFetch).mockImplementation(() => {
          markFetchEntered();
          return new Promise((resolve) => {
            resolveFetch = () => resolve(settled());
          });
        });
        const walk = retryPendingPushesForPeer('peer-a');
        // The walk reads subscriptions from disk before calling the peer, so wait on the walk
        // itself rather than a fixed turn count; a walk that settles without reaching peerFetch fails here.
        const walkEnded = walk.then((result) => ({ result }), (error) => ({ error }));
        const outcome = await Promise.race([fetchEntered.then(() => 'entered'), walkEnded]);
        if (outcome !== 'entered') {
          throw new Error(`retry walk settled without calling peerFetch: ${JSON.stringify(outcome.error?.message ?? outcome.result)}`);
        }
        expect(peerFetch).toHaveBeenCalledTimes(1);
        expect(await retryPendingPushesForPeer('peer-a')).toEqual({ walked: 0, pushed: 0, skipped: 'in-flight' });

        await advance(MINUTE);
        expect(peerFetch).toHaveBeenCalledTimes(1);
        resolveFetch();
        await walk;
      });
    });

    it('retries a missing-asset response without a new edit', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch).mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ missingAssets: [{ filename: 'example.png' }] }),
        });
        const first = await pushRecordToPeer(sub);
        expect(first.pushed).toBe(true);
        expect(first.missingAssets).toHaveLength(1);
        expect((await findPeerSubscription('peer-a', 'universe', 'u1')).lastPushedHash).toBeFalsy();
        vi.mocked(peerFetch).mockClear();

        await advance(MINUTE - 1);
        expect(peerFetch).not.toHaveBeenCalled();
        await advance(1);
        expect(peerFetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(vi.mocked(peerFetch).mock.calls[0][1].body);
        expect(body.record.id).toBe('u1');
      });
    });

    it('uninstall cancels a pending retry', async () => {
      await withFakeTimers(async () => {
        const sub = await subscribed();
        vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNRESET'));
        await pushRecordToPeer(sub);
        uninstallPeerSyncListener();
        installPeerSyncListener();
        await advance(MINUTE);
        await advance(30 * MINUTE);
        expect(peerFetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('forcePushRecord', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Forced', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(findCollectionByUniverseId).mockResolvedValue(null);
    });

    it('pushes even when existing sub lastPushedHash matches (bypasses unchanged short-circuit)', async () => {
      // First subscribe + initial push — record gets a lastPushedHash.
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      // Poll for the fire-and-forget initial push to persist its hash. A fixed
      // sleep OR a single writeTail drain (__drainForTests) is racy in slower CI
      // because the push's peerFetch + persistPushDeliveryEvidence chain may not have even
      // started when we read — vi.waitFor retries the real condition deterministically.
      let sub;
      await vi.waitFor(async () => {
        sub = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(sub?.lastPushedHash).toBeTruthy();
      });
      expect(sub.lastPushedHash).toBeTruthy(); // hash was recorded

      // Clear the mock call count — we care only about calls from forcePushRecord.
      vi.mocked(peerFetch).mockClear();
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });

      // forcePushRecord MUST hit the network despite the hash being unchanged.
      const result = await forcePushRecord('peer-a', 'universe', 'u1');
      expect(result.pushed).toBe(true);
      expect(vi.mocked(peerFetch)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(peerFetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/peer-sync/push'),
        expect.objectContaining({ method: 'POST' }),
        expect.objectContaining({ instanceId: 'peer-a' }),
      );
    });

    it('creates a subscription and pushes when no sub existed yet', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });

      const result = await forcePushRecord('peer-a', 'universe', 'u1');
      expect(result.pushed).toBe(true);

      // Subscription should now exist.
      const sub = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(sub).not.toBeNull();
    });
  });

  describe('getRecordPayloadForPeer', () => {
    it('uses the collection history filename for both transfers and read-only integrity', async () => {
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      await writeFile(join(PATHS.videos, 'imported.webm'), 'video bytes');
      await writeFile(join(tmp, 'video-history.json'), JSON.stringify([{ id: 'video-id', filename: 'imported.webm' }]));
      vi.mocked(getCollection).mockResolvedValue({
        id: 'collection-1', name: 'Test collection', items: [{ kind: 'video', ref: 'video-id' }],
      });

      const inventory = await getRecordPayloadForPeer('mediaCollection', 'collection-1', { collectionIntegrity: true });
      expect(inventory).toMatchObject({
        assetManifest: [{ kind: 'video', filename: 'imported.webm', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
        videoFilenames: { 'video-id.mp4': 'imported.webm' },
      });
      const transfer = await getRecordPayloadForPeer('mediaCollection', 'collection-1');
      expect(transfer.assetManifest).toEqual(inventory.assetManifest);
      expect(transfer).not.toHaveProperty('videoFilenames');
    });

    it('returns a push-payload for an existing universe', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      const payload = await getRecordPayloadForPeer('universe', 'u1');
      expect(payload).toMatchObject({ kind: 'universe', record: { id: 'u1' } });
      expect(Array.isArray(payload.assetManifest)).toBe(true);
    });

    it('returns null when the record does not exist locally', async () => {
      vi.mocked(getUniverse).mockResolvedValue(undefined);
      expect(await getRecordPayloadForPeer('universe', 'ghost')).toBeNull();
    });

    it('returns null (no unknown-sourced payload) when self-identity is unknown', async () => {
      // Without the guard this would emit a payload with sourceInstanceId='unknown'
      // that the puller's applyIncomingPush rejects — or 500 on a read failure.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(getInstanceId).mockResolvedValueOnce('unknown');
      expect(await getRecordPayloadForPeer('universe', 'u1')).toBeNull();
    });

    it('returns null when self-identity read fails', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(getInstanceId).mockRejectedValueOnce(new Error('instances.json unreadable'));
      expect(await getRecordPayloadForPeer('universe', 'u1')).toBeNull();
    });
  });

  describe('pushRecordToPeer', () => {
    it('accepts a large missing-asset acknowledgement and keeps delivery pending', async () => {
      const sub = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' }, { adoptedFromReverse: true });
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Example' });
      const missingAssets = Array.from({ length: 1500 }, (_, i) => ({ kind: 'image', filename: `${i}-${'a'.repeat(80)}.png` }));
      const response = new Response(JSON.stringify({ missingAssets }));
      vi.mocked(peerFetch).mockResolvedValue(response);
      expect(await pushRecordToPeer(sub)).toMatchObject({ pushed: true, missingAssets });
      expect(peerFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxBytes: 256 * 1024 * 1024 }), expect.any(Object));
      expect((await findPeerSubscription('peer-a', 'universe', 'u1')).lastPushedHash).toBeFalsy();
    });

    it.each([200, 400, 409])('ends a stalled HTTP %s body without confirming delivery and permits retry', async (status) => {
      const sub = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' }, { adoptedFromReverse: true });
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Example' });
      let stream;
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ start(controller) { stream = controller; }, cancel }), { status });
      vi.mocked(peerFetch).mockResolvedValueOnce(response);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let outcome;
      const pending = pushRecordToPeer(sub).then(result => { outcome = result; });
      try {
        await vi.waitFor(() => expect(peerFetch).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(5000);
        expect(outcome).toMatchObject({ pushed: false, reason: 'network' });
        expect(cancel).toHaveBeenCalledOnce();
        expect((await findPeerSubscription('peer-a', 'universe', 'u1')).lastPushedAt).toBeFalsy();
        vi.mocked(peerFetch).mockResolvedValue(acceptsPush());
        expect(await pushRecordToPeer(sub)).toMatchObject({ pushed: true });
      } finally {
        stream.error(new Error('Synthetic stream cleanup'));
        await pending;
        vi.useRealTimers();
      }
    });

    it('refuses to push when our instance id is unknown', async () => {
      vi.mocked(getInstanceId).mockResolvedValue('unknown');
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('unknown-local-instance');
      expect(peerFetch).not.toHaveBeenCalled();
    });

    it('refuses to push when the target peer is missing from the registry', async () => {
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-ghost', recordKind: 'universe', recordId: 'u1',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('peer-not-found');
    });

    it('refuses to push to a peer with syncEnabled=false (stale sub does not outlive the user toggle)', async () => {
      // Regression: an existing subscription is not a license to keep pushing
      // after the user has globally silenced the peer. Without this gate,
      // every subsequent edit would still leak across the wire.
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A',
          enabled: true, syncEnabled: false,
          directions: ['outbound'],
          syncCategories: { universe: true },
        },
      ]);
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('peer-disallows-outbound');
      expect(peerFetch).not.toHaveBeenCalled();
    });

    it('refuses to push to a peer that has been switched to inbound-only', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A',
          enabled: true, syncEnabled: true,
          directions: ['inbound'],
          syncCategories: { universe: true },
        },
      ]);
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('peer-disallows-outbound');
    });

    it('refuses to push when the matching category has been toggled off', async () => {
      // Stale sub on a universe but the user later toggled `syncCategories.universe`
      // back off — stop pushing universes to this peer.
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A',
          enabled: true, syncEnabled: true,
          directions: ['outbound'],
          syncCategories: { universe: false, pipeline: true },
        },
      ]);
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('category-disabled');
    });

    it('returns record-not-found when the record id no longer exists', async () => {
      vi.mocked(getUniverse).mockResolvedValue(null);
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'gone',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('record-not-found');
    });

    // #11455 — a store read FAILURE must not read as "record does not exist"
    // or ship a truncated payload that then advances lastPushedHash.
    describe('push read failures (#11455)', () => {
      const notFound = () => Object.assign(new Error('gone'), { code: 'PIPELINE_SERIES_NOT_FOUND' });
      const dbDown = () => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });

      it('maps a not-found loader error to record-not-found with no network call', async () => {
        vi.mocked(getUniverse).mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_FOUND' }));
        const result = await pushRecordToPeer({
          id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'gone',
        });
        expect(result).toMatchObject({ pushed: false, reason: 'record-not-found' });
        expect(peerFetch).not.toHaveBeenCalled();
      });

      it('rejects, posts nothing and keeps lastPushedHash when the loader fails for another reason', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
        await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
        let sub;
        await vi.waitFor(async () => {
          sub = await findPeerSubscription('peer-a', 'universe', 'u1');
          expect(sub?.lastPushedHash).toBeTruthy();
        });
        const priorHash = sub.lastPushedHash;
        vi.mocked(peerFetch).mockClear();
        vi.mocked(getUniverse).mockRejectedValue(dbDown());
        await expect(pushRecordToPeer(sub)).rejects.toThrow('connection refused');
        expect(peerFetch).not.toHaveBeenCalled();
        expect((await findPeerSubscription('peer-a', 'universe', 'u1')).lastPushedHash).toBe(priorHash);
      });

      it('series push: a failing listIssuesForSeries rejects instead of pushing issues: []', async () => {
        vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
        vi.mocked(listIssuesForSeries).mockRejectedValue(dbDown());
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
        }, { adoptedFromReverse: true });
        await expect(pushRecordToPeer(sub)).rejects.toThrow('connection refused');
        expect(peerFetch).not.toHaveBeenCalled();
        expect((await findPeerSubscription('peer-a', 'series', 'ser-1')).lastPushedHash).toBeFalsy();
      });

      it('series push: a failing review read rejects, but a not-found review is simply omitted', async () => {
        vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
        vi.mocked(getReview).mockRejectedValue(dbDown());
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
        }, { adoptedFromReverse: true });
        await expect(pushRecordToPeer(sub)).rejects.toThrow('connection refused');
        expect(peerFetch).not.toHaveBeenCalled();
        vi.mocked(getReview).mockRejectedValue(notFound());
        vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
        const ok = await pushRecordToPeer(sub);
        expect(ok.pushed).toBe(true);
      });

      it('debounced push logs the failure with the subscription id', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        vi.mocked(getUniverse).mockRejectedValue(dbDown());
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        try {
          await triggerPushForRecord('universe', 'u1');
          await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
        } finally {
          vi.useRealTimers();
        }
        await vi.waitFor(() => {
          expect(errSpy.mock.calls.some(([msg]) => String(msg).includes(`scheduled push failed for ${sub.id}`)
            && String(msg).includes('connection refused'))).toBe(true);
        });
        errSpy.mockRestore();
        expect(peerFetch).not.toHaveBeenCalled();
      });
    });

    it('short-circuits when the record hashes match the last push (no-op edits dont round-trip)', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      // Subscribe with adoptedFromReverse=true to suppress the auto-push so
      // we control timing explicitly — relying on a sleep to drain the
      // fire-and-forget push is flaky on slower CI runners.
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      const first = await pushRecordToPeer(sub);
      expect(first.pushed).toBe(true);
      expect(first.hash).toBeTruthy();
      vi.mocked(peerFetch).mockClear();
      const refreshed = await findPeerSubscription('peer-a', 'universe', 'u1');
      const result = await pushRecordToPeer(refreshed);
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('unchanged');
      expect(peerFetch).not.toHaveBeenCalled();
    });

    it('persists ackedDeletesUpTo from the peer response to the tombstone cursor', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ missingAssets: [], ackedDeletesUpTo: 5000 }),
      });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      await pushRecordToPeer(sub);
      const cursors = await listCursors();
      expect(cursors['peer-a'].lastAckedDeleteAt).toBe(5000);
    });

    it('stamps the per-record lastConfirmedPushedAt on a confirmed push (per-record tombstone-ack clamp)', async () => {
      // The per-peer cursor advances to the MAX deletedAt across all pushes;
      // the per-record water-mark must additionally record THIS record's
      // confirmed delivery so tombstoneGc won't prune its tombstone before
      // its own (delete-)push lands. See tombstoneGc.minConfirmedPushedAtForKind.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const before = Date.now();
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      expect(sub.lastConfirmedPushedAt).toBeNull(); // not set until a push lands
      await pushRecordToPeer(sub);
      const refreshed = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(refreshed.lastConfirmedPushedAt).toBeGreaterThanOrEqual(before);
    });

    it('does NOT advance lastConfirmedPushedAt on a failed push (no false confirmation)', async () => {
      // A network failure must leave the per-record water-mark untouched —
      // otherwise GC would treat an undelivered record's tombstone as safe.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      await pushRecordToPeer(sub); // first push confirms
      const afterFirst = await findPeerSubscription('peer-a', 'universe', 'u1');
      const stamped = afterFirst.lastConfirmedPushedAt;
      expect(stamped).toBeTruthy();
      // Now a later push to the SAME sub fails at the network — content must
      // differ so the unchanged-hash short-circuit doesn't skip the wire.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Bar' });
      vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await pushRecordToPeer({ ...afterFirst });
      expect(result.pushed).toBe(false);
      const afterFail = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(afterFail.lastConfirmedPushedAt).toBe(stamped); // unchanged
    });

    it('stamps lastConfirmedPushedAt at payload-snapshot time, so a live push answered after the delete stays below deletedAt (#11772)', async () => {
      // A push that read the record while live and whose response lands after
      // the user deleted it only proves the peer holds the LIVE state. Stamping
      // the floor at response time would lift it past the tombstone and let
      // tombstoneGc prune a deletion the peer never received.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      let releaseFetch;
      vi.mocked(peerFetch).mockImplementation(() => new Promise((resolve) => {
        releaseFetch = () => resolve({ ok: true, json: async () => ({ missingAssets: [] }) });
      }));
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      const inFlight = pushRecordToPeer(sub);
      await vi.waitFor(() => expect(releaseFetch).toBeTypeOf('function'));
      await new Promise((r) => setTimeout(r, 5));
      const deletedAt = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      releaseFetch();
      expect((await inFlight).pushed).toBe(true);
      const refreshed = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(refreshed.lastConfirmedPushedAt).toBeLessThan(deletedAt);
      // The human-facing "last pushed" time still reports the response.
      expect(Date.parse(refreshed.lastPushedAt)).toBeGreaterThan(deletedAt);
    });

    it('handles a network-level failure without throwing (returns pushed:false)', async () => {
      // The once-per-cause ledger would swallow the line if an earlier test already logged this cause.
      __resetPushFailureLogForTests();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNREFUSED'));
        const result = await pushRecordToPeer({
          id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        });
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('network');
        // An asleep or offline peer is routine: stdout, not stderr.
        expect(logSpy.mock.calls.some(([line]) => /peerSync: push universe\/u1 .* unreachable/.test(line))).toBe(true);
        expect(warnSpy).not.toHaveBeenCalled();
        const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n');
        expect(logged).not.toMatch(/Peer A|10\.0\.0\.2|peer-a/);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('logs a rejected push once per peer and cause, then logs recovery', async () => {
      // Every automatic caller discards the result, so this line is the only
      // trace that an edit never reached the peer.
      __resetPushFailureLogForTests();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Authentication required', code: 'AUTH_REQUIRED' }) });
        const sub = { id: 's1', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' };
        expect(await pushRecordToPeer(sub)).toMatchObject({ pushed: false, reason: 'http-401' });
        await pushRecordToPeer({ ...sub, id: 's2', recordId: 'u2' });
        const failures = errorSpy.mock.calls.map(([line]) => line).filter((line) => line.includes('peerSync: push'));
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/universe\/u1 \(sub s1\).*rejected with http-401: AUTH_REQUIRED: Authentication required/);

        vi.mocked(peerFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        expect((await pushRecordToPeer(sub)).pushed).toBe(true);
        expect(logSpy.mock.calls.some(([line]) => /pushes to .* landing again after http-401/.test(line))).toBe(true);
      } finally {
        errorSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it('does NOT short-circuit when the parent series record is identical but a bundled issue changed', async () => {
      // Regression: simplePayloadHash originally hashed only payload.record,
      // so a series push where only an issue field changed (a common case —
      // every panel edit propagates as an issue update under a series sub)
      // would collapse to reason: 'unchanged' and never propagate.
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(listIssuesForSeries).mockResolvedValueOnce([
        { id: 'i1', seriesId: 'ser-1', number: 1, title: 'First' },
      ]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' },
        { adoptedFromReverse: true },
      );
      const first = await pushRecordToPeer(sub);
      expect(first.pushed).toBe(true);

      // Series record identical, but child issue title changed → MUST re-push.
      vi.mocked(listIssuesForSeries).mockResolvedValueOnce([
        { id: 'i1', seriesId: 'ser-1', number: 1, title: 'Revised' },
      ]);
      vi.mocked(peerFetch).mockClear();
      const refreshed = await findPeerSubscription('peer-a', 'series', 'ser-1');
      const second = await pushRecordToPeer(refreshed);
      expect(second.pushed).toBe(true);
      expect(second.reason).not.toBe('unchanged');
      expect(peerFetch).toHaveBeenCalledTimes(1);
    });

    it('bundles child issues with current stage content and without run history', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(listIssuesForSeries).mockResolvedValue([
        { id: 'i1', seriesId: 'ser-1', number: 1, stages: {
          prose: { input: 'prompt', output: 'current prose', status: 'ready', runHistory: [{ runId: 'older' }] },
          audio: { status: 'empty', runHistory: [] },
        } },
        { id: 'i1001', seriesId: 'ser-1', number: 1001 },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
      });
      expect(captured.kind).toBe('series');
      expect(captured.issues).toHaveLength(2);
      expect(captured.issues.map((i) => i.id)).toEqual(['i1', 'i1001']);
      expect(captured.issues[0].stages).toEqual({
        prose: { input: 'prompt', output: 'current prose', status: 'ready' },
        audio: { status: 'empty' },
      });
      expect(listIssuesForSeries).toHaveBeenCalledWith('ser-1', { includeDeleted: true, withHistory: false });
    });

    it('stamps a conflict-journal base hash for every bundled issue after a series push lands', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(listIssuesForSeries).mockResolvedValue([
        { id: 'i1', seriesId: 'ser-1', number: 1 },
        { id: 'i2', seriesId: 'ser-1', number: 2 },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      for (const issue of captured.issues) {
        expect(await getSyncBaseHash('issue', issue.id)).toBe(contentHashForRecord('issue', issue));
      }
      expect(await getSyncBaseHash('series', 'ser-1')).toBe(contentHashForRecord('series', captured.record));
    });

    it('withholds lastPushedHash while the receiver still owes Writers Room draft bodies', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ missingAssets: [], missingDraftBodies: [{ workId: 'w1', draftId: 'd1' }] }),
      });
      const sub = await subscribePeer({
        peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      }, { adoptedFromReverse: true });
      const result = await pushRecordToPeer(sub);
      expect(result.pushed).toBe(true);
      const after = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(after.lastPushedHash).toBeFalsy();
      expect(after.lastConfirmedPushedAt).toBeGreaterThan(0);
    });

    it.each([
      ['a missing peerId', { recordKind: 'universe', recordId: 'u1' }],
      ['a blank recordKind', { peerId: 'peer-a', recordKind: ' ', recordId: 'u1' }],
      ['a missing recordId', { peerId: 'peer-a', recordKind: 'universe' }],
    ])('refuses a subscription with %s before touching the network', async (_label, fields) => {
      const result = await pushRecordToPeer({ id: 's', ...fields });
      expect(result).toEqual({ pushed: false, reason: 'invalid-subscription' });
      expect(peerFetch).not.toHaveBeenCalled();
    });

    it('bundles the manuscript review with a series push so review-only edits propagate', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(getReview).mockResolvedValue({
        schemaVersion: 1,
        comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      expect(captured.kind).toBe('series');
      expect(captured.manuscriptReview).toBeTruthy();
      expect(captured.manuscriptReview.comments).toHaveLength(1);
      expect(captured.manuscriptReview.comments[0].id).toBe('mrc-1');
    });

    it('omits the manuscriptReview key when the series has an empty review', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(getReview).mockResolvedValue({ schemaVersion: 1, comments: [] });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      expect(captured.manuscriptReview).toBeUndefined();
    });

    it('does not fetch a review for a tombstone series push', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      expect(captured.manuscriptReview).toBeUndefined();
      expect(vi.mocked(getReview)).not.toHaveBeenCalled();
    });

    it('bundles the reverse outline with a series push so regenerate-only edits propagate', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(getStoredOutline).mockResolvedValue({
        seriesId: 'ser-1', schemaVersion: 1, status: 'complete', generatedAt: '2026-06-02T00:00:00Z',
        plotlines: [{ id: 'a', label: 'A-plot', kind: 'main', color: '#3b82f6' }],
        scenes: [{ id: 'scene-001', sequence: 0, summary: 'opening', plotlineId: 'a' }],
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      expect(captured.reverseOutline).toBeTruthy();
      expect(captured.reverseOutline.scenes).toHaveLength(1);
      expect(captured.reverseOutline.generatedAt).toBe('2026-06-02T00:00:00Z');
    });

    it('omits the reverseOutline key when no complete outline exists', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      // A never-generated / in-progress outline (status !== 'complete') is not shipped.
      vi.mocked(getStoredOutline).mockResolvedValue({ seriesId: 'ser-1', schemaVersion: 1, status: 'none', plotlines: [], scenes: [] });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      expect(captured.reverseOutline).toBeUndefined();
    });

    it('does not fetch an outline for a tombstone series push', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      expect(captured.reverseOutline).toBeUndefined();
      expect(vi.mocked(getStoredOutline)).not.toHaveBeenCalled();
    });

    it('re-pushes when only the manuscript review changes (series record byte-identical)', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(getReview)
        .mockResolvedValueOnce({
          schemaVersion: 1,
          comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
        })
        .mockResolvedValueOnce({
          // A comment status flip bumps updatedAt → review (and thus hash) changes.
          schemaVersion: 1,
          comments: [{ id: 'mrc-1', problem: 'pacing', status: 'accepted', updatedAt: '2026-06-02T01:00:00Z' }],
        });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' },
        { adoptedFromReverse: true },
      );
      const first = await pushRecordToPeer(sub);
      expect(first.pushed).toBe(true);

      vi.mocked(peerFetch).mockClear();
      const refreshed = await findPeerSubscription('peer-a', 'series', 'ser-1');
      const second = await pushRecordToPeer(refreshed);
      expect(second.pushed).toBe(true);
      expect(second.reason).not.toBe('unchanged');
      expect(peerFetch).toHaveBeenCalledTimes(1);
    });

    it('bundles the linked media collection with a universe push so collection-only edits propagate', async () => {
      // Regression: collection items[] adds emit recordEvents.updated('universe', id)
      // but the universe record content itself doesn't change, so the
      // lastPushedHash short-circuit treated the push as 'unchanged' and the
      // receiver's collection diverged permanently. Including the linked
      // collection in both the payload AND the hash defeats the short-circuit.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Universe' });
      vi.mocked(findCollectionByUniverseId).mockResolvedValueOnce({
        id: 'col-1',
        name: 'Universe: U',
        description: '',
        coverKey: null,
        universeId: 'u1',
        seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(captured.kind).toBe('universe');
      expect(captured.linkedCollection).toBeTruthy();
      expect(captured.linkedCollection.id).toBe('col-1');
      expect(captured.linkedCollection.items).toHaveLength(1);
    });

    it('strips the local-only provenance stamp from a bundled linkedCollection', async () => {
      // #3311: `source` is per-install and must not cross the wire in ANY
      // transport. The standalone mediaCollection push goes through
      // sanitizeRecordForWire; the bundled copy has to as well, or the two
      // forms of the same record disagree and an upgraded peer's collection
      // checksum drifts from a not-yet-upgraded one's.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Universe' });
      vi.mocked(findCollectionByUniverseId).mockResolvedValueOnce({
        id: 'col-1',
        name: 'Universe: U',
        description: '',
        coverKey: null,
        universeId: 'u1',
        seriesId: null,
        source: 'auto',
        items: [],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(captured.linkedCollection.id).toBe('col-1');
      expect(captured.linkedCollection.source).toBeUndefined();
    });

    it('re-pushes when only the linked collection items change (universe record byte-identical)', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Universe' });
      vi.mocked(findCollectionByUniverseId)
        .mockResolvedValueOnce({
          id: 'col-1', name: 'Universe: U', description: '', coverKey: null,
          universeId: 'u1', seriesId: null,
          items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
        })
        .mockResolvedValueOnce({
          id: 'col-1', name: 'Universe: U', description: '', coverKey: null,
          universeId: 'u1', seriesId: null,
          items: [
            { kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' },
            { kind: 'image', ref: 'b.png', addedAt: '2026-05-22T02:00:00Z' },
          ],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
        });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      const first = await pushRecordToPeer(sub);
      expect(first.pushed).toBe(true);

      vi.mocked(peerFetch).mockClear();
      const refreshed = await findPeerSubscription('peer-a', 'universe', 'u1');
      const second = await pushRecordToPeer(refreshed);
      expect(second.pushed).toBe(true);
      expect(second.reason).not.toBe('unchanged');
      expect(peerFetch).toHaveBeenCalledTimes(1);
    });

    it('appends .mp4 when a collection video item ref is a bare id (no extension)', async () => {
      // Regression: video collection items store the bare id (e.g. a UUID),
      // while the on-disk file is `<id>.mp4`. Without the append, the file
      // would never be found, no manifest entry would be emitted, and the
      // receiver would never pull the video bytes.
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      await writeFile(join(PATHS.videos, 'vid-abc.mp4'), 'fake mp4 bytes');

      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Universe' });
      vi.mocked(findCollectionByUniverseId).mockResolvedValueOnce({
        id: 'col-1', name: 'Universe: U', description: '', coverKey: null,
        universeId: 'u1', seriesId: null,
        items: [{ kind: 'video', ref: 'vid-abc', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      const videoEntries = captured.assetManifest.filter(a => a.kind === 'video');
      expect(videoEntries).toHaveLength(1);
      // The .mp4 must have been appended to the bare id when constructing the manifest entry.
      expect(videoEntries[0].filename).toBe('vid-abc.mp4');
    });

    it('does NOT bundle a linked collection when the universe is a tombstone', async () => {
      vi.mocked(getUniverse).mockResolvedValue({
        id: 'u1', name: 'Gone', deleted: true, deletedAt: '2026-05-22T03:00:00Z',
      });
      // If buildPushPayload still called findCollectionByUniverseId for a
      // tombstoned record, we'd see this mock invoked. Guard against the
      // bundle path firing for soft-deletes.
      vi.mocked(findCollectionByUniverseId).mockResolvedValue({
        id: 'col-1', name: 'Universe: U', description: '', coverKey: null,
        universeId: 'u1', seriesId: null, items: [],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(captured.kind).toBe('universe');
      expect(captured.linkedCollection).toBeUndefined();
      expect(captured.assetManifest).toEqual([]);
    });

    it('drops ephemeral child issues from both the bundled issues AND the asset manifest', async () => {
      // Regression: an earlier version filtered ephemeral issues out of
      // `sanitizedIssues` but still walked the unfiltered `childIssues`
      // when building the asset manifest, leaking the ephemeral issue's
      // image / video filenames onto the wire. The receiver would then
      // background-fetch those bytes — defeating the "local-only" intent
      // of ephemeral.
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(listIssuesForSeries).mockResolvedValue([
        // Live issue with a referenced image.
        {
          id: 'i1', seriesId: 'ser-1', number: 1,
          stages: { storyboards: { scenes: [{ imageJobId: 'job-live' }] } },
        },
        // Ephemeral issue — must NOT leak its image into the manifest.
        {
          id: 'i2', seriesId: 'ser-1', number: 2, ephemeral: true,
          stages: { storyboards: { scenes: [{ imageJobId: 'job-secret' }] } },
        },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
      });
      // Sanitized issues: only the live one.
      expect(captured.issues).toHaveLength(1);
      expect(captured.issues[0].id).toBe('i1');
      // Asset manifest entries (if any) must not reference the ephemeral
      // issue's assets. The manifest can be empty if buildAssetManifest
      // didn't find any concrete filenames in the live issue's stages
      // (which is the case here — imageJobId references aren't yet
      // resolved to filenames in Stage 2's manifest builder). The
      // critical invariant is that NOTHING from the ephemeral issue
      // appears.
      const manifestFilenames = (captured.assetManifest || []).map(a => a.filename);
      expect(manifestFilenames.some(f => /secret/i.test(f))).toBe(false);
    });

    it('ships an empty asset manifest for tombstone pushes (deleted universe)', async () => {
      // Tombstone pushes carry deleted=true + deletedAt so the receiver
      // can converge its delete. They must NOT also ship asset filenames
      // — the receiver would diff them as `missing`, schedule pulls, and
      // download bytes for a record it's about to orphan. Privacy-
      // sensitive (a record deleted to get its assets off-peer would
      // still leak the bytes via this path) and wasteful.
      vi.mocked(getUniverse).mockResolvedValue({
        id: 'u1', name: 'Doomed', deleted: true, deletedAt: '2026-01-01T00:00:00Z',
        // Force a referenced image filename that would otherwise hash into
        // the manifest. The buildAssetManifest path skips entries whose
        // file isn't readable, so a definitely-not-present filename is
        // the cleanest "would have been emitted if not for the deleted
        // gate" probe.
        worldOverview: { sceneImageFilename: 'sentinel-doomed-asset.png' },
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 'sub-tomb', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      // Tombstone arrives — sanitizer keeps deleted records on the wire.
      expect(captured.record.id).toBe('u1');
      expect(captured.record.deleted).toBe(true);
      // But the manifest is empty — no pull-trigger for the receiver.
      expect(captured.assetManifest).toEqual([]);
    });

    it('ships FableLoom tombstones without scene assets', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A', host: null, address: '192.0.2.10', port: 5555,
          enabled: true, syncEnabled: true,
          directions: ['outbound', 'inbound'],
          syncCategories: { fableLoom: true },
        },
      ]);
      vi.mocked(getLoom).mockResolvedValue({
        id: 'loom-tomb',
        name: 'Example Loom',
        episodes: [{ scenes: [{ imageUrl: '/data/images/doomed.png', videoHistoryId: 'doomed' }] }],
        updatedAt: '2026-01-01T00:00:00Z',
        deleted: true,
        deletedAt: '2026-01-01T00:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });

      await pushRecordToPeer({
        id: 'sub-loom', peerId: 'peer-a', recordKind: 'fableLoom', recordId: 'loom-tomb',
      });

      expect(captured.kind).toBe('fableLoom');
      expect(captured.record).toMatchObject({ id: 'loom-tomb', deleted: true });
      expect(captured.assetManifest).toEqual([]);
    });

    it('drops deleted child issues from the asset manifest input', async () => {
      // Deleted issues' tombstones must still ride along in `issues` (so
      // the receiver's delete cascade runs), but their asset filenames
      // must NOT appear in the manifest — the receiver would otherwise
      // pull bytes for issues it's about to orphan.
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(listIssuesForSeries).mockResolvedValue([
        // Live issue (no manifest leak — buildAssetManifest doesn't yet
        // resolve imageJobId → filename, that's a Stage 3 thing).
        { id: 'i1', seriesId: 'ser-1', number: 1 },
        // Deleted issue with a sentinel filename that would surface
        // through buildAssetManifest's directVideoFilenames path if it
        // were fed to the manifest builder.
        {
          id: 'i2', seriesId: 'ser-1', number: 2,
          deleted: true, deletedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1',
      });
      // Both issues' tombstones/wire-records propagate.
      expect(captured.issues.map(i => i.id).sort()).toEqual(['i1', 'i2']);
      const deletedIssue = captured.issues.find(i => i.id === 'i2');
      expect(deletedIssue.deleted).toBe(true);
      // Manifest is empty (or at least carries nothing from i2). Stage-2
      // manifest builder doesn't emit filenames for these stage shapes,
      // so the manifest is empty in practice — but the invariant we're
      // guarding is that deleted issues NEVER contribute manifest entries
      // even when their stages happen to reference concrete assets.
      const manifestFilenames = (captured.assetManifest || []).map(a => a.filename);
      expect(manifestFilenames).toEqual([]);
    });

    // --- Standalone mediaCollection push payload --------------------------
    // A peer subscribed directly to a mediaCollection record (NOT via a
    // universe/series's linkedCollection bundle). The peer must have the
    // `mediaCollections` syncCategory enabled or the push gate short-circuits.
    const enableCollectionPeer = () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
          enabled: true, syncEnabled: true,
          directions: ['outbound', 'inbound'],
          syncCategories: { universe: true, pipeline: true, mediaCollections: true },
        },
      ]);
    };

    it('keeps a large collection pending when the peer still enforces the old manifest limit', async () => {
      enableCollectionPeer();
      const record = { id: 'col-large', name: 'Large collection', items: [], updatedAt: '2026-01-01T00:00:00Z' };
      vi.mocked(getCollection).mockResolvedValue(record);
      const subscribe = { peerId: 'peer-a', recordKind: 'mediaCollection', recordId: record.id };
      const sub = await subscribePeer(subscribe, { adoptedFromReverse: true });
      vi.mocked(peerFetch).mockResolvedValueOnce(Response.json({ ackedDeletesUpTo: 1 }));
      expect(await pushRecordToPeer(sub)).toMatchObject({ pushed: true });
      const before = await findPeerSubscription('peer-a', 'mediaCollection', record.id);
      const baseHash = await getSyncBaseHash('mediaCollection', record.id);
      const cursors = await listCursors();

      const items = Array.from({ length: 2001 }, (_, i) => ({ kind: 'image', ref: `large-${i}.png` }));
      for (let i = 0; i < items.length; i += 64) {
        await Promise.all(items.slice(i, i + 64).map(({ ref }) => writeFile(join(PATHS.images, ref), 'image bytes')));
      }
      vi.mocked(getCollection).mockResolvedValue({ ...record, name: 'Updated collection', items });
      vi.mocked(peerFetch).mockClear().mockResolvedValueOnce(Response.json({
        code: 'VALIDATION_ERROR',
        context: { details: [{ path: 'assetManifest', message: 'Too big: expected array to have <=2000 items' }] },
        ackedDeletesUpTo: 2,
      }, { status: 400 }));

      expect(await pushRecordToPeer(before)).toEqual({ pushed: false, reason: 'peer-schema-behind', blockedBySchema: true });
      expect(peerFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(vi.mocked(peerFetch).mock.calls[0][1].body).assetManifest).toHaveLength(2001);
      expect(await findPeerSubscription('peer-a', 'mediaCollection', record.id)).toMatchObject({
        blockedBySchema: { reason: 'peer-collection-manifest-limit' },
        lastPushedHash: before.lastPushedHash,
        lastPushedAt: before.lastPushedAt,
        lastConfirmedPushedAt: before.lastConfirmedPushedAt,
      });
      expect(await getSyncBaseHash('mediaCollection', record.id)).toBe(baseHash);
      expect(await listCursors()).toEqual(cursors);

      vi.mocked(peerFetch).mockResolvedValueOnce(Response.json({}));
      expect(await forcePushRecord('peer-a', 'mediaCollection', record.id)).toMatchObject({ pushed: true });
      const after = await findPeerSubscription('peer-a', 'mediaCollection', record.id);
      expect(after.blockedBySchema).toBeFalsy();
      expect(after.lastPushedHash).not.toBe(before.lastPushedHash);
    });

    it('emits BOTH image and video manifest entries for a live mediaCollection push', async () => {
      // Regression (Bug 2): video collection items store the bare videoId; the
      // on-disk file is `<id>.mp4`. The standalone push manifest builder must
      // append `.mp4` (same as the linkedCollection bundle path) or every
      // collection video is silently dropped and receivers never pull bytes.
      enableCollectionPeer();
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      await writeFile(join(PATHS.images, 'pic.png'), Buffer.from('image bytes'));
      await writeFile(join(PATHS.videos, 'vid-xyz.mp4'), Buffer.from('mp4 bytes'));

      vi.mocked(getCollection).mockResolvedValue({
        id: 'col-9', name: 'Standalone', description: '', coverKey: null,
        universeId: null, seriesId: null,
        items: [
          { kind: 'image', ref: 'pic.png', addedAt: '2026-05-22T01:00:00Z' },
          { kind: 'video', ref: 'vid-xyz', addedAt: '2026-05-22T02:00:00Z' },
        ],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
        deleted: false, deletedAt: null,
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 'sub-col', peerId: 'peer-a', recordKind: 'mediaCollection', recordId: 'col-9',
      });
      expect(captured.kind).toBe('mediaCollection');
      expect(captured.record.id).toBe('col-9');
      const imageEntries = captured.assetManifest.filter(a => a.kind === 'image');
      const videoEntries = captured.assetManifest.filter(a => a.kind === 'video');
      expect(imageEntries.map(a => a.filename)).toEqual(['pic.png']);
      // The .mp4 must have been appended to the bare videoId.
      expect(videoEntries.map(a => a.filename)).toEqual(['vid-xyz.mp4']);
    });

    it('ships an empty asset manifest for a tombstone mediaCollection push', async () => {
      enableCollectionPeer();
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      // Real files on disk would otherwise hash into the manifest — the
      // deleted gate must skip the manifest builder entirely.
      await writeFile(join(PATHS.images, 'doomed.png'), Buffer.from('bytes'));
      await writeFile(join(PATHS.videos, 'vid-doom.mp4'), Buffer.from('bytes'));

      vi.mocked(getCollection).mockResolvedValue({
        id: 'col-tomb', name: 'Doomed', description: '', coverKey: null,
        universeId: null, seriesId: null,
        items: [
          { kind: 'image', ref: 'doomed.png', addedAt: '2026-05-22T01:00:00Z' },
          { kind: 'video', ref: 'vid-doom', addedAt: '2026-05-22T02:00:00Z' },
        ],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T03:00:00Z',
        deleted: true, deletedAt: '2026-05-22T03:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 'sub-tomb', peerId: 'peer-a', recordKind: 'mediaCollection', recordId: 'col-tomb',
      });
      expect(captured.record.id).toBe('col-tomb');
      expect(captured.record.deleted).toBe(true);
      expect(captured.assetManifest).toEqual([]);
    });

    it('emits image and music asset manifests for music record pushes', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
          enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'],
          syncCategories: { artists: true, albums: true, tracks: true },
        },
      ]);
      await writeFile(join(PATHS.images, 'artist.png'), Buffer.from('artist portrait'));
      await writeFile(join(PATHS.images, 'album.png'), Buffer.from('album cover'));
      await writeFile(join(PATHS.music, 'song.mp3'), Buffer.from('track audio'));
      vi.mocked(getArtist).mockResolvedValue({
        id: 'artist-1', name: 'Nova', portraitImageUrl: '/data/images/artist.png',
        updatedAt: '2026-06-01T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(getAlbum).mockResolvedValue({
        id: 'album-1', title: 'Debut', coverImageUrl: '/data/images/album.png',
        updatedAt: '2026-06-01T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(getTrack).mockResolvedValue({
        id: 'track-1', title: 'Intro', audioFilename: 'song.mp3',
        updatedAt: '2026-06-01T00:00:00Z', deleted: false, deletedAt: null,
      });
      const captured = [];
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });

      await pushRecordToPeer({ id: 'sub-artist', peerId: 'peer-a', recordKind: 'artist', recordId: 'artist-1' });
      await pushRecordToPeer({ id: 'sub-album', peerId: 'peer-a', recordKind: 'album', recordId: 'album-1' });
      await pushRecordToPeer({ id: 'sub-track', peerId: 'peer-a', recordKind: 'track', recordId: 'track-1' });

      expect(captured.map(p => p.kind)).toEqual(['artist', 'album', 'track']);
      expect(captured[0].assetManifest).toEqual([expect.objectContaining({ kind: 'image', filename: 'artist.png' })]);
      expect(captured[1].assetManifest).toEqual([expect.objectContaining({ kind: 'image', filename: 'album.png' })]);
      expect(captured[2].assetManifest).toEqual([expect.objectContaining({ kind: 'music', filename: 'song.mp3' })]);
    });

    // --- Music Video project media federation (#1772) ---
    it('bundles uploaded audio + rendered scene clips + reference-frame stills for a music video project push', async () => {
      // #1772: the project record federated but shipped an empty manifest, so a
      // selectively-subscribed peer never received the referenced media. Audio
      // rides as a `music` entry (PATHS.music); each scene's videoHistoryId
      // resolves through video-history.json to its `<filename>` under PATHS.videos;
      // each scene's referenceImageId (#1760 Phase 1b) rides as a sidecar-aware
      // `image` entry (a gallery basename under PATHS.images).
      enableMusicVideoPeer();
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      await mkdir(PATHS.images, { recursive: true });
      await writeFile(join(PATHS.music, 'mv-song.mp3'), Buffer.from('audio bytes'));
      await writeFile(join(PATHS.videos, 'scene-one.mp4'), Buffer.from('clip one'));
      await writeFile(join(PATHS.videos, 'scene-two.webm'), Buffer.from('clip two'));
      await writeFile(join(PATHS.images, 'ref-x.png'), Buffer.from('frame bytes'));
      // video-history.json maps each videoHistoryId → its on-disk basename.
      await writeFile(join(tmp, 'video-history.json'), JSON.stringify([
        { id: 'vh-1', filename: 'scene-one.mp4' },
        { id: 'vh-2', filename: 'scene-two.webm' },
      ]));
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-1', name: 'My Video', mode: 'director', trackId: null,
        uploadedAudioFilename: 'mv-song.mp3',
        scenes: [
          { sceneId: 's-1', order: 0, videoHistoryId: 'vh-1', referenceImageId: 'ref-x.png' },
          { sceneId: 's-2', order: 1, videoHistoryId: 'vh-2', referenceImageId: null },
          { sceneId: 's-3', order: 2, videoHistoryId: null, referenceImageId: null },
        ],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });
      await pushRecordToPeer({
        id: 'sub-mv', peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-1',
      });
      expect(captured.kind).toBe('musicVideoProject');
      expect(captured.record.id).toBe('mv-1');
      const byKind = (k) => captured.assetManifest.filter(a => a.kind === k).map(a => a.filename).sort();
      expect(byKind('music')).toEqual(['mv-song.mp3']);
      expect(byKind('video')).toEqual(['scene-one.mp4', 'scene-two.webm']);
      // referenceImageId (Phase 1b) now ships as a gallery `image` asset so the
      // peer renders the thumbnail instead of a dangling /data/images/ reference.
      expect(byKind('image')).toEqual(['ref-x.png']);
    });

    it('bundles the linked track record + its master audio for a track-linked project (#1858)', async () => {
      // The create-UI path stores trackId with uploadedAudioFilename: null. A
      // peer subscribed to musicVideoProjects ONLY (no Tracks category) needs
      // both the audio BYTES (manifest) and the track RECORD (linkedTrack) — the
      // receiver's resolveMasterAudioPath() looks the track up by id first.
      enableMusicVideoPeer();
      await writeFile(join(PATHS.music, 'linked.mp3'), Buffer.from('linked track audio'));
      vi.mocked(getTrack).mockResolvedValue({
        id: 'track-7', title: 'Anthem', audioFilename: 'linked.mp3',
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-3', name: 'Linked', mode: 'director', trackId: 'track-7',
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });
      await pushRecordToPeer({
        id: 'sub-mv3', peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-3',
      });
      expect(captured.assetManifest.filter(a => a.kind === 'music').map(a => a.filename)).toEqual(['linked.mp3']);
      expect(captured.linkedTrack?.id).toBe('track-7');
      expect(captured.linkedTrack?.audioFilename).toBe('linked.mp3');
    });

    it('bundles a tombstone linkedTrack when the linked track is deleted (#1858)', async () => {
      // A track delete fans out to its linked projects; the project push must
      // carry the track tombstone so a Music-Videos-only peer converges instead
      // of keeping stale audio. No audio bytes ride for a deleted track.
      enableMusicVideoPeer();
      vi.mocked(getTrack).mockResolvedValue({
        id: 'track-8', title: 'Gone', audioFilename: 'gone.mp3',
        updatedAt: '2026-06-29T00:00:00Z', deleted: true, deletedAt: '2026-06-29T00:00:00Z',
      });
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-5', name: 'Linked-deleted', mode: 'director', trackId: 'track-8',
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-29T00:00:00Z', deleted: false, deletedAt: null,
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });
      await pushRecordToPeer({
        id: 'sub-mv5', peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-5',
      });
      expect(captured.linkedTrack?.id).toBe('track-8');
      expect(captured.linkedTrack?.deleted).toBe(true);
      expect(captured.assetManifest.filter(a => a.kind === 'music')).toEqual([]);
    });

    it('stamps lastConfirmedTrackBundleAtMs on a confirmed push whose bundled track merge succeeded (#1922)', async () => {
      // tombstoneGc's `track` cutoff reads this bundle-specific floor off
      // musicVideoProject subscription rows (a peer with no `track`
      // subscription of its own would otherwise be invisible to track GC).
      enableMusicVideoPeer();
      vi.mocked(getTrack).mockResolvedValue({
        id: 'track-10', title: 'Bundled', audioFilename: 'linked.mp3',
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-10', name: 'Bundled', mode: 'director', trackId: 'track-10',
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const before = Date.now();
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-10' },
        { adoptedFromReverse: true },
      );
      expect(sub.lastConfirmedTrackBundleAtMs).toBeNull();
      await pushRecordToPeer(sub);
      const refreshed = await findPeerSubscription('peer-a', 'musicVideoProject', 'mv-10');
      expect(refreshed.lastConfirmedTrackBundleAtMs).toBeGreaterThanOrEqual(before);
    });

    it('does NOT stamp lastConfirmedTrackBundleAtMs when the bundled track merge failed on the receiver (#1922)', async () => {
      // trackSyncPending means the receiver applied the project but the
      // bundled track merge threw — the peer never actually got the track,
      // so the bundle-specific floor must stay unset (the generic
      // lastConfirmedPushedAt still advances; that's a separate water-mark
      // for the project record itself, not the bundled track).
      enableMusicVideoPeer();
      vi.mocked(getTrack).mockResolvedValue({
        id: 'track-11', title: 'Pending', audioFilename: 'linked.mp3',
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-11', name: 'Pending', mode: 'director', trackId: 'track-11',
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ missingAssets: [], trackSyncPending: true }),
      });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-11' },
        { adoptedFromReverse: true },
      );
      await pushRecordToPeer(sub);
      const refreshed = await findPeerSubscription('peer-a', 'musicVideoProject', 'mv-11');
      expect(refreshed.lastConfirmedTrackBundleAtMs).toBeNull();
      expect(refreshed.lastConfirmedPushedAt).toBeTruthy();
    });

    it('does NOT stamp lastConfirmedTrackBundleAtMs when the project still has a trackId but the sender omitted linkedTrack (#1922)', async () => {
      // Regression (codex review round 3): a project can still carry a
      // `trackId` while buildPushPayload's own getTrack() lookup transiently
      // returns null/throws, so `linkedTrack` is omitted from the payload
      // entirely. The receiver never sees a linkedTrack key, so it can't
      // report trackSyncPending either — `!trackSyncPending` alone would
      // wrongly look "confirmed". A track is still owed (trackId is set), so
      // the bundle floor must stay unstamped until a future push actually
      // ships the track.
      enableMusicVideoPeer();
      vi.mocked(getTrack).mockResolvedValue(null); // transient lookup failure
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-12', name: 'Lookup failed', mode: 'director', trackId: 'track-12',
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-12' },
        { adoptedFromReverse: true },
      );
      await pushRecordToPeer(sub);
      const refreshed = await findPeerSubscription('peer-a', 'musicVideoProject', 'mv-12');
      expect(refreshed.lastConfirmedTrackBundleAtMs).toBeNull();
      expect(refreshed.lastConfirmedPushedAt).toBeTruthy();
    });

    it('DOES stamp lastConfirmedTrackBundleAtMs when the project has no trackId at all (nothing owed)', async () => {
      enableMusicVideoPeer();
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-13', name: 'No track', mode: 'director', trackId: null,
        uploadedAudioFilename: 'upload.mp3', scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const before = Date.now();
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-13' },
        { adoptedFromReverse: true },
      );
      await pushRecordToPeer(sub);
      const refreshed = await findPeerSubscription('peer-a', 'musicVideoProject', 'mv-13');
      expect(refreshed.lastConfirmedTrackBundleAtMs).toBeGreaterThanOrEqual(before);
    });

    it('never stamps the bundled-track floor on a subscription that carries no linkedTrack (non-musicVideoProject)', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      await pushRecordToPeer(sub);
      const refreshed = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(refreshed.lastConfirmedPushedAt).toBeGreaterThan(0);
      expect(refreshed.lastConfirmedTrackBundleAtMs ?? null).toBeNull();
    });

    it('omits linkedTrack when the project has no linked track', async () => {
      enableMusicVideoPeer();
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-4', name: 'Upload only', mode: 'director', trackId: null,
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });
      await pushRecordToPeer({
        id: 'sub-mv4', peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-4',
      });
      expect(captured.kind).toBe('musicVideoProject');
      expect('linkedTrack' in captured).toBe(false);
    });

    it('falls back to the <id>.mp4 convention when a scene clip has no video-history row', async () => {
      // The metadata row may not have synced yet; the bare-id + .mp4 convention
      // (collectionVideoRefToFilename) still resolves the bytes. A wrong guess is
      // harmless — a missing file is skipped, never shipped.
      enableMusicVideoPeer();
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      await writeFile(join(PATHS.videos, 'vh-orphan.mp4'), Buffer.from('orphan clip'));
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-2', name: 'No Rows', mode: 'director', trackId: null,
        uploadedAudioFilename: null,
        scenes: [{ sceneId: 's-1', order: 0, videoHistoryId: 'vh-orphan', referenceImageId: null }],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ missingAssets: [] }) };
      });
      await pushRecordToPeer({
        id: 'sub-mv2', peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-2',
      });
      expect(captured.assetManifest).toEqual([expect.objectContaining({ kind: 'video', filename: 'vh-orphan.mp4' })]);
    });

    it('ships an empty asset manifest for a tombstone music video project push', async () => {
      enableMusicVideoPeer();
      PATHS.videos = join(tmp, 'videos');
      await mkdir(PATHS.videos, { recursive: true });
      // Real files on disk would otherwise hash in — the deleted gate must skip
      // the manifest builder entirely.
      await writeFile(join(PATHS.music, 'doomed.mp3'), Buffer.from('bytes'));
      await writeFile(join(PATHS.videos, 'doomed.mp4'), Buffer.from('bytes'));
      await writeFile(join(tmp, 'video-history.json'), JSON.stringify([{ id: 'vh-d', filename: 'doomed.mp4' }]));
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-tomb', name: 'Doomed', mode: 'director', trackId: null,
        uploadedAudioFilename: 'doomed.mp3',
        scenes: [{ sceneId: 's-1', order: 0, videoHistoryId: 'vh-d', referenceImageId: null }],
        updatedAt: '2026-06-28T03:00:00Z', deleted: true, deletedAt: '2026-06-28T03:00:00Z',
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 'sub-mvt', peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-tomb',
      });
      expect(captured.record.id).toBe('mv-tomb');
      expect(captured.record.deleted).toBe(true);
      expect(captured.assetManifest).toEqual([]);
    });
  });
});
