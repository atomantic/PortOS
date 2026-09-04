/**
 * Peer-subscription store: the per-(peer, record) subscription rows plus the
 * fire-and-forget background-operation registry and the debounce timer map
 * that the scheduler in `peerSync.js` drives.
 *
 * This module exists to be a LEAF of the peer-sync cluster. `peerSync.js` is
 * the public entry point (routes, tools, `sharing/index.js`) and it statically
 * imports `peerSyncReceive.js`; the receiver in turn needs
 * `findPeerSubscription` / `subscribePeer` for its reverse-subscribe path.
 * Declaring them here — and having BOTH modules import the declaring module —
 * removes that two-module ESM cycle (#5919) rather than papering over it with
 * a dynamic `await import()`. `peerSync.js` re-exports this surface so every
 * existing deep importer keeps working unchanged.
 */
import { initCursor, removeCursor as removeTombstoneCursor } from './peerTombstoneCursors.js';
import {
  PEER_SUBSCRIBABLE_KINDS,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  makeErr,
  isNonEmptyStr,
  subscriptionId,
  readState,
  writeState,
  withStateLock,
  KIND_TO_CATEGORY,
} from './peerSyncShared.js';
import { pushRecordToPeer } from './peerSyncPush.js';

// subId → Timeout for the debounced push scheduler. Lives beside the
// subscription rows because `unsubscribePeer` must cancel a pending timer as
// part of removing a row; `peerSync.js` owns the scheduling side.
export const pendingTimers = new Map();

// Fire-and-forget work must remain non-blocking in production, but it still
// needs an explicit lifecycle so shutdown/tests can wait for it. Without this
// registry, an initial push can enqueue subscription/cursor writes after a
// test has started removing its temporary PATHS.data tree, producing an
// intermittent ENOTEMPTY teardown failure.
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

export async function listPeerSubscriptions(filter = {}) {
  const { subscriptions } = await readState();
  return subscriptions.filter((s) => {
    if (filter.peerId && s.peerId !== filter.peerId) return false;
    if (filter.recordKind && s.recordKind !== filter.recordKind) return false;
    if (filter.recordId && s.recordId !== filter.recordId) return false;
    return true;
  });
}

export async function findPeerSubscription(peerId, recordKind, recordId) {
  if (!peerId || !recordKind || !recordId) return null;
  const { subscriptions } = await readState();
  return subscriptions.find(
    (s) => s.peerId === peerId && s.recordKind === recordKind && s.recordId === recordId,
  ) || null;
}

/**
 * Coverage map for the snapshot-sync exclude-set, grouped by snapshot
 * CATEGORY (universe / pipeline / mediaCollections) — NOT by record kind.
 * `series` subscriptions roll into the `pipeline` category (series + its
 * child issues are bundled by the per-record push pipeline), matching the
 * single composite `getPipelineSnapshot` produces.
 *
 * DIRECTION — this is the crux of the Item-A fix. The returned ids are the
 * records THIS instance has OUTBOUND subscriptions for to `peerId` (i.e.
 * records we push to that peer via the per-record pipeline). When THIS
 * instance is the SNAPSHOT SOURCE answering a pull from `peerId`, those
 * exact records are the ones the requester already receives from us via
 * push — so they are the requester's INBOUND coverage and must be excluded
 * from the snapshot we serve it. Everything NOT in these sets (un-subscribed
 * records, and tombstones for records whose sub was torn down) still rides
 * the snapshot, which is what fixes both the partial-subscription gap and
 * the ephemeralize-then-delete tombstone stall.
 *
 * Why outbound-at-the-source and not inbound-at-the-puller: only the source
 * authoritatively knows which records it pushes per-record to the requester.
 * The puller cannot infer that from its own subscription store (every local
 * sub is outbound from the puller's view; a local sub to peer-A does NOT
 * prove peer-A pushes back). Computing the exclude-set at the source closes
 * the inbound-vs-outbound conflation with zero extra round-trips.
 *
 * Returns `{ universe, pipeline, mediaCollections }`, each a `Set<recordId>`.
 */
