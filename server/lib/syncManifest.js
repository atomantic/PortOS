/**
 * Snapshot-sync MANIFEST wire contract.
 *
 * Most snapshot categories are effectively static, so the checksum
 * short-circuit in `syncOrchestrator` is enough: nothing moved → nothing
 * transfers. `usage` broke that assumption — it is always dirty (every recorded
 * AI run rewrites `usage.json`) and it is a MAP of per-instance slots, so a
 * single instance advancing its counters dragged every other instance's digest
 * across the wire on the next 60s cycle.
 *
 * A manifest fixes the granularity: the category serves
 * `{ instances: { <slotId>: <lww timestamp> }, tombstones }` — a few hundred
 * bytes — and the puller fetches only the slots whose timestamp actually moved.
 *
 * Two rules make it safe across independently-upgrading installs:
 *
 *  - **The manifest is the category's checksum.** A category that serves one
 *    hashes the manifest (not the payload) for BOTH `/checksum` and
 *    `/snapshot`, so an older peer that only knows those two endpoints still
 *    sees a checksum that changes exactly when a slot advances.
 *  - **Every leg degrades to the whole snapshot.** A puller that gets no usable
 *    manifest (older source peer → 404) falls back to the full snapshot, and a
 *    source peer that gets no `slots` filter serves everything. Receivers merge
 *    per slot under LWW either way, so a full payload is always applied
 *    idempotently.
 *
 * Timestamp comparison goes through `lwwTimestamp.js` so the polarity matches
 * every other sync merge: a tie breaks to what we already hold, and an
 * unparseable remote stamp never drags a slot across.
 */

import { isPlainObject } from './objects.js';
import { compareNewerWins } from './lwwTimestamp.js';

/**
 * Hard cap on the slot ids one `?slots=` request may carry — a bound on the URL
 * and on the Set the server builds from it, not a tuning knob. Comfortably
 * above any real fleet (`peerUsage` stores at most 64 instances), but a puller
 * that DOES diff more stale slots than this must truncate AND leave its cached
 * checksum unadvanced, or the slots it dropped are never fetched again.
 */
export const MAX_MANIFEST_SLOTS = 128;

/** True when `value` is a usable `{ data: { instances }, checksum }` envelope. */
export function isManifestEnvelope(value) {
  return typeof value?.checksum === 'string'
    && value.checksum.length > 0
    && isPlainObject(value?.data)
    && isPlainObject(value.data.instances);
}

/**
 * Slot ids whose REMOTE timestamp is strictly newer than the local one — i.e.
 * exactly the slots worth fetching. A slot we have never seen is always newer
 * (local `undefined` is unparseable, so `compareNewerWins` takes the remote).
 * Returned sorted so the request URL — and therefore any test asserting it — is
 * deterministic regardless of map ordering.
 */
export function diffManifestSlots(remoteInstances, localInstances) {
  if (!isPlainObject(remoteInstances)) return [];
  const local = isPlainObject(localInstances) ? localInstances : {};
  const stale = [];
  for (const [slotId, capturedAt] of Object.entries(remoteInstances)) {
    if (typeof slotId !== 'string' || slotId.length === 0) continue;
    if (!compareNewerWins(capturedAt, local[slotId])) continue;
    stale.push(slotId);
  }
  return stale.sort();
}
