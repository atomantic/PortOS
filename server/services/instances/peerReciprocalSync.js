/** Serialize reciprocal sync requests and apply the mirrored peer configuration. */
import { PROBE_TIMEOUT_MS, peerLogLabel } from './peerRecord.js';
import { autoSubscribePeerToAllRecords } from '../sharing/recordEvents.js';
import { getSelf, loadData, withData } from '../instanceIdentity.js';
import { instanceEvents } from '../instanceEvents.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { DEFAULT_SYNC_CATEGORIES, PER_RECORD_CATEGORY_KINDS, allSyncCategoriesOn, hasOptedInCategory } from '../../lib/instanceSyncCategories.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';

const reciprocalSyncQueue = createKeyCachedQueue();

// Per-peer tail that serializes reciprocal-sync sends. Two rapid category
// toggles for the same peer each want to push the full resulting map; if their
// fire-and-forget requests raced, the earlier (staler) map could land last on
// the peer and undo the newer change. Chaining per peer.id guarantees in-order
// delivery, and each send re-reads the FRESHEST persisted category map (not a
// value captured at enqueue time) so the final send always carries final state.
// Per-peer serialization (silence prior + self-pruning tail) via the shared
// helper — `work` runs on both fulfil and reject of the prior send, so a failed
// send can't break the chain.
export function enqueueReciprocalSync(peerId) {
  return reciprocalSyncQueue(peerId, async () => {
    // Re-read the peer fresh at send time — the last enqueued send wins with
    // the latest persisted syncCategories, regardless of enqueue order.
    const data = await loadData();
    const peer = data.peers.find(p => p.id === peerId);
    if (!peer?.instanceId) return { ok: false, reason: 'no-peer-identity' };
    // For a full-sync peer send the all-on category view (its stored
    // syncCategories can be all-false underneath — sending that raw would tell
    // the peer to DISABLE everything, since reciprocal-sync apply is an
    // authoritative overlay; the all-on map also makes a peer too old to
    // understand the fullSync flag still mirror every category) plus the
    // fullSync flag. A regular peer keeps sending its raw partial map so a
    // category it never set stays untouched on the peer (absent ≠ false).
    const reciprocalCategories = peer.fullSync === true ? allSyncCategoriesOn() : (peer.syncCategories || {});
    return requestReciprocalSync(peer, reciprocalCategories, { fullSync: peer.fullSync === true }).catch((err) => {
      console.log(`⚠️ peer: reciprocal sync request failed: ${err.message}`);
      return { ok: false, reason: err.message };
    });
  });
}

// --- Bidirectional sync reciprocation ---
//
// A single user commonly owns every federated machine and expects enabling a
// sync category toward a peer to make it two-way without also toggling it on
// the peer by hand. Sync is pull-based per direction, so enabling category C
// toward peer B only makes US pull B's C. For B to pull OUR C, B must enable C
// toward US. `requestReciprocalSync` asks B to do exactly that; the peer side
// is `applyReciprocalSync`, invoked by the POST /sync-categories route.
//
// SEMANTICS — full mirror, NOT enable-only (resolved, issue #1094). A peer's
// announced keys are applied as an authoritative overlay onto our existing map
// (`{ ...prev, ...sanitized }`) — announced `false` values are authoritative
// (they DISABLE), while categories the peer omits are preserved untouched. So a
// peer sending `C:false` DISABLES C on our record for that peer even when we had
// independently enabled C toward them. This is intentional, not a bug:
//   - The 'Make mutual' UI deliberately pushes the sender's *current* set
//     (including its disables) so a previously-offline / one-directional peer
//     converges to the sender's view in one round-trip.
//   - It's the recovery path for clearing a stale enabled category after a peer
//     was offline during a disable.
// Treating sync categories as a symmetric mirror (rather than two strictly
// independent per-direction switches) is the chosen model. If a future change
// wants per-direction-independent semantics, 'Make mutual' must grow a separate
// explicit-disable path so reciprocation never clobbers an independent enable —
// don't quietly switch this to enable-only, which would regress the two paths
// above. The full-mirror behavior is pinned by tests in instances.test.js.

// Keep only the keys DEFAULT_SYNC_CATEGORIES defines, coerced to booleans, so a
// peer can never inject unknown/garbage category flags onto our peer record.
function sanitizeSyncCategories(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const key of Object.keys(DEFAULT_SYNC_CATEGORIES)) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Receiver side of reciprocation: a peer is telling us it enabled `categories`
 * toward us and is asking us to mirror them so the sync is bidirectional.
 * Find the local peer record for the announcing instance and apply the same
 * category flags. Returns `{ changed, peer }`; `changed` is false when our
 * record already matched (the echo guard — the caller never re-reciprocates,
 * but this keeps a misbehaving peer from churning our state).
 */
