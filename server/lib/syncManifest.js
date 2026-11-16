/**
 * Snapshot-sync MANIFEST wire contract for always-dirty, per-instance-slot categories such as `usage`.
 *
 * every AI run rewrites `usage.json`, so one instance advancing dragged every other instance's digest across the wire each 60s cycle). The category serves `{ instances: { <slotId>: <lww timestamp> }, tombstones }` (a few hundred bytes) and the puller fetches only slots whose timestamp moved. `isManifestEnvelope(value)` validates `{ data: { instances }, checksum }` (a legacy peer that 404s fails it, so the puller falls back to the whole snapshot); `diffManifestSlots(remoteInstances, localInstances)` returns the sorted slot ids whose REMOTE LWW stamp is strictly newer (compared via `lwwTimestamp.js`, so a tie breaks to what we hold and an unparseable remote stamp never drags a slot across). Consumed by `syncOrchestrator.syncDataCategoryFromPeer`; served by `dataSync.getManifest`. Safe across independently-upgrading installs: **the manifest is the category's checksum** (hashed, not the payload, for BOTH `/checksum` and `/snapshot`, so an older peer knowing only those endpoints sees a checksum changing exactly when a slot advances), and **every leg degrades to the whole snapshot** (no usable manifest → full snapshot; no `slots` filter → serve everything; receivers merge per slot under LWW, so a full payload applies idempotently).
 */

import { isPlainObject } from './objects.js';
import { compareNewerWins } from './lwwTimestamp.js';

/** Hard cap on slot ids per `?slots=` request: a bound on the URL and the server's Set, not a tuning knob (above any real fleet; `peerUsage` stores at most 64). A puller diffing more stale slots must truncate AND leave its cached checksum unadvanced, or the dropped slots are never fetched again. */
export const MAX_MANIFEST_SLOTS = 128;

/** True when `value` is a usable `{ data: { instances }, checksum }` envelope. */
export function isManifestEnvelope(value) {
  return typeof value?.checksum === 'string'
    && value.checksum.length > 0
    && isPlainObject(value?.data)
    && isPlainObject(value.data.instances);
}

/** Slot ids whose REMOTE timestamp is strictly newer than the local one, exactly the slots worth fetching (a never-seen slot is newer: local `undefined` is unparseable so `compareNewerWins` takes the remote). Sorted so the request URL and any test asserting it are deterministic. */
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