export async function getOutboundCoverageForPeer(peerId) {
  // Keyed by SNAPSHOT category — this set excludes per-record-subscribed records
  // from the 60s snapshot the source serves a peer. Only kinds that ALSO ride a
  // snapshot category belong here (universe / pipeline / mediaCollections).
  // `author` is intentionally absent: authors sync ONLY via per-record push (no
  // snapshot category), so there's no snapshot to exclude them from. The
  // `coverage[category]?.add` below no-ops for an `author` sub by design — do
  // NOT add an `authors` key here (it would have no consumer in dataSync's
  // snapshot exclude path and would imply a snapshot category that doesn't exist).
  const coverage = { universe: new Set(), pipeline: new Set(), mediaCollections: new Set() };
  if (!isNonEmptyStr(peerId)) return coverage;
  const subs = await listPeerSubscriptions({ peerId });
  for (const sub of subs) {
    const category = KIND_TO_CATEGORY[sub.recordKind];
    if (!category || !isNonEmptyStr(sub.recordId)) continue;
    coverage[category]?.add(sub.recordId);
  }
  return coverage;
}

/**
 * Create a peer subscription. Idempotent — re-subscribing returns the existing
 * record. The first subscribe also initializes the tombstone cursor with
 * `subscribedSince=now` so tombstones older than the subscription aren't
 * replayed to the peer.
 *
 * `opts.adoptedFromReverse` marks the subscription as auto-created by the
 * receiver-side reverse-subscribe path; it suppresses the immediate push so
 * we don't ping-pong (the peer that triggered the reverse just pushed us
 * the latest state by definition).
 *
 * `opts.awaitInitialPush` makes the first-insert push AWAITED instead of
 * fire-and-forget. Default false preserves the non-blocking single-subscribe
 * contract (the HTTP route and one-off subscribes must not stall on a slow
 * peer). The fan-out helpers set it true so the push — and the base-hash
 * stamps inside it — settle synchronously within an enclosing
 * `withBaseHashFlushBatch` scope; otherwise the async stamps escape the scope
 * and the per-record `sync_base_hashes.json` flush can't be coalesced. The
 * push failure stays non-fatal either way (logged, never thrown), so one dead
 * peer can't abort a fan-out loop.
 */
