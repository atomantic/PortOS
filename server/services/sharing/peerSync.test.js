import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// We test peerSync.js by stubbing the external dependencies:
//   - getPeers / getInstanceId from services/instances
//   - merge*FromSync + getUniverse + getSeries + listIssues
//   - peerFetch (network)
// All other logic (subscription store, asset manifest, diff, cursor advance)
// runs against the real on-disk paths via the tmpdir-redirect pattern below.

import { PATHS } from '../../lib/fileUtils.js';
import { RECORD_KIND_SCHEMA_CATEGORIES, PORTOS_SCHEMA_VERSIONS, NON_RECORD_SCHEMA_CATEGORIES } from '../../lib/schemaVersions.js';

// instances.js mock: aligns with mockNoPeers() contract (getPeers → [], getInstanceId
// → 'test-instance' by default) while keeping vi.fn() wrappers so per-test
// overrides via vi.mocked(getPeers).mockResolvedValue([...]) still work.
// A plain mockNoPeers() call would return static functions that vi.mocked()
// cannot spy on — so we construct vi.fn() variants here and match the same defaults.
vi.mock('../instances.js', () => ({
  UNKNOWN_INSTANCE_ID: 'unknown',
  DEFAULT_SYNC_CATEGORIES: {},
  getInstanceId: vi.fn().mockResolvedValue('test-instance'),
  getPeers: vi.fn().mockResolvedValue([]),
  enqueueReciprocalSync: vi.fn().mockResolvedValue({ ok: true }),
}));

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

// manuscriptReview is dynamic-imported inside the series push/receive helpers;
// mock both entry points so the review bundle path is exercisable.
vi.mock('../pipeline/manuscriptReview.js', async () => ({
  getReview: vi.fn(),
  mergeReviewFromSync: vi.fn(),
}));

// reverseOutline is dynamic-imported inside the series push/receive helpers (and
// statically by exporter.js, which peerSync.js imports) — mock both entry points
// so the outline bundle path is exercisable without loading the arcPlanner graph.
vi.mock('../pipeline/reverseOutline.js', async () => ({
  getStoredOutline: vi.fn(),
  mergeOutlineFromSync: vi.fn(),
}));

vi.mock('../mediaCollections.js', async () => ({
  getCollection: vi.fn(),
  listCollections: vi.fn(),
  findCollectionByUniverseId: vi.fn(),
  findCollectionBySeriesId: vi.fn(),
  mergeMediaCollectionsFromSync: vi.fn(),
}));

