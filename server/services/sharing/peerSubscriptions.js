/**
 * Peer-subscription store: per-(peer, record) subscription rows, the fire-and-forget
 * background-operation registry and the debounce timer map that `peerSync.js` drives.
 *
 * A LEAF of the peer-sync cluster: `peerSync.js` (public entry) imports `peerSyncReceive.js`,
 * which needs `findPeerSubscription` / `subscribePeer`. Declaring them here removes that ESM
 * cycle (#5919) without a dynamic `await import()`; `peerSync.js` re-exports this surface.
 */
import { initCursor, removeCursor as removeTombstoneCursor } from './peerTombstoneCursors.js';
import {
  PEER_SUBSCRIBABLE_KINDS,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  makeErr,
  subscriptionId,
  readState,
  writeState,
  withStateLock,
} from './peerSyncShared.js';
import { pushRecordToPeer } from './peerSyncPush.js';
import { getOutboundCoverageForPeer, listPeerSubscriptions } from './peerOutboundCoverage.js';
import { isNonBlankStr } from '../../lib/textUtils.js';

export { getOutboundCoverageForPeer, listPeerSubscriptions };

// subId → Timeout for the debounced push scheduler; here because `unsubscribePeer` must cancel a pending timer (`peerSync.js` schedules).
export const pendingTimers = new Map();

// Fire-and-forget work needs an explicit lifecycle so shutdown/tests can wait for it; otherwise an
// initial push can write after a test removes its temp PATHS.data tree (intermittent ENOTEMPTY).
const backgroundOperations = new Set();

export function trackBackgroundOperation(operation) {
  const tracked = Promise.resolve(operation);
  backgroundOperations.add(tracked);
  tracked.finally(() => backgroundOperations.delete(tracked)).catch(() => {});
  return tracked;
}

export async function drainBackgroundOperations() {
  while (backgroundOperations.size > 0) {
    await Promise.allSettled([...backgroundOperations]);
  }
}

// --- Subscription CRUD --------------------------------------------------

export async function findPeerSubscription(peerId, recordKind, recordId) {
  if (!peerId || !recordKind || !recordId) return null;
  const { subscriptions } = await readState();
  return subscriptions.find(
    (s) => s.peerId === peerId && s.recordKind === recordKind && s.recordId === recordId,
  ) || null;
}

/**
 * Create a peer subscription. Idempotent: re-subscribing returns the existing record. The
 * first subscribe initializes the tombstone cursor with `subscribedSince=now`.
 *
 * `opts.adoptedFromReverse` marks a receiver-side reverse-subscribe and suppresses the
 * immediate push (the peer just pushed us its latest; no ping-pong).
 *
 * `opts.awaitInitialPush` AWAITS the first-insert push instead of fire-and-forget (default
 * false so the HTTP route never stalls on a slow peer). Fan-out helpers set it so the
 * push's base-hash stamps settle inside an enclosing `withBaseHashFlushBatch`. Push failure
 * is non-fatal either way.
 */
