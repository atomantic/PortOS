import { describe, it, expect, vi, beforeEach } from 'vitest';

// All downstream surfaces are mocked so we can drive the math without
// touching real state files. The point of these tests is the cutoff policy
// (grace + min-ack), not the pure-mechanical prune helpers — those are
// covered by their own service tests.
vi.mock('../universeBuilder.js', () => ({
  pruneTombstonedUniverses: vi.fn().mockResolvedValue({ pruned: 0 }),
  listUniverses: vi.fn().mockResolvedValue([]),
}));
vi.mock('../pipeline/series.js', () => ({
  pruneTombstonedSeries: vi.fn().mockResolvedValue({ pruned: 0 }),
  listSeries: vi.fn().mockResolvedValue([]),
}));
vi.mock('../pipeline/issues.js', () => ({
  pruneTombstonedIssues: vi.fn().mockResolvedValue({ pruned: 0 }),
  listIssueIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mediaCollections.js', () => ({
  pruneTombstonedCollections: vi.fn().mockResolvedValue({ pruned: 0 }),
  listCollections: vi.fn().mockResolvedValue([]),
}));
vi.mock('../authors/index.js', () => ({
  pruneTombstonedAuthors: vi.fn().mockResolvedValue({ pruned: 0 }),
  listAuthorIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../artists/index.js', () => ({
  pruneTombstonedArtists: vi.fn().mockResolvedValue({ pruned: 0 }),
  listArtistIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../albums/index.js', () => ({
  pruneTombstonedAlbums: vi.fn().mockResolvedValue({ pruned: 0 }),
  listAlbumIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../tracks/index.js', () => ({
  pruneTombstonedTracks: vi.fn().mockResolvedValue({ pruned: 0 }),
  listTrackIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../creativeDirector/local.js', () => ({
  pruneTombstonedProjects: vi.fn().mockResolvedValue({ pruned: 0 }),
  listProjectIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../musicVideo/projects.js', () => ({
  pruneTombstonedProjects: vi.fn().mockResolvedValue({ pruned: 0 }),
  listProjectIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../moodBoard/index.js', () => ({
  pruneTombstonedBoards: vi.fn().mockResolvedValue({ pruned: 0 }),
  listBoardIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../writersRoom/sync.js', () => ({
  pruneTombstonedWorks: vi.fn().mockResolvedValue({ pruned: 0 }),
  listWorkIdsForSync: vi.fn().mockResolvedValue([]),
  pruneTombstonedFolders: vi.fn().mockResolvedValue({ pruned: 0 }),
  listFolderIdsForSync: vi.fn().mockResolvedValue([]),
  pruneTombstonedExercises: vi.fn().mockResolvedValue({ pruned: 0 }),
  listExerciseIdsForSync: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/conflictJournal.js', () => ({
  pruneOrphanedBaseHashes: vi.fn().mockResolvedValue({ pruned: 0 }),
}));
vi.mock('./peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
  pruneOrphanedPeerSubscriptions: vi.fn().mockResolvedValue({ pruned: 0, removed: [] }),
}));
vi.mock('./peerTombstoneCursors.js', () => ({
  getMinAckAcrossPeers: vi.fn(),
}));
vi.mock('../instances.js', () => ({
  getPeers: vi.fn(),
}));

import {
  sweepTombstones,
  getSweepStatus,
  TOMBSTONE_GRACE_MS,
} from './tombstoneGc.js';
import { pruneTombstonedUniverses, listUniverses } from '../universeBuilder.js';
import { pruneTombstonedSeries, listSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues, listIssueIds } from '../pipeline/issues.js';
import { pruneTombstonedCollections, listCollections } from '../mediaCollections.js';
import { pruneTombstonedAuthors, listAuthorIds } from '../authors/index.js';
import { pruneTombstonedArtists, listArtistIds } from '../artists/index.js';
import { pruneTombstonedAlbums, listAlbumIds } from '../albums/index.js';
import { pruneTombstonedTracks, listTrackIds } from '../tracks/index.js';
import { pruneTombstonedProjects } from '../creativeDirector/local.js';
import { pruneTombstonedProjects as pruneTombstonedMusicVideoProjects } from '../musicVideo/projects.js';
import { pruneTombstonedBoards } from '../moodBoard/index.js';
import { pruneTombstonedWorks, pruneTombstonedFolders, pruneTombstonedExercises } from '../writersRoom/sync.js';
import { pruneOrphanedBaseHashes } from '../../lib/conflictJournal.js';
import { listPeerSubscriptions, pruneOrphanedPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';
import { getPeers } from '../instances.js';

const NOW = 1_700_000_000_000; // arbitrary epoch ms anchor

// Helper: tombstoneGc now reads subscriptions ONCE per sweep without a
// per-kind filter, so tests should hand the full sub list with each row
// carrying its own `recordKind` tag. The previous per-kind mock shape
// (`mockImplementation(({ recordKind }) => ...)`) is replaced by this.
//
// `lastConfirmedPushedAt` defaults to NOW so the per-record clamp
// (minConfirmedPushedAtForKind) is a no-op for the per-peer-ack policy tests —
// they model "pushes are landing, only the tombstone ACK cursor lags." Tests
// that exercise the per-record clamp (a record whose push never confirmed)
// override it per row with a lower value (or `null`).
const mockSubs = (subsByKind) => {
  const rows = [];
  for (const [recordKind, peers] of Object.entries(subsByKind)) {
    for (const p of peers) {
      rows.push({
        lastConfirmedPushedAt: NOW,
        ...p,
        recordKind,
      });
    }
  }
  listPeerSubscriptions.mockResolvedValue(rows);
};

beforeEach(() => {
  vi.clearAllMocks();
  listPeerSubscriptions.mockResolvedValue([]);
  pruneOrphanedPeerSubscriptions.mockResolvedValue({ pruned: 0, removed: [] });
  getMinAckAcrossPeers.mockResolvedValue(Infinity);
  getPeers.mockResolvedValue([]);
});

describe('TOMBSTONE_GRACE_MS', () => {
  it('is 24 hours so an off-by-a-magnitude regression fails the test (not silently in prod)', () => {
    expect(TOMBSTONE_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('sweepTombstones — no peers subscribed', () => {
  it('uses now-GRACE as the cutoff for all kinds when nobody is subscribed', async () => {
    await sweepTombstones({ now: NOW });
    const expectedCutoff = NOW - TOMBSTONE_GRACE_MS + 1;
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedCollections).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedAuthors).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedArtists).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedAlbums).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedTracks).toHaveBeenCalledWith(expectedCutoff);
  });
});

describe('sweepTombstones — full-sync peer resurrection guard', () => {
  it('a full-sync peer with an empty category map still blocks snapshot-kind pruning', async () => {
    // A full-sync peer mirrors every category regardless of its stored
    // syncCategories map. If it weren't counted in the snapshot-resurrection
    // set, pruning would drop a tombstone the peer hasn't seen and its next
    // snapshot push would resurrect the record. So with no per-record sub, a
    // full-sync peer must hold the line for every snapshot-backed kind.
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncEnabled: true, fullSync: true, syncCategories: {} },
    ]);
    mockSubs({}); // no per-record subscriptions → only the snapshot gate can block
    const res = await sweepTombstones({ now: NOW });
    expect(res.refused).toEqual(expect.arrayContaining(['universe', 'series', 'issue', 'mediaCollection']));
  });
});

