import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// We test peerSync.js by stubbing the external dependencies:
//   - getPeers / getInstanceId from services/instances
//   - merge*FromSync + getUniverse + getSeries + listIssues
//   - peerFetch (network)
// All other logic (subscription store, asset manifest, diff, cursor advance)
// runs against the real on-disk paths via the tmpdir-redirect pattern below.

import { PATHS } from '../../lib/fileUtils.js';

vi.mock('../instances.js', async () => {
  return {
    UNKNOWN_INSTANCE_ID: 'unknown',
    DEFAULT_SYNC_CATEGORIES: {},
    getInstanceId: vi.fn(),
    getPeers: vi.fn(),
  };
});

vi.mock('../universeBuilder.js', async () => ({
  getUniverse: vi.fn(),
  mergeUniversesFromSync: vi.fn(),
  listUniverses: vi.fn(),
}));

vi.mock('../pipeline/series.js', async () => ({
  getSeries: vi.fn(),
  mergeSeriesFromSync: vi.fn(),
  listSeries: vi.fn(),
}));

vi.mock('../pipeline/issues.js', async () => ({
  listIssues: vi.fn(),
  mergeIssuesFromSync: vi.fn(),
}));

vi.mock('../../lib/peerHttpClient.js', async () => ({
  peerFetch: vi.fn(),
  peerSocketOptions: {},
}));

import {
  PEER_SUBSCRIBABLE_KINDS,
  listPeerSubscriptions,
  findPeerSubscription,
  subscribePeer,
  unsubscribePeer,
  unsubscribeAllForPeer,
  pushRecordToPeer,
  applyIncomingPush,
  diffAssetManifestAgainstLocal,
  buildAssetManifest,
  autoSubscribeRecordToAllPeers,
  autoSubscribePeerToAllRecords,
  retryPendingPushesForPeer,
  __resetForTests,
} from './peerSync.js';

import { getInstanceId, getPeers } from '../instances.js';
import { getUniverse, mergeUniversesFromSync, listUniverses } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync, listSeries } from '../pipeline/series.js';
import { listIssues, mergeIssuesFromSync } from '../pipeline/issues.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { listCursors, __drainForTests as __drainCursors } from './peerTombstoneCursors.js';

let originalDataPath;
let originalImagesPath;
let originalImageRefsPath;
let originalVideosPath;
let tmp;

beforeEach(async () => {
  // Capture EVERY PATHS field we (or any test in this file) might mutate so
  // the afterEach restoration is total. The sha-mismatch-for-all-kinds test
  // points PATHS.imageRefs / PATHS.videos at the per-test tmpdir; without
  // restoring them here, later tests in unrelated files inherit the deleted
  // tmpdir and get ENOENT on real asset reads.
  originalDataPath = PATHS.data;
  originalImagesPath = PATHS.images;
  originalImageRefsPath = PATHS.imageRefs;
  originalVideosPath = PATHS.videos;
  tmp = join(tmpdir(), `portos-peer-sync-${Date.now()}-${Math.random()}`);
  await mkdir(join(tmp, 'sharing'), { recursive: true });
  await mkdir(join(tmp, 'images'), { recursive: true });
  PATHS.data = tmp;
  PATHS.images = join(tmp, 'images');

  // Reset mocks. The default peer fixture INTENTIONALLY INVERTS production
  // defaults: `addPeer` in instances.js creates peers with `syncEnabled:
  // false`, every `syncCategories.*` false, and `directions: ['outbound']`
  // (the user has to explicitly opt them in via the Instances page).
  // Tests in this file pre-enable everything so the new outbound/category
  // gates in pushRecordToPeer don't short-circuit the broader push-pipeline
  // assertions. Tests that exercise the gating paths explicitly override
  // these mocks with the relevant flag flipped off.
  vi.mocked(getInstanceId).mockResolvedValue('local-instance');
  vi.mocked(getPeers).mockResolvedValue([
    {
      instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
      enabled: true, syncEnabled: true,
      directions: ['outbound', 'inbound'],
      syncCategories: { universe: true, pipeline: true },
    },
    {
      instanceId: 'peer-b-inbound-only', name: 'Peer B', host: null, address: '10.0.0.3', port: 5555,
      enabled: true, syncEnabled: true,
      directions: ['inbound'],
      syncCategories: { universe: true, pipeline: true },
    },
  ]);
  vi.mocked(peerFetch).mockReset();
  vi.mocked(mergeUniversesFromSync).mockResolvedValue({ applied: true, count: 1 });
  vi.mocked(mergeSeriesFromSync).mockResolvedValue({ applied: true, count: 1 });
  vi.mocked(mergeIssuesFromSync).mockResolvedValue({ applied: true, count: 1 });
  vi.mocked(getUniverse).mockReset();
  vi.mocked(getSeries).mockReset();
  vi.mocked(listIssues).mockReset();

  await __resetForTests();
});