export async function subscribePeer({ peerId, recordKind, recordId }, opts = {}) {
  if (!PEER_SUBSCRIBABLE_KINDS.includes(recordKind)) {
    throw makeErr(`subscribable kinds are ${PEER_SUBSCRIBABLE_KINDS.join(', ')} (got "${recordKind}")`, ERR_VALIDATION);
  }
  if (!isNonEmptyStr(peerId) || !isNonEmptyStr(recordId)) {
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
        // #3928: full-payload hash of the last push that landed ONLY after we
        // stripped a top-level key an older peer's strict schema rejects
        // (`manuscriptReview` / `reverseOutline` / `linkedTrack`).
        // `lastPushedHash` stays withheld in that case so the stripped key is
        // re-sent once the peer upgrades; this second water-mark keeps an
        // unchanged record from re-running the 400 + stripped-retry pair on
        // every sync cycle. See peerSyncPush.js `pushRecordToPeer`.
        lastPushedLegacyHash: null,
        // Per-(peer,record) confirmed-delivery water-mark (ms epoch). Set ONLY
        // when a push to this peer for THIS record lands successfully (the
        // receiver returned 2xx). Distinct from the per-peer tombstone ack
        // cursor (`peer_tombstone_cursors.json`) which advances to the MAX
        // acked deletedAt across ALL of a peer's pushes — a later record-B
        // success would otherwise advance that cursor past a failed record-A,
        // letting GC prune A's tombstone before A's delete-push was ever
        // confirmed. tombstoneGc clamps its prune cutoff to the MIN of this
        // field across a kind's subscription rows, so an unconfirmed record
        // (still `null`, or stuck at a pre-delete success time) holds the
        // line. Lives on the row → cleaned up for free when the row is
        // removed (`unsubscribePeer`), no separate storage to leak.
        lastConfirmedPushedAt: null,
        // #1922: same contract as `lastConfirmedPushedAt`, scoped to confirmed
        // delivery of a BUNDLED `linkedTrack` tombstone/record (#1858) on a
        // musicVideoProject subscription — see peerSyncPush.js
        // `persistPushSuccess` and tombstoneGc.js's `track` cutoff. Stays
        // `null` for every other recordKind.
        lastConfirmedTrackBundleAtMs: null,
        adoptedFromReverse: opts.adoptedFromReverse === true,
      };
      state.subscriptions.push(existing);
      await writeState(state);
      wasCreated = true;
    }
    return { sub: existing, created: wasCreated };
  });
  // initCursor manages its own state file; no need to hold the subscription
  // lock across it. Callers that already initialized the cursor for this
  // peerId (e.g. the backfill loop in `autoSubscribePeerToAllRecords`) can
  // pass `skipCursorInit: true` to avoid N redundant cursor reads + lock
  // acquisitions when subscribing many records to the same peer in sequence.
  if (!opts.skipCursorInit) await initCursor(peerId);

  // Trigger initial push ONLY on the first insert (created=true) — and not
  // when this was auto-created by a reverse-subscribe (the peer just pushed
  // us their latest, so pushing back is a no-op cycle). Idempotent re-hits
  // (auto-subscribe paths walking N existing records, manual re-subscribe,
  // peer:online convergence) MUST NOT re-push: the record's content hasn't
  // moved, so buildPushPayload would burn an asset-manifest sha-pass for a
  // result lastPushedHash will short-circuit anyway. Callers that need a
  // forced re-push can call pushRecordToPeer(sub) directly.
  if (created && !opts.adoptedFromReverse) {
    const initialPush = trackBackgroundOperation(pushRecordToPeer(sub).catch((err) => {
      console.log(`⚠️ peerSync: initial push failed for ${sub.id}: ${err.message}`);
    }));
    // Fan-out callers await the push inside a flush batch so its base-hash
    // stamps land before the batch's terminal flush; the default path leaves it
    // fire-and-forget so a single subscribe never blocks on a slow peer.
    if (opts.awaitInitialPush) await initialPush;
  }
  // `created` distinguishes a freshly-inserted subscription from an idempotent
  // hit on an existing one. Auto-subscribe helpers use this to suppress
  // "🔗 ... auto-subscribed" log spam (and inflated return arrays) on re-runs.
  // The HTTP route forwards this through `{ subscription }` so REST clients
  // can also branch on it.
  return { ...sub, created };
}

export async function unsubscribePeer(id) {
  if (!isNonEmptyStr(id)) throw makeErr('subscription id required', ERR_VALIDATION);
  const { sub, stillSubscribed } = await withStateLock(async () => {
    const state = await readState();
    const idx = state.subscriptions.findIndex((s) => s.id === id);
    if (idx < 0) throw makeErr(`Peer subscription not found: ${id}`, ERR_NOT_FOUND);
    const removedSub = state.subscriptions[idx];

    // Cancel any pending debounced push for this subscription so the timer
    // doesn't fire ~3s later trying to look up a now-deleted sub.
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

  // If this peer no longer has ANY subscriptions, drop its tombstone cursor.
  // The cursor exists to gate tombstone GC against subscribed peers — once
  // the peer is fully unsubscribed it has no further claim on tombstones.
  if (!stillSubscribed) {
    await removeTombstoneCursor(sub.peerId).catch(() => {});
  }
  return { id, removed: true };
}