export async function subscribePeer({ peerId, recordKind, recordId }, opts = {}) {
  if (!PEER_SUBSCRIBABLE_KINDS.includes(recordKind)) {
    throw makeErr(`subscribable kinds are ${PEER_SUBSCRIBABLE_KINDS.join(', ')} (got "${recordKind}")`, ERR_VALIDATION);
  }
  if (!isNonBlankStr(peerId) || !isNonBlankStr(recordId)) {
    throw makeErr('peerId and recordId are required', ERR_VALIDATION);
  }

  const { sub, created } = await withStateLock(async () => {
    const state = await readState();
    const id = subscriptionId({ peerId, recordKind, recordId });
    const now = new Date().toISOString();
    let existing = state.subscriptions.find((s) => s.id === id);
    let wasCreated = false;
    if (!existing) {
      existing = {
        id,
        peerId,
        recordKind,
        recordId,
        createdAt: now,
        updatedAt: now,
        lastPushedAt: null,
        lastPushedHash: null,
        // #3928: full-payload hash of a push that landed ONLY after stripping a top-level key an
        // older peer's strict schema rejects (`manuscriptReview` / `reverseOutline` / `linkedTrack`).
        // `lastPushedHash` stays withheld so the key is re-sent after upgrade; this second water-mark
        // stops an unchanged record re-running the 400 + stripped-retry pair (peerSyncPush.js `pushRecordToPeer`).
        lastPushedLegacyHash: null,
        // Per-(peer,record) confirmed-delivery water-mark (ms epoch), set ONLY when a push for THIS
        // record gets a 2xx. Distinct from the per-peer tombstone ack cursor, which advances to the
        // MAX acked deletedAt: record-B success would otherwise let GC prune A's tombstone before
        // A's delete-push was confirmed. tombstoneGc clamps to the MIN of this field per kind.
        // Lives on the row, so `unsubscribePeer` cleans it up.
        lastConfirmedPushedAt: null,
        // #1922: same contract as `lastConfirmedPushedAt` for confirmed delivery of a BUNDLED
        // `linkedTrack` on a musicVideoProject subscription (peerSyncPush.js
        // `persistPushDeliveryEvidence`, tombstoneGc.js's `track` cutoff); `null` otherwise.
        lastConfirmedTrackBundleAtMs: null,
        adoptedFromReverse: opts.adoptedFromReverse === true,
      };
      state.subscriptions.push(existing);
      await writeState(state);
      wasCreated = true;
    }
    return { sub: existing, created: wasCreated };
  });
  // initCursor manages its own state file, so the subscription lock isn't held across it.
  // `skipCursorInit: true` avoids redundant cursor reads when subscribing many records to one peer.
  if (!opts.skipCursorInit) await initCursor(peerId);

  // Push ONLY on the first insert and not for a reverse-subscribe (the peer just pushed us its
  // latest). Idempotent re-hits MUST NOT re-push (unchanged content would burn an asset-manifest
  // sha-pass); a forced re-push calls pushRecordToPeer(sub) directly.
  if (created && !opts.adoptedFromReverse) {
    const initialPush = trackBackgroundOperation(pushRecordToPeer(sub).catch((err) => {
      console.log(`⚠️ peerSync: initial push failed for ${sub.id}: ${err.message}`);
    }));
    // Fan-out callers await the push inside a flush batch so base-hash stamps land before the terminal flush.
    if (opts.awaitInitialPush) await initialPush;
  }
  // `created` separates a fresh insert from an idempotent hit so auto-subscribe helpers can suppress
  // log spam on re-runs; the HTTP route forwards it as `{ subscription }`.
  return { ...sub, created };
}

export async function unsubscribePeer(id) {
  if (!isNonBlankStr(id)) throw makeErr('subscription id required', ERR_VALIDATION);
  const { sub, stillSubscribed } = await withStateLock(async () => {
    const state = await readState();
    const idx = state.subscriptions.findIndex((s) => s.id === id);
    if (idx < 0) throw makeErr(`Peer subscription not found: ${id}`, ERR_NOT_FOUND);
    const removedSub = state.subscriptions[idx];

    // Cancel any pending debounced push so it doesn't look up a deleted sub.
    const pending = pendingTimers.get(removedSub.id);
    if (pending) {
      clearTimeout(pending);
      pendingTimers.delete(removedSub.id);
    }

    state.subscriptions.splice(idx, 1);
    await writeState(state);
    return {
      sub: removedSub,
      stillSubscribed: state.subscriptions.some((s) => s.peerId === removedSub.peerId),
    };
  });

  // A fully unsubscribed peer has no further claim on tombstones, so drop its cursor (it gates tombstone GC).
  if (!stillSubscribed) {
    await removeTombstoneCursor(sub.peerId).catch(() => {});
  }
  return { id, removed: true };
}