describe('sweepTombstones — orphaned base-hash sweep', () => {
  it('runs the orphan sweep and surfaces its count, regardless of refusals', async () => {
    // A snapshot-mode peer with no per-record sub refuses every tombstone kind
    // (cutoff null) — but the orphan sweep is NOT gated on coverage, so it must
    // still run.
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncEnabled: true, syncCategories: { universe: true, pipeline: true, mediaCollections: true } },
    ]);
    mockSubs({}); // no per-record subscriptions → all kinds refused
    pruneOrphanedBaseHashes.mockResolvedValueOnce({ pruned: 3 });

    const res = await sweepTombstones({ now: NOW });
    expect(pruneOrphanedBaseHashes).toHaveBeenCalledTimes(1);
    // The resolver passed in is the kind-aware predicate (a function).
    expect(typeof pruneOrphanedBaseHashes.mock.calls[0][0]).toBe('function');
    expect(res.orphanBaseHashes).toBe(3);
    // Tombstone prunes were refused, but the orphan sweep still reported.
    expect(res.refused).toEqual(expect.arrayContaining(['universe', 'series', 'issue', 'mediaCollection']));
  });

  it('reports orphanBaseHashes:0 when nothing is orphaned', async () => {
    const res = await sweepTombstones({ now: NOW });
    expect(res.orphanBaseHashes).toBe(0);
  });

  it('passes a resolver that keeps live records, drops dead ones, keeps unknown kinds, and lists each kind once', async () => {
    listUniverses.mockResolvedValue([{ id: 'u-live' }]);
    listSeries.mockResolvedValue([{ id: 's-live' }]);
    listIssueIds.mockResolvedValue(['i-live']); // already ids, uncapped
    listCollections.mockResolvedValue([{ id: 'c-live' }]);
    listAuthorIds.mockResolvedValue(['auth-live']);
    listArtistIds.mockResolvedValue(['artist-live']);
    listAlbumIds.mockResolvedValue(['album-live']);
    listTrackIds.mockResolvedValue(['track-live']);
    // Capture the resolver the sweep hands to pruneOrphanedBaseHashes and drive
    // it directly — this is the real makeBaseHashKeyResolver closure.
    let resolver;
    pruneOrphanedBaseHashes.mockImplementationOnce(async (fn) => { resolver = fn; return { pruned: 0 }; });
    await sweepTombstones({ now: NOW });

    expect(await resolver('universe', 'u-live')).toBe(true);
    expect(await resolver('universe', 'u-gone')).toBe(false);
    expect(await resolver('series', 's-live')).toBe(true);
    expect(await resolver('series', 's-gone')).toBe(false);
    expect(await resolver('issue', 'i-live')).toBe(true);
    expect(await resolver('issue', 'i-gone')).toBe(false);
    expect(await resolver('mediaCollection', 'c-live')).toBe(true);
    expect(await resolver('mediaCollection', 'c-gone')).toBe(false);
    expect(await resolver('author', 'auth-live')).toBe(true);
    expect(await resolver('author', 'auth-gone')).toBe(false);
    expect(await resolver('artist', 'artist-live')).toBe(true);
    expect(await resolver('artist', 'artist-gone')).toBe(false);
    expect(await resolver('album', 'album-live')).toBe(true);
    expect(await resolver('album', 'album-gone')).toBe(false);
    expect(await resolver('track', 'track-live')).toBe(true);
    expect(await resolver('track', 'track-gone')).toBe(false);
    // Unknown kind is always kept and never triggers a listing.
    expect(await resolver('brain', 'whatever')).toBe(true);
    // A second probe of an already-listed kind reuses the cached id-set —
    // listUniverses is called exactly once across both universe probes.
    expect(listUniverses).toHaveBeenCalledTimes(1);
    expect(listSeries).toHaveBeenCalledTimes(1);
    expect(listIssueIds).toHaveBeenCalledTimes(1);
    expect(listCollections).toHaveBeenCalledTimes(1);
    expect(listAuthorIds).toHaveBeenCalledTimes(1);
    expect(listArtistIds).toHaveBeenCalledTimes(1);
    expect(listAlbumIds).toHaveBeenCalledTimes(1);
    expect(listTrackIds).toHaveBeenCalledTimes(1);
  });
});