afterEach(async () => {
  // Drain in-flight fire-and-forget pushes before tearing down the tmpdir —
  // otherwise persistPushSuccess can race the rm and leave ENOTEMPTY.
  // Drain BOTH writeTails (peerSync's subscription state AND the tombstone
  // cursor module's separate writeTail, since initCursor writes happen
  // outside peerSync's lock). Three drain cycles with a 5ms macrotask
  // delay between them — pushes scheduled by an earlier drain (e.g.
  // ackDeletesUpTo from a settled push) only enqueue on the next tick, so
  // we need more than one pass to fully quiesce the writeTail chains.
  for (let i = 0; i < 3; i++) {
    await __resetForTests();
    await __drainCursors();
    await new Promise((r) => setTimeout(r, 5));
  }
  await rm(tmp, { recursive: true, force: true });
  PATHS.data = originalDataPath;
  PATHS.images = originalImagesPath;
  PATHS.imageRefs = originalImageRefsPath;
  PATHS.videos = originalVideosPath;
});

describe('peerSync', () => {
  describe('PEER_SUBSCRIBABLE_KINDS', () => {
    it('exposes the canonical kinds (universe + series only)', () => {
      // Issues piggyback on series subscriptions — direct issue subs are
      // intentionally rejected per the Stage 2 design.
      expect(PEER_SUBSCRIBABLE_KINDS).toEqual(['universe', 'series']);
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

    it('does NOT re-push on idempotent re-subscribe (existing sub keeps its lastPushedAt)', async () => {
      // Regression: subscribePeer used to fire pushRecordToPeer fire-and-
      // forget on every call, even when the sub already existed. For the
      // auto-subscribe paths that walk N records, that meant N
      // buildAssetManifest sha-passes for already-pushed records — wasted
      // work, since lastPushedHash short-circuits the wire I/O anyway.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await new Promise((r) => setTimeout(r, 10));
      // First subscribe DID push.
      expect(vi.mocked(peerFetch).mock.calls.length).toBeGreaterThan(0);
      vi.mocked(peerFetch).mockClear();
      // Second subscribe is idempotent — no push should fire.
      const second = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await new Promise((r) => setTimeout(r, 10));
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
      // peerFetch may have been called for some other reason, but NOT
      // synchronously from this code path. Allow a small wait to be sure.
      await new Promise((r) => setTimeout(r, 10));
      expect(peerFetch).not.toHaveBeenCalled();
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
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Bar' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub1 = await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
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

  describe('unsubscribeAllForPeer', () => {
    it('removes every subscription targeting a peer', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(getSeries).mockResolvedValue({ id: 's1' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      const result = await unsubscribeAllForPeer('peer-a');
      expect(result.removed).toHaveLength(2);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
    });
  });

  describe('autoSubscribeRecordToAllPeers', () => {
    beforeEach(() => {
      // Default these so the push triggered by subscribePeer doesn't 500
      // when the underlying buildPushPayload runs.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(getSeries).mockResolvedValue({ id: 's1' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
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
      const created = await autoSubscribeRecordToAllPeers('series', 's1');
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
  });

  describe('autoSubscribePeerToAllRecords', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(getSeries).mockResolvedValue({ id: 's1' });
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
      vi.mocked(listSeries).mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      const created = await autoSubscribePeerToAllRecords('peer-a', 'series');
      expect(created.map(c => c.recordId).sort()).toEqual(['s1', 's2']);
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

    it('returns [] on re-run — only newly-created subs are reported', async () => {
      // `subscribePeer` is idempotent; the helper must not double-count
      // existing subs as freshly created on the second invocation.
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }]);
      const first = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(first.map(c => c.recordId)).toEqual(['u1']);
      const second = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(second).toEqual([]);
    });

    it('returns [] for invalid arguments', async () => {
      expect(await autoSubscribePeerToAllRecords('', 'universe')).toEqual([]);
      expect(await autoSubscribePeerToAllRecords('peer-a', 'bogus')).toEqual([]);
    });

    it('short-circuits the for-loop when every record is already subscribed', async () => {
      // Regression: peer:online fires this helper on every online
      // transition. Without the pre-computed set-diff, a steady-state peer
      // with all records already subscribed would still iterate N records
      // and pay N subscribePeer readState calls per online transition.
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
      await autoSubscribePeerToAllRecords('peer-a', 'universe');
      await new Promise((r) => setTimeout(r, 10));
      vi.mocked(peerFetch).mockClear();
      // Re-run on steady state — no push should fire because the set-diff
      // is empty and the for-loop body never runs.
      const second = await autoSubscribePeerToAllRecords('peer-a', 'universe');
      expect(second).toEqual([]);
      expect(vi.mocked(peerFetch)).not.toHaveBeenCalled();
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
      // Allow the listener's fire-and-forget IIFE to settle.
      await new Promise((r) => setTimeout(r, 30));
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).not.toBeNull();
    });
  });

  describe('retryPendingPushesForPeer', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(listIssues).mockResolvedValue([]);
    });

    it('re-pushes subs with lastPushedAt=null and skips already-pushed subs', async () => {
      // Create a sub with the initial push FAILING — leaves lastPushedAt=null.
      vi.mocked(peerFetch).mockResolvedValueOnce(null);
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      // Wait for the fire-and-forget initial push to settle so the
      // persisted lastPushedAt is final before we re-check it.
      await new Promise((r) => setTimeout(r, 10));
      const stale = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(stale.lastPushedAt).toBeNull();
      // Peer comes back — retry must succeed and stamp lastPushedAt.
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const result = await retryPendingPushesForPeer('peer-a');
      expect(result.retried).toBe(1);
      const updated = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(updated.lastPushedAt).toBeTruthy();
      // Second retry must be a no-op now that lastPushedAt is set.
      const second = await retryPendingPushesForPeer('peer-a');
      expect(second.retried).toBe(0);
    });

    it('returns {retried: 0} when the peer has no subscriptions', async () => {
      const result = await retryPendingPushesForPeer('peer-without-subs');
      expect(result).toEqual({ retried: 0 });
    });

    it('returns {retried: 0} for invalid peerId', async () => {
      expect(await retryPendingPushesForPeer('')).toEqual({ retried: 0 });
      expect(await retryPendingPushesForPeer(null)).toEqual({ retried: 0 });
    });
  });

  describe('buildAssetManifest', () => {
    it('hashes direct image filenames via the sidecar cache', async () => {
      await writeFile(join(PATHS.images, 'asset-1.png'), Buffer.from('image bytes'));
      const record = {
        id: 'u1',
        characters: [{ imageRefs: ['asset-1.png'] }],
      };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].filename).toBe('asset-1.png');
      expect(manifest[0].kind).toBe('image');
      expect(manifest[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('skips assets whose file is missing (sender cant ship bytes it doesnt have)', async () => {
      // Regression: a null-hash entry would make every receiver diff
      // report this as "missing" even though the sender cant fulfill the
      // pull, producing a permanent "asset pending" badge in the UI.
      const record = { id: 'u1', characters: [{ imageRefs: ['ghost.png'] }] };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toEqual([]);
    });

    it('returns an empty manifest for records with no asset refs', async () => {
      const manifest = await buildAssetManifest({ id: 'u1', name: 'Bare' });
      expect(manifest).toEqual([]);
    });
  });

  describe('diffAssetManifestAgainstLocal', () => {
    it('returns assets we dont have on disk', async () => {
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'ghost.png', kind: 'image', sha256: 'a'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].filename).toBe('ghost.png');
    });

    it('skips assets we already have with matching sha', async () => {
      await writeFile(join(PATHS.images, 'have.png'), Buffer.from('hello world'));
      // "hello world" sha256
      const local = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'have.png', kind: 'image', sha256: local },
      ]);
      expect(missing).toEqual([]);
    });

    it('reports assets with mismatched sha as missing (peer has newer bytes)', async () => {
      await writeFile(join(PATHS.images, 'stale.png'), Buffer.from('old bytes'));
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'stale.png', kind: 'image', sha256: 'b'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
    });

    it('ignores malformed manifest entries silently', async () => {
      const missing = await diffAssetManifestAgainstLocal([
        null,
        'not-an-object',
        { filename: '', kind: 'image' },
        { filename: 'foo.png', kind: 'mystery' },
      ]);
      expect(missing).toEqual([]);
    });

    it('strips junk fields from echoed missingAssets entries (no untrusted round-trip)', async () => {
      // Regression: the diff originally pushed the raw peer-supplied entry
      // into the missing list, so a malicious peer could amplify response
      // size or smuggle prototype-pollution attempts by attaching extra
      // fields. The receiver MUST project to {filename, kind, sha256?} only.
      const evil = {
        filename: 'absent.png',
        kind: 'image',
        sha256: 'a'.repeat(64),
        __proto__: { polluted: true },
        gigantic: 'x'.repeat(10000),
        nested: { evil: true },
      };
      const missing = await diffAssetManifestAgainstLocal([evil]);
      expect(missing).toHaveLength(1);
      expect(Object.keys(missing[0]).sort()).toEqual(['filename', 'kind', 'sha256']);
      expect(missing[0].gigantic).toBeUndefined();
      expect(missing[0].nested).toBeUndefined();
    });

    it('rejects path-traversal filenames silently (cant be used to probe local FS)', async () => {
      // Regression: a malicious peer sending `../../etc/passwd` (or backslash
      // variants on Windows checkouts) would otherwise let us join arbitrary
      // paths and reveal whether they exist via the missing/present split.
      const missing = await diffAssetManifestAgainstLocal([
        { filename: '../../etc/passwd', kind: 'image', sha256: 'a'.repeat(64) },
        { filename: '..\\windows\\system32\\config', kind: 'image' },
        { filename: 'sub/dir/asset.png', kind: 'image' },
        { filename: '/etc/hosts', kind: 'image' },
      ]);
      expect(missing).toEqual([]);
    });

    it('reports sha-mismatched videos AND image-refs as missing (not just images)', async () => {
      // Regression: stage 2 originally only sha-checked the 'image' kind,
      // letting an image-ref / video drift silently when bytes diverged
      // under the same filename — the snapshot-sync fallback was the only
      // thing that would catch it 60s later.
      await mkdir(join(tmp, 'image-refs'), { recursive: true });
      await mkdir(join(tmp, 'videos'), { recursive: true });
      // Re-route PATHS by writing into the locations the resolver uses.
      const localImageRefBytes = Buffer.from('local image-ref bytes');
      const localVideoBytes = Buffer.from('local video bytes');
      const { PATHS: livePaths } = await import('../../lib/fileUtils.js');
      livePaths.imageRefs = join(tmp, 'image-refs');
      livePaths.videos = join(tmp, 'videos');
      const { writeFile: writeFileFs } = await import('fs/promises');
      await writeFileFs(join(livePaths.imageRefs, 'ref.png'), localImageRefBytes);
      await writeFileFs(join(livePaths.videos, 'clip.mp4'), localVideoBytes);
      const remoteFakeSha = 'f'.repeat(64);
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'ref.png', kind: 'image-ref', sha256: remoteFakeSha },
        { filename: 'clip.mp4', kind: 'video', sha256: remoteFakeSha },
      ]);
      expect(missing).toHaveLength(2);
      expect(missing.map((m) => m.filename).sort()).toEqual(['clip.mp4', 'ref.png']);
    });
  });

  describe('pushRecordToPeer', () => {
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

    it('handles a network-level failure without throwing (returns pushed:false)', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
      });
      expect(result.pushed).toBe(false);
      expect(result.reason).toBe('network');
    });

    it('does NOT short-circuit when the parent series record is identical but a bundled issue changed', async () => {
      // Regression: simplePayloadHash originally hashed only payload.record,
      // so a series push where only an issue field changed (a common case —
      // every panel edit propagates as an issue update under a series sub)
      // would collapse to reason: 'unchanged' and never propagate.
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(listIssues).mockResolvedValueOnce([
        { id: 'i1', seriesId: 's1', number: 1, title: 'First' },
      ]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'series', recordId: 's1' },
        { adoptedFromReverse: true },
      );
      const first = await pushRecordToPeer(sub);
      expect(first.pushed).toBe(true);

      // Series record identical, but child issue title changed → MUST re-push.
      vi.mocked(listIssues).mockResolvedValueOnce([
        { id: 'i1', seriesId: 's1', number: 1, title: 'Revised' },
      ]);
      vi.mocked(peerFetch).mockClear();
      const refreshed = await findPeerSubscription('peer-a', 'series', 's1');
      const second = await pushRecordToPeer(refreshed);
      expect(second.pushed).toBe(true);
      expect(second.reason).not.toBe('unchanged');
      expect(peerFetch).toHaveBeenCalledTimes(1);
    });

    it('bundles child issues with a series push', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(listIssues).mockResolvedValue([
        { id: 'i1', seriesId: 's1', number: 1 },
        { id: 'i2', seriesId: 's1', number: 2 },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1',
      });
      expect(captured.kind).toBe('series');
      expect(captured.issues).toHaveLength(2);
      expect(captured.issues.map((i) => i.id)).toEqual(['i1', 'i2']);
    });
  });

  describe('applyIncomingPush', () => {
    it('rejects payloads without a known kind', async () => {
      await expect(applyIncomingPush({ kind: 'mystery', record: { id: 'x' }, sourceInstanceId: 'peer-a' }))
        .rejects.toThrow(/unknown kind/);
    });

    it('rejects pushes from sourceInstanceId="unknown"', async () => {
      // The sender's instance id is the identity we hang the cursor on.
      // Accepting an "unknown" sourceInstanceId would poison the cursor
      // table with a synthetic key that never gets cleaned up.
      await expect(applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1' },
        sourceInstanceId: 'unknown',
      })).rejects.toThrow(/sourceInstanceId required/);
    });

    it('rejects payloads with a missing/malformed record', async () => {
      await expect(applyIncomingPush({
        kind: 'universe',
        record: 'not-an-object',
        sourceInstanceId: 'peer-a',
      })).rejects.toThrow(/object with a string id/);
    });

    it('dispatches universe pushes through mergeUniversesFromSync', async () => {
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeUniversesFromSync).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'u1' }),
      ]);
    });

    it('dispatches series pushes through mergeSeriesFromSync AND mergeIssuesFromSync for bundled issues', async () => {
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', deleted: false, deletedAt: null },
        issues: [{ id: 'i1', seriesId: 's1', deleted: false, deletedAt: null }],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeSeriesFromSync).toHaveBeenCalled();
      expect(mergeIssuesFromSync).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'i1' }),
      ]);
    });

    it('reports missing assets in the response', async () => {
      const result = await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [{ filename: 'absent.png', kind: 'image', sha256: 'a'.repeat(64) }],
        sourceInstanceId: 'peer-a',
      });
      expect(result.missingAssets).toHaveLength(1);
    });

    it('advances the sender cursor when the payload carries a tombstone', async () => {
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const cursors = await listCursors();
      expect(cursors['peer-a'].lastAckedDeleteAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });

    it('picks the MAX deletedAt across record + bundled issues for the cursor advance', async () => {
      // Regression: if only `record.deletedAt` is considered, a series push
      // bundling multiple tombstoned issues would advance the cursor only
      // by the series' own deletion time — newer issue tombstones in the
      // same push would never be acknowledged until a separate push lands.
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        issues: [
          { id: 'i1', deleted: true, deletedAt: '2026-03-01T00:00:00Z' },
          { id: 'i2', deleted: false },
        ],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const cursors = await listCursors();
      expect(cursors['peer-a'].lastAckedDeleteAt).toBe(Date.parse('2026-03-01T00:00:00Z'));
    });

    it('auto-creates a reverse subscription back to the sender', async () => {
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const sub = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(sub).not.toBeNull();
      expect(sub.adoptedFromReverse).toBe(true);
    });

    it('does NOT create a reverse subscription when the sender peer is configured as inbound-only', async () => {
      // peer-b-inbound-only has directions: ['inbound']. The user explicitly
      // told this instance not to push back to them — auto-creating a
      // reverse subscription would override that intent.
      const result = await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-b-inbound-only',
      });
      expect(result.reverseSubscriptionCreated).toBe(false);
      const sub = await findPeerSubscription('peer-b-inbound-only', 'universe', 'u1');
      expect(sub).toBeNull();
    });

    it('does NOT duplicate a reverse subscription on subsequent pushes', async () => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', updatedAt: '2026-01-02T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const all = await listPeerSubscriptions({ peerId: 'peer-a' });
      expect(all).toHaveLength(1);
    });
  });
});
