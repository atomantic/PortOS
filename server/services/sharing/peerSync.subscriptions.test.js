import { tmp, installPeerSyncHooks } from './peerSync.test.fixture.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import {
  PEER_SUBSCRIBABLE_KINDS,
  listPeerSubscriptions,
  getOutboundCoverageForPeer,
  getFullSyncCoverageForPeer,
  subscribePeer,
  unsubscribePeer,
  unsubscribeAllForRecord,
  pruneOrphanedPeerSubscriptions,
  autoSubscribeRecordToAllPeers,
  autoSubscribePeerToAllRecords,
  forcePushRecord,
  collectSubscriptionsForUpdate,
  __drainForTests,
} from './peerSync.js';
import { findPeerSubscription } from './peerSubscriptions.js';
import { getPeers } from '../instances.js';
import { getUniverse, listUniverses } from '../universeBuilder.js';
import { getSeries, listSeries } from '../pipeline/series.js';
import { getIssue, listIssues } from '../pipeline/issues.js';
import { getCollection, findCollectionByUniverseId, findCollectionBySeriesId } from '../mediaCollections.js';
import { getArtist, listArtists } from '../artists/index.js';
import { getAlbum, listAlbums } from '../albums/index.js';
import { getTrack, listTracks } from '../tracks/index.js';
import { getProject as getMusicVideoProject, listProjects as listMusicVideoProjects } from '../musicVideo/projects.js';
import { listAuthors } from '../authors/index.js';
import { getLoom, listLooms } from '../fableLoom/records.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { listCursors } from './peerTombstoneCursors.js';
import { contentHashForRecord, } from '../../lib/conflictJournal.js';

installPeerSyncHooks();