describe('sweepTombstones — orphaned peer-subscription sweep', () => {
  it('runs the orphan-subscription sweep AFTER the base-hash sweep and surfaces its count', async () => {
    pruneOrphanedPeerSubscriptions.mockResolvedValueOnce({ pruned: 2, removed: ['peer-universe-u-gone-a', 'peer-series-s-gone-b'] });
    const res = await sweepTombstones({ now: NOW });
    expect(pruneOrphanedPeerSubscriptions).toHaveBeenCalledTimes(1);
    // A function resolver is handed in (the kind-aware include-tombstones predicate).
    expect(typeof pruneOrphanedPeerSubscriptions.mock.calls[0][0]).toBe('function');
    expect(res.orphanSubscriptions).toBe(2);
    // Ordering: the base-hash sweep must run before the subscription sweep so a
    // record hard-deleted in this same sweep is gone for both resolvers.
    expect(pruneOrphanedBaseHashes.mock.invocationCallOrder[0])
      .toBeLessThan(pruneOrphanedPeerSubscriptions.mock.invocationCallOrder[0]);
  });

  it('runs the orphan-subscription sweep regardless of refusals (orphans aren’t gated on snapshot coverage)', async () => {
    // Snapshot-mode peer with no per-record sub refuses every tombstone kind,
    // but a subscription whose record is gone is still safe to strip.
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncEnabled: true, syncCategories: { universe: true, pipeline: true, mediaCollections: true } },
    ]);
    listPeerSubscriptions.mockResolvedValue([]);
    pruneOrphanedPeerSubscriptions.mockResolvedValueOnce({ pruned: 1, removed: ['x'] });
    const res = await sweepTombstones({ now: NOW });
    expect(pruneOrphanedPeerSubscriptions).toHaveBeenCalledTimes(1);
    expect(res.orphanSubscriptions).toBe(1);
    expect(res.refused).toEqual(expect.arrayContaining(['universe', 'series', 'issue', 'mediaCollection']));
  });

  it('reports orphanSubscriptions:0 when nothing is orphaned', async () => {
    const res = await sweepTombstones({ now: NOW });
    expect(res.orphanSubscriptions).toBe(0);
  });

  it('passes a tombstone-inclusive resolver: keeps live + tombstoned records, drops dir-gone ones, keeps unknown kinds, lists once', async () => {
    // includeDeleted:true listers — a tombstoned record (u-tomb) is STILL in the
    // list, so its sub must survive (it pushes the delete to peers). Only a
    // record whose dir is truly gone (u-gone) resolves false.
    listUniverses.mockResolvedValue([{ id: 'u-live' }, { id: 'u-tomb', deleted: true }]);
    listSeries.mockResolvedValue([{ id: 's-live' }]);
    listCollections.mockResolvedValue([{ id: 'c-live' }]);
    listAuthorIds.mockResolvedValue(['auth-live']);
    listArtistIds.mockResolvedValue(['artist-live']);
    listAlbumIds.mockResolvedValue(['album-live']);
    listTrackIds.mockResolvedValue(['track-live']);
    let resolver;
    pruneOrphanedPeerSubscriptions.mockImplementationOnce(async (fn) => { resolver = fn; return { pruned: 0, removed: [] }; });
    await sweepTombstones({ now: NOW });

    expect(await resolver('universe', 'u-live')).toBe(true);
    expect(await resolver('universe', 'u-tomb')).toBe(true); // tombstoned → kept
    expect(await resolver('universe', 'u-gone')).toBe(false); // dir gone → orphan
    expect(await resolver('series', 's-live')).toBe(true);
    expect(await resolver('series', 's-gone')).toBe(false);
    expect(await resolver('mediaCollection', 'c-live')).toBe(true);
    expect(await resolver('mediaCollection', 'c-gone')).toBe(false);
    expect(await resolver('author', 'auth-live')).toBe(true);
    expect(await resolver('author', 'auth-gone')).toBe(false);
    expect(await resolver('artist', 'artist-live')).toBe(true);
    expect(await resolver('artist', 'artist-gone')).toBe(false);
    expect(await resolver('album', 'album-live')).toBe(true);
    expect(await resolver('album', 'album-gone')).toBe(false);
    expect(await resolver('track', 'track-live')).toBe(true);
    expect(await resolver('track', 'track-gone')).toBe(false);
    // Unknown kind (issues are never directly subscribed) is always kept and
    // never triggers a listing.
    expect(await resolver('issue', 'i-whatever')).toBe(true);
    expect(await resolver('brain', 'whatever')).toBe(true);
    // The resolver lists with includeDeleted so tombstones are visible.
    expect(listUniverses).toHaveBeenCalledWith({ includeDeleted: true });
    // Cached id-set — a second universe probe reuses the listing.
    expect(listUniverses).toHaveBeenCalledTimes(1);
  });
});

