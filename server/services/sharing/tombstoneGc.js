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
import { pruneTombstonedSeries, listSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues, listIssues } from '../pipeline/issues.js';
import { listPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';

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
 * Compute the cutoff timestamp: tombstones with `deletedAt < cutoff` are
 * safe to prune. The cutoff is the EARLIER of "now - grace" and
 * "minAck - grace" — i.e. we subtract the grace buffer from whichever
 * water-mark is lower, so we never prune past the laggiest peer's ack.
 *
 * Practically: subtract grace from `min(now, minAckedAcrossPeers)`. The
 * `Math.min` collapses the two policy branches into one formula:
 *   - no peers subscribed → minAck=Infinity → cutoff = now - grace
 *   - peers subscribed but behind → minAck < now → cutoff = minAck - grace
 *
 * @returns {number} the cutoff ms-epoch — pass to `pruneTombstoned*` as `beforeMs`.
 */
async function cutoffForKind(recordKind, { now = Date.now() } = {}) {
  const peerIds = await peerIdsSubscribedToKind(recordKind);
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
  // Issue tombstones ride series pushes — same ack cohort.
  const issueCutoff = seriesCutoff;
  const [u, s, i] = await Promise.all([
    pruneTombstonedUniverses(universeCutoff),
    pruneTombstonedSeries(seriesCutoff),
    pruneTombstonedIssues(issueCutoff),
  ]);
  return {
    universes: u.pruned,
    series: s.pruned,
    issues: i.pruned,
  };
}

/**
 * Diagnostic helper for the dev tools / UI: count tombstones in each
 * state file WITHOUT pruning anything. Lets us surface "X tombstones
 * pending GC" without having to dump the full state.
 *
 * Cheap enough to run on every status fetch — the three JSON loads are
 * tiny compared to the rest of the dashboard refresh.
 */
export async function getTombstoneSummary() {
  const [allSeries, allIssues] = await Promise.all([
    listSeries({ includeDeleted: true }),
    listIssues({ includeDeleted: true }),
  ]);
  // No `listUniverses(includeDeleted)` import here on purpose: requiring
  // it would force the GC module to import the heavyweight universe
  // service surface (its merge graph + sanitizer + write queues). The
  // sweep itself doesn't need to count, only to prune via the explicit
  // `pruneTombstoned*` exports.
  return {
    seriesTombstones: allSeries.filter((s) => s.deleted).length,
    issueTombstones: allIssues.filter((i) => i.deleted).length,
  };
}

// Constants exported for tests; module-level so future tuning doesn't
// require a code search to find the magic number.
export const TOMBSTONE_GRACE_MS = GRACE_MS;
