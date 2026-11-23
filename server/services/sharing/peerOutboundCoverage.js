/**
 * Read side of the peer-subscription store: subscription lists and the per-peer outbound coverage map.
 *
 * Kept apart from `peerSubscriptions.js` (subscribe/push) so the snapshot source
 * (`dataSync.js`) can compute its exclude-set without the push/receive graph.
 */
import { readState, KIND_TO_CATEGORY } from './peerSyncShared.js';
import { isNonBlankStr } from '../../lib/textUtils.js';

export async function listPeerSubscriptions(filter = {}) {
  const { subscriptions } = await readState();
  return subscriptions.filter((s) => {
    if (filter.peerId && s.peerId !== filter.peerId) return false;
    if (filter.recordKind && s.recordKind !== filter.recordKind) return false;
    if (filter.recordId && s.recordId !== filter.recordId) return false;
    return true;
  });
}

/**
 * Coverage map for the snapshot-sync exclude-set, grouped by snapshot CATEGORY (universe /
 * pipeline / mediaCollections), NOT record kind; `series` rolls into `pipeline`.
 *
 * DIRECTION: the ids are records THIS instance has OUTBOUND subscriptions for to `peerId`.
 * When this instance is the SNAPSHOT SOURCE answering a pull, those are already pushed to the
 * requester, so they are excluded from the snapshot; everything else (un-subscribed records,
 * tombstones of torn-down subs) still rides it. Computed at the source because only it knows
 * what it pushes; the puller's local subs are all outbound from its own view.
 *
 * Returns `{ universe, pipeline, mediaCollections }`, each a `Set<recordId>`.
 */
export async function getOutboundCoverageForPeer(peerId) {
  // Keyed by SNAPSHOT category: only kinds that also ride a snapshot belong here. `author` is
  // absent on purpose (per-record push only), so the `?.add` below no-ops for it; do NOT add an
  // `authors` key (it would imply a nonexistent snapshot category).
  const coverage = { universe: new Set(), pipeline: new Set(), mediaCollections: new Set() };
  if (!isNonBlankStr(peerId)) return coverage;
  const subs = await listPeerSubscriptions({ peerId });
  for (const sub of subs) {
    const category = KIND_TO_CATEGORY[sub.recordKind];
    if (!category || !isNonBlankStr(sub.recordId)) continue;
    coverage[category]?.add(sub.recordId);
  }
  return coverage;
}
