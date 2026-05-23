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
  // Filter against the live peer registry — but only against peers
  // ELIGIBLE TO SYNC. Three filters in lockstep with snapshotPeerIdsForKind:
  //   (1) Live in the registry — peer_subscriptions.json rows outlive peer
  //       removal (no cleanup hook on instance delete), so an unfiltered
  //       removed peer would freeze the cursor at its last ack (often 0)
  //       and refuse to prune.
  //   (2) p.enabled — disabled peers receive no pushes; their cursor
  //       never advances and would otherwise stall GC.
  //   (3) p.syncEnabled !== false — globally-silenced peers same as (2).
  // Without (2) and (3), a per-record subscription belonging to a
  // disabled/silenced peer would treat it as an active blocker even
  // though it can't move.
  const eligiblePeerIds = new Set(
    (await getPeers().catch(() => []))
      .filter((p) => p?.enabled && p.syncEnabled !== false)
      .map((p) => p.instanceId)
      .filter(Boolean),
  );
  return [...new Set(subs.map((s) => s.peerId).filter((id) => id && eligiblePeerIds.has(id)))];
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
 * Returns the set of enabled peer instance-ids that can still send us a
 * snapshot of this record kind via the 60s snapshot loop in `dataSync.js`.
 *
 * The snapshot path has NO per-peer ack water-mark — peerTombstoneCursors
 * only tracks acks from the per-record push pipeline. So for every peer in
 * this set that's NOT also covered by a per-record subscription, we have
 * zero proof they've received any deletion we want to prune. An offline
 * peer with an older LIVE copy could come back, push its snapshot, and
 * `merge*FromSync` would INSERT the resurrected record (the merge path
 * inserts records the local file is missing).
 *
 * Legacy peers without an explicit `syncCategories` map fall back to
 * brain+memory only (see syncOrchestrator.getEffectiveCategories), so
 * they can't send universe/pipeline snapshots — excluded from the set.
 */
async function snapshotPeerIdsForKind(recordKind) {
  const category = snapshotCategoryForKind(recordKind);
  if (!category) return [];
  const peers = await getPeers().catch(() => []);
  return peers
    .filter((p) => {
      if (!p?.enabled) return false;
      // Mirror syncOrchestrator's syncAllPeers gate — a globally-silenced
      // peer (syncEnabled === false) never receives snapshots, so it can't
      // resurrect a pruned tombstone. Without this filter, a silenced peer's
      // stale syncCategories map permanently stalls GC by reporting "snapshot
      // peer not covered by per-record sub" → cutoff = null → refuse to prune.
      if (p.syncEnabled === false) return false;
      const cats = p.syncCategories;
      return !!cats && typeof cats === 'object' && cats[category] === true;
    })
    .map((p) => p.instanceId)
    .filter(Boolean);
}

/**
 * Compute the cutoff timestamp: tombstones with `deletedAt < cutoff` are
 * safe to prune. The cutoff is the EARLIER of "now - grace" and
 * "minAck - grace" — i.e. we subtract the grace buffer from whichever
 * water-mark is lower, so we never prune past the laggiest peer's ack.
 *
 * Returns `null` to mean "refuse to prune" — used when ANY snapshot-mode
 * peer for this kind is NOT covered by a per-record subscription. The
 * snapshot path has no ack water-mark, so an uncovered snapshot peer
 * can resurrect a pruned tombstone on its next snapshot push. This
 * applies BOTH to "no per-record subs at all" AND to "mixed deployment
 * where peer-A has per-record subs but peer-B is snapshot-only" — both
 * cases leave at least one peer un-acked, so both must refuse.
 *
 * Otherwise: subtract grace from `min(now, minAckedAcrossPeers)`. The
 * `Math.min` collapses the two safe branches into one formula:
 *   - no peers at all (no subs, no snapshot peers) → minAck=Infinity →
 *     cutoff = now - grace
 *   - every snapshot peer also has a per-record sub → minAck < now →
 *     cutoff = minAck - grace
 *
 * @returns {number|null} the cutoff ms-epoch (or null to refuse).
 */
async function cutoffForKind(recordKind, { now = Date.now() } = {}) {
  const peerIds = await peerIdsSubscribedToKind(recordKind);
  const snapshotPeerIds = await snapshotPeerIdsForKind(recordKind);
  // Snapshot-mode peers NOT covered by per-record subscriptions have no
  // ack horizon — refuse to prune until every snapshot peer is covered
  // OR they're disabled (the filter in snapshotPeerIdsForKind drops them).
  const subbed = new Set(peerIds);
  const uncovered = snapshotPeerIds.filter((id) => !subbed.has(id));
  if (uncovered.length > 0) return null;
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