describe('peerSync', () => {
  describe('PEER_SUBSCRIBABLE_KINDS', () => {
    it('lists every record kind handled by the peer-sync pipeline', () => {
      // Exact equality (not toContain) so an accidental add/remove/reorder is
      // caught — this list is canonical and its order can affect iteration
      // elsewhere (e.g. syncNow's per-kind backfill). Issues piggyback on series
      // subscriptions; direct issue subs are intentionally rejected (Stage 2).
      expect(PEER_SUBSCRIBABLE_KINDS).toEqual(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'fableLoom', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject', 'commissionFeedback', 'creativeCommission', 'deck', 'storyboard']);
    });
  });

  describe('subscribePeer', () => {
    it('creates a subscription, initializes the tombstone cursor, and schedules a push', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const sub = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(sub.id).toBe('peer-universe-u1-peer-a');
      expect(sub.peerId).toBe('peer-a');
      expect(sub.adoptedFromReverse).toBe(false);
      // Cursor initialized
      const cursors = await listCursors();
      expect(cursors['peer-a']).toBeDefined();
      expect(cursors['peer-a'].subscribedSince).toBeGreaterThan(0);
    });

    it('refuses to subscribe over an unreadable list and preserves its bytes', async () => {
      const file = join(PATHS.data, 'sharing', 'peer_subscriptions.json');
      await writeFile(file, '{"subscriptions":');
      const before = await readFile(file);

      await expect(subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' }))
        .rejects.toMatchObject({ code: 'UNREADABLE_STORE', status: 500 });
      expect(await readFile(file)).toEqual(before);
    });

    it('is idempotent — re-subscribing returns the existing record without duplicating', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      const first = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      const second = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(first.id).toBe(second.id);
      // `created` distinguishes the first insert from the idempotent re-hit so
      // auto-subscribe helpers can suppress duplicate "🔗 auto-subscribed" logs.
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      const all = await listPeerSubscriptions();
      expect(all).toHaveLength(1);
    });

    it('drains a non-blocking initial push before teardown', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      let resolveFetch;
      vi.mocked(peerFetch).mockImplementation(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await vi.waitFor(() => expect(peerFetch).toHaveBeenCalledTimes(1));

      let drained = false;
      const drain = __drainForTests().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);

      resolveFetch({ ok: true, json: async () => ({ missingAssets: [] }) });
      await drain;

      const persisted = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(persisted.lastPushedAt).toBeTruthy();
    });

    it('does NOT re-push on idempotent re-subscribe (existing sub keeps its lastPushedAt)', async () => {
      // Regression: subscribePeer used to fire pushRecordToPeer fire-and-
      // forget on every call, even when the sub already existed. For the
      // auto-subscribe paths that walk N records, that meant N
      // buildAssetManifest sha-passes for already-pushed records — wasted
      // work, since lastPushedHash short-circuits the wire I/O anyway.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      // subscribePeer registers the fire-and-forget initial push BEFORE it
      // resolves, so the drain is a deterministic barrier for it. A fixed 10ms
      // sleep was not: on a contended Windows CI runner the push chain had not
      // reached peerFetch yet and this asserted 0 > 0.
      await __drainForTests();
      // First subscribe DID push.
      expect(vi.mocked(peerFetch).mock.calls.length).toBeGreaterThan(0);
      vi.mocked(peerFetch).mockClear();
      // Second subscribe is idempotent — no push should fire.
      const second = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await __drainForTests();
      expect(second.created).toBe(false);
      expect(vi.mocked(peerFetch)).not.toHaveBeenCalled();
    });

    it('rejects invalid kind', async () => {
      await expect(
        subscribePeer({ peerId: 'peer-a', recordKind: 'issue', recordId: 'i1' }),
      ).rejects.toThrow(/subscribable kinds/);
    });

    it('rejects missing peerId / recordId', async () => {
      await expect(
        subscribePeer({ peerId: '', recordKind: 'universe', recordId: 'u1' }),
      ).rejects.toThrow(/required/);
      await expect(
        subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: '' }),
      ).rejects.toThrow(/required/);
    });

    it('does NOT push when adoptedFromReverse=true (avoids ping-pong with the peer that just pushed us)', async () => {
      // Regression: receiver auto-creates a reverse sub on each incoming push.
      // If that reverse sub triggered an initial push, we'd ping-pong forever.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer(
        { peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' },
        { adoptedFromReverse: true },
      );
      // peerFetch may have been called for some other reason, but NOT from
      // this code path. Drain rather than sleep: a negative assertion has to
      // outlast any push that WOULD have been scheduled, and the drain does
      // that deterministically instead of betting on a 10ms budget.
      await __drainForTests();
      expect(peerFetch).not.toHaveBeenCalled();
    });
  });

  describe('getOutboundCoverageForPeer', () => {
    beforeEach(() => {
      // No push side effects — we only assert on the returned coverage map.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Ser', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(getCollection).mockResolvedValue({ id: 'c1', name: 'Col', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(findCollectionByUniverseId).mockResolvedValue(null);
      vi.mocked(findCollectionBySeriesId).mockResolvedValue(null);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
    });

    it('groups outbound subs by snapshot category (series → pipeline)', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'mediaCollection', recordId: 'c1' });
      const cov = await getOutboundCoverageForPeer('peer-a');
      expect([...cov.universe]).toEqual(['u1']);
      // series rolls into the pipeline category (series + child issues bundle).
      expect([...cov.pipeline]).toEqual(['ser-1']);
      expect([...cov.mediaCollections]).toEqual(['c1']);
    });

    it('only reports subs for the named peer (per-peer isolation)', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-b', recordKind: 'universe', recordId: 'u1' });
      const covA = await getOutboundCoverageForPeer('peer-a');
      const covB = await getOutboundCoverageForPeer('peer-b');
      expect([...covA.universe]).toEqual(['u1']);
      expect([...covB.universe]).toEqual(['u1']);
      const covC = await getOutboundCoverageForPeer('peer-c');
      expect(covC.universe.size).toBe(0);
    });

    it('returns empty coverage for a missing/blank peerId', async () => {
      const cov = await getOutboundCoverageForPeer('');
      expect(cov.universe.size + cov.pipeline.size + cov.mediaCollections.size).toBe(0);
    });
  });

  describe('getFullSyncCoverageForPeer', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'U1' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
    });

    it('reports fully-mirrored with zero total when there are no local records', async () => {
      // All listers default to [] in the suite-level beforeEach.
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov).toMatchObject({ total: 0, confirmed: 0, pending: 0, fullyMirrored: true, available: true, partial: false, failedReads: [] });
    });

    // An inventory failure must survive both lazy and direct lister boundaries.
    it('marks failed inventories unavailable even when the remaining subset is confirmed', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Inventory failures log to stderr (#7943); both streams are checked so
      // the redaction contract can't be satisfied by moving the leak elsewhere.
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(listUniverses).mockRejectedValue(new Error('private database details'));
      vi.mocked(listAuthors).mockRejectedValue(new Error('private author contents'));
      vi.mocked(listSeries).mockResolvedValue([{ id: 'ser-1' }]);
      await writeFile(join(tmp, 'sharing', 'peer_subscriptions.json'), JSON.stringify({
        subscriptions: [{ id: 'sub-s1', peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1', lastConfirmedPushedAt: Date.now() }],
      }));
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov).toMatchObject({ available: false, partial: true, fullyMirrored: false, total: 1, confirmed: 1, pending: 0 });
      expect(cov.failedReads).toEqual([
        { kind: 'universe', operation: 'records' },
        { kind: 'author', operation: 'records' },
      ]);
      expect(cov.byKind.universe).toMatchObject({ partial: true });
      expect(JSON.stringify(cov)).not.toContain('private');
      expect([...log.mock.calls, ...errorLog.mock.calls].flat().join(' ')).not.toContain('private');
      expect(errorLog.mock.calls.filter(([message]) => message.includes('coverage unavailable'))).toHaveLength(2);
      log.mockRestore();
      errorLog.mockRestore();
    });

    it('reports unavailable when subscription storage cannot be read, including empty inventories', async () => {
      await writeFile(join(tmp, 'sharing', 'peer_subscriptions.json'), 'invalid private JSON');
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov).toMatchObject({ available: false, partial: true, fullyMirrored: false, total: 0, pending: 0 });
      expect(cov.failedReads).toEqual(PEER_SUBSCRIBABLE_KINDS.map(kind => ({ kind, operation: 'subscriptions' })));
      expect(JSON.stringify(cov)).not.toContain('private');
    });

    it('counts a record with no subscription as pending (real ID diff, not cursors)', async () => {
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov.total).toBe(2);
      expect(cov.confirmed).toBe(0);
      expect(cov.pending).toBe(2);
      expect(cov.fullyMirrored).toBe(false);
      expect(cov.byKind.universe).toEqual({ total: 2, confirmed: 0, pending: 2 });
    });

    it('counts a confirmed-pushed subscription as mirrored', async () => {
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      // peerHasCategory gate is bypassed here — forcePushRecord drives the push
      // directly. Register the peer so forcePushRecord finds it.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: true, syncEnabled: true, fullSync: true, syncCategories: {} },
      ]);
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      // Deterministically push + confirm so lastConfirmedPushedAt is stamped
      // (the subscribe's initial push is fire-and-forget; awaiting forcePushRecord
      // avoids a drain-timing flake).
      await forcePushRecord('peer-a', 'universe', 'u1');
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov.total).toBe(1);
      expect(cov.confirmed).toBe(1);
      expect(cov.pending).toBe(0);
      expect(cov.fullyMirrored).toBe(true);
    });

    it('counts a record edited AFTER its last confirmed push as pending (stale content)', async () => {
      // Record confirmed once, then edited (updatedAt in the future relative to
      // the confirm time) — the peer has stale content, so it's not mirrored.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: true, syncEnabled: true, fullSync: true, syncCategories: {} },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await forcePushRecord('peer-a', 'universe', 'u1'); // stamps lastConfirmedPushedAt ≈ now
      // Now the record reports an edit far in the future relative to the confirm.
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1', updatedAt: '2999-01-01T00:00:00Z' }]);
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov.total).toBe(1);
      expect(cov.confirmed).toBe(0);
      expect(cov.pending).toBe(1);
      expect(cov.fullyMirrored).toBe(false);
    });

    it('a created-but-unconfirmed subscription still counts as pending', async () => {
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      // Push FAILS — the sub is created but never confirmed-delivered.
      vi.mocked(peerFetch).mockRejectedValue(new Error('offline'));
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' }).catch(() => {});
      await __drainForTests();
      const cov = await getFullSyncCoverageForPeer('peer-a');
      expect(cov.total).toBe(1);
      expect(cov.confirmed).toBe(0);
      expect(cov.pending).toBe(1);
      expect(cov.fullyMirrored).toBe(false);
    });

    it('returns empty coverage for a blank peerId', async () => {
      const cov = await getFullSyncCoverageForPeer('');
      expect(cov).toMatchObject({ total: 0, fullyMirrored: true });
    });
  });

  describe('unsubscribePeer', () => {
    it('removes the subscription and the peer cursor when no other subs remain for that peer', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await unsubscribePeer(sub.id);
      const cursors = await listCursors();
      expect(cursors['peer-a']).toBeUndefined();
    });

    it('keeps the peer cursor when other subscriptions to the same peer remain', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Bar' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub1 = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'series', recordId: 'ser-1' });
      await unsubscribePeer(sub1.id);
      const cursors = await listCursors();
      expect(cursors['peer-a']).toBeDefined();
    });

    it('throws ERR_NOT_FOUND for unknown id', async () => {
      await expect(unsubscribePeer('peer-universe-x-peer-a')).rejects.toMatchObject({
        code: 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND',
      });
    });
  });

  describe('unsubscribeAllForRecord', () => {
    it('removes every subscription for a record across all peers', async () => {
      // updateUniverse({ ephemeral: true }) fires this — when a record
      // transitions ephemeral, every per-peer sub for that record must go
      // away so the orphan-row state never materializes.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-b-inbound-only', recordKind: 'universe', recordId: 'u1' });
      // Different record on peer-a — must survive the unsubscribe.
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u-other' });
      const result = await unsubscribeAllForRecord('universe', 'u1');
      expect(result.removed).toHaveLength(2);
      expect(result.failed).toEqual([]);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
      expect(await findPeerSubscription('peer-b-inbound-only', 'universe', 'u1')).toBeNull();
      // Untouched: u-other on peer-a.
      expect(await findPeerSubscription('peer-a', 'universe', 'u-other')).not.toBeNull();
    });

    it('reports per-sub success vs failure separately when unsubscribePeer throws', async () => {
      // Regression guard against the "always push to removed" bug: a sub
      // whose unsubscribe call throws (concurrent teardown, malformed id)
      // must NOT appear in `removed`. Callers reading `removed.length`
      // need an honest count.
      //
      // We force the failure path by racing two `unsubscribeAllForRecord`
      // calls in parallel. `listPeerSubscriptions` is NOT inside the state
      // lock, so the two calls can race: each takes its own snapshot, and
      // whichever `unsubscribePeer` lands second for a given sub hits
      // ERR_NOT_FOUND and routes that id to `failed` instead of `removed`.
      //
      // The EXACT split depends on interleaving (whether the second call
      // snapshots before or after the first call's removals land), so this
      // asserts the INVARIANTS that must hold under every interleaving
      // rather than a single timing-specific outcome (the latter flaked in
      // CI — see #1200): each sub is removed exactly once total, no id is
      // ever in both `removed` and `failed` of the SAME call, and a
      // `failed` id always coincides with the other call having `removed`
      // it (a failure only happens because the racing call already won).
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub1 = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      const sub2 = await subscribePeer({ peerId: 'peer-b-inbound-only', recordKind: 'universe', recordId: 'u1' });
      const [resultA, resultB] = await Promise.all([
        unsubscribeAllForRecord('universe', 'u1'),
        unsubscribeAllForRecord('universe', 'u1'),
      ]);

      const removedA = new Set(resultA.removed);
      const removedB = new Set(resultB.removed);
      const failedA = new Set(resultA.failed);
      const failedB = new Set(resultB.failed);

      // Each sub is removed exactly once across the two calls — never zero
      // (it must come out) and never twice (the lock serializes the actual
      // removal, so only one call legitimately removes it).
      for (const id of [sub1.id, sub2.id]) {
        const removedCount = (removedA.has(id) ? 1 : 0) + (removedB.has(id) ? 1 : 0);
        expect(removedCount, `sub ${id} removed exactly once`).toBe(1);
      }

      // The honest-accounting guard: within a single call, an id is never
      // reported as BOTH removed and failed.
      for (const [removed, failed] of [[removedA, failedA], [removedB, failedB]]) {
        for (const id of removed) expect(failed.has(id)).toBe(false);
      }

      // Any `failed` id is one the OTHER call removed — a failure only
      // arises because the racing call already won that sub (never a
      // spurious failure for a sub nobody removed).
      for (const id of failedA) expect(removedB.has(id)).toBe(true);
      for (const id of failedB) expect(removedA.has(id)).toBe(true);

      // Both subs are actually gone from disk regardless of who won.
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
      expect(await findPeerSubscription('peer-b-inbound-only', 'universe', 'u1')).toBeNull();
    });

    it('returns {removed: [], failed: []} for invalid arguments', async () => {
      expect(await unsubscribeAllForRecord('', 'u1')).toEqual({ removed: [], failed: [] });
      expect(await unsubscribeAllForRecord('universe', '')).toEqual({ removed: [], failed: [] });
      expect(await unsubscribeAllForRecord('bogus', 'u1')).toEqual({ removed: [], failed: [] });
    });
  });

  describe('pruneOrphanedPeerSubscriptions', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
    });

    it('drops subs whose record no longer resolves and keeps the rest', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u-gone' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u-live' });
      await subscribePeer({ peerId: 'peer-b', recordKind: 'series', recordId: 's-gone' });
      // Resolver: only u-live still exists.
      const live = new Set(['universe:u-live']);
      const res = await pruneOrphanedPeerSubscriptions(async (kind, id) => live.has(`${kind}:${id}`));
      expect(res.pruned).toBe(2);
      expect(await findPeerSubscription('peer-a', 'universe', 'u-gone')).toBeNull();
      expect(await findPeerSubscription('peer-b', 'series', 's-gone')).toBeNull();
      // u-live survives.
      expect(await findPeerSubscription('peer-a', 'universe', 'u-live')).not.toBeNull();
    });

    it('keeps a sub whose resolver throws (conservative — never a false strip)', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      const res = await pruneOrphanedPeerSubscriptions(async () => { throw new Error('listing blew up'); });
      expect(res.pruned).toBe(0);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).not.toBeNull();
    });

    it('returns {pruned:0, removed:[]} for a non-function resolver', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      expect(await pruneOrphanedPeerSubscriptions(undefined)).toEqual({ pruned: 0, removed: [] });
      // The sub is untouched.
      expect(await listPeerSubscriptions()).toHaveLength(1);
    });

    it('drops the tombstone cursor when the peer’s last sub was an orphan', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u-gone' });
      let cursors = await listCursors();
      expect(cursors['peer-a']).toBeDefined();
      await pruneOrphanedPeerSubscriptions(async () => false); // everything orphaned
      cursors = await listCursors();
      expect(cursors['peer-a']).toBeUndefined();
    });
  });

  describe('autoSubscribeRecordToAllPeers', () => {
    beforeEach(() => {
      // Default these so the push triggered by subscribePeer doesn't 500
      // when the underlying buildPushPayload runs.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
    });

    it('is registered with the recordEvents subscription adapter at module load', async () => {
      // Domain services (universeBuilder/series/mediaCollections/instances)
      // reach these functions only through the adapter — this pins the
      // module-scope registerSubscriptionAdapter(...) call that wires it.
      const adapter = await import('./recordEvents.js');
      vi.mocked(getPeers).mockResolvedValue([]);
      // Registered → the real implementation's no-peers [] (an unregistered
      // adapter would resolve to undefined instead).
      await expect(adapter.autoSubscribeRecordToAllPeers('universe', 'u1')).resolves.toEqual([]);
    });

    it('subscribes the record to every peer with the matching category enabled', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: true, syncCategories: { universe: true } },
        { instanceId: 'peer-b', name: 'B', enabled: true, syncCategories: { universe: true } },
        { instanceId: 'peer-c', name: 'C', enabled: true, syncCategories: { universe: false } },
      ]);
      const created = await autoSubscribeRecordToAllPeers('universe', 'u1');
      expect(created.map(c => c.peerId).sort()).toEqual(['peer-a', 'peer-b']);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).not.toBeNull();
      expect(await findPeerSubscription('peer-c', 'universe', 'u1')).toBeNull();
    });

    it('skips disabled peers and inbound-only peers', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: false, syncCategories: { universe: true } },
        { instanceId: 'peer-b', name: 'B', enabled: true, syncCategories: { universe: true }, directions: ['inbound'] },
        { instanceId: 'peer-c', name: 'C', enabled: true, syncCategories: { universe: true }, directions: ['outbound'] },
      ]);
      const created = await autoSubscribeRecordToAllPeers('universe', 'u1');
      expect(created.map(c => c.peerId)).toEqual(['peer-c']);
    });

    it('skips peers with syncEnabled=false (global toggle off)', async () => {
      // Regression guard: the per-category bit is necessary but not sufficient
      // — `syncEnabled` is the global "sync this peer at all" toggle. Without
      // this check, a peer the user silenced would still be auto-subscribed
      // and pushed to from createUniverse / createSeries.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: true, syncEnabled: false, syncCategories: { universe: true } },
        { instanceId: 'peer-b', enabled: true, syncEnabled: true, syncCategories: { universe: true } },
      ]);
      const created = await autoSubscribeRecordToAllPeers('universe', 'u1');
      expect(created.map(c => c.peerId)).toEqual(['peer-b']);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
    });

    it('maps series records to the pipeline category', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true, pipeline: false } },
        { instanceId: 'peer-b', enabled: true, syncCategories: { universe: false, pipeline: true } },
      ]);
      const created = await autoSubscribeRecordToAllPeers('series', 'ser-1');
      expect(created.map(c => c.peerId)).toEqual(['peer-b']);
    });

    it('returns [] for invalid arguments', async () => {
      expect(await autoSubscribeRecordToAllPeers('bogus', 'x')).toEqual([]);
      expect(await autoSubscribeRecordToAllPeers('universe', '')).toEqual([]);
    });

    it('returns [] on re-run — only newly-created subs are reported', async () => {
      // Idempotent re-subscribe must not re-log "🔗 auto-subscribed" or
      // re-count existing subs as freshly created. This pins the
      // `subscribePeer().created` plumbing.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: true, syncCategories: { universe: true } },
      ]);
      const first = await autoSubscribeRecordToAllPeers('universe', 'u1');
      expect(first.map(c => c.peerId)).toEqual(['peer-a']);
      const second = await autoSubscribeRecordToAllPeers('universe', 'u1');
      expect(second).toEqual([]);
    });

    it('persists the base hash synchronously (awaitInitialPush coalesces the flush)', async () => {
      // Regression for the flush-coalesce wrap: the fan-out wraps its loop in
      // withBaseHashFlushBatch and passes awaitInitialPush, so every peer's
      // initial-push base-hash stamp lands BEFORE the helper returns — no
      // drain needed. Under the old fire-and-forget path the push hadn't even
      // started yet, so the file wouldn't carry the stamp here.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'U1' });
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: true, syncCategories: { universe: true } },
        { instanceId: 'peer-b', name: 'B', enabled: true, syncCategories: { universe: true } },
      ]);
      const created = await autoSubscribeRecordToAllPeers('universe', 'u1');
      expect(created.map(c => c.peerId).sort()).toEqual(['peer-a', 'peer-b']);
      // Assert against the FILE, not getSyncBaseHash() — the latter reads the
      // in-memory map and would pass even if the terminal flush never wrote. A
      // present-on-disk entry proves the batch's coalesced write actually ran
      // inside the awaited fan-out (no drain).
      // On-disk entries are `{ h, v }` (#2912 — the hash-fields version travels
      // with the hash it was computed under); `.h` is the plain hash string.
      const onDisk = JSON.parse(await readFile(join(tmp, 'sharing', 'sync_base_hashes.json'), 'utf8'));
      expect(onDisk['universe:u1'].h).toBe(contentHashForRecord('universe', { id: 'u1', name: 'U1' }));
    });
  });

  describe('autoSubscribePeerToAllRecords', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      // Default: peer is registered + outbound-capable + has both categories
      // enabled. Individual tests override to verify the gating paths.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', name: 'A', enabled: true, syncCategories: { universe: true, pipeline: true } },
      ]);
    });

    it('subscribes every local non-deleted universe to the peer', async () => {
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created.map(c => c.recordId).sort()).toEqual(['u1', 'u2']);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).not.toBeNull();
      expect(await findPeerSubscription('peer-a', 'universe', 'u2')).not.toBeNull();
    });

    it('subscribes every local non-deleted series to the peer', async () => {
      vi.mocked(listSeries).mockResolvedValue([{ id: 'ser-1' }, { id: 'ser-2' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'series');
      expect(created.map(c => c.recordId).sort()).toEqual(['ser-1', 'ser-2']);
    });

    it('backfills every local FableLoom when its category is enabled', async () => {
      vi.mocked(getPeers).mockResolvedValue([{
        instanceId: 'peer-a',
        name: 'A',
        enabled: true,
        syncEnabled: true,
        directions: ['outbound'],
        syncCategories: { fableLoom: true },
      }]);
      vi.mocked(listLooms).mockResolvedValue([{ id: 'loom-1' }, { id: 'loom-2' }]);
      vi.mocked(getLoom).mockImplementation(async (id) => ({
        id, name: `Story ${id}`, episodes: [], updatedAt: '2026-01-01T00:00:00.000Z',
      }));

      const created = await autoSubscribePeerToAllRecords('peer-a', 'fableLoom');

      expect(created.map((sub) => sub.recordId).sort()).toEqual(['loom-1', 'loom-2']);
      expect(await findPeerSubscription('peer-a', 'fableLoom', 'loom-1')).not.toBeNull();
    });

    it('returns [] when the peer is disabled', async () => {
      // Guard against backfill pushing to a peer the user has explicitly
      // disabled — the category bit can be stale even after `enabled: false`.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: false, syncCategories: { universe: true } },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created).toEqual([]);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
    });

    it('returns [] when syncEnabled is false (global toggle off)', async () => {
      // Mirrors the autoSubscribeRecordToAllPeers test — both helpers go
      // through `peerAllowsOutbound` which now consults syncEnabled.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: true, syncEnabled: false, syncCategories: { universe: true } },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created).toEqual([]);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
    });

    it('returns [] when the peer is inbound-only', async () => {
      // Inbound-only peers must not get outbound subscriptions — that would
      // trigger pushes in violation of the peer's configured directions.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: true, directions: ['inbound'], syncCategories: { universe: true } },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created).toEqual([]);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
    });

    it('returns [] when the matching category is no longer enabled', async () => {
      // Race window: caller saw false→true flip, then the user toggled back
      // to false before this helper ran. Re-check protects against that.
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: true, syncCategories: { universe: false } },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created).toEqual([]);
    });

    it('returns [] when the peer id is unknown', async () => {
      vi.mocked(getPeers).mockResolvedValue([]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const created = await autoSubscribePeerToAllRecords('peer-ghost', 'universe');
      expect(created).toEqual([]);
    });

    it('a full-sync peer subscribes records even when the matching category bit is off', async () => {
      // fullSync implies every category — so the back-subscribe sweep covers a
      // kind whose individual syncCategories bit was never turned on (and any
      // future kind, with no per-peer change).
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'peer-a', enabled: true, syncEnabled: true, fullSync: true, syncCategories: { universe: false } },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created.map(c => c.recordId)).toEqual(['u1']);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).not.toBeNull();
    });

    it('returns [] on re-run — only newly-created subs are reported', async () => {
      // `subscribePeer` is idempotent; the helper must not double-count
      // existing subs as freshly created on the second invocation.
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const first = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(first.map(c => c.recordId)).toEqual(['u1']);
      const second = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(second).toEqual([]);
    });

    it('backfills existing music records for their category toggles', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'A', enabled: true, syncEnabled: true, directions: ['outbound'],
          syncCategories: { artists: true, albums: true, tracks: true },
        },
      ]);
      vi.mocked(listArtists).mockResolvedValue([{ id: 'artist-1', name: 'Nova' }]);
      vi.mocked(listAlbums).mockResolvedValue([{ id: 'album-1', title: 'Debut' }]);
      vi.mocked(listTracks).mockResolvedValue([{ id: 'track-1', title: 'Intro' }]);
      vi.mocked(getArtist).mockImplementation(async (id) => ({ id, name: 'Nova' }));
      vi.mocked(getAlbum).mockImplementation(async (id) => ({ id, title: 'Debut' }));
      vi.mocked(getTrack).mockImplementation(async (id) => ({ id, title: 'Intro' }));
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });

      const artists = await autoSubscribePeerToAllRecords('peer-a', 'artist');
      const albums = await autoSubscribePeerToAllRecords('peer-a', 'album');
      const tracks = await autoSubscribePeerToAllRecords('peer-a', 'track');

      expect(artists.map(c => c.recordId)).toEqual(['artist-1']);
      expect(albums.map(c => c.recordId)).toEqual(['album-1']);
      expect(tracks.map(c => c.recordId)).toEqual(['track-1']);
      expect(await findPeerSubscription('peer-a', 'artist', 'artist-1')).not.toBeNull();
      expect(await findPeerSubscription('peer-a', 'album', 'album-1')).not.toBeNull();
      expect(await findPeerSubscription('peer-a', 'track', 'track-1')).not.toBeNull();
    });

    it('returns [] for invalid arguments', async () => {
      expect(await autoSubscribePeerToAllRecords('', 'universe')).toEqual([]);
      expect(await autoSubscribePeerToAllRecords('peer-a', 'bogus')).toEqual([]);
    });

    it('persists every record base hash synchronously (awaitInitialPush coalesces the flush)', async () => {
      // Backfill subscribes N records to one peer; awaitInitialPush keeps each
      // record's stamp inside the flush batch so all N are persisted by the
      // time the helper returns — without per-record flushes and without a
      // post-hoc drain.
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1', name: 'U1' }, { id: 'u2', name: 'U2' }]);
      vi.mocked(getUniverse).mockImplementation(async (id) => ({ id, name: id.toUpperCase() }));
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created.map(c => c.recordId).sort()).toEqual(['u1', 'u2']);
      // Both records' stamps are in the single on-disk file — read it directly
      // (not getSyncBaseHash's in-memory map) so the assertion proves the
      // coalesced terminal flush wrote all N stamps before the helper returned.
      // On-disk entries are `{ h, v }` (#2912) — `.h` is the plain hash string.
      const onDisk = JSON.parse(await readFile(join(tmp, 'sharing', 'sync_base_hashes.json'), 'utf8'));
      expect(onDisk['universe:u1'].h).toBe(contentHashForRecord('universe', { id: 'u1', name: 'U1' }));
      expect(onDisk['universe:u2'].h).toBe(contentHashForRecord('universe', { id: 'u2', name: 'U2' }));
    });

    it('drops ephemeral records before computing the set-diff', async () => {
      // Ephemeral universes/series are local-only — backfill must not
      // create subscriptions for them, even when every other gate passes.
      // Without the filter, the sub would be created and a later push would
      // simply short-circuit via sanitizeRecordForWire — but the row would
      // still live in peer_subscriptions.json forever, confusing unsubscribe-all.
      vi.mocked(listUniverses).mockResolvedValue([
        { id: 'live' },
        { id: 'scratch', ephemeral: true },
      ]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(created.map(c => c.recordId)).toEqual(['live']);
      expect(await findPeerSubscription('peer-a', 'universe', 'scratch')).toBeNull();
    });

    it('short-circuits the for-loop when every record is already subscribed', async () => {
      // Regression: peer:online fires this helper on every online
      // transition. Without the pre-computed set-diff, a steady-state peer
      // with all records already subscribed would still iterate N records
      // and pay N subscribePeer readState calls per online transition.
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
      await autoSubscribePeerToAllRecords('peer-a', 'universe');
      // Deterministically settle the fire-and-forget initial pushes (their
      // peerFetch fires a tick after subscribe returns) so they don't leak past
      // a fixed sleep into the assertion window below — the CI flake this fixes.
      await __drainForTests();
      vi.mocked(peerFetch).mockClear();
      // Re-run on steady state — no push should fire because the set-diff
      // is empty and the for-loop body never runs.
      const second = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(second).toEqual([]);
      expect(vi.mocked(peerFetch)).not.toHaveBeenCalled();
    });

    it('continues peer-online backfill after a kind inventory fails, logging the peer and cause', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { instanceEvents } = await import('../instanceEvents.js');
      const { installPeerSyncListener } = await import('./peerSync.js');
      installPeerSyncListener();
      vi.mocked(listUniverses).mockRejectedValue(new Error('private inventory details'));
      vi.mocked(listSeries).mockResolvedValue([{ id: 'ser-1' }]);
      vi.mocked(getSeries).mockResolvedValue({ id: 'ser-1', name: 'Series' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      instanceEvents.emit('peer:online', {
        instanceId: 'peer-a', enabled: true, syncEnabled: true,
        directions: ['outbound'], syncCategories: { universe: true, pipeline: true },
      });
      await __drainForTests();
      expect(await findPeerSubscription('peer-a', 'series', 'ser-1')).not.toBeNull();
      const logged = errorLog.mock.calls.flat().join(' ');
      expect(logged).toContain('backfill inventory unavailable for universe → A');
      expect(logged).toContain('private inventory details');
      log.mockRestore();
      errorLog.mockRestore();
    });

    it('converges from peer:online when the toggle fired before instanceId was known', async () => {
      // Regression for the addPeer→toggle→probe ordering: addPeer creates
      // a peer with instanceId=null. The user can flip syncCategories on
      // before the first probe lands, in which case instances.updatePeer's
      // inline backfill silently no-ops (no instanceId to subscribe to).
      // The peer:online listener (wired in installPeerSyncListener) must
      // re-run autoSubscribePeerToAllRecords once the probe assigns the
      // instanceId, otherwise the user's intent is lost forever.
      const { instanceEvents } = await import('../instanceEvents.js');
      const { installPeerSyncListener } = await import('./peerSync.js');
      installPeerSyncListener();
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      // Emit peer:online with a peer that has universe-sync turned on but
      // was never seen by the inline backfill (the test never called
      // updatePeer — that's the point).
      instanceEvents.emit('peer:online', {
        instanceId: 'peer-a',
        name: 'A',
        enabled: true,
        syncEnabled: true,
        directions: ['outbound'],
        syncCategories: { universe: true },
      });
      // Poll for the listener's fire-and-forget IIFE to persist the subscription;
      // a fixed sleep races the write queue on slower CI runners.
      await vi.waitFor(async () => {
        expect(await findPeerSubscription('peer-a', 'universe', 'u1')).not.toBeNull();
      });
    });

    it('reciprocates a full-sync peer on peer:online (mirror requested once identity is known)', async () => {
      // A peer added via defaultPeerFullSync (or toggled before its first probe)
      // has fullSync:true but no instanceId, so updatePeer couldn't reciprocate.
      // peer:online must request the mutual mirror now.
      const { instanceEvents } = await import('../instanceEvents.js');
      const { installPeerSyncListener } = await import('./peerSync.js');
      const { enqueueReciprocalSync } = await import('../instances.js');
      vi.mocked(enqueueReciprocalSync).mockClear();
      installPeerSyncListener();
      vi.mocked(listUniverses).mockResolvedValue([]);
      instanceEvents.emit('peer:online', {
        id: 'local-1',
        instanceId: 'peer-a',
        name: 'A',
        enabled: true,
        syncEnabled: true,
        directions: ['outbound'],
        fullSync: true,
        syncCategories: {},
      });
      // Poll until the async handler resolves peer identity and enqueues the
      // mirror — a fixed sleep raced the call on a loaded CI runner (#1860).
      await vi.waitFor(() =>
        expect(vi.mocked(enqueueReciprocalSync)).toHaveBeenCalledWith('local-1')
      );
    });

    it('does NOT reciprocate a non-full-sync peer on peer:online (preserves prior behavior)', async () => {
      const { instanceEvents } = await import('../instanceEvents.js');
      const { installPeerSyncListener } = await import('./peerSync.js');
      const { enqueueReciprocalSync } = await import('../instances.js');
      vi.mocked(enqueueReciprocalSync).mockClear();
      installPeerSyncListener();
      vi.mocked(listUniverses).mockResolvedValue([]);
      // Emit the non-full-sync subject first, then a full-sync *barrier* peer.
      // Both run the same async handler pipeline (backfill → retryPending →
      // fullSync check), and the barrier — emitted second and doing equal-or-
      // more work — only calls enqueueReciprocalSync as its final step. So once
      // the barrier's reciprocal call lands, the subject's handler has provably
      // reached and *skipped* its own fullSync check. This replaces a fixed
      // sleep that could false-pass merely because the absent call was slow.
      instanceEvents.emit('peer:online', {
        id: 'local-2',
        instanceId: 'peer-b',
        name: 'B',
        enabled: true,
        syncEnabled: true,
        directions: ['outbound'],
        syncCategories: { universe: true },
      });
      instanceEvents.emit('peer:online', {
        id: 'local-barrier',
        instanceId: 'peer-barrier',
        name: 'Barrier',
        enabled: true,
        syncEnabled: true,
        directions: ['outbound'],
        fullSync: true,
        syncCategories: {},
      });
      await vi.waitFor(() =>
        expect(vi.mocked(enqueueReciprocalSync)).toHaveBeenCalledWith('local-barrier')
      );
      expect(vi.mocked(enqueueReciprocalSync)).not.toHaveBeenCalledWith('local-2');
    });
  });

  describe('collectSubscriptionsForUpdate', () => {
    it('resolves a tail issue directly when finding its parent-series subscription', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 'series-tail', title: 'Long series' });
      vi.mocked(getIssue).mockResolvedValue({ id: 'issue-1001', seriesId: 'series-tail' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'series', recordId: 'series-tail' });
      await __drainForTests();

      const subs = await collectSubscriptionsForUpdate('issue', 'issue-1001');

      expect(getIssue).toHaveBeenCalledWith('issue-1001', { includeDeleted: true });
      expect(listIssues).not.toHaveBeenCalled();
      expect(subs.some((sub) => sub.recordKind === 'series' && sub.recordId === 'series-tail')).toBe(true);
    });

    // Regression: mediaCollections.js emits emitRecordUpdated('mediaCollection',…)
    // on every edit/delete, but the push pipeline only acted on it if
    // collectSubscriptionsForUpdate returns the direct subs. Omitting the
    // mediaCollection branch made those emits inert (edits never auto-pushed).
    it('returns direct mediaCollection subscriptions (so edits/deletes auto-push)', async () => {
      vi.mocked(getPeers).mockResolvedValue([{
        instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
        enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'],
        syncCategories: { universe: true, pipeline: true, mediaCollections: true },
      }]);
      vi.mocked(getCollection).mockResolvedValue({
        id: 'col-7', name: 'Standalone', description: '', coverKey: null,
        universeId: null, seriesId: null, items: [],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
        deleted: false, deletedAt: null,
      });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'mediaCollection', recordId: 'col-7' });
      await __drainForTests();

      const subs = await collectSubscriptionsForUpdate('mediaCollection', 'col-7');
      expect(subs.map((s) => s.recordId)).toContain('col-7');
      expect(subs.every((s) => s.recordKind === 'mediaCollection')).toBe(true);
    });

    it('fans a track update out to music-video projects that link it (#1858)', async () => {
      vi.mocked(getPeers).mockResolvedValue([{
        instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
        enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'],
        syncCategories: { musicVideoProjects: true },
      }]);
      vi.mocked(getMusicVideoProject).mockResolvedValue({
        id: 'mv-link', name: 'Linked', mode: 'director', trackId: 'track-7',
        uploadedAudioFilename: null, scenes: [],
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      });
      vi.mocked(listMusicVideoProjects).mockResolvedValue([
        { id: 'mv-link', trackId: 'track-7' },
        { id: 'mv-other', trackId: 'track-99' },
      ]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'musicVideoProject', recordId: 'mv-link' });
      await __drainForTests();

      const subs = await collectSubscriptionsForUpdate('track', 'track-7');
      expect(subs.some((s) => s.recordKind === 'musicVideoProject' && s.recordId === 'mv-link')).toBe(true);
      // A project linking a DIFFERENT track is not fanned out.
      expect(subs.some((s) => s.recordId === 'mv-other')).toBe(false);
    });

    it('returns [] for a kind with no direct/parent subscription path', async () => {
      expect(await collectSubscriptionsForUpdate('image', 'whatever')).toEqual([]);
    });
  });
});