describe('sweepTombstones — peers behind', () => {
  it("clamps the universe cutoff to the laggiest universe-subscribed peer (can't prune past min-ack)", async () => {
    // Regression: if we used `now - GRACE` even when peers are subscribed,
    // we'd prune tombstones the laggiest peer hasn't seen yet — and a
    // subsequent push from that peer would resurrect the record under its
    // older `updatedAt`.
    const minAck = NOW - 48 * 60 * 60 * 1000; // 48h behind now
    mockSubs({ universe: [{ peerId: 'peer-a' }] });
    // peerIdsSubscribedToKind now filters against live peers (removed-peer
    // subscriptions otherwise stall GC forever). Register peer-a so the
    // sub passes the registry filter.
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockImplementation(async (peerIds) => {
      if (peerIds.includes('peer-a')) return minAck;
      return Infinity;
    });
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(minAck - TOMBSTONE_GRACE_MS + 1);
    // series + issues still use now-GRACE since no series subs exist.
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
  });

  it('uses the same cutoff for issues as for series (issue tombstones ride series pushes)', async () => {
    // Regression: if issue cutoff used issues' own subscription cohort,
    // it would always be `now - GRACE` (issues are never directly
    // subscribable) — but issues need to wait for series-subscribed peers
    // to ack their parent series's push.
    const seriesAck = NOW - 72 * 60 * 60 * 1000;
    mockSubs({ series: [{ peerId: 'peer-a' }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockImplementation(async (peerIds) => {
      if (peerIds.includes('peer-a')) return seriesAck;
      return Infinity;
    });
    await sweepTombstones({ now: NOW });
    const seriesCutoff = seriesAck - TOMBSTONE_GRACE_MS + 1;
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(seriesCutoff);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(seriesCutoff);
  });

  it('does NOT clamp past `now` when peers are ahead of wall-clock (defensive)', async () => {
    // Regression: a peer's lastAckedDeleteAt should never legitimately
    // exceed now (it's an ack of OUR deletion timestamps), but if some
    // future replay or clock skew put it there, the cutoff must still
    // not move into the future — otherwise we'd prune tombstones the
    // local user just created.
    const ahead = NOW + 24 * 60 * 60 * 1000;
    mockSubs({ universe: [{ peerId: 'peer-a' }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockImplementation(async () => ahead);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
  });

  it('passes the unique peer-id list to getMinAckAcrossPeers (no duplicate ids)', async () => {
    // Subscriptions are per-record, so one peer can appear in many sub
    // rows. Pass the deduped set to the cursor query — otherwise a peer
    // subscribed to 50 universes would over-count itself.
    mockSubs({
      universe: [
        { peerId: 'peer-a' },
        { peerId: 'peer-a' }, // same peer, different record
        { peerId: 'peer-b' },
      ],
    });
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true },
      { instanceId: 'peer-b', enabled: true },
    ]);
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    await sweepTombstones({ now: NOW });
    expect(getMinAckAcrossPeers).toHaveBeenCalledWith(
      expect.arrayContaining(['peer-a', 'peer-b']),
    );
    const firstCallArgs = getMinAckAcrossPeers.mock.calls[0][0];
    // De-dup invariant.
    expect(new Set(firstCallArgs).size).toBe(firstCallArgs.length);
  });

  it('ignores subscriptions for peers no longer in the registry (removed-peer GC stall)', async () => {
    // Regression: peer_subscriptions.json rows outlive peer removal — no
    // cleanup hook on instance delete. Without the live-registry filter,
    // getMinAckAcrossPeers would receive a removed peer-id, return its
    // frozen-at-removal ack (often 0), and the cutoff would clamp to
    // `0 - GRACE` — refusing to prune any tombstone for this kind
    // indefinitely.
    mockSubs({ universe: [{ peerId: 'peer-ghost' }, { peerId: 'peer-live' }] });
    // peer-ghost was removed; only peer-live is still in the registry.
    getPeers.mockResolvedValue([{ instanceId: 'peer-live', enabled: true }]);
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    await sweepTombstones({ now: NOW });
    const firstCallArgs = getMinAckAcrossPeers.mock.calls[0][0];
    expect(firstCallArgs).toEqual(['peer-live']);
    expect(firstCallArgs).not.toContain('peer-ghost');
  });

  it('ignores subscriptions for disabled or globally-silenced peers (cursor stall)', async () => {
    // Regression: peerIdsSubscribedToKind must mirror snapshotPeerIdsForKind
    // — disabled peers (enabled:false) and globally-silenced peers
    // (syncEnabled:false) receive no pushes, so their ack cursor never
    // advances. Including them in getMinAckAcrossPeers would freeze the
    // cutoff at their last ack (often 0) and stall GC indefinitely.
    mockSubs({
      universe: [
        { peerId: 'peer-disabled' },
        { peerId: 'peer-silenced' },
        { peerId: 'peer-active' },
      ],
    });
    getPeers.mockResolvedValue([
      { instanceId: 'peer-disabled', enabled: false },
      { instanceId: 'peer-silenced', enabled: true, syncEnabled: false },
      { instanceId: 'peer-active', enabled: true },
    ]);
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    await sweepTombstones({ now: NOW });
    const firstCallArgs = getMinAckAcrossPeers.mock.calls[0][0];
    expect(firstCallArgs).toEqual(['peer-active']);
    expect(firstCallArgs).not.toContain('peer-disabled');
    expect(firstCallArgs).not.toContain('peer-silenced');
  });
});

describe('sweepTombstones — return shape', () => {
  it('returns the per-kind prune count so the orchestrator can log a single-line summary', async () => {
    pruneTombstonedUniverses.mockResolvedValueOnce({ pruned: 2 });
    pruneTombstonedSeries.mockResolvedValueOnce({ pruned: 0 });
    pruneTombstonedIssues.mockResolvedValueOnce({ pruned: 5 });
    pruneTombstonedCollections.mockResolvedValueOnce({ pruned: 3 });
    pruneTombstonedAuthors.mockResolvedValueOnce({ pruned: 1 });
    pruneTombstonedArtists.mockResolvedValueOnce({ pruned: 4 });
    pruneTombstonedAlbums.mockResolvedValueOnce({ pruned: 6 });
    pruneTombstonedTracks.mockResolvedValueOnce({ pruned: 7 });
    pruneTombstonedProjects.mockResolvedValueOnce({ pruned: 8 });
    pruneTombstonedMusicVideoProjects.mockResolvedValueOnce({ pruned: 13 });
    pruneTombstonedBoards.mockResolvedValueOnce({ pruned: 9 });
    pruneTombstonedWorks.mockResolvedValueOnce({ pruned: 10 });
    pruneTombstonedFolders.mockResolvedValueOnce({ pruned: 11 });
    pruneTombstonedExercises.mockResolvedValueOnce({ pruned: 12 });
    const result = await sweepTombstones({ now: NOW });
    expect(result).toEqual({
      universes: 2,
      series: 0,
      issues: 5,
      collections: 3,
      authors: 1,
      artists: 4,
      albums: 6,
      tracks: 7,
      creativeDirectorProjects: 8,
      musicVideoProjects: 13,
      moodBoards: 9,
      writersRoomWorks: 10,
      writersRoomFolders: 11,
      writersRoomExercises: 12,
      orphanBaseHashes: 0,
      orphanSubscriptions: 0,
      refused: [],
    });
  });

  it('lists kinds whose cutoff was null in `refused` so the manual-trigger UI can explain why nothing pruned', async () => {
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true, pipeline: true, mediaCollections: true } },
    ]);
    const result = await sweepTombstones({ now: NOW });
    expect(result.refused.sort()).toEqual(['issue', 'mediaCollection', 'series', 'universe']);
    expect(result.universes).toBe(0);
    expect(result.series).toBe(0);
    expect(result.issues).toBe(0);
    expect(result.collections).toBe(0);
  });
});