export async function applyReciprocalSync(instanceId, categories, { fullSync } = {}) {
  // The admitted peer's direction and categories are machine-local consent.
  // Anonymous reciprocal callbacks must never broaden or revoke them.
  const sanitized = sanitizeSyncCategories(categories);
  // A fullSync-only signal (peer asking us to mirror everything) is valid even
  // if the category map didn't sanitize to anything actionable. An explicit
  // `fullSync === false` is the peer telling us it STOPPED mirroring us, so we
  // drop our mirror toward it too — keeping enable AND disable symmetric (a peer
  // too old to send the field leaves it undefined, which touches nothing).
  const wantsFullSync = fullSync === true;
  const wantsFullSyncOff = fullSync === false;
  if (!sanitized && !wantsFullSync && !wantsFullSyncOff) return { changed: false, peer: null };
  const turnedOnKinds = [];
  let backfillInstanceId = null;
  let changed = false;
  const peer = await withData(async (data, afterCommit) => {
    const entry = data.peers.find(p => p.instanceId === instanceId);
    if (!entry || entry.syncSecret) return null;
    // Default the baseline so a partial stored map doesn't make absent-vs-false
    // diverge — otherwise sanitized adding `goals:false` to a `prev` missing
    // `goals` reads as a change (`false !== undefined`) and defeats the guard.
    const prev = { ...DEFAULT_SYNC_CATEGORIES, ...(entry.syncCategories || {}) };
    const next = sanitized ? { ...prev, ...sanitized } : prev;
    const fullSyncFlips = wantsFullSync && entry.fullSync !== true;
    const fullSyncOffFlips = wantsFullSyncOff && entry.fullSync === true;
    const categoriesFlip = !Object.keys(next).every(k => next[k] === prev[k]);
    // Does THIS reciprocal request itself ask us to push per-record data back —
    // full mirror, or at least one per-record category carried IN the request?
    // Scope the consent decision to what the peer asked for this time (wantsFullSync
    // / sanitized), NOT the preserved `next` map: a request that only reciprocates a
    // snapshot category (or a per-record kind we merely happen to already have on
    // locally) must not silently widen us to push every locally-enabled kind back.
    // The request is the consent signal, so it also scopes what that consent covers.
    const requestEnablesPushable = wantsFullSync
      || (sanitized ? PER_RECORD_CATEGORY_KINDS.some(([cat]) => sanitized[cat] === true) : false);
    const directions = Array.isArray(entry.directions) ? entry.directions : [];
    // An `/announce`-created peer record is inbound-only (it announced to us; the
    // user here never added it back), and `peerAllowsOutbound` then refuses our
    // pushes — so the backfill below, every future per-record push, and reverse-
    // subscription creation on incoming pushes would all silently no-op, leaving
    // the mirror one-directional. An explicit reciprocal-sync request IS the peer
    // asking us to mirror our data back — its consent to receive our pushes — so
    // adopt `outbound`. Crucially this must hold even when nothing flips: a record
    // that adopted fullSync/categories BEFORE this fix (#1636) but stayed inbound-
    // only never back-fills, and the echo guard below would return first — so the
    // missing direction has to participate in change detection to heal it.
    const needsOutboundAdopt = requestEnablesPushable && directions.length > 0 && !directions.includes('outbound');
    // No-op only when nothing flips AND there's no outbound to adopt — the echo guard.
    if (!fullSyncFlips && !fullSyncOffFlips && !categoriesFlip && !needsOutboundAdopt) return entry;
    if (fullSyncFlips) {
      // Adopting full mirror. fullSync alone drives gating, so the stored
      // per-category map is PRESERVED untouched — we do NOT apply the sender's
      // all-on compat overlay. That keeps the user's own selection intact so a
      // later disable restores it, exactly like the local toggle path. (Legacy
      // receivers that don't understand fullSync fall into the category branch
      // below and mirror via the all-on overlay instead — that's its purpose.)
      entry.fullSync = true;
    } else if (fullSyncOffFlips) {
      // Dropping full mirror: clear the flag. If this SAME reciprocal request
      // also carries a changed per-category selection, adopt it too — otherwise
      // (the old combined branch fell through without touching categories) the
      // peer's intended post-full-sync set would be ignored and the stale
      // preserved map would keep mirroring the wrong categories. With no
      // category change in the request, the preserved map stands (restore path).
      entry.fullSync = false;
      if (categoriesFlip) entry.syncCategories = next;
    } else if (categoriesFlip) {
      entry.syncCategories = next;
    }
    // Adopt outbound consent from the reciprocal request (see needsOutboundAdopt).
    // Inline rather than via markDirection — that helper opens its own withData and
    // would deadlock on this same lock; idempotent (a peer already pushing has
    // outbound and never reaches here, so directions.push is never a duplicate).
    if (needsOutboundAdopt) entry.directions = [...directions, 'outbound'];
    // Recompute from the (possibly preserved) stored map — a full-sync peer is
    // always sync-enabled; otherwise it follows the per-category selection.
    entry.syncEnabled = entry.fullSync === true || hasOptedInCategory(entry.syncCategories);
    // Backfill every per-record kind whose push toward this peer just became
    // viable: a kind that flipped false→true, all kinds when full mirror was just
    // adopted, and — when we just adopted outbound on a previously inbound-only
    // record — every kind already enabled (it was on but never pushed while we
    // couldn't push outbound). autoSubscribePeerToAllRecords is idempotent, so a
    // kind already subscribed is a harmless no-op.
    for (const [cat, kind] of PER_RECORD_CATEGORY_KINDS) {
      const enabledNow = entry.fullSync === true || !!(entry.syncCategories && entry.syncCategories[cat] === true);
      const flippedOn = prev[cat] !== true && next[cat] === true;
      // On a heal (outbound just adopted, no flip) only back-fill kinds THIS request
      // enabled — full mirror, or the specific per-record category it carried — so a
      // heal never pushes a kind the current request didn't authorize.
      const requestEnablesKind = wantsFullSync || !!(sanitized && sanitized[cat] === true);
      if ((fullSyncFlips && enabledNow) || flippedOn || (needsOutboundAdopt && enabledNow && requestEnablesKind)) {
        turnedOnKinds.push(kind);
      }
    }
    if (turnedOnKinds.length > 0) backfillInstanceId = entry.instanceId || null;
    changed = true;
    afterCommit(() => instanceEvents.emit('peers:updated', data.peers));
    return entry;
  });
  if (!peer) return { changed: false, peer: null };
  // Mirror updatePeer's backfill-subscribe so a reciprocally-enabled
  // per-record category (universe/pipeline) pushes our existing records too.
  if (changed && turnedOnKinds.length > 0 && backfillInstanceId) {
    (async () => {
      for (const kind of turnedOnKinds) {
        await autoSubscribePeerToAllRecords(backfillInstanceId, kind).catch((err) => {
          console.log(`⚠️ peer: reciprocal backfill-subscribe ${kind} failed: ${err.message}`);
        });
      }
    })();
  }
  if (changed) {
    const enabledList = sanitized ? Object.keys(sanitized).filter(k => sanitized[k]).join(',') : '';
    console.log(`🔁 Reciprocal sync applied for ${peerLogLabel()}: ${peer.fullSync ? 'full-mirror' : (enabledList || 'none')}`);
  }
  return { changed, peer };
}

