import { describe, it, expect, vi, beforeEach } from 'vitest';

// All four downstream surfaces are mocked so we can drive the math without
// touching real state files. The point of these tests is the cutoff policy
// (grace + min-ack), not the pure-mechanical prune helpers — those are
// covered by their own service tests.
vi.mock('../universeBuilder.js', () => ({
  pruneTombstonedUniverses: vi.fn().mockResolvedValue({ pruned: 0 }),
}));
vi.mock('../pipeline/series.js', () => ({
  pruneTombstonedSeries: vi.fn().mockResolvedValue({ pruned: 0 }),
}));
vi.mock('../pipeline/issues.js', () => ({
  pruneTombstonedIssues: vi.fn().mockResolvedValue({ pruned: 0 }),
}));
vi.mock('../mediaCollections.js', () => ({
  pruneTombstonedCollections: vi.fn().mockResolvedValue({ pruned: 0 }),
}));
vi.mock('./peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
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
import { pruneTombstonedUniverses } from '../universeBuilder.js';
import { pruneTombstonedSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues } from '../pipeline/issues.js';
import { pruneTombstonedCollections } from '../mediaCollections.js';
import { listPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';
import { getPeers } from '../instances.js';

const NOW = 1_700_000_000_000; // arbitrary epoch ms anchor

// Helper: tombstoneGc now reads subscriptions ONCE per sweep without a
// per-kind filter, so tests should hand the full sub list with each row
// carrying its own `recordKind` tag. The previous per-kind mock shape
// (`mockImplementation(({ recordKind }) => ...)`) is replaced by this.
const mockSubs = (subsByKind) => {
  const rows = [];
  for (const [recordKind, peers] of Object.entries(subsByKind)) {
    for (const p of peers) rows.push({ ...p, recordKind });
  }
  listPeerSubscriptions.mockResolvedValue(rows);
};

beforeEach(() => {
  vi.clearAllMocks();
  listPeerSubscriptions.mockResolvedValue([]);
  getMinAckAcrossPeers.mockResolvedValue(Infinity);
  getPeers.mockResolvedValue([]);
});

describe('TOMBSTONE_GRACE_MS', () => {
  it('is 24 hours so an off-by-a-magnitude regression fails the test (not silently in prod)', () => {
    expect(TOMBSTONE_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('sweepTombstones — no peers subscribed', () => {
  it('uses now-GRACE as the cutoff for all four kinds when nobody is subscribed', async () => {
    await sweepTombstones({ now: NOW });
    const expectedCutoff = NOW - TOMBSTONE_GRACE_MS + 1;
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedCollections).toHaveBeenCalledWith(expectedCutoff);
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
    const result = await sweepTombstones({ now: NOW });
    expect(result).toEqual({ universes: 2, series: 0, issues: 5, collections: 3, refused: [] });
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