describe('sweepTombstones — graceMs override (manual trigger / CLI path)', () => {
  it('passes the override through to the cutoff so callers can shrink the 24h buffer', async () => {
    // Regression: the orchestrator path keeps the 24h default; the manual
    // "GC now" button passes graceMs:0 so a user who just mass-deleted
    // records doesn't have to wait 24h. The cutoff math must use the
    // caller's graceMs, not the module-level GRACE_MS, when overridden.
    await sweepTombstones({ now: NOW, graceMs: 0 });
    // cutoff is NOW+1 (the +1 compensates for the prune helpers' strict
    // `deletedAt < beforeMs` comparison so a tombstone created at exactly
    // NOW is still pruned — see cutoffForKind in tombstoneGc.js).
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(NOW + 1);
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(NOW + 1);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(NOW + 1);
  });

  it('defaults to TOMBSTONE_GRACE_MS when graceMs is omitted (orchestrator path unchanged)', async () => {
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
  });

  it('still clamps to min-ack even with graceMs:0 (per-record sub safety preserved)', async () => {
    // graceMs:0 only removes the time buffer — the ack-horizon clamp must
    // still fire, otherwise a manual trigger would prune past the laggiest
    // peer's ack and resurrection would follow.
    const minAck = NOW - 1000;
    mockSubs({ universe: [{ peerId: 'peer-a' }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockResolvedValue(minAck);
    await sweepTombstones({ now: NOW, graceMs: 0 });
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(minAck + 1);
  });

  it("prunes a tombstone whose deletedAt equals minAck exactly (inclusive-cutoff regression)", async () => {
    // Regression for codex P2 finding: prune helpers compare with strict
    // less-than (`deletedAt < beforeMs`), so before the +1 shift, a single
    // delete at timestamp T where minAck == T would never prune — cutoff
    // returned T and the comparison rejected `T < T`. With the shift the
    // cutoff is T+1 and the tombstone is correctly pruned.
    const t = NOW - 1000;
    mockSubs({ universe: [{ peerId: 'peer-a' }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockResolvedValue(t);
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedUniverses.mock.calls[0][0];
    expect(cutoff).toBeGreaterThan(t); // tombstone at t passes `t < cutoff`
  });

  it('still refuses to prune snapshot-uncovered kinds even with graceMs:0', async () => {
    // The snapshot-mode-peer gate is independent of graceMs — a manual
    // trigger must not bypass the resurrection-safety check.
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true } },
    ]);
    const result = await sweepTombstones({ now: NOW, graceMs: 0 });
    expect(pruneTombstonedUniverses).not.toHaveBeenCalled();
    expect(result.refused).toContain('universe');
  });
});

describe('sweepTombstones — per-record confirmed-push clamp (peer-sync-per-record-tombstone-ack-cursor)', () => {
  // Regression for the per-peer cursor gap: the per-peer tombstone ack cursor
  // (getMinAckAcrossPeers) advances to the MAX deletedAt acked across ALL of a
  // peer's pushes. If push for record-A FAILS and a later push for record-B
  // SUCCEEDS, the receiver returns ackedDeletesUpTo = B.deletedAt > A.deletedAt
  // and the per-peer cursor jumps past A — even though A's delete-push was
  // never confirmed. Without the per-record clamp, GC prunes A's tombstone and
  // A's stale live copy on the receiver resurrects on the next snapshot sync.
  //
  // The fix clamps the cutoff to MIN(lastConfirmedPushedAt) across the kind's
  // rows. Record-A's row is stuck at a pre-delete confirm time below A's
  // deletedAt, so the cutoff stays below A and A's tombstone survives.
  const A_DELETED_AT = NOW - 10 * 60 * 1000; // A deleted 10m ago
  const A_LAST_CONFIRMED = NOW - 20 * 60 * 1000; // A's last *confirmed* push (pre-delete), 20m ago
  const B_DELETED_AT = NOW - 5 * 60 * 1000; // B deleted 5m ago (more recent than A)

  it('does NOT prune record-A tombstone when A push failed but a later record-B push advanced the per-peer cursor', async () => {
    // Per-peer cursor reflects B's ack (the bug: it jumped past A).
    getMinAckAcrossPeers.mockResolvedValue(B_DELETED_AT);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    // Two universe subs to the same peer. A's push never confirmed since
    // before its delete (stuck low); B's push confirmed recently (at NOW).
    mockSubs({
      universe: [
        { peerId: 'peer-a', recordId: 'u-A', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedPushedAt: A_LAST_CONFIRMED },
        { peerId: 'peer-a', recordId: 'u-B', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedPushedAt: NOW },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedUniverses.mock.calls[0][0];
    // Cutoff must be clamped to A's stuck confirm point (+1), NOT the per-peer
    // ack of B. So A's tombstone (deletedAt = A_DELETED_AT) does NOT satisfy
    // `A_DELETED_AT < cutoff` and survives; B's (deletedAt = B_DELETED_AT)
    // also survives, which is fine — correctness over GC aggressiveness.
    expect(cutoff).toBe(A_LAST_CONFIRMED + 1);
    expect(A_DELETED_AT).toBeGreaterThanOrEqual(cutoff); // A NOT pruned
  });

  it('prunes record-A tombstone once A push is confirmed past its deletedAt', async () => {
    // After A's delete-push finally lands, A's row confirm advances above its
    // deletedAt and the clamp no longer holds the line — A is prunable.
    getMinAckAcrossPeers.mockResolvedValue(B_DELETED_AT);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    mockSubs({
      universe: [
        { peerId: 'peer-a', recordId: 'u-A', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedPushedAt: NOW },
        { peerId: 'peer-a', recordId: 'u-B', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedPushedAt: NOW },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedUniverses.mock.calls[0][0];
    // Both rows confirmed at NOW; the per-peer ack (B) is the binding clamp now.
    expect(cutoff).toBe(B_DELETED_AT + 1);
    expect(A_DELETED_AT).toBeLessThan(cutoff); // A NOW pruned
  });

  it('floors a never-confirmed row to its createdAt (protects post-subscribe tombstones, GC of pre-subscribe ones unaffected)', async () => {
    // A brand-new sub (lastConfirmedPushedAt absent) shouldn't permanently
    // freeze GC at 0 — it floors to createdAt, protecting only tombstones it
    // still owes the peer (those created after it subscribed).
    const createdAt = NOW - 30 * 60 * 1000;
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    mockSubs({
      universe: [
        // lastConfirmedPushedAt: null overrides the mockSubs NOW default to
        // model a row whose push has never been confirmed.
        { peerId: 'peer-a', recordId: 'u-new', createdAt: new Date(createdAt).toISOString(), lastConfirmedPushedAt: null },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedUniverses.mock.calls[0][0];
    expect(cutoff).toBe(createdAt + 1);
  });

  it('issues inherit the series rows confirmed-push clamp (issue tombstones ride series pushes)', async () => {
    // An issue tombstone is bundled into its parent series push, so its
    // protection comes from the series row's confirmed-push mark — not a
    // (nonexistent) issue subscription.
    const seriesStuckConfirm = NOW - 25 * 60 * 1000;
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    mockSubs({
      series: [
        { peerId: 'peer-a', recordId: 's-A', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedPushedAt: seriesStuckConfirm },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const seriesCutoff = pruneTombstonedSeries.mock.calls[0][0];
    const issueCutoff = pruneTombstonedIssues.mock.calls[0][0];
    expect(seriesCutoff).toBe(seriesStuckConfirm + 1);
    expect(issueCutoff).toBe(seriesCutoff); // issues clamp identically to series
  });
});

describe('getSweepStatus — dry-run for UI button gating', () => {
  it('returns refused kinds without invoking any prune helper', async () => {
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true, pipeline: true, mediaCollections: true } },
    ]);
    const result = await getSweepStatus({ now: NOW });
    expect(result.refused.sort()).toEqual(['issue', 'mediaCollection', 'series', 'universe']);
    expect(pruneTombstonedUniverses).not.toHaveBeenCalled();
    expect(pruneTombstonedSeries).not.toHaveBeenCalled();
    expect(pruneTombstonedIssues).not.toHaveBeenCalled();
    expect(pruneTombstonedCollections).not.toHaveBeenCalled();
    expect(pruneTombstonedAuthors).not.toHaveBeenCalled();
    expect(pruneTombstonedArtists).not.toHaveBeenCalled();
    expect(pruneTombstonedAlbums).not.toHaveBeenCalled();
    expect(pruneTombstonedTracks).not.toHaveBeenCalled();
  });

  it('returns an empty refused list when every kind has an ack horizon', async () => {
    const result = await getSweepStatus({ now: NOW });
    expect(result.refused).toEqual([]);
  });
});

describe('sweepTombstones — resurrection safety against snapshot-mode peers', () => {
  it('refuses to prune universe tombstones when a snapshot-mode peer exists for the universe category', async () => {
    // Regression: with no per-record subs but a snapshot-mode peer enabled
    // for `universe`, an offline peer could come back with an older LIVE
    // copy and force-resurrect via mergeUniversesFromSync's "no local
    // record → insert" branch. We must refuse to prune.
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true, pipeline: false } },
    ]);
    await sweepTombstones({ now: NOW });
    // Universe prune is skipped (no call); series + issues still run
    // because no peer has pipeline=true here.
    expect(pruneTombstonedUniverses).not.toHaveBeenCalled();
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
  });

  it('refuses to prune series + issue tombstones when a pipeline snapshot-mode peer exists', async () => {
    // Same risk on the pipeline side — and the gate must apply to BOTH
    // series and issues (issues ride pipeline snapshots bundled with
    // series).
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: false, pipeline: true } },
    ]);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalled();
    expect(pruneTombstonedSeries).not.toHaveBeenCalled();
    expect(pruneTombstonedIssues).not.toHaveBeenCalled();
  });

  it('still prunes when per-record subscriptions exist (their min-ack water-mark provides the safety we need)', async () => {
    // Snapshot peers are also subscribed via per-record: the ack cursor
    // tracks every push they receive, so we have a horizon and CAN prune.
    mockSubs({ universe: [{ peerId: 'peer-a' }] });
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true, pipeline: true } },
    ]);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalled();
  });

  it('refuses to prune in mixed deployment (peer-A per-record subscribed, peer-B snapshot-only)', async () => {
    // Regression for the round-3 finding: my round-2 fix only checked the
    // snapshot-mode gate when peerIds.length === 0. But if peer-A has a
    // per-record sub AND peer-B is snapshot-only for the same kind, peer-B
    // has no ack horizon — its next snapshot push could still resurrect
    // a record we pruned based on peer-A's ack alone. The fix now checks
    // for ANY uncovered snapshot peer.
    mockSubs({ universe: [{ peerId: 'peer-a' }] });
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { universe: true } },
      { instanceId: 'peer-b', enabled: true, syncCategories: { universe: true } }, // snapshot-only
    ]);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).not.toHaveBeenCalled();
  });

  it("ignores disabled snapshot-mode peers (can't resurrect from a disabled peer)", async () => {
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: false, syncCategories: { universe: true } },
    ]);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalled();
  });

  it("ignores legacy peers with no syncCategories (they can't send universe/pipeline snapshots)", async () => {
    // Legacy peers fall back to brain+memory only in getEffectiveCategories,
    // so they don't participate in the universe/pipeline snapshot loop and
    // can't resurrect those records.
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true /* no syncCategories */ },
    ]);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalled();
    expect(pruneTombstonedSeries).toHaveBeenCalled();
  });
});