/**
 * Sender side: ask `peer` to enable `categories` toward us (mirror what we just
 * enabled toward them). Best-effort and fire-and-forget at the call site — a
 * peer that's offline or on an older version (404s the endpoint) just stays
 * one-directional until the next toggle. Returns `{ ok, reason }`.
 */
export async function requestReciprocalSync(peer, categories, { fullSync } = {}) {
  const self = await getSelf();
  if (!self?.instanceId) return { ok: false, reason: 'no-self-identity' };
  const sanitized = sanitizeSyncCategories(categories);
  // Bail only when there's genuinely nothing to say: no actionable categories
  // AND no full-sync state to communicate. A full-sync DISABLE (fullSync:false)
  // on a peer whose stored category map is empty must still send — otherwise the
  // remote never learns to drop its mirror. `fullSync === undefined` means the
  // caller didn't communicate a full-sync state at all (legacy direct callers).
  if (!sanitized && fullSync === undefined) return { ok: false, reason: 'no-categories' };
  const url = `${peerBaseUrl(peer)}/api/instances/peers/sync-categories`;
  return withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    const res = await peerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Always carry our current full-sync state (true OR false) so a peer new
      // enough to understand it adopts mirror mode on enable AND drops it on
      // disable. Older peers ignore the field; on enable they still mirror via
      // the all-on syncCategories map we sent. syncCategories defaults to {} so
      // the receiver's required-object schema still parses a fullSync-only send.
      body: JSON.stringify({ instanceId: self.instanceId, syncCategories: sanitized || {}, fullSync: fullSync === true }),
      signal
    }, peer);
    if (res.ok) {
      const enabledList = sanitized ? Object.keys(sanitized).filter(k => sanitized[k]).join(',') : '';
      console.log(`🔁 Requested reciprocal sync from ${peerLogLabel()}: ${fullSync === false ? 'full-mirror-off' : (enabledList || 'none')}`);
      return { ok: true };
    }
    // 404 = peer predates this endpoint; not an error worth surfacing loudly.
    return { ok: false, reason: `http-${res.status}` };
  }).catch((err) => ({ ok: false, reason: err.message }));
}