// #1566 — the media-library sweep dynamic-imports this to rebuild the derived
// media_assets index after bytes land. Mock it to a no-op spy so the sweep tests
// don't touch Postgres and can assert the reconcile fired.
vi.mock('../mediaAssetIndex/index.js', () => ({
  reconcileMediaAssets: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../artists/index.js', async () => {
  const imageBasename = (url) => {
    if (typeof url !== 'string' || !url.trim()) return null;
    if (/^(https?:|data:|blob:)/i.test(url)) return null;
    const prefix = '/data/images/';
    const value = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    if (value.startsWith('/')) return null;
    return value.split(/[?#]/)[0].split('/').pop() || null;
  };
  return {
    getArtist: vi.fn(),
    listArtists: vi.fn(),
    mergeArtistsFromSync: vi.fn(),
    portraitImageFilename: vi.fn(imageBasename),
  };
});

vi.mock('../albums/index.js', async () => {
  const imageBasename = (url) => {
    if (typeof url !== 'string' || !url.trim()) return null;
    if (/^(https?:|data:|blob:)/i.test(url)) return null;
    const prefix = '/data/images/';
    const value = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    if (value.startsWith('/')) return null;
    return value.split(/[?#]/)[0].split('/').pop() || null;
  };
  return {
    getAlbum: vi.fn(),
    listAlbums: vi.fn(),
    mergeAlbumsFromSync: vi.fn(),
    coverImageFilename: vi.fn(imageBasename),
  };
});

vi.mock('../tracks/index.js', async () => ({
  getTrack: vi.fn(),
  listTracks: vi.fn(),
  mergeTracksFromSync: vi.fn(),
  trackAudioFilename: vi.fn((name) => {
    if (typeof name !== 'string' || !name.trim()) return null;
    const value = name.trim();
    return value.includes('/') || value.includes('\\') || value.includes('..') ? null : value;
  }),
}));

vi.mock('../musicVideo/projects.js', async () => ({
  getProject: vi.fn(),
  listProjects: vi.fn(),
  mergeProjectsFromSync: vi.fn(),
}));

vi.mock('../../lib/peerHttpClient.js', async () => ({
  peerFetch: vi.fn(),
  peerSocketOptions: {},
}));

// Catalog bundle deps are dynamic-imported inside the universe push/apply
// helpers; mock the backend + DB + sync so the bundle path is exercisable
// without Postgres. Default backend is non-postgres so existing tests see no
// bundle; the catalog-bundle suite overrides getBackendName per-test.
vi.mock('../memoryBackend.js', async () => ({
  getBackendName: vi.fn(() => 'file'),
}));
vi.mock('../catalogDB.js', async () => ({
  getCatalogBundleForRef: vi.fn(),
}));
vi.mock('../catalogSync.js', async () => ({
  applyRemoteChanges: vi.fn(),
}));

import {
  PEER_SUBSCRIBABLE_KINDS,
  listPeerSubscriptions,
  findPeerSubscription,
  getOutboundCoverageForPeer,
  getFullSyncCoverageForPeer,
  subscribePeer,
  unsubscribePeer,
  unsubscribeAllForPeer,
  unsubscribeAllForRecord,
  pruneOrphanedPeerSubscriptions,
  pushRecordToPeer,
  applyIncomingPush,
  diffAssetManifestAgainstLocal,
  buildAssetManifest,
  assetIntegrityForRecord,
  collectCollectionAssetReferences,
  autoSubscribeRecordToAllPeers,
  autoSubscribePeerToAllRecords,
  retryPendingPushesForPeer,
  forcePushRecord,
  getRecordPayloadForPeer,
  pullRecordFromPeer,
  syncNowForPeer,
  collectSubscriptionsForUpdate,
  buildMediaLibraryManifest,
  libraryKindsExcludedByPatterns,
  syncMediaLibraryFromPeer,
  syncMediaLibraryWithAllPeers,
  peerSyncEvents,
  __resetForTests,
  __drainForTests,
} from './peerSync.js';

import { getInstanceId, getPeers } from '../instances.js';
import { getUniverse, mergeUniversesFromSync, listUniverses } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync, listSeries } from '../pipeline/series.js';
import { listIssues, mergeIssuesFromSync } from '../pipeline/issues.js';
import { getReview, mergeReviewFromSync } from '../pipeline/manuscriptReview.js';
import { getStoredOutline, mergeOutlineFromSync } from '../pipeline/reverseOutline.js';
import {
  getCollection,
  listCollections,
  findCollectionByUniverseId,
  findCollectionBySeriesId,
  mergeMediaCollectionsFromSync,
} from '../mediaCollections.js';
import { getArtist, listArtists, mergeArtistsFromSync } from '../artists/index.js';
import { getAlbum, listAlbums, mergeAlbumsFromSync } from '../albums/index.js';
import { getTrack, listTracks, mergeTracksFromSync } from '../tracks/index.js';
import {
  getProject as getMusicVideoProject,
  listProjects as listMusicVideoProjects,
  mergeProjectsFromSync as mergeMusicVideoProjectsFromSync,
} from '../musicVideo/projects.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { reconcileMediaAssets } from '../mediaAssetIndex/index.js';
import { getBackendName } from '../memoryBackend.js';
import { getCatalogBundleForRef } from '../catalogDB.js';
import { applyRemoteChanges as applyCatalogRemoteChanges } from '../catalogSync.js';
import { listCursors, __drainForTests as __drainCursors } from './peerTombstoneCursors.js';
import { contentHashForRecord, __resetBaseHashCacheForTests } from '../../lib/conflictJournal.js';

let originalDataPath;
let originalImagesPath;
let originalImageRefsPath;
let originalVideosPath;
let originalMusicPath;
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
  originalMusicPath = PATHS.music;
  tmp = join(tmpdir(), `portos-peer-sync-${Date.now()}-${Math.random()}`);
  await mkdir(join(tmp, 'sharing'), { recursive: true });
  await mkdir(join(tmp, 'images'), { recursive: true });
  await mkdir(join(tmp, 'music'), { recursive: true });
  PATHS.data = tmp;
  PATHS.images = join(tmp, 'images');
  PATHS.music = join(tmp, 'music');

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
  // Default getUniverse / getSeries / listIssues mocks to resolved promises
  // so any callsite that doesn't override (e.g. the receiver-side
  // `isLocalRecordEphemeral` lookup in maybeCreateReverseSubscription)
  // doesn't blow up on `.catch` against a `vi.fn()` non-Promise return.
  // Real getUniverse / getSeries / listIssues are `async` so they always
  // return Promises; production code can assume this, but the test mock
  // has to match — including the per-call default for listIssues so a
  // buildPushPayload path that bundles child issues doesn't choke on an
  // un-overridden mock.
  vi.mocked(getUniverse).mockReset().mockResolvedValue(undefined);
  vi.mocked(getSeries).mockReset().mockResolvedValue(undefined);
  vi.mocked(listIssues).mockReset().mockResolvedValue([]);
  // Default: no manuscript review for any series. Tests that exercise the
  // review-bundle path override getReview per-call.
  vi.mocked(getReview).mockReset().mockResolvedValue({ schemaVersion: 1, comments: [] });
  vi.mocked(mergeReviewFromSync).mockReset().mockResolvedValue({ schemaVersion: 1, comments: [] });
  // Default: no stored reverse outline for any series. Tests that exercise the
  // outline-bundle path override getStoredOutline per-call.
  vi.mocked(getStoredOutline).mockReset().mockResolvedValue(null);
  vi.mocked(mergeOutlineFromSync).mockReset().mockResolvedValue(null);
  // Default: no linked collection for any record. Tests that exercise the
  // bundle path override these per-call.
  vi.mocked(getCollection).mockReset().mockRejectedValue(Object.assign(new Error('Collection not found'), { code: 'NOT_FOUND' }));
  vi.mocked(listCollections).mockReset().mockResolvedValue([]);
  vi.mocked(findCollectionByUniverseId).mockReset().mockResolvedValue(null);
  vi.mocked(findCollectionBySeriesId).mockReset().mockResolvedValue(null);
  vi.mocked(mergeMediaCollectionsFromSync).mockReset().mockResolvedValue({ applied: false, count: 0 });
  vi.mocked(getArtist).mockReset().mockResolvedValue(null);
  vi.mocked(listArtists).mockReset().mockResolvedValue([]);
  vi.mocked(mergeArtistsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
  vi.mocked(getAlbum).mockReset().mockResolvedValue(null);
  vi.mocked(listAlbums).mockReset().mockResolvedValue([]);
  vi.mocked(mergeAlbumsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
  vi.mocked(getTrack).mockReset().mockResolvedValue(null);
  vi.mocked(listTracks).mockReset().mockResolvedValue([]);
  vi.mocked(mergeTracksFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
  vi.mocked(getMusicVideoProject).mockReset().mockResolvedValue(null);
  vi.mocked(listMusicVideoProjects).mockReset().mockResolvedValue([]);
  vi.mocked(mergeMusicVideoProjectsFromSync).mockReset().mockResolvedValue({ applied: true, count: 1 });
  // Catalog bundle defaults: non-postgres backend (no bundle), empty DB read,
  // no-op apply. The catalog-bundle suite overrides these per-test.
  vi.mocked(getBackendName).mockReset().mockReturnValue('file');
  vi.mocked(getCatalogBundleForRef).mockReset().mockResolvedValue({ ingredients: [], refs: [] });
  vi.mocked(applyCatalogRemoteChanges).mockReset().mockResolvedValue({ errors: [] });

  // The conflict-journal base-hash side store caches `_baseHashes` against the
  // first PATHS.data it loaded; reset it so each test's fresh tmpdir starts
  // with an empty map (and stamps from a prior test don't bleed in).
  __resetBaseHashCacheForTests();

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
  // __drainForTests double-awaits writeTail (one tick apart) so the
  // persistPushSuccess that enqueues after peerFetch resolves is captured.
  for (let i = 0; i < 3; i++) {
    await __drainForTests();
    await __drainCursors();
    await new Promise((r) => setTimeout(r, 5));
  }
  await __resetForTests();
  await rm(tmp, { recursive: true, force: true });
  PATHS.data = originalDataPath;
  PATHS.images = originalImagesPath;
  PATHS.imageRefs = originalImageRefsPath;
  PATHS.videos = originalVideosPath;
  PATHS.music = originalMusicPath;
});

describe('peerSync', () => {
  describe('PEER_SUBSCRIBABLE_KINDS', () => {
    it('is exactly [universe, series, mediaCollection, author, artist, album, track, creativeDirectorProject, moodBoard, writersRoomWork]', () => {
      // Exact equality (not toContain) so an accidental add/remove/reorder is
      // caught — this list is canonical and its order can affect iteration
      // elsewhere (e.g. syncNow's per-kind backfill). Issues piggyback on series
      // subscriptions; direct issue subs are intentionally rejected (Stage 2).
      expect(PEER_SUBSCRIBABLE_KINDS).toEqual(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise', 'musicVideoProject']);
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

  describe('getOutboundCoverageForPeer', () => {
    beforeEach(() => {
      // No push side effects — we only assert on the returned coverage map.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Ser', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(getCollection).mockResolvedValue({ id: 'c1', name: 'Col', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(listIssues).mockResolvedValue([]);
      vi.mocked(findCollectionByUniverseId).mockResolvedValue(null);
      vi.mocked(findCollectionBySeriesId).mockResolvedValue(null);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });
    });

    it('groups outbound subs by snapshot category (series → pipeline)', async () => {
      await subscribePeer({ peerId: 'peer-a', recordKind: 'universe', recordId: 'u1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      await subscribePeer({ peerId: 'peer-a', recordKind: 'mediaCollection', recordId: 'c1' });
      const cov = await getOutboundCoverageForPeer('peer-a');
      expect([...cov.universe]).toEqual(['u1']);
      // series rolls into the pipeline category (series + child issues bundle).
      expect([...cov.pipeline]).toEqual(['s1']);
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
      expect(cov).toMatchObject({ total: 0, confirmed: 0, pending: 0, fullyMirrored: true });
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
      vi.mocked(getSeries).mockResolvedValue({ id: 's1' });
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
      vi.mocked(getSeries).mockResolvedValue({ id: 's1' });
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
      const onDisk = JSON.parse(await readFile(join(tmp, 'sharing', 'sync_base_hashes.json'), 'utf8'));
      expect(onDisk['universe:u1']).toBe(contentHashForRecord('universe', { id: 'u1', name: 'U1' }));
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
      const onDisk = JSON.parse(await readFile(join(tmp, 'sharing', 'sync_base_hashes.json'), 'utf8'));
      expect(onDisk['universe:u1']).toBe(contentHashForRecord('universe', { id: 'u1', name: 'U1' }));
      expect(onDisk['universe:u2']).toBe(contentHashForRecord('universe', { id: 'u2', name: 'U2' }));
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

  describe('retryPendingPushesForPeer', () => {
    beforeEach(() => {
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1' });
      vi.mocked(listIssues).mockResolvedValue([]);
    });

    it('re-pushes subs with lastPushedAt=null and walks all subs on subsequent retries (hash short-circuits unchanged ones)', async () => {
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
      expect(result.walked).toBe(1);
      expect(result.pushed).toBe(1); // network call landed
      const updated = await findPeerSubscription('peer-a', 'universe', 'u1');
      expect(updated.lastPushedAt).toBeTruthy();
      // Subsequent retry now walks every sub regardless of lastPushedAt
      // (the lastPushedHash short-circuit inside pushRecordToPeer is what
      // skips the actual HTTP call for unchanged records). This is the
      // mechanism that lets out-of-band file edits (e.g., a cleanup script
      // that wrote tombstones directly to disk + a server restart)
      // re-propagate via peer:online without needing a per-record edit.
      vi.mocked(peerFetch).mockClear();
      const second = await retryPendingPushesForPeer('peer-a');
      expect(second.walked).toBe(1); // walked, not skipped by the helper
      expect(second.pushed).toBe(0); // hash short-circuited, no HTTP call
      // The hash short-circuit inside pushRecordToPeer prevents the actual
      // HTTP call because the record content is unchanged since the first push.
      expect(vi.mocked(peerFetch)).not.toHaveBeenCalled();
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
      // because the push's peerFetch + persistPushSuccess chain may not have even
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

  describe('pullRecordFromPeer', () => {
    it('peer-not-found when the peer is unknown', async () => {
      vi.mocked(getPeers).mockResolvedValue([]);
      expect(await pullRecordFromPeer('nope', 'universe', 'u1')).toEqual({ pulled: false, reason: 'peer-not-found' });
    });

    it('peer-unreachable when the fetch fails', async () => {
      vi.mocked(peerFetch).mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u1')).toEqual({ pulled: false, reason: 'peer-unreachable' });
    });

    it('not-on-peer on a 404 from the peer', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: false, status: 404 });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u1')).toEqual({ pulled: false, reason: 'not-on-peer' });
    });

    it('invalid-payload when the peer returns a malformed body', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ junk: true }) });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u1')).toEqual({ pulled: false, reason: 'invalid-payload' });
    });

    it('applies a valid payload and reports missingAssets count', async () => {
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'universe', record: { id: 'u-pull' }, assetManifest: [], sourceInstanceId: 'peer-a' }),
      });
      const result = await pullRecordFromPeer('peer-a', 'universe', 'u-pull');
      expect(result.pulled).toBe(true);
      expect(typeof result.missingAssets).toBe('number');
    });

    it('invalid-payload when sourceInstanceId does not match the contacted peer', async () => {
      // We fetched from peer-a, but the payload claims to originate from someone
      // else — applying it would bind our reverse-subscription/asset-pull to a
      // peer we never contacted. Reject rather than trust the self-reported origin.
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'universe', record: { id: 'u-pull' }, assetManifest: [], sourceInstanceId: 'peer-b' }),
      });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'invalid-payload' });
    });

    it('payload-too-large when the peer declares a Content-Length over the cap', async () => {
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(64 * 1024 * 1024) : null) },
        json: async () => ({ kind: 'universe', record: { id: 'u-pull' }, assetManifest: [], sourceInstanceId: 'peer-a' }),
      });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'payload-too-large' });
    });

    it('payload-too-large (not peer-unreachable) when the HTTPS shim trips the maxBytes cap', async () => {
      // The shim rejects with an "exceed" Error — must map to payload-too-large,
      // consistent with the Content-Length path, not be misread as offline.
      vi.mocked(peerFetch).mockRejectedValue(new Error('Response body exceeded maxBytes 16777216 (got 99999999)'));
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'payload-too-large' });
    });

    it('invalid-payload when the returned record is not the one we requested', async () => {
      // Asked for universe/u-pull but the peer returned a different record id —
      // applying it would merge unexpected data under the requested key.
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'universe', record: { id: 'some-other-id' }, assetManifest: [], sourceInstanceId: 'peer-a' }),
      });
      expect(await pullRecordFromPeer('peer-a', 'universe', 'u-pull'))
        .toEqual({ pulled: false, reason: 'invalid-payload' });
    });
  });

  describe('syncNowForPeer', () => {
    it('returns {ok:false} when the peer has no instanceId', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: null, name: 'No ID Peer', enabled: true, syncEnabled: true },
      ]);
      const result = await syncNowForPeer('no-such-peer');
      expect(result).toEqual({ ok: false });
    });

    it('returns {ok:false} when the peer is not found', async () => {
      const result = await syncNowForPeer('ghost-peer');
      expect(result).toEqual({ ok: false });
    });

    it('calls backfill+retry for a peer with enabled categories and returns {ok:true}', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        {
          instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
          enabled: true, syncEnabled: true,
          directions: ['outbound', 'inbound'],
          syncCategories: { universe: true, pipeline: false, mediaCollections: false },
        },
      ]);
      vi.mocked(listUniverses).mockResolvedValue([{ id: 'u1', name: 'Universe 1' }]);
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Universe 1', updatedAt: '2026-01-01T00:00:00Z' });
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ missingAssets: [] }) });

      const result = await syncNowForPeer('peer-a');
      expect(result).toEqual({ ok: true });
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

    it('includes sidecarSha256 in the manifest entry when sidecar is present', async () => {
      await writeFile(join(PATHS.images, 'with-sidecar.png'), Buffer.from('image bytes'));
      await writeFile(join(PATHS.images, 'with-sidecar.metadata.json'), Buffer.from(JSON.stringify({ prompt: 'a cat' })));
      const record = { id: 'u1', characters: [{ imageRefs: ['with-sidecar.png'] }] };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].sidecarSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('omits sidecarSha256 from the manifest entry when no sidecar exists', async () => {
      await writeFile(join(PATHS.images, 'no-sidecar.png'), Buffer.from('image bytes'));
      const record = { id: 'u1', characters: [{ imageRefs: ['no-sidecar.png'] }] };
      const manifest = await buildAssetManifest(record);
      expect(manifest).toHaveLength(1);
      expect(manifest[0]).not.toHaveProperty('sidecarSha256');
    });

    it('summarizes missing image sidecars for integrity without another asset walk', async () => {
      await writeFile(join(PATHS.images, 'missing-meta.png'), Buffer.from('image bytes'));
      const record = { id: 'u1', characters: [{ imageRefs: ['missing-meta.png'] }] };
      const summary = await assetIntegrityForRecord('universe', record);
      expect(summary.assetHashes).toHaveLength(1);
      expect(summary.metadataMissing).toBe(true);
    });

    it('includes live child issue assets in a series integrity summary', async () => {
      await writeFile(join(PATHS.images, 'issue-panel.png'), Buffer.from('issue image bytes'));
      vi.mocked(listIssues).mockResolvedValue([
        { id: 'i1', seriesId: 's1', stages: { storyboards: { panels: [{ imageRefs: ['issue-panel.png'] }] } } },
      ]);
      const summary = await assetIntegrityForRecord('series', { id: 's1', name: 'Series' });
      expect(summary.assetHashes).toHaveLength(1);
      expect(summary.metadataMissing).toBe(true);
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

    it('returns image entry as missing when image hash matches but sidecar is absent', async () => {
      // The image file is already present and hash-matches; BUT the sender
      // carries a sidecarSha256 and we have no local sidecar. The diff must
      // still include the entry so the worker pulls the sidecar.
      const imageBytes = Buffer.from('hello world');
      await writeFile(join(PATHS.images, 'nosidecar.png'), imageBytes);
      // Actual sha256 of "hello world"
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'nosidecar.png', kind: 'image', sha256: imageHash, sidecarSha256: 'a'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].filename).toBe('nosidecar.png');
      expect(missing[0].sidecarSha256).toBe('a'.repeat(64));
    });

    it('does NOT return an image as missing when image hash matches and sidecar gen-params match', async () => {
      // Both image and sidecar are present; the gen-params are identical — no pull needed.
      const imageBytes = Buffer.from('hello world');
      await writeFile(join(PATHS.images, 'fullmatch.png'), imageBytes);
      await writeFile(join(PATHS.images, 'fullmatch.metadata.json'), Buffer.from(JSON.stringify({ prompt: 'cat' })));
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      // The sender advertises the gen-params hash (NOT the raw-file hash).
      const senderSidecarHash = sidecarGenParamsHash({ prompt: 'cat' });
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'fullmatch.png', kind: 'image', sha256: imageHash, sidecarSha256: senderSidecarHash },
      ]);
      expect(missing).toEqual([]);
    });

    it('CONVERGENCE: image NOT re-flagged when gen-params match but the sha256 cache block differs', async () => {
      // CRITICAL regression for the churn bug. Two machines with byte-identical
      // gen-params but different per-machine `sha256` cache blocks (mtimeMs/size
      // differ) must NOT perpetually re-pull. The sidecar hash is computed over
      // gen-params ONLY (sha256 cache stripped), so it converges regardless of
      // the local cache block.
      const imageBytes = Buffer.from('hello world');
      await writeFile(join(PATHS.images, 'converge.png'), imageBytes);
      // Local sidecar: SAME gen-params, but a DIFFERENT sha256 cache block than
      // whatever the sender stamped (simulates the receiver re-stamping its own
      // local image mtime+size after a prior pull).
      await writeFile(join(PATHS.images, 'converge.metadata.json'), Buffer.from(JSON.stringify({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'c'.repeat(64), mtimeMs: 111111, size: 222 },
      })));
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      // The SENDER computes the gen-params hash over its OWN sidecar, which has
      // the SAME gen-params but a DIFFERENT sha256 cache block (different mtime/size).
      const senderSidecarHash = sidecarGenParamsHash({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'd'.repeat(64), mtimeMs: 999999, size: 888 },
      });
      // The receiver computes its local gen-params hash the same way.
      const localSidecarHash = sidecarGenParamsHash({
        prompt: 'a wizard', model: 'flux', steps: 30,
        sha256: { value: 'c'.repeat(64), mtimeMs: 111111, size: 222 },
      });
      // The two MUST be equal despite differing cache blocks — proves convergence.
      expect(senderSidecarHash).toBe(localSidecarHash);
      // And the diff must NOT flag the image as missing (no re-pull churn).
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'converge.png', kind: 'image', sha256: imageHash, sidecarSha256: senderSidecarHash },
      ]);
      expect(missing).toEqual([]);
    });

    it('CONVERGENCE: key-order differences across machines do not break the gen-params hash', async () => {
      const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
      const a = sidecarGenParamsHash({ prompt: 'x', model: 'flux', steps: 30 });
      const b = sidecarGenParamsHash({ steps: 30, prompt: 'x', model: 'flux' });
      expect(a).toBe(b);
    });

    it('returns image entry as missing when sidecar hash differs (peer has updated metadata)', async () => {
      const imageBytes = Buffer.from('hello world');
      const sidecarBytes = Buffer.from(JSON.stringify({ prompt: 'old prompt' }));
      await writeFile(join(PATHS.images, 'staleside.png'), imageBytes);
      await writeFile(join(PATHS.images, 'staleside.metadata.json'), sidecarBytes);
      const imageHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'staleside.png', kind: 'image', sha256: imageHash, sidecarSha256: 'b'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].filename).toBe('staleside.png');
    });

    it('preserves sidecarSha256 in the sanitized missing entry (no untrusted round-trip loss)', async () => {
      const missing = await diffAssetManifestAgainstLocal([
        { filename: 'absent.png', kind: 'image', sha256: 'a'.repeat(64), sidecarSha256: 'b'.repeat(64) },
      ]);
      expect(missing).toHaveLength(1);
      expect(missing[0].sidecarSha256).toBe('b'.repeat(64));
      // Junk fields still stripped.
      expect(missing[0]).not.toHaveProperty('gigantic');
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

    it('bundles the manuscript review with a series push so review-only edits propagate', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(getReview).mockResolvedValue({
        schemaVersion: 1,
        comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      expect(captured.kind).toBe('series');
      expect(captured.manuscriptReview).toBeTruthy();
      expect(captured.manuscriptReview.comments).toHaveLength(1);
      expect(captured.manuscriptReview.comments[0].id).toBe('mrc-1');
    });

    it('omits the manuscriptReview key when the series has an empty review', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(getReview).mockResolvedValue({ schemaVersion: 1, comments: [] });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      expect(captured.manuscriptReview).toBeUndefined();
    });

    it('does not fetch a review for a tombstone series push', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      expect(captured.manuscriptReview).toBeUndefined();
      expect(vi.mocked(getReview)).not.toHaveBeenCalled();
    });

    it('bundles the reverse outline with a series push so regenerate-only edits propagate', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(getStoredOutline).mockResolvedValue({
        seriesId: 's1', schemaVersion: 1, status: 'complete', generatedAt: '2026-06-02T00:00:00Z',
        plotlines: [{ id: 'a', label: 'A-plot', kind: 'main', color: '#3b82f6' }],
        scenes: [{ id: 'scene-001', sequence: 0, summary: 'opening', plotlineId: 'a' }],
      });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      expect(captured.reverseOutline).toBeTruthy();
      expect(captured.reverseOutline.scenes).toHaveLength(1);
      expect(captured.reverseOutline.generatedAt).toBe('2026-06-02T00:00:00Z');
    });

    it('omits the reverseOutline key when no complete outline exists', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      // A never-generated / in-progress outline (status !== 'complete') is not shipped.
      vi.mocked(getStoredOutline).mockResolvedValue({ seriesId: 's1', schemaVersion: 1, status: 'none', plotlines: [], scenes: [] });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      expect(captured.reverseOutline).toBeUndefined();
    });

    it('does not fetch an outline for a tombstone series push', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' });
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({ id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1' });
      expect(captured.reverseOutline).toBeUndefined();
      expect(vi.mocked(getStoredOutline)).not.toHaveBeenCalled();
    });

    it('re-pushes when only the manuscript review changes (series record byte-identical)', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
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
        { peerId: 'peer-a', recordKind: 'series', recordId: 's1' },
        { adoptedFromReverse: true },
      );
      const first = await pushRecordToPeer(sub);
      expect(first.pushed).toBe(true);

      vi.mocked(peerFetch).mockClear();
      const refreshed = await findPeerSubscription('peer-a', 'series', 's1');
      const second = await pushRecordToPeer(refreshed);
      expect(second.pushed).toBe(true);
      expect(second.reason).not.toBe('unchanged');
      expect(peerFetch).toHaveBeenCalledTimes(1);
    });

    it('withholds lastPushedHash when the receiver reports reviewSyncPending (so the next cycle re-sends)', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(getReview).mockResolvedValue({
        schemaVersion: 1,
        comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
      });
      // Receiver merged the record but its review merge threw → reviewSyncPending.
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ reviewSyncPending: true }) });
      const sub = await subscribePeer(
        { peerId: 'peer-a', recordKind: 'series', recordId: 's1' },
        { adoptedFromReverse: true },
      );
      const r = await pushRecordToPeer(sub);
      expect(r.pushed).toBe(true);
      // Hash withheld → a subsequent push with identical content is NOT a no-op.
      const refreshed = await findPeerSubscription('peer-a', 'series', 's1');
      expect(refreshed.lastPushedHash).toBeFalsy();
      vi.mocked(peerFetch).mockClear();
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      const second = await pushRecordToPeer(refreshed);
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
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(listIssues).mockResolvedValue([
        // Live issue with a referenced image.
        {
          id: 'i1', seriesId: 's1', number: 1,
          stages: { storyboards: { scenes: [{ imageJobId: 'job-live' }] } },
        },
        // Ephemeral issue — must NOT leak its image into the manifest.
        {
          id: 'i2', seriesId: 's1', number: 2, ephemeral: true,
          stages: { storyboards: { scenes: [{ imageJobId: 'job-secret' }] } },
        },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1',
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

    it('drops deleted child issues from the asset manifest input', async () => {
      // Deleted issues' tombstones must still ride along in `issues` (so
      // the receiver's delete cascade runs), but their asset filenames
      // must NOT appear in the manifest — the receiver would otherwise
      // pull bytes for issues it's about to orphan.
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
      vi.mocked(listIssues).mockResolvedValue([
        // Live issue (no manifest leak — buildAssetManifest doesn't yet
        // resolve imageJobId → filename, that's a Stage 3 thing).
        { id: 'i1', seriesId: 's1', number: 1 },
        // Deleted issue with a sentinel filename that would surface
        // through buildAssetManifest's directVideoFilenames path if it
        // were fed to the manifest builder.
        {
          id: 'i2', seriesId: 's1', number: 2,
          deleted: true, deletedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      let captured = null;
      vi.mocked(peerFetch).mockImplementation(async (_url, opts) => {
        captured = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      });
      await pushRecordToPeer({
        id: 's', peerId: 'peer-a', recordKind: 'series', recordId: 's1',
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
    const enableMusicVideoPeer = () => {
      vi.mocked(getPeers).mockResolvedValue([{
        instanceId: 'peer-a', name: 'Peer A', host: null, address: '10.0.0.2', port: 5555,
        enabled: true, syncEnabled: true, directions: ['outbound', 'inbound'],
        syncCategories: { musicVideoProjects: true },
      }]);
    };

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

  describe('collectSubscriptionsForUpdate', () => {
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
      expect(mergeUniversesFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'u1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
    });

    it('dispatches music pushes through their merge entry points', async () => {
      await applyIncomingPush({
        kind: 'artist',
        record: { id: 'artist-1', name: 'Nova', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      await applyIncomingPush({
        kind: 'album',
        record: { id: 'album-1', title: 'Debut', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      await applyIncomingPush({
        kind: 'track',
        record: { id: 'track-1', title: 'Intro', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });

      expect(mergeArtistsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'artist-1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
      expect(mergeAlbumsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'album-1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
      expect(mergeTracksFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'track-1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
    });

    it('routes a bundled linkedCollection through mergeMediaCollectionsFromSync', async () => {
      const linkedCollection = {
        id: 'col-1', name: 'Universe: U', items: [
          { kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' },
        ],
      };
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        linkedCollection,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith(
        [linkedCollection],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
    });

    it('skips mergeMediaCollectionsFromSync when no linkedCollection is bundled', async () => {
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
    });

    it('routes a bundled linkedTrack through mergeTracksFromSync on a music-video push (#1858)', async () => {
      const linkedTrack = {
        id: 'track-9', title: 'Anthem', audioFilename: 'linked.mp3',
        updatedAt: '2026-06-28T00:00:00Z', deleted: false, deletedAt: null,
      };
      await applyIncomingPush({
        kind: 'musicVideoProject',
        record: { id: 'mv-1', name: 'Linked', trackId: 'track-9', deleted: false, deletedAt: null },
        linkedTrack,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMusicVideoProjectsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'mv-1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
      expect(mergeTracksFromSync).toHaveBeenCalledWith(
        [linkedTrack],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
    });

    it('skips linkedTrack merge when none is bundled or the project is a tombstone', async () => {
      await applyIncomingPush({
        kind: 'musicVideoProject',
        record: { id: 'mv-2', trackId: 'track-9', deleted: false, deletedAt: null },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
      await applyIncomingPush({
        kind: 'musicVideoProject',
        record: { id: 'mv-3', trackId: 'track-9', deleted: true, deletedAt: '2026-06-29T00:00:00Z' },
        linkedTrack: { id: 'track-9', audioFilename: 'linked.mp3' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
    });

    it('refuses a linkedTrack whose id does not match the project trackId (#1858)', async () => {
      await applyIncomingPush({
        kind: 'musicVideoProject',
        record: { id: 'mv-5', trackId: 'track-A', deleted: false, deletedAt: null },
        linkedTrack: { id: 'track-SMUGGLED', audioFilename: 'x.mp3' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeTracksFromSync).not.toHaveBeenCalled();
    });

    it('signals trackSyncPending when the bundled linkedTrack merge fails (#1858)', async () => {
      // The linked track has no independent reconciliation cycle for a
      // musicVideoProjects-only subscriber, so a swallowed failure must surface
      // a pending flag that makes the sender withhold its hash and re-send.
      vi.mocked(mergeTracksFromSync).mockRejectedValueOnce(new Error('disk full'));
      const res = await applyIncomingPush({
        kind: 'musicVideoProject',
        record: { id: 'mv-9', trackId: 'track-9', deleted: false, deletedAt: null },
        linkedTrack: { id: 'track-9', audioFilename: 'linked.mp3' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(res.trackSyncPending).toBe(true);
    });

    it('routes a bundled manuscriptReview through mergeReviewFromSync on a series push', async () => {
      const manuscriptReview = {
        schemaVersion: 1,
        comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
      };
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        manuscriptReview,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).toHaveBeenCalledWith('s1', manuscriptReview);
    });

    it('skips mergeReviewFromSync when no manuscriptReview is bundled', async () => {
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
    });

    it('refuses to merge manuscriptReview when the incoming series record is a tombstone', async () => {
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' },
        issues: [],
        manuscriptReview: { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
    });

    it('skips mergeReviewFromSync when the LOCAL series is ephemeral', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', ephemeral: true });
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        manuscriptReview: { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeReviewFromSync).not.toHaveBeenCalled();
    });

    it('returns reviewSyncPending when the bundled review merge throws (so the sender retries)', async () => {
      vi.mocked(mergeReviewFromSync).mockRejectedValueOnce(new Error('disk full'));
      const res = await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        manuscriptReview: { schemaVersion: 1, comments: [{ id: 'mrc-1', problem: 'x', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      // The series/issues merge still succeeded — the push isn't failed — but
      // the sender is told to withhold its hash and retry the review.
      expect(res.reviewSyncPending).toBe(true);
    });

    const sampleOutline = (generatedAt = '2026-06-02T00:00:00Z') => ({
      schemaVersion: 1, status: 'complete', generatedAt,
      plotlines: [{ id: 'a', label: 'A', kind: 'main' }],
      scenes: [{ id: 'scene-001', sequence: 0, summary: 'opening', plotlineId: 'a' }],
    });

    it('routes a bundled reverseOutline through mergeOutlineFromSync on a series push', async () => {
      const reverseOutline = sampleOutline();
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        reverseOutline,
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).toHaveBeenCalledWith('s1', reverseOutline);
    });

    it('skips mergeOutlineFromSync when no reverseOutline is bundled', async () => {
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
    });

    it('refuses to merge reverseOutline when the incoming series record is a tombstone', async () => {
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', deleted: true, deletedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z' },
        issues: [],
        reverseOutline: sampleOutline(),
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
    });

    it('skips mergeOutlineFromSync when the LOCAL series is ephemeral', async () => {
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', ephemeral: true });
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        reverseOutline: sampleOutline(),
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeOutlineFromSync).not.toHaveBeenCalled();
    });

    it('returns outlineSyncPending when the bundled outline merge throws (so the sender retries)', async () => {
      vi.mocked(mergeOutlineFromSync).mockRejectedValueOnce(new Error('disk full'));
      const res = await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', name: 'S', deleted: false, deletedAt: null },
        issues: [],
        reverseOutline: sampleOutline(),
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      // Series/issues merge still succeeded — the outline has no independent
      // reconciliation path, so the sender withholds its hash and retries.
      expect(res.outlineSyncPending).toBe(true);
    });

    it('refuses to merge linkedCollection when the incoming record is a tombstone', async () => {
      // Defense in depth: the sender's buildPushPayload already skips the
      // bundle for tombstones, but a buggy or malicious peer could send
      // one anyway. Receiving a collection during a delete propagation
      // would resurrect collection state for a record being torn down.
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
        linkedCollection: { id: 'col-1', name: 'Universe: U', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
    });

    it('refuses to merge linkedCollection when it is not a plain object (array, primitive)', async () => {
      // Wrapping a non-plain-object in `[...]` and passing to the merge
      // function would just produce a no-op (sanitizeCollection drops
      // non-objects), but skipping early keeps the trust posture clean
      // and the failure mode obvious.
      for (const bogus of [[], ['a'], 'string', 42, true]) {
        vi.mocked(mergeMediaCollectionsFromSync).mockClear();
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', deleted: false, deletedAt: null },
          linkedCollection: bogus,
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
        expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
      }
    });

    it('dispatches series pushes through mergeSeriesFromSync AND mergeIssuesFromSync for bundled issues', async () => {
      await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', deleted: false, deletedAt: null },
        issues: [{ id: 'i1', seriesId: 's1', deleted: false, deletedAt: null }],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(mergeSeriesFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 's1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
      expect(mergeIssuesFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'i1' })],
        { source: { via: 'peer-push', peerId: 'peer-a' } },
      );
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

    it('returns ackedDeletesUpTo for the sender (does NOT advance the local cursor on receive)', async () => {
      // Cursors track "what peer X has acked of OUR local deletions" so
      // tombstoneGc can prune our local tombstones once every subscribed
      // peer has confirmed receipt. Advancing the cursor for sourceInstanceId
      // on receive would mis-credit the sender's tombstones as our own pushed-
      // and-acked ones, letting GC prune local tombstones the sender never
      // saw — and resurrecting them on the sender's next push.
      const result = await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.ackedDeletesUpTo).toBe(Date.parse('2026-01-01T00:00:00Z'));
      const cursors = await listCursors();
      expect(cursors['peer-a']).toBeUndefined();
    });

    it('returns the MAX deletedAt across record + bundled issues so the sender can ack all in one round-trip', async () => {
      // Regression: if only `record.deletedAt` is returned, a series push
      // bundling multiple tombstoned issues would only ack the series'
      // own deletion time — newer issue tombstones in the same push would
      // never be acknowledged until a separate push lands.
      const result = await applyIncomingPush({
        kind: 'series',
        record: { id: 's1', deleted: true, deletedAt: '2026-01-01T00:00:00Z' },
        issues: [
          { id: 'i1', deleted: true, deletedAt: '2026-03-01T00:00:00Z' },
          { id: 'i2', deleted: false },
        ],
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.ackedDeletesUpTo).toBe(Date.parse('2026-03-01T00:00:00Z'));
    });

    it('auto-creates a reverse subscription back to the sender', async () => {
      // The merge path actually landed the record locally, so the
      // classifyLocalRecord('universe', 'u1') call inside
      // maybeCreateReverseSubscription will find a syncable record on
      // disk. Mock the lookup explicitly — the tri-state gate refuses
      // 'missing' to avoid orphan reverse-subs (e.g. for records the
      // sanitizer dropped at the merge boundary).
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
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

    it('does NOT create a reverse subscription when the local record is missing (merge dropped it)', async () => {
      // Regression: classifyLocalRecord must hard-stop on 'missing'.
      // Previously the gate only checked `ephemeral === true`, so a
      // record the sanitizer dropped during merge (missing name, schema
      // mismatch, etc.) would still get an orphan reverse-sub that fires
      // pushes against a nonexistent local record forever.
      vi.mocked(getUniverse).mockResolvedValue(undefined);
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u-dropped' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      const sub = await findPeerSubscription('peer-a', 'universe', 'u-dropped');
      expect(sub).toBeNull();
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

    it('does NOT create a reverse subscription when the local record is ephemeral', async () => {
      // The user marked u1 local-only; the merge already refused the
      // inbound edit (see mergeUniversesFromSync local-ephemeral guard).
      // Creating a reverse sub here would accumulate an orphan row in
      // peer_subscriptions.json that burns asset-manifest sha-passes on
      // every future edit and never sends bytes.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', ephemeral: true });
      const result = await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1' },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.reverseSubscriptionCreated).toBe(false);
      expect(await findPeerSubscription('peer-a', 'universe', 'u1')).toBeNull();
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

    it('emits peerSyncEvents "subscription-created" ONLY when a reverse sub is genuinely created', async () => {
      // The Instances UI listens on the relayed `peerSync:subscription:created`
      // socket event to re-fetch a peer's subs without a manual reload. It must
      // fire exactly once — on the first push that creates the reverse sub —
      // and NOT on every subsequent push to the same (already-subscribed) record.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      const events = [];
      const handler = (payload) => events.push(payload);
      peerSyncEvents.on('subscription-created', handler);
      try {
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
        // Second push — sub already exists, so no new event.
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', updatedAt: '2026-01-02T00:00:00Z' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
      } finally {
        peerSyncEvents.off('subscription-created', handler);
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        peerId: 'peer-a',
        recordKind: 'universe',
        recordId: 'u1',
      });
      expect(typeof events[0].subId).toBe('string');
    });

    it('does NOT emit "subscription-created" when the reverse-sub gate refuses (inbound-only peer)', async () => {
      // No reverse sub is created for an inbound-only peer, so the UI signal
      // must stay silent — emitting on every push would trigger needless
      // peerSubs refetches across all cards.
      vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
      const events = [];
      const handler = (payload) => events.push(payload);
      peerSyncEvents.on('subscription-created', handler);
      try {
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1' },
          assetManifest: [],
          sourceInstanceId: 'peer-b-inbound-only',
        });
      } finally {
        peerSyncEvents.off('subscription-created', handler);
      }
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CATALOG BUNDLE — universe push carries referenced catalog ingredients +
  // refs (catalog-bundled-universe-push). Assembly is gated on Postgres +
  // non-tombstone + non-empty; the receiver applies via catalogSync.
  // -------------------------------------------------------------------------
  describe('catalog bundle (universe push)', () => {
    const liveUniverse = { id: 'u1', name: 'Foo', updatedAt: '2026-01-01T00:00:00Z', deleted: false, deletedAt: null };

    it('bundles catalog ingredients + refs into a live universe push (Postgres)', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getUniverse).mockResolvedValue(liveUniverse);
      vi.mocked(getCatalogBundleForRef).mockResolvedValue({
        ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }],
        refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
      });

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(getCatalogBundleForRef).toHaveBeenCalledWith('universe', 'u1');
      expect(payload.catalogBundle).toBeDefined();
      expect(payload.catalogBundle.ingredients).toHaveLength(1);
      expect(payload.catalogBundle.ingredients[0].id).toBe('cat-chr-1');
      expect(payload.catalogBundle.refs[0].refId).toBe('u1');
    });

    it('omits the bundle on a non-Postgres install (nothing to bundle)', async () => {
      vi.mocked(getBackendName).mockReturnValue('file');
      vi.mocked(getUniverse).mockResolvedValue(liveUniverse);

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(getCatalogBundleForRef).not.toHaveBeenCalled();
      expect(payload.catalogBundle).toBeUndefined();
    });

    it('omits the bundle on a tombstone (deleted) universe push', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getUniverse).mockResolvedValue({ ...liveUniverse, deleted: true, deletedAt: '2026-03-01T00:00:00Z' });

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(getCatalogBundleForRef).not.toHaveBeenCalled();
      expect(payload.catalogBundle).toBeUndefined();
    });

    it('omits the bundle key when the universe has no catalog rows', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getUniverse).mockResolvedValue(liveUniverse);
      vi.mocked(getCatalogBundleForRef).mockResolvedValue({ ingredients: [], refs: [] });

      const payload = await getRecordPayloadForPeer('universe', 'u1');

      expect(payload.catalogBundle).toBeUndefined();
    });

    it('does NOT bundle catalog rows on a series push (only universe)', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Ser', updatedAt: '2026-01-01T00:00:00Z', deleted: false, deletedAt: null });
      vi.mocked(listIssues).mockResolvedValue([]);

      const payload = await getRecordPayloadForPeer('series', 's1');

      expect(getCatalogBundleForRef).not.toHaveBeenCalled();
      expect(payload.catalogBundle).toBeUndefined();
    });

    it('receiver applies a bundled catalog payload via catalogSync', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      const catalogBundle = {
        ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }],
        refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
      };
      const portosMeta = { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } };

      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle,
        sourceInstanceId: 'peer-a',
        portosMeta,
      });

      expect(applyCatalogRemoteChanges).toHaveBeenCalledTimes(1);
      const arg = vi.mocked(applyCatalogRemoteChanges).mock.calls[0][0];
      expect(arg.ingredients).toEqual(catalogBundle.ingredients);
      expect(arg.refs).toEqual(catalogBundle.refs);
      // portosMeta forwarded so applyRemoteChanges can run its own gate.
      expect(arg.portosMeta).toEqual(portosMeta);
    });

    it('receiver skips the bundle on a tombstone universe push', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      await applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: true, deletedAt: '2026-03-01T00:00:00Z' },
        assetManifest: [],
        catalogBundle: { ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }], refs: [] },
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS } },
      });

      expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
    });

    it('receiver rejects a universe push whose bundle ingredient is schema-ahead on catalog', async () => {
      vi.mocked(getBackendName).mockReturnValue('postgres');
      await expect(applyIncomingPush({
        kind: 'universe',
        record: { id: 'u1', name: 'Foo', deleted: false, deletedAt: null },
        assetManifest: [],
        catalogBundle: { ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }], refs: [] },
        sourceInstanceId: 'peer-a',
        portosMeta: { schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, catalog: PORTOS_SCHEMA_VERSIONS.catalog + 1 }, portosVersion: '99.0.0' },
      })).rejects.toThrow(/schema is ahead/);
      // Gated before merge — bundle apply never runs.
      expect(applyCatalogRemoteChanges).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SCHEMA-VERSION GATING — sender side (handle 409 / cooldown / clear)
  // + receiver side (reject when sender ahead / pass through legacy + behind)
  // -------------------------------------------------------------------------
  describe('schema-version gating', () => {
    beforeEach(() => {
      // Earlier tests in this file accumulate calls on the merge mocks (the
      // file's outer beforeEach does mockResolvedValue but not mockClear).
      // Clear history so `expect(...).not.toHaveBeenCalled()` reflects only
      // calls made in the current test.
      vi.mocked(mergeUniversesFromSync).mockClear();
      vi.mocked(mergeSeriesFromSync).mockClear();
      vi.mocked(mergeIssuesFromSync).mockClear();
      vi.mocked(mergeMediaCollectionsFromSync).mockClear();
    });

    describe('receiver — applyIncomingPush', () => {
      it('rejects when sender schemaVersions.universes is AHEAD of local code', async () => {
        // Local code is at universes:7 (see server/lib/schemaVersions.js).
        // A push from a sender on universes:8 must NOT touch local state.
        const rejection = await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 8 } },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'universes', senderV: 8, receiverV: 7 }]);
        expect(rejection.details.senderPortosVersion).toBe('99.0.0');
        // Receiver MUST stamp its OWN PortOS version so the sender can show
        // the user "peer X is on PortOS vY" — without this, the sender would
        // fall back to its own version (the one it sent) and mislabel the
        // peer in the SchemaGapBadge.
        expect(typeof rejection.details.receiverPortosVersion).toBe('string');
        expect(rejection.details.receiverPortosVersion.length).toBeGreaterThan(0);
        // mergeUniversesFromSync MUST NOT have been called — the gate runs
        // before the merge dispatch.
        expect(mergeUniversesFromSync).not.toHaveBeenCalled();
      });

      it('passes through when sender schemaVersions are EQUAL to local', async () => {
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '2.7.0', schemaVersions: { universes: 6 } },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1' })],
          { source: { via: 'peer-push', peerId: 'peer-a' } },
        );
      });

      it('passes through when sender is BEHIND local (sanitizer handles the backfill)', async () => {
        // Older peer pushes a v4-shape universe. Receiver is on v6 but the
        // record-shape sanitizer can backfill, so we apply rather than reject.
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '2.6.0', schemaVersions: { universes: 4 } },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1' })],
          { source: { via: 'peer-push', peerId: 'peer-a' } },
        );
      });

      it('passes through legacy peers that send NO portosMeta at all', async () => {
        // Backwards compat — pre-this-PR peers don't know to include the
        // envelope. The comparator treats absent sender versions as 0, which
        // either matches (receiver also 0 for the category) or surfaces as
        // "behind" (which we DON'T gate on).
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
        });
        expect(mergeUniversesFromSync).toHaveBeenCalled();
      });

      // ---- per-category gate: cross-key isolation -------------------------
      // The sender stamps its full schemaVersions map. A push must only be
      // gated on the categories THIS record actually writes.
      it('does NOT reject a universe push when the sender is ahead on mediaCollections only', async () => {
        // universes is equal; the sender bumped an unrelated category. The old
        // whole-payload gate would have rejected this universe push.
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, mediaCollections: 2 } },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1' })],
          { source: { via: 'peer-push', peerId: 'peer-a' } },
        );
      });

      it('does NOT reject a series push with NO bundled issues when the sender is ahead on pipelineIssues only', async () => {
        // No issues ride along, so pipelineIssues is not a transferred category.
        await applyIncomingPush({
          kind: 'series',
          record: { id: 's1', name: 'Foo' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, pipelineSeries: 1, pipelineIssues: 3 } },
        });
        expect(mergeSeriesFromSync).toHaveBeenCalled();
        expect(mergeIssuesFromSync).not.toHaveBeenCalled();
      });

      it('DOES reject a series push WITH bundled issues when the sender is ahead on pipelineIssues', async () => {
        // Issues are being transferred, so a pipelineIssues ahead-mismatch must
        // gate the push — otherwise the receiver merges issues it can't parse.
        const rejection = await applyIncomingPush({
          kind: 'series',
          record: { id: 's1', name: 'Foo' },
          issues: [{ id: 'i1', seriesId: 's1', deleted: false, deletedAt: null }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, pipelineSeries: 1, pipelineIssues: 3 } },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'pipelineIssues', senderV: 3, receiverV: 2 }]);
        expect(mergeSeriesFromSync).not.toHaveBeenCalled();
        expect(mergeIssuesFromSync).not.toHaveBeenCalled();
      });

      it('DOES reject a universe push WITH a bundled linkedCollection when the sender is ahead on mediaCollections', async () => {
        // The linked collection is a transferred category, so a mediaCollections
        // ahead-mismatch must gate even though universes is equal.
        const rejection = await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', name: 'Foo' },
          linkedCollection: { id: 'col-1', name: 'Universe: U', items: [] },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, mediaCollections: 2 } },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'mediaCollections', senderV: 2, receiverV: 1 }]);
        expect(mergeUniversesFromSync).not.toHaveBeenCalled();
        expect(mergeMediaCollectionsFromSync).not.toHaveBeenCalled();
      });

      // ---- tombstone-aware per-category scoping --------------------------
      it('does NOT reject a pure tombstone push even when the sender is ahead on that record kind (delete converges)', async () => {
        // A tombstone carries only id+deleted+deletedAt+updatedAt — safe at any
        // schema version. Gating it would strand federated deletes when one peer
        // upgrades ahead. The merge still runs (the delete must land).
        await applyIncomingPush({
          kind: 'universe',
          record: { id: 'u1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 6 } },
        });
        expect(mergeUniversesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'u1', deleted: true })],
          { source: { via: 'peer-push', peerId: 'peer-a' } },
        );
      });

      it('DOES reject a deleted-series push that bundles a LIVE issue when the sender is ahead on pipelineIssues', async () => {
        // deleteSeries does not cascade-tombstone child issues, and the push
        // bundles every child — so a deleted series can carry full-shape LIVE
        // issues. The series tombstone alone is safe, but the live issues are
        // NOT; gate pipelineIssues so they can't corrupt an older receiver.
        const rejection = await applyIncomingPush({
          kind: 'series',
          record: { id: 's1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
          issues: [{ id: 'i1', seriesId: 's1', deleted: false, deletedAt: null }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, pipelineSeries: 1, pipelineIssues: 3 } },
        }).catch((err) => err);
        expect(rejection.code).toBe('PEER_SYNC_SCHEMA_VERSION_AHEAD');
        expect(rejection.details.ahead).toEqual([{ category: 'pipelineIssues', senderV: 3, receiverV: 2 }]);
        expect(mergeSeriesFromSync).not.toHaveBeenCalled();
        expect(mergeIssuesFromSync).not.toHaveBeenCalled();
      });

      it('does NOT reject a deleted-series push whose bundled issues are ALL tombstones (cascade delete converges)', async () => {
        // Series tombstone + issue tombstones only — no live record in any
        // category, so nothing gates and the whole delete cascade converges
        // even though the sender is ahead on both pipelineSeries and pipelineIssues.
        await applyIncomingPush({
          kind: 'series',
          record: { id: 's1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' },
          issues: [{ id: 'i1', seriesId: 's1', deleted: true, deletedAt: '2026-05-22T03:00:00Z' }],
          assetManifest: [],
          sourceInstanceId: 'peer-a',
          portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, pipelineSeries: 9, pipelineIssues: 9 } },
        });
        expect(mergeSeriesFromSync).toHaveBeenCalled();
        expect(mergeIssuesFromSync).toHaveBeenCalledWith(
          [expect.objectContaining({ id: 'i1', deleted: true })],
          { source: { via: 'peer-push', peerId: 'peer-a' } },
        );
      });
    });

    describe('gate-map completeness (fail-open guard)', () => {
      it('every PEER_SUBSCRIBABLE_KIND resolves to a schema-category mapping', () => {
        // A new push kind that writes a versioned layout must be added to
        // RECORD_KIND_SCHEMA_CATEGORIES, or its push would bypass the gate
        // entirely (silent cross-install corruption). `mediaCollection` maps
        // via the same key; series issues are unioned at the call site.
        for (const kind of PEER_SUBSCRIBABLE_KINDS) {
          expect(Array.isArray(RECORD_KIND_SCHEMA_CATEGORIES[kind])).toBe(true);
          expect(RECORD_KIND_SCHEMA_CATEGORIES[kind].length).toBeGreaterThan(0);
        }
      });

      it('every versioned PORTOS_SCHEMA_VERSIONS key is reachable from a record kind', () => {
        // So a newly-versioned category can't ship without being wired into the
        // per-category gate (which would leave its transfers ungated). The only
        // exemptions are categories explicitly declared as non-record (pull-gated
        // elsewhere) via NON_RECORD_SCHEMA_CATEGORIES — e.g. mediaLibrary (#1566).
        const covered = new Set(Object.values(RECORD_KIND_SCHEMA_CATEGORIES).flat());
        for (const key of Object.keys(PORTOS_SCHEMA_VERSIONS)) {
          if (NON_RECORD_SCHEMA_CATEGORIES.has(key)) continue;
          expect(covered.has(key)).toBe(true);
        }
      });

      it('keeps the Tribe graph + universe render-runs intentionally OUT of the sync graph (#1724)', () => {
        // ADR 2026-06-26: tribe_* and universe_runs are deliberately machine-local.
        // - Tribe is relationship-graph data (mirrors the deliberate "memory_links
        //   are instance-local" policy in memorySync.js) and is coupled to
        //   machine-local calendar-account refs on touchpoints.
        // - universe_runs is a regenerable render cache under a 200-row GLOBAL cap
        //   that two producers would mutually evict; the durable universe record
        //   already federates.
        // This guard pins that decision: federating either later is a conscious act
        // — wire the kind AND update this assertion + the ADR together.
        const localOnlyKinds = ['tribe', 'tribePerson', 'tribeTouchpoint', 'tribeMemoryLink', 'universeRun'];
        for (const kind of localOnlyKinds) {
          expect(PEER_SUBSCRIBABLE_KINDS).not.toContain(kind);
          expect(RECORD_KIND_SCHEMA_CATEGORIES[kind]).toBeUndefined();
        }
        const localOnlyCategories = ['tribe', 'tribePeople', 'tribeTouchpoints', 'tribeMemoryLinks', 'universeRuns'];
        for (const category of localOnlyCategories) {
          expect(PORTOS_SCHEMA_VERSIONS[category]).toBeUndefined();
          expect(NON_RECORD_SCHEMA_CATEGORIES.has(category)).toBe(false);
        }
      });
    });

    describe('sender — pushRecordToPeer', () => {
      it('stamps portosMeta on the outbound push payload', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
        await pushRecordToPeer({
          id: 's-meta', peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        });
        const call = vi.mocked(peerFetch).mock.calls.at(-1);
        expect(call).toBeDefined();
        const body = JSON.parse(call[1].body);
        expect(body.portosMeta).toBeDefined();
        expect(body.portosMeta.schemaVersions.universes).toBe(7);
        expect(typeof body.portosMeta.portosVersion).toBe('string');
      });

      it('records a blockedBySchema marker on the subscription when the peer responds 409', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        // Receiver claims it's on universes:4 + PortOS 2.5.0; sender is at 5.
        // `receiverPortosVersion` is the rejecting peer's version — that's
        // the label the sender persists as `peerPortosVersion`.
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({
            error: 'sender schema is ahead',
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: {
                ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
                behind: [],
                senderPortosVersion: '3.0.0',
                receiverPortosVersion: '2.5.0',
                receiverSchemaVersions: { universes: 4 },
              },
            },
          }),
        });
        // Subscribe first so we have a sub record to assert against.
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('peer-schema-behind');
        expect(result.blockedBySchema).toBe(true);
        // Block persisted on the subscription.
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeDefined();
        expect(after.blockedBySchema.ahead).toEqual([{ category: 'universes', senderV: 5, receiverV: 4 }]);
        expect(after.blockedBySchema.peerPortosVersion).toBe('2.5.0');
        expect(typeof after.blockedBySchema.detectedAt).toBe('string');
        // lastPushedHash must NOT have advanced — the record didn't land.
        expect(after.lastPushedHash).toBeFalsy();
      });

      it('short-circuits subsequent pushes for blocked subs within the cooldown window', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        // First push gets the 409.
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: {
                ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }],
                senderPortosVersion: '2.5.0',
              },
            },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const fetchCallsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        // Re-load the sub with the persisted block, then push again with NO
        // bypass — should not hit the network.
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        const result = await pushRecordToPeer(blocked);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('peer-schema-behind-cooldown');
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(fetchCallsAfterFirst);
      });

      it('bypasses the schema cooldown for tombstone pushes so deletes converge immediately', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: {
              details: { ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] },
            },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        vi.mocked(getUniverse).mockResolvedValue({
          id: 'u1',
          name: 'Foo',
          deleted: true,
          deletedAt: '2026-05-23T00:00:00.000Z',
          updatedAt: '2026-05-23T00:00:00.000Z',
        });
        vi.mocked(peerFetch).mockResolvedValueOnce({ ok: true, json: async () => ({ missingAssets: [] }) });

        const result = await pushRecordToPeer(blocked);

        expect(result.pushed).toBe(true);
        const body = JSON.parse(vi.mocked(peerFetch).mock.calls.at(-1)[1].body);
        expect(body.record.deleted).toBe(true);
        expect(body.assetManifest).toEqual([]);
      });

      it('bypassSchemaCooldown=true re-probes regardless of recent block', async () => {
        // Simulates the peer:online path: retryPendingPushesForPeer passes
        // bypassSchemaCooldown so the next probe actually hits the wire even
        // if a recent 409 set the cooldown.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(peerFetch).mockResolvedValue({
          ok: false, status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: { details: { ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] } },
          }),
        });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const callsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        await pushRecordToPeer(blocked, { bypassSchemaCooldown: true });
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(callsAfterFirst + 1);
      });

      it('clears blockedBySchema once a subsequent push succeeds (peer upgraded)', async () => {
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        // First push: 409.
        vi.mocked(peerFetch).mockResolvedValueOnce({
          ok: false, status: 409,
          json: async () => ({
            code: 'PEER_SYNC_SCHEMA_VERSION_AHEAD',
            context: { details: { ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }], senderPortosVersion: '2.5.0' } },
          }),
        });
        // Second push: peer upgraded, accepts.
        vi.mocked(peerFetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        expect((await findPeerSubscription('peer-a', 'universe', 'u1')).blockedBySchema).toBeDefined();
        // Bypass cooldown to simulate a peer:online retry.
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        await pushRecordToPeer(blocked, { bypassSchemaCooldown: true });
        const cleared = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(cleared.blockedBySchema).toBeUndefined();
        expect(cleared.lastPushedHash).toBeTruthy(); // succeeded → hash recorded
      });

      it('falls back without portosMeta when the peer is on a pre-version-gate PortOS (strict schema 400)', async () => {
        // Pre-version-gate receiver: its `peerSyncPushSchema` is `.strict()`
        // and has no `portosMeta` field, so it rejects our envelope as a
        // generic VALIDATION_ERROR before any schema-gate logic. The sender
        // must detect that specific shape, strip portosMeta, and retry —
        // otherwise universe/series pushes to not-yet-upgraded peers fail
        // hard and silently during a federation rollout.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const firstCallBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: '', message: "Unrecognized key(s) in object: 'portosMeta'" }] },
        }) };
        firstCallBody.clone = () => firstCallBody;
        const retryBody = { ok: true, status: 200, json: async () => ({}) };
        vi.mocked(peerFetch)
          .mockResolvedValueOnce(firstCallBody)
          .mockResolvedValueOnce(retryBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(true);
        // Two network calls: the failed validating one + the retry without portosMeta.
        const calls = vi.mocked(peerFetch).mock.calls;
        expect(calls.length).toBe(2);
        const firstPayload = JSON.parse(calls[0][1].body);
        const retryPayload = JSON.parse(calls[1][1].body);
        expect(firstPayload.portosMeta).toBeDefined();
        expect(retryPayload.portosMeta).toBeUndefined();
        // Record content is preserved across the retry.
        expect(retryPayload.record.id).toBe('u1');
        expect(retryPayload.sourceInstanceId).toBe(firstPayload.sourceInstanceId);
      });

      it('falls back without catalogBundle when an older peer rejects the new key, keeping portosMeta', async () => {
        // A peer that supports portosMeta but predates catalog federation
        // rejects the new `catalogBundle` key with a strict VALIDATION_ERROR.
        // The sender must strip ONLY catalogBundle (not portosMeta, which the
        // peer supports) and retry, so the universe push still lands — the
        // receiver re-derives the catalog enrichments from the embedded canon.
        vi.mocked(getBackendName).mockReturnValue('postgres');
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        vi.mocked(getCatalogBundleForRef).mockResolvedValue({
          ingredients: [{ id: 'cat-chr-1', type: 'character', name: 'Hero', updatedAt: '2026-01-02T00:00:00Z' }],
          refs: [{ ingredientId: 'cat-chr-1', refKind: 'universe', refId: 'u1', role: 'canon-character', createdAt: '2026-01-02T00:00:00Z' }],
        });
        const firstCallBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: '', message: "Unrecognized key(s) in object: 'catalogBundle'" }] },
        }) };
        firstCallBody.clone = () => firstCallBody;
        const retryBody = { ok: true, status: 200, json: async () => ({}) };
        vi.mocked(peerFetch).mockResolvedValueOnce(firstCallBody).mockResolvedValueOnce(retryBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(true);
        const calls = vi.mocked(peerFetch).mock.calls;
        expect(calls.length).toBe(2);
        const firstPayload = JSON.parse(calls[0][1].body);
        const retryPayload = JSON.parse(calls[1][1].body);
        expect(firstPayload.catalogBundle).toBeDefined();
        expect(retryPayload.catalogBundle).toBeUndefined();
        // Surgical strip: portosMeta survives because the peer didn't reject it.
        expect(retryPayload.portosMeta).toBeDefined();
        expect(retryPayload.record.id).toBe('u1');
      });

      it('falls back without manuscriptReview when a pre-feature peer rejects the new key, keeping series + issues', async () => {
        // A pre-manuscript-review-sync peer's seriesPushSchema is still
        // `.strict()` without `manuscriptReview`, so it 400-rejects a review-
        // bearing series push. The sender must strip ONLY manuscriptReview and
        // retry so the series + issues still land (the review reaches the peer
        // once it upgrades). This is what makes the review's "degrades
        // gracefully on older peers" contract hold.
        vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
        vi.mocked(listIssues).mockResolvedValue([{ id: 'i1', seriesId: 's1', number: 1 }]);
        vi.mocked(getReview).mockResolvedValue({
          schemaVersion: 1,
          comments: [{ id: 'mrc-1', problem: 'pacing', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
        });
        const firstCallBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: '', message: "Unrecognized key(s) in object: 'manuscriptReview'" }] },
        }) };
        firstCallBody.clone = () => firstCallBody;
        const retryBody = { ok: true, status: 200, json: async () => ({}) };
        vi.mocked(peerFetch).mockResolvedValueOnce(firstCallBody).mockResolvedValueOnce(retryBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'series', recordId: 's1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(true);
        const calls = vi.mocked(peerFetch).mock.calls;
        expect(calls.length).toBe(2);
        const firstPayload = JSON.parse(calls[0][1].body);
        const retryPayload = JSON.parse(calls[1][1].body);
        expect(firstPayload.manuscriptReview).toBeDefined();
        expect(retryPayload.manuscriptReview).toBeUndefined();
        // Surgical strip: portosMeta survives, and the series + issues still land.
        expect(retryPayload.portosMeta).toBeDefined();
        expect(retryPayload.record.id).toBe('s1');
        expect(retryPayload.issues).toHaveLength(1);
        // Hash withheld so the review re-sends once the peer upgrades (the
        // retry landed with the review stripped, so saving the full-payload
        // hash would short-circuit the next push as 'unchanged').
        const refreshed = await findPeerSubscription('peer-a', 'series', 's1');
        expect(refreshed.lastPushedHash).toBeFalsy();
      });

      it('falls back without reverseOutline when a pre-#1348 peer rejects the new key, keeping series + issues', async () => {
        // Same graceful-degradation contract as the manuscriptReview strip above:
        // a pre-#1348 peer's `.strict()` series schema 400-rejects the
        // reverseOutline key, so the sender strips ONLY it and retries, then
        // withholds the hash so the outline re-sends once the peer upgrades.
        vi.mocked(getSeries).mockResolvedValue({ id: 's1', name: 'Series' });
        vi.mocked(listIssues).mockResolvedValue([{ id: 'i1', seriesId: 's1', number: 1 }]);
        vi.mocked(getStoredOutline).mockResolvedValue({
          seriesId: 's1', schemaVersion: 1, status: 'complete', generatedAt: '2026-06-02T00:00:00Z',
          plotlines: [{ id: 'a', label: 'A', kind: 'main', color: '#3b82f6' }],
          scenes: [{ id: 'scene-001', sequence: 0, summary: 'opening', plotlineId: 'a' }],
        });
        const firstCallBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: '', message: "Unrecognized key(s) in object: 'reverseOutline'" }] },
        }) };
        firstCallBody.clone = () => firstCallBody;
        const retryBody = { ok: true, status: 200, json: async () => ({}) };
        vi.mocked(peerFetch).mockResolvedValueOnce(firstCallBody).mockResolvedValueOnce(retryBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'series', recordId: 's1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(true);
        const calls = vi.mocked(peerFetch).mock.calls;
        expect(calls.length).toBe(2);
        const firstPayload = JSON.parse(calls[0][1].body);
        const retryPayload = JSON.parse(calls[1][1].body);
        expect(firstPayload.reverseOutline).toBeDefined();
        expect(retryPayload.reverseOutline).toBeUndefined();
        // Surgical strip: portosMeta + series + issues still land.
        expect(retryPayload.portosMeta).toBeDefined();
        expect(retryPayload.record.id).toBe('s1');
        expect(retryPayload.issues).toHaveLength(1);
        // Hash withheld so the outline re-sends once the peer upgrades.
        const refreshed = await findPeerSubscription('peer-a', 'series', 's1');
        expect(refreshed.lastPushedHash).toBeFalsy();
      });

      it('does NOT retry on a 400 whose validation error is unrelated to portosMeta', async () => {
        // The retry is keyed on the `portosMeta` mention in the validation
        // details — any other 400 (oversized field, unknown record key, etc.)
        // is a genuine bug we want to surface, not silently retry.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'record.name', message: 'String too long' }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValueOnce(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('http-400');
        // Only ONE call — no retry.
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(1);
      });

      it('records a peer-pre-feature blockedBySchema marker when a peer rejects an unknown record kind (400 invalid discriminator)', async () => {
        // A peer on an older PortOS whose `peerSyncPushSchema` discriminated
        // union has no arm for this record kind (authors / mediaCollection when
        // they first landed) rejects the push at Zod with a generic 400 whose
        // offending field is the `kind` discriminator — BEFORE its version gate
        // (the 409 path) ever runs. The sender must NOT treat this as a bare
        // http-400 (which churns silently); it routes the sub into an empty-gap
        // schema-version block so the SchemaGapBadge surfaces "peer needs to
        // update" and the edit-push cooldown engages, exactly like the 409 path.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'kind', message: "Invalid discriminator value. Expected 'universe' | 'series'" }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValueOnce(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.pushed).toBe(false);
        expect(result.reason).toBe('peer-schema-behind');
        expect(result.blockedBySchema).toBe(true);
        // No retry — the kind itself is unrecognized, so re-sending changes nothing.
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(1);
        // Block persisted with the pre-feature marker + an empty gap (the peer
        // 400'd before sending any schemaVersions to populate ahead/behind).
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeDefined();
        expect(after.blockedBySchema.reason).toBe('peer-pre-feature');
        expect(after.blockedBySchema.ahead).toEqual([]);
        expect(after.blockedBySchema.behind).toEqual([]);
        expect(after.blockedBySchema.peerPortosVersion).toBeNull();
        expect(typeof after.blockedBySchema.detectedAt).toBe('string');
        // lastPushedHash must NOT have advanced — the record didn't land.
        expect(after.lastPushedHash).toBeFalsy();
      });

      it('engages the push cooldown after a pre-feature block so the next edit-push short-circuits', async () => {
        // The pre-feature block must behave like the 409 block: a subsequent
        // push (no bypass) short-circuits on the cooldown instead of re-probing
        // the peer on every local edit.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'kind', message: 'Invalid discriminator value. Expected ...' }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValue(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        await pushRecordToPeer(sub);
        const callsAfterFirst = vi.mocked(peerFetch).mock.calls.length;
        const blocked = await findPeerSubscription('peer-a', 'universe', 'u1');
        const result = await pushRecordToPeer(blocked);
        expect(result.reason).toBe('peer-schema-behind-cooldown');
        expect(vi.mocked(peerFetch).mock.calls.length).toBe(callsAfterFirst);
      });

      it('does NOT misclassify a non-discriminator field 400 as a pre-feature block', async () => {
        // Guard: only a `kind`-path discriminator/enum error is the unknown-kind
        // signal. A 400 on any other field (oversized record, etc.) stays a
        // genuine http-400 — not a silently-swallowed schema block.
        vi.mocked(getUniverse).mockResolvedValue({ id: 'u1', name: 'Foo' });
        const errBody = { ok: false, status: 400, json: async () => ({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          context: { details: [{ path: 'record.name', message: 'String too long' }] },
        }) };
        errBody.clone = () => errBody;
        vi.mocked(peerFetch).mockResolvedValueOnce(errBody);
        const sub = await subscribePeer({
          peerId: 'peer-a', recordKind: 'universe', recordId: 'u1',
        }, { adoptedFromReverse: true });
        const result = await pushRecordToPeer(sub);
        expect(result.reason).toBe('http-400');
        const after = await findPeerSubscription('peer-a', 'universe', 'u1');
        expect(after.blockedBySchema).toBeUndefined();
      });
    });
  });

  // -------------------------------------------------------------------------
  // mediaCollection push + receiver
  // -------------------------------------------------------------------------
  describe('collectCollectionAssetReferences', () => {
    it('maps items to image/video refs with an empty directImageRefFilenames', () => {
      const refs = collectCollectionAssetReferences({ items: [
        { kind: 'image', ref: 'a.png' },
        { kind: 'video', ref: 'vid123' },
        { kind: 'image', ref: 'b.png' },
      ] });
      expect(refs.directImageFilenames).toEqual(['a.png', 'b.png']);
      expect(refs.directVideoFilenames).toEqual(['vid123']);
      expect(refs.directImageRefFilenames).toEqual([]);
    });

    it('returns empty arrays for a collection with no items', () => {
      const refs = collectCollectionAssetReferences({ items: [] });
      expect(refs.directImageFilenames).toEqual([]);
      expect(refs.directVideoFilenames).toEqual([]);
      expect(refs.directImageRefFilenames).toEqual([]);
    });

    it('returns empty arrays for null/undefined input', () => {
      expect(collectCollectionAssetReferences(null).directImageFilenames).toEqual([]);
      expect(collectCollectionAssetReferences(undefined).directImageFilenames).toEqual([]);
    });
  });

  describe('applyIncomingPush — mediaCollection', () => {
    it('applies an incoming mediaCollection push into local collections', async () => {
      // Use the real mergeMediaCollectionsFromSync via importActual so the
      // write lands in the tmpdir and listCollections can confirm persistence.
      const real = await vi.importActual('../mediaCollections.js');
      vi.mocked(mergeMediaCollectionsFromSync).mockImplementationOnce(real.mergeMediaCollectionsFromSync);
      vi.mocked(listCollections).mockImplementationOnce(real.listCollections);

      await applyIncomingPush({
        kind: 'mediaCollection',
        record: { id: 'col-x', name: 'Synced', items: [], updatedAt: '2026-05-23T00:00:00.000Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-abc',
      });

      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'col-x', name: 'Synced' })],
        { source: { via: 'peer-push', peerId: 'peer-abc' } },
      );

      // Confirm the record landed on disk via the real listCollections.
      const all = await real.listCollections();
      const found = all.find((c) => c.id === 'col-x');
      expect(found).toBeDefined();
      expect(found.name).toBe('Synced');
    });

    it('routes a mediaCollection push through mergeMediaCollectionsFromSync (mock assertion)', async () => {
      await applyIncomingPush({
        kind: 'mediaCollection',
        record: { id: 'col-y', name: 'Test', items: [], updatedAt: '2026-05-23T00:00:00.000Z' },
        assetManifest: [],
        sourceInstanceId: 'peer-abc',
      });
      expect(mergeMediaCollectionsFromSync).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'col-y' })],
        { source: { via: 'peer-push', peerId: 'peer-abc' } },
      );
    });

    it('auto-creates a reverse subscription back to the sender for a syncable local collection', async () => {
      // Regression (Bug 1): classifyLocalRecord had no mediaCollection branch,
      // so it returned 'missing' and maybeCreateReverseSubscription's
      // `localState !== 'syncable'` guard never bootstrapped bidirectional
      // collection sync. The merge landed the record locally, so the
      // classifyLocalRecord lookup must resolve it as 'syncable'.
      vi.mocked(getCollection).mockResolvedValue({
        id: 'col-rev', name: 'Synced', items: [], updatedAt: '2026-05-23T00:00:00.000Z',
        deleted: false, deletedAt: null,
      });
      const result = await applyIncomingPush({
        kind: 'mediaCollection',
        record: { id: 'col-rev', name: 'Synced', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.reverseSubscriptionCreated).toBe(true);
      const sub = await findPeerSubscription('peer-a', 'mediaCollection', 'col-rev');
      expect(sub).not.toBeNull();
      expect(sub.adoptedFromReverse).toBe(true);
    });

    it('does NOT create a reverse subscription when the local collection is missing (merge dropped it)', async () => {
      // The default getCollection mock rejects (NOT_FOUND) → classifyLocalRecord
      // returns 'missing' → no orphan reverse-sub.
      const result = await applyIncomingPush({
        kind: 'mediaCollection',
        record: { id: 'col-gone', name: 'Gone', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-a',
      });
      expect(result.reverseSubscriptionCreated).toBe(false);
      const sub = await findPeerSubscription('peer-a', 'mediaCollection', 'col-gone');
      expect(sub).toBeNull();
    });
  });

  describe('peerSyncPushSchema — mediaCollection validation', () => {
    it('accepts a valid mediaCollection push payload', async () => {
      const { peerSyncPushSchema } = await import('../../lib/validation.js');
      expect(() => peerSyncPushSchema.parse({
        kind: 'mediaCollection',
        record: { id: 'col-x', name: 'My Collection', items: [] },
        assetManifest: [],
        sourceInstanceId: 'peer-abc',
      })).not.toThrow();
    });

    it('rejects a mediaCollection push payload missing sourceInstanceId', async () => {
      const { peerSyncPushSchema } = await import('../../lib/validation.js');
      expect(() => peerSyncPushSchema.parse({
        kind: 'mediaCollection',
        record: { id: 'col-x' },
        assetManifest: [],
      })).toThrow();
    });

    it('accepts music push payloads and music asset manifests', async () => {
      const { peerSyncPushSchema } = await import('../../lib/validation.js');
      for (const kind of ['artist', 'album', 'track']) {
        expect(() => peerSyncPushSchema.parse({
          kind,
          record: { id: `${kind}-1` },
          assetManifest: [{ filename: 'song.mp3', kind: 'music', sha256: 'a'.repeat(64) }],
          sourceInstanceId: 'peer-abc',
        })).not.toThrow();
      }
    });
  });
});

