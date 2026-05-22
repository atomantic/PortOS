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
  listSeries: vi.fn().mockResolvedValue([]),
}));
vi.mock('../pipeline/issues.js', () => ({
  pruneTombstonedIssues: vi.fn().mockResolvedValue({ pruned: 0 }),
  listIssues: vi.fn().mockResolvedValue([]),
}));
vi.mock('./peerSync.js', () => ({
  listPeerSubscriptions: vi.fn(),
}));
vi.mock('./peerTombstoneCursors.js', () => ({
  getMinAckAcrossPeers: vi.fn(),
}));

import {
  sweepTombstones,
  getTombstoneSummary,
  TOMBSTONE_GRACE_MS,
} from './tombstoneGc.js';
import { pruneTombstonedUniverses } from '../universeBuilder.js';
import { pruneTombstonedSeries, listSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues, listIssues } from '../pipeline/issues.js';
import { listPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';

const NOW = 1_700_000_000_000; // arbitrary epoch ms anchor

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no peer subscriptions (empty array → getMinAckAcrossPeers
  // returns Infinity in the real implementation; mirror that here).
  listPeerSubscriptions.mockResolvedValue([]);
  getMinAckAcrossPeers.mockResolvedValue(Infinity);
});

describe('TOMBSTONE_GRACE_MS', () => {
  it('is 24 hours so an off-by-a-magnitude regression fails the test (not silently in prod)', () => {
    expect(TOMBSTONE_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('sweepTombstones — no peers subscribed', () => {
  it('uses now-GRACE as the cutoff for all three kinds when nobody is subscribed', async () => {
    await sweepTombstones({ now: NOW });
    const expectedCutoff = NOW - TOMBSTONE_GRACE_MS;
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(expectedCutoff);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(expectedCutoff);
  });
});

describe('sweepTombstones — peers behind', () => {
  it("clamps the universe cutoff to the laggiest universe-subscribed peer (can't prune past min-ack)", async () => {
    // Regression: if we used `now - GRACE` even when peers are subscribed,
    // we'd prune tombstones the laggiest peer hasn't seen yet — and a
    // subsequent push from that peer would resurrect the record under its
    // older `updatedAt`.
    const minAck = NOW - 48 * 60 * 60 * 1000; // 48h behind now
    listPeerSubscriptions.mockImplementation(async ({ recordKind }) => {
      if (recordKind === 'universe') return [{ peerId: 'peer-a' }];
      return [];
    });
    getMinAckAcrossPeers.mockImplementation(async (peerIds) => {
      if (peerIds.includes('peer-a')) return minAck;
      return Infinity;
    });
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(minAck - TOMBSTONE_GRACE_MS);
    // series + issues still use now-GRACE since no series subs exist.
    expect(pruneTombstonedSeries).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS);
    expect(pruneTombstonedIssues).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS);
  });

  it('uses the same cutoff for issues as for series (issue tombstones ride series pushes)', async () => {
    // Regression: if issue cutoff used issues' own subscription cohort,
    // it would always be `now - GRACE` (issues are never directly
    // subscribable) — but issues need to wait for series-subscribed peers
    // to ack their parent series's push.
    const seriesAck = NOW - 72 * 60 * 60 * 1000;
    listPeerSubscriptions.mockImplementation(async ({ recordKind }) => {
      if (recordKind === 'series') return [{ peerId: 'peer-a' }];
      return [];
    });
    getMinAckAcrossPeers.mockImplementation(async (peerIds) => {
      if (peerIds.includes('peer-a')) return seriesAck;
      return Infinity;
    });
    await sweepTombstones({ now: NOW });
    const seriesCutoff = seriesAck - TOMBSTONE_GRACE_MS;
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
    listPeerSubscriptions.mockImplementation(async ({ recordKind }) => {
      if (recordKind === 'universe') return [{ peerId: 'peer-a' }];
      return [];
    });
    getMinAckAcrossPeers.mockImplementation(async () => ahead);
    await sweepTombstones({ now: NOW });
    expect(pruneTombstonedUniverses).toHaveBeenCalledWith(NOW - TOMBSTONE_GRACE_MS);
  });

  it('passes the unique peer-id list to getMinAckAcrossPeers (no duplicate ids)', async () => {
    // Subscriptions are per-record, so one peer can appear in many sub
    // rows. Pass the deduped set to the cursor query — otherwise a peer
    // subscribed to 50 universes would over-count itself.
    listPeerSubscriptions.mockImplementation(async ({ recordKind }) => {
      if (recordKind === 'universe') {
        return [
          { peerId: 'peer-a' },
          { peerId: 'peer-a' }, // same peer, different record
          { peerId: 'peer-b' },
        ];
      }
      return [];
    });
    getMinAckAcrossPeers.mockResolvedValue(NOW - 1000);
    await sweepTombstones({ now: NOW });
    expect(getMinAckAcrossPeers).toHaveBeenCalledWith(
      expect.arrayContaining(['peer-a', 'peer-b']),
    );
    const firstCallArgs = getMinAckAcrossPeers.mock.calls[0][0];
    // De-dup invariant.
    expect(new Set(firstCallArgs).size).toBe(firstCallArgs.length);
  });
});

describe('sweepTombstones — return shape', () => {
  it('returns the per-kind prune count so the orchestrator can log a single-line summary', async () => {
    pruneTombstonedUniverses.mockResolvedValueOnce({ pruned: 2 });
    pruneTombstonedSeries.mockResolvedValueOnce({ pruned: 0 });
    pruneTombstonedIssues.mockResolvedValueOnce({ pruned: 5 });
    const result = await sweepTombstones({ now: NOW });
    expect(result).toEqual({ universes: 2, series: 0, issues: 5 });
  });
});

describe('getTombstoneSummary', () => {
  it('counts series + issue tombstones from their listX(includeDeleted) responses', async () => {
    listSeries.mockResolvedValueOnce([
      { id: 's1', deleted: false },
      { id: 's2', deleted: true },
      { id: 's3', deleted: true },
    ]);
    listIssues.mockResolvedValueOnce([
      { id: 'i1', deleted: false },
      { id: 'i2', deleted: true },
    ]);
    const summary = await getTombstoneSummary();
    expect(summary.seriesTombstones).toBe(2);
    expect(summary.issueTombstones).toBe(1);
    // includeDeleted MUST be true — otherwise the count is always 0.
    expect(listSeries).toHaveBeenCalledWith({ includeDeleted: true });
    expect(listIssues).toHaveBeenCalledWith({ includeDeleted: true });
  });
});
