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
 *   2. At least `graceMs` has elapsed since the tombstone was created — a
 *      buffer for transient replay / disconnect cases that haven't shown
 *      up in the ack water-mark yet. The orchestrator path uses the 24h
 *      default; the manual-trigger UI / CLI passes `graceMs: 0`.
 *
 * When a record's kind has NO subscribed peers, condition (1) is trivially
 * satisfied (`getMinAckAcrossPeers([])` returns Infinity), so the sweep
 * falls back to a simple "older than grace" check.
 *
 * Issues piggyback on the series subscription model — an issue tombstone
 * is only pushed alongside its parent series's push, so the relevant ack
 * cohort for issue tombstones is "peers subscribed to series".
 */

import { pruneTombstonedUniverses } from '../universeBuilder.js';
import { pruneTombstonedSeries } from '../pipeline/series.js';
import { pruneTombstonedIssues } from '../pipeline/issues.js';
import { pruneTombstonedCollections } from '../mediaCollections.js';
import { listPeerSubscriptions } from './peerSync.js';
import { getMinAckAcrossPeers } from './peerTombstoneCursors.js';
import { getPeers } from '../instances.js';

const GRACE_MS = 24 * 60 * 60 * 1000;

// `peer_subscriptions.json` rows outlive peer removal (no cleanup hook on
// instance delete), and disabled / globally-silenced peers never advance
// their ack cursor. Filtering against this set keeps a stale sub from
// freezing the GC water-mark at peer-removal time.
function eligiblePeerIdSet(peers) {
  return new Set(
    peers
      .filter((p) => p?.enabled && p.syncEnabled !== false)
      .map((p) => p.instanceId)
      .filter(Boolean),
  );
}

function peerIdsSubscribedToKind(subs, peers, recordKind) {
  const eligible = eligiblePeerIdSet(peers);
  return [...new Set(
    subs
      .filter((s) => s.recordKind === recordKind)
      .map((s) => s.peerId)
      .filter((id) => id && eligible.has(id)),
  )];
}

function snapshotCategoryForKind(recordKind) {
  if (recordKind === 'universe') return 'universe';
  if (recordKind === 'series' || recordKind === 'issue') return 'pipeline';
  if (recordKind === 'mediaCollection') return 'mediaCollections';
  return null;
}

// Peers that can resurrect a pruned tombstone via the 60s snapshot loop.
// The snapshot path has no per-peer ack water-mark, so any peer in this set
// that's NOT also covered by a per-record subscription makes pruning unsafe.
// Legacy peers without `syncCategories` fall back to brain+memory only
// (syncOrchestrator.getEffectiveCategories), so they're excluded.
function snapshotPeerIdsForKind(peers, recordKind) {
  const category = snapshotCategoryForKind(recordKind);
  if (!category) return [];
  return peers
    .filter((p) => {
      if (!p?.enabled) return false;
      if (p.syncEnabled === false) return false;
      const cats = p.syncCategories;
      return !!cats && typeof cats === 'object' && cats[category] === true;
    })
    .map((p) => p.instanceId)
    .filter(Boolean);
}

// Returns null when ANY snapshot-mode peer for this kind isn't covered by
// a per-record subscription — without an ack horizon, an offline peer could
// resurrect a pruned tombstone via its next snapshot push. Otherwise the
// cutoff is `min(now, minAck) - graceMs + 1`. The `+1` compensates for the
// strict-less-than comparison the prune helpers use (`deletedAt < beforeMs`);
// without it, a tombstone deleted at the same millisecond as `minAck`
// survives forever under `graceMs:0` (the manual-trigger path). At
// graceMs=24h the 1ms shift is invisible, so the orchestrator path is
// unchanged in practice.
async function cutoffForKind(recordKind, { peers, subs, now, graceMs }) {
  const peerIds = peerIdsSubscribedToKind(subs, peers, recordKind);
  const snapshotPeerIds = snapshotPeerIdsForKind(peers, recordKind);
  const subbed = new Set(peerIds);
  if (snapshotPeerIds.some((id) => !subbed.has(id))) return null;
  const minAck = await getMinAckAcrossPeers(peerIds);
  return Math.min(minAck, now) - graceMs + 1;
}

// Single point of disk I/O for peer registry + subscription rows. Both
// `sweepTombstones` and `getSweepStatus` read these once and thread them
// through the pure helpers, so the orchestrator's 60s loop hits the file
// system twice per cycle instead of six times.
async function loadState() {
  const [peers, subs] = await Promise.all([
    getPeers().catch(() => []),
    listPeerSubscriptions(),
  ]);
  return { peers, subs };
}

function refusedFromCutoffs(universeCutoff, seriesCutoff, collectionCutoff) {
  const refused = [];
  if (universeCutoff === null) refused.push('universe');
  // Issue tombstones ride series pushes — refused exactly when series is.
  if (seriesCutoff === null) {
    refused.push('series');
    refused.push('issue');
  }
  if (collectionCutoff === null) refused.push('mediaCollection');
  return refused;
}

/**
 * One sweep cycle. Returns `{ universes, series, issues, collections, refused }`.
 *
 * `graceMs` defaults to 24h so the orchestrator path is unchanged; the
 * manual-trigger UI / CLI passes 0 to skip the post-delete buffer. The
 * per-kind null-cutoff refusal (snapshot-mode peer with no per-record sub)
 * fires independently of graceMs — `refused` lists kinds we couldn't touch.
 */
export async function sweepTombstones({ now = Date.now(), graceMs = GRACE_MS } = {}) {
  const { peers, subs } = await loadState();
  const [universeCutoff, seriesCutoff, collectionCutoff] = await Promise.all([
    cutoffForKind('universe', { peers, subs, now, graceMs }),
    cutoffForKind('series', { peers, subs, now, graceMs }),
    cutoffForKind('mediaCollection', { peers, subs, now, graceMs }),
  ]);
  const issueCutoff = seriesCutoff;
  const [u, s, i, c] = await Promise.all([
    universeCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedUniverses(universeCutoff),
    seriesCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedSeries(seriesCutoff),
    issueCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedIssues(issueCutoff),
    collectionCutoff === null ? Promise.resolve({ pruned: 0 }) : pruneTombstonedCollections(collectionCutoff),
  ]);
  return {
    universes: u.pruned,
    series: s.pruned,
    issues: i.pruned,
    collections: c.pruned,
    refused: refusedFromCutoffs(universeCutoff, seriesCutoff, collectionCutoff),
  };
}

// Dry-run companion to `sweepTombstones` — returns the refused kinds
// without pruning. Refusal is independent of graceMs (only snapshot
// coverage matters), so this hardcodes graceMs:0 internally.
export async function getSweepStatus({ now = Date.now() } = {}) {
  const { peers, subs } = await loadState();
  const [universeCutoff, seriesCutoff, collectionCutoff] = await Promise.all([
    cutoffForKind('universe', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('series', { peers, subs, now, graceMs: 0 }),
    cutoffForKind('mediaCollection', { peers, subs, now, graceMs: 0 }),
  ]);
  return { refused: refusedFromCutoffs(universeCutoff, seriesCutoff, collectionCutoff) };
}

export const TOMBSTONE_GRACE_MS = GRACE_MS;