describe('media-library federation (#1566)', () => {
  let origAudio;
  let origVideos;

  beforeEach(async () => {
    // The suite beforeEach redirects PATHS.data/images/music to `tmp` and
    // restores videos in its afterEach; redirect videos + audio (not created
    // there) into the same per-test tmpdir so manifest builds see ONLY fixtures.
    origAudio = PATHS.audio;
    origVideos = PATHS.videos;
    PATHS.videos = join(tmp, 'videos');
    PATHS.audio = join(tmp, 'audio');
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.audio, { recursive: true });
    vi.mocked(reconcileMediaAssets).mockClear();
  });

  afterEach(() => {
    PATHS.audio = origAudio;
    PATHS.videos = origVideos;
  });

  describe('libraryKindsExcludedByPatterns (honors backup excludes)', () => {
    it('flags a kind whose whole dir is excluded — anchored, trailing-slash, and glob forms', () => {
      expect([...libraryKindsExcludedByPatterns(['/music/'])]).toEqual(['music']);
      expect([...libraryKindsExcludedByPatterns(['/videos/**'])]).toEqual(['video']);
      expect([...libraryKindsExcludedByPatterns(['images'])]).toEqual(['image']);
      expect([...libraryKindsExcludedByPatterns(['/audio'])]).toEqual(['audio']);
    });

    it('ignores excludes that do not name a whole media dir', () => {
      expect(libraryKindsExcludedByPatterns(['/loras/*.safetensors', '/repos/']).size).toBe(0);
      expect(libraryKindsExcludedByPatterns([]).size).toBe(0);
      expect(libraryKindsExcludedByPatterns(undefined).size).toBe(0);
    });
  });

  describe('buildMediaLibraryManifest', () => {
    it('walks all media dirs, hashes files, skips image sidecars, and is deterministic', async () => {
      await writeFile(join(PATHS.images, 'a.png'), 'img-a');
      await writeFile(join(PATHS.images, 'a.png.metadata.json'), JSON.stringify({ prompt: 'x' }));
      await writeFile(join(PATHS.videos, 'v.mp4'), 'vid');
      await writeFile(join(PATHS.audio, 's.wav'), 'aud');
      await writeFile(join(PATHS.music, 'm.mp3'), 'mus');

      const m1 = await buildMediaLibraryManifest();
      const kinds = m1.assets.map((e) => `${e.kind}:${e.filename}`).sort();
      expect(kinds).toEqual(['audio:s.wav', 'image:a.png', 'music:m.mp3', 'video:v.mp4']);
      // sidecar json is metadata, not advertised as its own asset
      expect(m1.assets.find((e) => e.filename.endsWith('.json'))).toBeUndefined();
      // every entry carries a 64-hex sha256
      expect(m1.assets.every((e) => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(true);
      expect(m1.schemaVersion).toBe(PORTOS_SCHEMA_VERSIONS.mediaLibrary);
      expect(/^[a-f0-9]{64}$/.test(m1.manifestHash)).toBe(true);
      // deterministic hash across rebuilds of the same library
      const m2 = await buildMediaLibraryManifest();
      expect(m2.manifestHash).toBe(m1.manifestHash);
    });

    it('changes manifestHash when the library changes', async () => {
      await writeFile(join(PATHS.audio, 's.wav'), 'aud');
      const before = (await buildMediaLibraryManifest()).manifestHash;
      await writeFile(join(PATHS.audio, 't.wav'), 'aud2');
      const after = (await buildMediaLibraryManifest()).manifestHash;
      expect(after).not.toBe(before);
    });

    it('returns an empty manifest when the library is empty', async () => {
      const m = await buildMediaLibraryManifest();
      expect(m.assets).toEqual([]);
    });

    it('re-hash cache invalidates when a flat asset changes in place (size differs)', async () => {
      const p = join(PATHS.audio, 's.wav');
      await writeFile(p, 'short');
      const first = (await buildMediaLibraryManifest()).assets.find((e) => e.filename === 's.wav').sha256;
      // Overwrite with different-length content → (mtime,size) cache key changes.
      await writeFile(p, 'a much longer payload than before');
      const second = (await buildMediaLibraryManifest()).assets.find((e) => e.filename === 's.wav').sha256;
      expect(second).not.toBe(first);
    });
  });

  describe('syncMediaLibraryFromPeer', () => {
    const mkPeer = (id, extra = {}) => ({
      instanceId: id, name: id, host: null, address: '10.0.0.9', port: 5555,
      enabled: true, fullSync: true, ...extra,
    });

    it('no-ops for a non-full-sync peer and never hits the network', async () => {
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-nofs', { fullSync: false }));
      expect(res.skipped).toBe('not-fullsync');
      expect(peerFetch).not.toHaveBeenCalled();
    });

    it('gently skips a peer whose manifest schema is ahead of local (no pull, no reconcile)', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary + 1,
        manifestHash: 'a'.repeat(64), assets: [],
      }) });
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-ahead'));
      expect(res.skipped).toBe('schema-ahead');
      expect(reconcileMediaAssets).not.toHaveBeenCalled();
    });

    it('skips an unreachable peer and an invalid manifest', async () => {
      vi.mocked(peerFetch).mockResolvedValue({ ok: false });
      expect((await syncMediaLibraryFromPeer(mkPeer('fs-down'))).skipped).toBe('unreachable');
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({ bogus: true }) });
      expect((await syncMediaLibraryFromPeer(mkPeer('fs-bad'))).skipped).toBe('invalid');
    });

    it('pulls nothing when assets already exist locally, then short-circuits on unchanged hash', async () => {
      // The peer's manifest == our OWN library (write files, build manifest, feed
      // it back) so diffAssetManifestAgainstLocal finds everything present.
      await writeFile(join(PATHS.audio, 's.wav'), 'aud');
      await writeFile(join(PATHS.images, 'a.png'), 'img');
      const localManifest = await buildMediaLibraryManifest();
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => localManifest });

      const peer = mkPeer('fs-present');
      const res1 = await syncMediaLibraryFromPeer(peer);
      expect(res1.pulled).toBe(0);
      expect(res1.skipped).toBeUndefined();
      expect(reconcileMediaAssets).not.toHaveBeenCalled(); // nothing pulled → no reconcile

      const res2 = await syncMediaLibraryFromPeer(peer);
      expect(res2.skipped).toBe('unchanged');
    });

    it('does NOT record the manifestHash when a byte pull fails — the next tick retries', async () => {
      const peer = mkPeer('fs-diverge');
      // pullMissingAssetsFromPeer re-resolves the peer via getPeers — include it.
      vi.mocked(getPeers).mockResolvedValue([peer]);
      const manifest = {
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
        manifestHash: 'b'.repeat(64),
        assets: [{ filename: 'remote.wav', kind: 'audio', sha256: 'c'.repeat(64) }],
      };
      vi.mocked(peerFetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/library-manifest')) return { ok: true, json: async () => manifest };
        return { ok: false }; // byte pull fails → nothing lands on disk
      });
      const res = await syncMediaLibraryFromPeer(peer);
      // The asset URL was requested...
      const urls = vi.mocked(peerFetch).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/data/audio/remote.wav'))).toBe(true);
      // ...but nothing landed (re-diff still sees it missing), so pulled=0,
      // no reconcile, and the hash is NOT recorded.
      expect(res.pulled).toBe(0);
      expect(res.missing).toBe(1);
      expect(reconcileMediaAssets).not.toHaveBeenCalled();
      // Second call must re-diff (NOT short-circuit on an 'unchanged' hash).
      const res2 = await syncMediaLibraryFromPeer(peer);
      expect(res2.skipped).not.toBe('unchanged');
    });

    it('skips a manifest whose Content-Length exceeds the cap (unbounded-body guard for HTTP peers)', async () => {
      vi.mocked(peerFetch).mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }), // > 32MB cap
        json: async () => ({ schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash: 'a'.repeat(64), assets: [] }),
      });
      const res = await syncMediaLibraryFromPeer(mkPeer('fs-huge'));
      expect(res.skipped).toBe('too-large');
    });

    it('forces a re-diff after repeated unchanged ticks so a local file loss self-heals', async () => {
      const peer = mkPeer('fs-selfheal');
      vi.mocked(getPeers).mockResolvedValue([peer]);
      const bytes = Buffer.from('heal-bytes');
      const manifest = {
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
        manifestHash: 'f0'.repeat(32),
        assets: [{ filename: 'heal.wav', kind: 'audio' }], // existence-only diff
      };
      vi.mocked(peerFetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/library-manifest')) return { ok: true, json: async () => manifest };
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(bytes.length) }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      });
      // First sweep lands the file and records the manifestHash.
      expect((await syncMediaLibraryFromPeer(peer)).pulled).toBe(1);
      // Simulate local loss after the hash was recorded.
      await rm(join(PATHS.audio, 'heal.wav'), { force: true });
      // Unchanged ticks short-circuit until the periodic forced re-diff fires and
      // re-pulls the lost file (proves self-heal without a restart).
      let healed = false;
      for (let i = 0; i < 12; i++) {
        const r = await syncMediaLibraryFromPeer(peer);
        if (r.skipped !== 'unchanged') { healed = true; break; }
      }
      expect(healed).toBe(true);
    });

    it('records the manifestHash + reconciles once missing bytes actually land', async () => {
      const peer = mkPeer('fs-success');
      vi.mocked(getPeers).mockResolvedValue([peer]);
      // No sha256 on the entry → diff is existence-only, so once the byte pull
      // writes the file the re-diff sees it present (no hash to mismatch).
      const manifest = {
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
        manifestHash: 'e'.repeat(64),
        assets: [{ filename: 'land.wav', kind: 'audio' }],
      };
      const bytes = Buffer.from('audio-bytes-that-landed');
      vi.mocked(peerFetch).mockImplementation(async (url) => {
        if (String(url).endsWith('/library-manifest')) return { ok: true, json: async () => manifest };
        // Asset byte fetch — a Response-like the cap-checker accepts.
        return {
          ok: true,
          headers: new Headers({ 'content-length': String(bytes.length) }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      });
      const res1 = await syncMediaLibraryFromPeer(peer);
      expect(res1.pulled).toBe(1);
      expect(res1.missing).toBe(0);
      expect(reconcileMediaAssets).toHaveBeenCalled();
      // Hash recorded → second call short-circuits as unchanged.
      const res2 = await syncMediaLibraryFromPeer(peer);
      expect(res2.skipped).toBe('unchanged');
    });
  });

  describe('syncMediaLibraryWithAllPeers', () => {
    it('sweeps only full-sync, enabled peers that have an instanceId', async () => {
      vi.mocked(getPeers).mockResolvedValue([
        { instanceId: 'fs1', address: '10.0.0.4', port: 5555, enabled: true, fullSync: true },
        { instanceId: 'partial', address: '10.0.0.5', port: 5555, enabled: true, fullSync: false },
        { instanceId: 'disabled', address: '10.0.0.6', port: 5555, enabled: false, fullSync: true },
        { instanceId: null, address: '10.0.0.7', port: 5555, enabled: true, fullSync: true },
      ]);
      vi.mocked(peerFetch).mockResolvedValue({ ok: true, json: async () => ({
        schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash: 'd'.repeat(64), assets: [],
      }) });
      await syncMediaLibraryWithAllPeers();
      const manifestUrls = vi.mocked(peerFetch).mock.calls
        .map((c) => String(c[0])).filter((u) => u.endsWith('/library-manifest'));
      expect(manifestUrls).toHaveLength(1);
      expect(manifestUrls[0]).toContain('10.0.0.4');
    });
  });
});