describe('sweepTombstones — mediaCollection GC (Task 1.10b)', () => {
  it('prunes collection tombstones when no peers are subscribed (grace satisfied)', async () => {
    // No subs → peerIdsSubscribedToKind returns [] → getMinAckAcrossPeers([])
    // returns Infinity → cutoff = min(Infinity, NOW) - GRACE + 1 = NOW - GRACE + 1.
    // pruneTombstonedCollections is called; universe/series/issues also run with
    // their own grace-only cutoffs.
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedCollections).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS + 1);
  });

  it('does NOT prune collection tombstones when a subscribed peer has not acked', async () => {
    // Peer-a has a per-record mediaCollection sub but its ack cursor is far
    // behind. The cutoff must clamp to the peer's ack water-mark so we can't
    // prune a tombstone the peer hasn't received yet.
    const minAck = NOW - 48 * 60 * 60 * 1000; // 48h behind now
    mockSubs({ mediaCollection: [{ peerId: 'peer-a' }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockImplementation(async (peerIds) => {
      if (peerIds.includes('peer-a')) return minAck;
      return Infinity;
    });
    await sweepTombstones({ now: NOW });
    // Cutoff must be clamped to the laggiest peer's ack, not now-GRACE.
    expect(pruneTombstonedCollections).toHaveBeenCalledWith(minAck - TOMBSTONE_GRACE_MS + 1);
    // Verify this is older than the grace-only cutoff — i.e. we DID clamp.
    const calledWith = pruneTombstonedCollections.mock.calls[0][0];
    expect(calledWith).toBeLessThan(NOW - TOMBSTONE_GRACE_MS + 1);
  });

  it('refuses to prune collection tombstones when a snapshot-mode peer exists for mediaCollections but has no per-record sub', async () => {
    // A snapshot-only peer for mediaCollections can resurrect a pruned record
    // via its next snapshot push — must refuse the prune until a per-record sub
    // gives us an ack horizon.
    listPeerSubscriptions.mockResolvedValue([]);
    getPeers.mockResolvedValue([
      { instanceId: 'peer-a', enabled: true, syncCategories: { mediaCollections: true } },
    ]);
    const result = await sweepTombstones({ now: NOW });
    expect(pruneTombstonedCollections).not.toHaveBeenCalled();
    expect(result.refused).toContain('mediaCollection');
    expect(result.collections).toBe(0);
  });
});

describe('sweepTombstones — track GC cohort widened by musicVideoProject bundling (#1922)', () => {
  // #1858 bundles a music-video project's linked track record on the project
  // push so a peer subscribed to musicVideoProjects ONLY (no `track`
  // subscription) can still resolve it. Before #1922, such a peer was
  // entirely invisible to the `track` cutoff cohort — its ack/confirm never
  // gated track-tombstone GC at all, so a transient bundled-delivery failure
  // plus GC pruning the tombstone before a retry could strand stale audio on
  // that peer forever.
  it('includes a musicVideoProject-only peer in the track ack cohort (peer has no track subscription)', async () => {
    mockSubs({ musicVideoProject: [{ peerId: 'peer-a', lastConfirmedTrackBundleAtMs: NOW }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    await sweepTombstones({ now: NOW });
    // peerIdsSubscribedToKind('track') must include peer-a even though peer-a
    // has zero `track`-kind subscription rows.
    const trackAckCall = getMinAckAcrossPeers.mock.calls.find((call) => call[0].includes('peer-a'));
    expect(trackAckCall).toBeTruthy();
  });

  it('does NOT prune a track tombstone until the musicVideoProject peer confirms the bundled delivery', async () => {
    // The per-peer ack cursor (getMinAckAcrossPeers) is already past the
    // tombstone — mimics #1922's failure mode where the coarse cursor jumped
    // ahead via an unrelated push. The musicVideoProject row's bundle-specific
    // floor (lastConfirmedTrackBundleAtMs absent → floors to createdAt) must
    // still hold the cutoff back.
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    const createdAt = NOW - 30 * 60 * 1000;
    mockSubs({
      musicVideoProject: [
        // No lastConfirmedTrackBundleAtMs yet (bundle never confirmed) — floors
        // to createdAt, NOT the mockSubs lastConfirmedPushedAt default.
        { peerId: 'peer-a', createdAt: new Date(createdAt).toISOString(), lastConfirmedTrackBundleAtMs: null },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedTracks.mock.calls[0][0];
    expect(cutoff).toBe(createdAt + 1);
  });

  it('prunes a track tombstone once the musicVideoProject peer confirms the bundled track merge', async () => {
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    mockSubs({
      musicVideoProject: [
        { peerId: 'peer-a', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedTrackBundleAtMs: NOW },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedTracks.mock.calls[0][0];
    expect(cutoff).toBe(NOW + 1);
  });

  it('does NOT release the track cutoff off a musicVideoProject row whose bundled merge never confirmed, even though lastConfirmedPushedAt (the generic field) is fresh', async () => {
    // Regression for the field-confusion bug: mockSubs defaults
    // lastConfirmedPushedAt to NOW (every push lands), but that field reflects
    // confirmed delivery of the PROJECT record, not the bundled TRACK — using
    // it for the `track` cutoff would let GC treat an unconfirmed bundled
    // tombstone as delivered.
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    const createdAt = NOW - 30 * 60 * 1000;
    mockSubs({
      // lastConfirmedPushedAt defaults to NOW via mockSubs; only
      // lastConfirmedTrackBundleAtMs is left unset here.
      musicVideoProject: [{ peerId: 'peer-a', createdAt: new Date(createdAt).toISOString() }],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedTracks.mock.calls[0][0];
    expect(cutoff).toBe(createdAt + 1); // floors to createdAt, ignores the fresh lastConfirmedPushedAt
  });

  it('does NOT widen the musicVideoProject cutoff cohort itself (only `track` borrows musicVideoProject rows)', async () => {
    // The OWN musicVideoProject cutoff must keep reading lastConfirmedPushedAt
    // (its own record's confirmed-delivery floor) — confirming this isn't
    // accidentally redirected to the bundle-specific field too.
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    const stuckConfirm = NOW - 40 * 60 * 1000;
    mockSubs({
      musicVideoProject: [
        {
          peerId: 'peer-a',
          createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
          lastConfirmedPushedAt: stuckConfirm,
          lastConfirmedTrackBundleAtMs: NOW, // fresh — must NOT be what gates the project's own cutoff
        },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedMusicVideoProjects.mock.calls[0][0];
    expect(cutoff).toBe(stuckConfirm + 1);
  });

  it('a peer with only a track subscription (no musicVideoProject) still gates track GC as before', async () => {
    const minAck = NOW - 10 * 60 * 1000;
    mockSubs({ track: [{ peerId: 'peer-a', lastConfirmedPushedAt: NOW }] });
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    getMinAckAcrossPeers.mockImplementation(async (peerIds) => {
      if (peerIds.includes('peer-a')) return minAck;
      return Infinity;
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    expect(pruneTombstonedTracks).toHaveBeenCalledWith(minAck + 1);
  });

  it('does NOT hold the track cutoff hostage to a stale musicVideoProject row when the peer already has a confirmed direct track subscription', async () => {
    // Regression (codex review on #1922): a peer syncing BOTH Music and Music
    // Videos has its own direct `track` subscription, already fully governed
    // by that row's `lastConfirmedPushedAt` floor. Without excluding the
    // peer's musicVideoProject rows here, an unrelated/long-stale project
    // subscription (never confirmed a bundled track delivery — e.g. it has no
    // linked track at all) would needlessly hold back GC for EVERY track
    // tombstone, even ones the peer's direct track subscription already
    // confirmed.
    getMinAckAcrossPeers.mockResolvedValue(NOW);
    getPeers.mockResolvedValue([{ instanceId: 'peer-a', enabled: true }]);
    mockSubs({
      track: [
        { peerId: 'peer-a', createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(), lastConfirmedPushedAt: NOW },
      ],
      musicVideoProject: [
        // Stale/unrelated project sub for the SAME peer: never confirmed a
        // bundled track delivery, floors to its old createdAt — must NOT gate
        // the track cutoff because peer-a already has a direct track sub.
        {
          peerId: 'peer-a',
          createdAt: new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString(),
          lastConfirmedTrackBundleAtMs: null,
        },
      ],
    });
    await sweepTombstones({ now: NOW, graceMs: 0 });
    const cutoff = pruneTombstonedTracks.mock.calls[0][0];
    expect(cutoff).toBe(NOW + 1); // governed by the direct track row, not the stale MV row
  });
});
