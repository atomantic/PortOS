/**
 * Tombstone garbage collection for federated peer sync.
 *
 * The Stage 1 soft-delete refactor turned deletes into tombstone records
 * (`{ deleted: true, deletedAt }`) so the LWW merge can keep them from
 * being resurrected by out-of-date peers. Tombstones cannot be pruned
 * blindly — if peer-A deletes record X and peer-B comes online later,
 * peer-B's snapshot must still see the tombstone so its older "live" copy
 * loses the merge.
 *
 * This sweep prunes a tombstone only when BOTH conditions hold:
 *   1. Every peer currently subscribed to the record's kind has acked a
 *      deletedAt at least as recent as the tombstone (so we know every
 *      subscriber has received and applied this specific deletion).
 *   2. At least GRACE_MS has elapsed since the tombstone was created — a
 *      buffer for transient replay / disconnect cases that haven't shown
 *      up in the ack water-mark yet.
 *
 * When a record's kind has NO subscribed peers, condition (1) is trivially
 * satisfied (`getMinAckAcrossPeers([])` returns Infinity), so the sweep
 * falls back to a simple "older than grace" check.
 *
 * Issues piggyback on the series subscription model — an issue tombstone
 * is only pushed alongside its parent series's push, so the relevant ack
 * cohort for issue tombstones is "peers subscribed to series".
 *
 * Wired into the syncOrchestrator interval; runs once per cycle (~60s)
 * since the math is cheap (read 3 small JSONs + cursor map) and prunes
 * in place when there's anything to drop.
 */

import { pruneTombstonedUniverses } from '../universeBuilder.js';
import { pruneTombstonedSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues } from '../pipeline/issues.js';
import { listPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';
import { getPeers } from '../instances.js';

const GRACE_MS = 24 * 60 * 60 * 1000; // 24h grace

/**
 * Resolve the set of peer ids currently subscribed to a given record kind.
 * The result feeds `getMinAckAcrossPeers` to compute the GC water-mark.
 *
 * Returns an array of unique instance ids; an empty array means "no
 * subscribers — fall back to time-only grace."
 */
async function peerIdsSubscribedToKind(recordKind) {
  const subs = await listPeerSubscriptions({ recordKind });
  return [...new Set(subs.map((s) => s.peerId).filter(Boolean))];
}

/**
 * Map a record kind to the snapshot-sync category that ships it on the wire.
 * Universe records ride the 'universe' snapshot category; series + issues
 * both ride the 'pipeline' snapshot category (which bundles them together
 * — see `dataSync.getPipelineSnapshot`).
 */
function snapshotCategoryForKind(recordKind) {
  if (recordKind === 'universe') return 'universe';
  if (recordKind === 'series' || recordKind === 'issue') return 'pipeline';
  return null;
}

/**
 * Returns true if any enabled peer can still send us a snapshot of this
 * record kind via the 60s snapshot loop in `dataSync.js`. The snapshot
 * path has NO per-peer ack water-mark — peerTombstoneCursors only tracks
 * acks from the per-record push pipeline — so as long as a snapshot-mode
 * peer exists for this kind, we can't safely prune tombstones: an offline
 * peer with an older LIVE copy could come back, push its snapshot, and
 * `merge*FromSync` would INSERT the resurrected record (the merge path
 * inserts records the local file is missing).
 *
 * This is the critical safety guard between "no per-record subs" and
 * "safe to fall back to time-only grace pruning."
 */
async function snapshotPeersExistForKind(recordKind) {
  const category = snapshotCategoryForKind(recordKind);
  if (!category) return false;
  const peers = await getPeers().catch(() => []);
  return peers.some((p) => {
    if (!p?.enabled) return false;
    const cats = p.syncCategories;
    if (cats && typeof cats === 'object') return cats[category] === true;
    // Legacy peers without an explicit syncCategories map fall back to
    // brain+memory only (see syncOrchestrator.getEffectiveCategories), so
    // they CAN'T send universe/pipeline snapshots — no resurrection risk.
    return false;
  });
}

/**
 * Compute the cutoff timestamp: tombstones with `deletedAt < cutoff` are
 * safe to prune. The cutoff is the EARLIER of "now - grace" and
 * "minAck - grace" — i.e. we subtract the grace buffer from whichever
 * water-mark is lower, so we never prune past the laggiest peer's ack.
 *
 * Returns `null` to mean "refuse to prune" — used when a snapshot-mode
 * peer exists for this kind but no per-record subscription gives us an
 * ack water-mark; pruning then risks resurrection on the offline peer's
 * next snapshot push (see `snapshotPeersExistForKind`).
 *
 * Otherwise: subtract grace from `min(now, minAckedAcrossPeers)`. The
 * `Math.min` collapses the two safe branches into one formula:
 *   - no peers at all → minAck=Infinity → cutoff = now - grace
 *   - per-record-subscribed peers (and possibly snapshot peers too) →
 *     minAck < now → cutoff = minAck - grace
 *
 * @returns {number|null} the cutoff ms-epoch (or null to refuse).
 */
async function cutoffForKind(recordKind, { now = Date.now() } = {}) {
  const peerIds = await peerIdsSubscribedToKind(recordKind);
  // No per-record subs — but if a snapshot-mode peer exists, we have no
  // ack horizon and pruning risks resurrection. Refuse.
  if (peerIds.length === 0) {
    const snapshotPeers = await snapshotPeersExistForKind(recordKind);
    if (snapshotPeers) return null;
  }
  const minAck = await getMinAckAcrossPeers(peerIds);
  const threshold = Math.min(minAck, now);
  return threshold - GRACE_MS;
}

/**
 * One sweep cycle. Runs all three kinds in parallel — each prune call is
 * already serialized through its own service's write queue, so concurrent
 * kicks don't race local writers.
 *
 * Returns `{ universes, series, issues }` with the prune count per kind so
 * the orchestrator can log a single-line summary on non-zero cycles and
 * stay quiet otherwise.
 */
export async function sweepTombstones({ now = Date.now() } = {}) {
  const [universeCutoff, seriesCutoff] = await Promise.all([
    cutoffForKind('universe', { now }),
    cutoffForKind('series', { now }),
  ]);
  // Issue tombstones ride series pushes — same ack cohort, same cutoff.
  const issueCutoff = seriesCutoff;
  // Skip the prune entirely when cutoff is null (snapshot-mode peer exists
  // for the kind, no ack horizon → refuse to prune to avoid resurrection).
  const [u, s, i] = await Promise.all([
    universeCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedUniverses(universeCutoff),
    seriesCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedSeries(seriesCutoff),
    issueCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedIssues(issueCutoff),
  ]);
  return {
    universes: u.pruned,
    series: s.pruned,
    issues: i.pruned,
  };
}

// Constants exported for tests; module-level so future tuning doesn't
// require a code search to find the magic number.
export const TOMBSTONE_GRACE_MS = GRACE_MS;
