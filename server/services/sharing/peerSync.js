/**
 * Federated peer-sync: per-record subscription store + event wiring.
 *
 * This file is the orchestrator + subscription CRUD + the debounced push
 * scheduler + the recordEvents / peer:online listeners. The three sync
 * protocols it used to inline now live in sibling modules (#1830 decomposed the
 * former 4,004-line god file):
 *   - `peerSyncShared.js`   — state machine, constants, peer-capability helpers
 *   - `peerSyncAssets.js`   — asset manifests + receiver-side asset pull
 *   - `peerSyncPush.js`     — outbound push pipeline
 *   - `peerSyncReceive.js`  — receiver-side push handler
 *   - `peerMediaLibrarySync.js` — standalone media-library sync
 *   - `peerCosSync.js`      — CoS history + tasks sync
 *
 * Their public surface is re-exported below so existing importers
 * (routes/peerSync.js, sharing/index.js, dataSync, the test suite, …) keep
 * working unchanged.
 *
 * Transport: pushes POST to the peer's `/api/peer-sync/push` (wired in
 * `server/routes/peerSync.js`) via `peerFetch`. Receiver pulls missing assets
 * back over the sender's `/data/{images,image-refs,videos}/` static mounts.
 */
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { withBaseHashFlushBatch } from '../../lib/conflictJournal.js';
import { recordEvents, registerSubscriptionAdapter } from './recordEvents.js';
import { getInstanceId, getPeers, enqueueReciprocalSync, UNKNOWN_INSTANCE_ID } from '../instances.js';
import { peerSyncPushSchema } from '../../lib/validation.js';
import { instanceEvents } from '../instanceEvents.js';
import { listIssues } from '../pipeline/issues.js';
import { listCollections } from '../mediaCollections.js';
import { listAuthors } from '../authors/index.js';
import { listArtists } from '../artists/index.js';
import { listAlbums } from '../albums/index.js';
import { listTracks } from '../tracks/index.js';
import { listProjects } from '../creativeDirector/local.js';
import { listProjects as listMusicVideoProjects } from '../musicVideo/projects.js';
import { listBoards } from '../moodBoard/index.js';
import { listWorksForSync, listFoldersForSync, listExercisesForSync } from '../writersRoom/sync.js';
import { initCursor, removeCursor as removeTombstoneCursor } from './peerTombstoneCursors.js';
import {
  PEER_SUBSCRIBABLE_KINDS,
  peerSyncEvents,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  ERR_SCHEMA_VERSION_AHEAD,
  makeErr,
  isNonEmptyStr,
  subscriptionId,
  readState,
  writeState,
  withStateLock,
  drainWriteTail,
  DEBOUNCE_MS,
  PUSH_TIMEOUT_MS,
  KIND_TO_CATEGORY,
  peerAllowsOutbound,
  peerHasCategory,
  findPeerById,
} from './peerSyncShared.js';
import { pushRecordToPeer, buildPushPayload } from './peerSyncPush.js';
import { applyIncomingPush } from './peerSyncReceive.js';

// Re-export the decomposed modules' public surface so existing deep importers
// keep working without a re-import. (#1830)
export {
  PEER_SUBSCRIBABLE_KINDS,
  peerSyncEvents,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  ERR_SCHEMA_VERSION_AHEAD,
} from './peerSyncShared.js';
export {
  buildAssetManifest,
  collectCollectionAssetReferences,
  assetIntegrityForRecord,
  assetShaListForRecord,
  diffAssetManifestAgainstLocal,
} from './peerSyncAssets.js';
export { pushRecordToPeer } from './peerSyncPush.js';
export { applyIncomingPush } from './peerSyncReceive.js';
export {
  buildMediaLibraryManifest,
  libraryKindsExcludedByPatterns,
  syncMediaLibraryFromPeer,
  syncMediaLibraryWithAllPeers,
} from './peerMediaLibrarySync.js';
export {
  buildCosHistoryManifest,
  diffCosHistoryManifestAgainstLocal,
  syncCosHistoryFromPeer,
  syncCosHistoryWithAllPeers,
  buildCosTasksPayload,
  syncCosTasksFromPeer,
  syncCosTasksWithAllPeers,
} from './peerCosSync.js';


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
    const initialPush = pushRecordToPeer(sub).catch((err) => {
      console.log(`⚠️ peerSync: initial push failed for ${sub.id}: ${err.message}`);
    });
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

/**
 * When a new local record is created (universe / series), subscribe it to
 * every peer that has the matching category enabled. Idempotent + best-effort
 * — `subscribePeer` short-circuits if a sub already exists, and we swallow
 * per-peer failures so a single offline peer can't block the creation path.
 */
export async function autoSubscribeRecordToAllPeers(recordKind, recordId) {
  if (!PEER_SUBSCRIBABLE_KINDS.includes(recordKind) || !isNonEmptyStr(recordId)) return [];
  const peers = await getPeers().catch(() => []);
  const targets = peers.filter(p => isNonEmptyStr(p.instanceId) && peerAllowsOutbound(p) && peerHasCategory(p, recordKind));
  if (targets.length === 0) return [];
  // Only track + log subscriptions that were *newly created* on this call.
  // `subscribePeer` is idempotent, so a re-run against already-subscribed
  // peers would otherwise return the existing subs and emit misleading
  // "🔗 auto-subscribed" lines on every retry / restart.
  const created = [];
  // Coalesce the base-hash flushes across this fan-out: one record subscribed
  // to N peers fires N initial pushes, each of which would otherwise rewrite
  // sync_base_hashes.json. `awaitInitialPush` keeps each push's stamps inside
  // the batch so the single terminal write covers all N.
  await withBaseHashFlushBatch(async () => {
    for (const peer of targets) {
      const sub = await subscribePeer({ peerId: peer.instanceId, recordKind, recordId }, { awaitInitialPush: true }).catch((err) => {
        console.log(`⚠️ peerSync: auto-subscribe ${recordKind}/${recordId} → ${peer.name || peer.instanceId} failed: ${err.message}`);
        return null;
      });
      if (sub && sub.created) {
        created.push({ peerId: peer.instanceId, subscriptionId: sub.id });
        console.log(`🔗 peerSync: auto-subscribed ${recordKind}/${recordId} → ${peer.name || peer.instanceId}`);
      }
    }
  });
  return created;
}

/**
 * When a peer's syncCategories toggle flips false → true for a category,
 * subscribe every existing local non-deleted record of the matching kind
 * to that peer. Idempotent — re-running is safe.
 *
 * Dynamic imports for the listers avoid a static cycle (peerSync already
 * imports merge entry points from universeBuilder / pipeline.series).
 */
/**
 * List the local, non-deleted, non-ephemeral records of a subscribable kind —
 * the candidate set for both the back-subscribe sweep and full-sync coverage
 * diffing. Ephemeral records are dropped because they can never push (the wire
 * sanitizer short-circuits them) and a sub for one would leave an orphan row.
 * Universe/series listers are dynamic-imported to avoid a static cycle
 * (peerSync already imports their merge entry points).
 */
async function listRecordsForKind(recordKind) {
  let records = [];
  if (recordKind === 'universe') {
    const { listUniverses } = await import('../universeBuilder.js');
    records = await listUniverses({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'series') {
    const { listSeries } = await import('../pipeline/series.js');
    records = await listSeries({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'mediaCollection') {
    records = await listCollections({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'author') {
    records = await listAuthors({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'artist') {
    records = await listArtists({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'album') {
    records = await listAlbums({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'track') {
    records = await listTracks({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'creativeDirectorProject') {
    records = await listProjects({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'moodBoard') {
    records = await listBoards({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'writersRoomWork') {
    // Live works as { id, updatedAt } (full-sync coverage compares updatedAt to
    // detect a stale confirmed push; bare {id} stubs would report a changed
    // manuscript as fully mirrored). Without this branch, enabling the
    // writersRoomWorks category (or full-sync) would backfill nothing.
    records = await listWorksForSync().catch(() => []);
  } else if (recordKind === 'writersRoomFolder') {
    // Live folders as { id, updatedAt } (#1645) — same coverage-compare reason
    // as works. Body-less, so no asset/body manifest backfill.
    records = await listFoldersForSync().catch(() => []);
  } else if (recordKind === 'writersRoomExercise') {
    // Live exercises as { id, updatedAt } (#1645). updatedAt is derived from
    // finishedAt ?? startedAt in the facade so coverage keys on the wire value.
    records = await listExercisesForSync().catch(() => []);
  } else if (recordKind === 'musicVideoProject') {
    records = await listMusicVideoProjects({ includeDeleted: false }).catch(() => []);
  }
  return records.filter(r => r?.ephemeral !== true && isNonEmptyStr(r?.id));
}

export async function autoSubscribePeerToAllRecords(peerId, recordKind) {
  if (!isNonEmptyStr(peerId) || !PEER_SUBSCRIBABLE_KINDS.includes(recordKind)) return [];
  // Re-check the peer is enabled + outbound-capable + still has the category
  // turned on. The caller (instances.updatePeer) already saw the false→true
  // flip inside withData, but this helper is also reachable from other
  // backfill paths and we don't want to push to an inbound-only peer just
  // because the category bit was set. Snapshot read is good enough — peer
  // edits are infrequent compared to subscription pushes.
  const peers = await getPeers().catch(() => []);
  const peer = peers.find(p => p.instanceId === peerId);
  if (!peer || !peerAllowsOutbound(peer) || !peerHasCategory(peer, recordKind)) return [];
  const records = await listRecordsForKind(recordKind);
  if (records.length === 0) return [];
  // Compute the set difference up front: which local records aren't yet
  // subscribed to this peer? The peer:online convergence path fires this
  // helper on every online transition, so the steady-state case (all
  // records already subscribed) must NOT walk N records and N subscribePeer
  // readState calls. A single listPeerSubscriptions + Set diff collapses
  // it to O(K) where K = existing-sub count, with the for-loop body
  // running only for records that genuinely need a new sub.
  const existingSubs = await listPeerSubscriptions({ peerId, recordKind });
  const existingIds = new Set(existingSubs.map(s => s.recordId));
  const missing = records.filter(r => isNonEmptyStr(r.id) && !existingIds.has(r.id));
  if (missing.length === 0) return [];
  // Initialize the tombstone cursor for this peer ONCE up front. Each
  // subsequent subscribePeer call passes `skipCursorInit: true` ONLY when
  // this pre-init succeeded — otherwise we'd silently create subscriptions
  // without a cursor, which breaks the tombstone horizon contract
  // (`subscribedSince` would be unset, so historical deletes could replay).
  // On failure we fall back to per-call initCursor inside subscribePeer,
  // paying the cost of N file reads but preserving correctness.
  const cursorInited = await initCursor(peerId).then(() => true).catch(() => false);
  // Only track newly-created subscriptions so re-runs of this helper (e.g. a
  // second toggle on the same category) don't double-report or noise the
  // backfill log line with already-subscribed records.
  const created = [];
  // Coalesce the base-hash flushes across the backfill: N records subscribed to
  // one peer fire N initial pushes, each of which would otherwise rewrite
  // sync_base_hashes.json. `awaitInitialPush` keeps each push's stamps inside
  // the batch so the single terminal write covers all N.
  await withBaseHashFlushBatch(async () => {
    for (const rec of missing) {
      const sub = await subscribePeer({ peerId, recordKind, recordId: rec.id }, { skipCursorInit: cursorInited, awaitInitialPush: true }).catch((err) => {
        console.log(`⚠️ peerSync: backfill-subscribe ${recordKind}/${rec.id} → ${peerId} failed: ${err.message}`);
        return null;
      });
      if (sub && sub.created) created.push({ recordId: rec.id, subscriptionId: sub.id });
    }
  });
  if (created.length > 0) {
    console.log(`🔗 peerSync: backfill-subscribed ${created.length} ${recordKind} record(s) → ${peerId}`);
  }
  return created;
}

/**
 * Real coverage diff for a (full-sync) peer: of every local subscribable record,
 * how many have a CONFIRMED-delivered subscription to this peer? Backs the
 * Instances UI "fully mirrored ✓ / N pending" indicator.
 *
 * Coverage is computed by diffing actual record IDs against subscriptions whose
 * `lastConfirmedPushedAt` is set — NOT off the BIGSERIAL push cursors (which are
 * sequence numbers, not row counts, and would misreport coverage). A record is
 * "pending" when it has no subscription to this peer OR its subscription hasn't
 * been confirmed-delivered yet. Returns per-kind breakdown plus totals, and
 * `fullyMirrored` (pending === 0).
 */
export async function getFullSyncCoverageForPeer(peerId) {
  const empty = { total: 0, confirmed: 0, pending: 0, fullyMirrored: true, byKind: {} };
  if (!isNonEmptyStr(peerId)) return empty;
  // Each kind's record list + subscription list are independent I/O — fetch all
  // kinds (and the two lists within a kind) concurrently.
  const perKind = await Promise.all(PEER_SUBSCRIBABLE_KINDS.map(async (kind) => {
    const [records, subs] = await Promise.all([
      listRecordsForKind(kind).catch(() => []),
      listPeerSubscriptions({ peerId, recordKind: kind }).catch(() => []),
    ]);
    // Map each subscribed record to its confirmed-delivery water-mark (ms epoch).
    const confirmedAtById = new Map(subs.filter(s => s.lastConfirmedPushedAt).map(s => [s.recordId, s.lastConfirmedPushedAt]));
    // A record counts as mirrored only when a confirmed push covers its CURRENT
    // version — the confirm happened at/after the record's last edit. A record
    // edited after its last confirmed push (peer offline / schema-blocked since)
    // has stale content on the peer, so it's pending, not mirrored. A created-
    // but-never-pushed sub (no water-mark) is pending too.
    const kindTotal = records.length;
    const kindConfirmed = records.filter((r) => {
      const confirmedAt = confirmedAtById.get(r.id);
      if (!confirmedAt) return false;
      const updatedAt = Date.parse(r.updatedAt);
      // No parseable updatedAt → can't prove staleness; trust the confirmation.
      return !Number.isFinite(updatedAt) || confirmedAt >= updatedAt;
    }).length;
    return { kind, total: kindTotal, confirmed: kindConfirmed, pending: kindTotal - kindConfirmed };
  }));
  const byKind = {};
  let total = 0;
  let confirmed = 0;
  for (const k of perKind) {
    byKind[k.kind] = { total: k.total, confirmed: k.confirmed, pending: k.pending };
    total += k.total;
    confirmed += k.confirmed;
  }
  const pending = total - confirmed;
  return { total, confirmed, pending, fullyMirrored: pending === 0, byKind };
}

/**
 * Drop every subscription targeting a given peer. Used when removing a peer
 * from the federation entirely (and by tests).
 */
export async function unsubscribeAllForPeer(peerId) {
  const matching = await listPeerSubscriptions({ peerId });
  const removed = [];
  for (const sub of matching) {
    await unsubscribePeer(sub.id).catch((err) => {
      console.log(`⚠️ peerSync: unsubscribe-all failed for ${sub.id}: ${err.message}`);
    });
    removed.push(sub.id);
  }
  return { removed };
}

/**
 * Drop every subscription tied to a single record (across all peers). Used
 * when a record transitions to ephemeral via PATCH — the user just opted
 * the record out of sync, so the existing subs (one per peer with the
 * matching category enabled) need to go away. Peers keep their last-pushed
 * copy on disk; this just stops future pushes. The user is responsible for
 * any cross-peer cleanup beyond that (e.g., delete the record locally to
 * tombstone-propagate, then mark a fresh record ephemeral).
 *
 * Returns `{ removed, failed }` where `removed` lists subscription ids the
 * unsubscribe call actually completed for, and `failed` lists ids whose
 * unsubscribePeer threw (race with another teardown path, malformed sub
 * id, etc.). Callers can branch on `failed.length > 0` to surface partial
 * failures; today nobody does, but the contract has to be honest so a
 * future caller that DOES want to verify completion can.
 */
export async function unsubscribeAllForRecord(recordKind, recordId) {
  if (!PEER_SUBSCRIBABLE_KINDS.includes(recordKind) || !isNonEmptyStr(recordId)) {
    return { removed: [], failed: [] };
  }
  const matching = await listPeerSubscriptions({ recordKind, recordId });
  const removed = [];
  const failed = [];
  for (const sub of matching) {
    const ok = await unsubscribePeer(sub.id).then(() => true).catch((err) => {
      console.log(`⚠️ peerSync: unsubscribe-for-record failed for ${sub.id}: ${err.message}`);
      return false;
    });
    if (ok) {
      removed.push(sub.id);
    } else {
      failed.push(sub.id);
    }
  }
  return { removed, failed };
}

/**
 * Drop peer subscriptions whose target record no longer resolves AT ALL —
 * not even as a tombstone. The tombstone GC path (`pruneTombstonedUniverses`
 * / `pruneTombstonedSeries` in tombstoneGc.js) rm's a pruned record's
 * directory but leaves its rows in `peer_subscriptions.json`: on the next
 * `peer:online`, `retryPendingPushesForPeer` walks them, `buildPushPayload`
 * returns null ("record-not-found"), and the push silently no-ops — harmless,
 * but it inflates the "retrying N pending pushes" log count and keeps the
 * peer's tombstone cursor pinned by a dead row.
 *
 * `resolver(recordKind, recordId) => Promise<boolean>` returns true when the
 * record still exists in ANY form (live OR tombstoned). Only subs whose
 * resolver returns false are dropped. A tombstoned-but-not-yet-pruned record
 * still resolves true, so its sub survives to push the delete to peers — we
 * strip a sub only once the underlying record directory is actually gone.
 *
 * Mirrors the orphan-base-hash sweep's conservative contract: a resolver that
 * throws is treated as "still resolves" so a transient listing failure can
 * never trigger a false strip. Malformed rows (missing recordKind/recordId)
 * are left untouched — they're a separate concern from the dir-gone orphan
 * this sweep targets.
 *
 * Returns `{ pruned, removed }` — count and ids of dropped subscriptions.
 */
export async function pruneOrphanedPeerSubscriptions(resolver) {
  if (typeof resolver !== 'function') return { pruned: 0, removed: [] };
  const subs = await listPeerSubscriptions();
  const removed = [];
  for (const sub of subs) {
    if (!isNonEmptyStr(sub?.recordKind) || !isNonEmptyStr(sub?.recordId)) continue;
    const exists = await resolver(sub.recordKind, sub.recordId).catch(() => true);
    if (exists) continue;
    const ok = await unsubscribePeer(sub.id).then(() => true).catch((err) => {
      console.log(`⚠️ peerSync: orphan-subscription sweep failed for ${sub.id}: ${err.message}`);
      return false;
    });
    if (ok) removed.push(sub.id);
  }
  return { pruned: removed.length, removed };
}
// A record pull returns JSON (the record + its asset *manifest* of hashes, not
// the bytes). Even a large series+issues record is metadata, so 16MB is a
// generous ceiling that still caps a buggy/runaway peer's response.
const RECORD_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

// --- Listener install + debounced trigger -------------------------------

const pendingTimers = new Map(); // subId → Timeout

/**
 * Schedule a debounced push for every subscription whose record was just
 * updated. The 3s window matches the share-bucket subscriptions debounce
 * so a flurry of edits coalesces into one push per ~3s.
 *
 * Issues piggyback on their series' subscription: an issue update triggers
 * a push of the parent series (which re-bundles every issue). This keeps
 * the subscription model simple — users subscribe at universe/series
 * granularity, and child issue edits flow automatically.
 */
export async function triggerPushForRecord(recordKind, recordId) {
  const subs = await collectSubscriptionsForUpdate(recordKind, recordId);
  for (const sub of subs) {
    const existing = pendingTimers.get(sub.id);
    if (existing) clearTimeout(existing);
    const subId = sub.id;
    const t = setTimeout(() => {
      pendingTimers.delete(subId);
      // Re-load the subscription by id rather than reusing the snapshot
      // captured when this timer was scheduled. Three things can have moved
      // since: (1) lastPushedHash advanced (the no-op short-circuit would
      // miss otherwise and re-push redundantly), (2) the sub was unsubscribed
      // (we'd be pushing for nothing), (3) a subsequent edit landed under a
      // newer hash. Reading the live record by id makes the debounced fire
      // safe against all three.
      pushFromFreshSubscription(subId).catch((err) => {
        console.log(`⚠️ peerSync: scheduled push failed for ${subId}: ${err.message}`);
      });
    }, DEBOUNCE_MS);
    if (typeof t.unref === 'function') t.unref();
    pendingTimers.set(sub.id, t);
  }
}

async function pushFromFreshSubscription(subId) {
  const { subscriptions } = await readState();
  const fresh = subscriptions.find((s) => s.id === subId);
  if (!fresh) return; // unsubscribed between schedule and fire
  return pushRecordToPeer(fresh);
}

/**
 * For an `(updated)` event on `(recordKind, recordId)`, return every
 * subscription that should fire a push:
 *   - Direct subscriptions on the record itself.
 *   - For issue updates, the subscription on the parent series (resolved
 *     via `getIssueSeriesId` — see below).
 */
export async function collectSubscriptionsForUpdate(recordKind, recordId) {
  // Direct-subscription kinds: a peer subscribes to the record itself, so an
  // edit/delete fires a push to exactly those subs. mediaCollection belongs
  // here (standalone collections sync per-record) — omitting it would make
  // mediaCollections.js's emitRecordUpdated('mediaCollection', …) inert, so
  // collection edits would only reach peers via initial subscribe / manual
  // force-push, never on subsequent edits.
  if (PEER_SUBSCRIBABLE_KINDS.includes(recordKind)) {
    const direct = await listPeerSubscriptions({ recordKind, recordId });
    // #1858: a track edit must ALSO re-push every music-video project that links
    // it. The linked track's record + master-audio bytes ride the project's push
    // (a `musicVideoProjects`-only subscriber has no direct `track` sub), so
    // without this fan-out the project's audio would go stale on that peer until
    // the project itself is edited. Mirrors the issue→series resolution below.
    if (recordKind === 'track') {
      const projectSubs = await collectMusicVideoSubsForTrack(recordId);
      if (projectSubs.length === 0) return direct;
      const byId = new Map(direct.map((s) => [s.id, s]));
      for (const s of projectSubs) byId.set(s.id, s);
      return [...byId.values()];
    }
    return direct;
  }
  if (recordKind === 'issue') {
    const seriesId = await getIssueSeriesId(recordId);
    if (!seriesId) return [];
    return listPeerSubscriptions({ recordKind: 'series', recordId: seriesId });
  }
  return [];
}

// #1858: every music-video-project subscription whose project links `trackId`.
// Backs the track→project push fan-out in collectSubscriptionsForUpdate so a
// linked-track edit reaches a `musicVideoProjects`-only subscriber. The project
// list is small (per-install), so a full scan on the debounce path is fine —
// same posture as getIssueSeriesId's issue scan below.
async function collectMusicVideoSubsForTrack(trackId) {
  if (!isNonEmptyStr(trackId)) return [];
  const projects = await listMusicVideoProjects({ includeDeleted: false }).catch(() => []);
  const linked = projects.filter((p) => p?.trackId === trackId && isNonEmptyStr(p?.id));
  if (linked.length === 0) return [];
  const subLists = await Promise.all(
    linked.map((p) => listPeerSubscriptions({ recordKind: 'musicVideoProject', recordId: p.id })),
  );
  return subLists.flat();
}

async function getIssueSeriesId(issueId) {
  // Avoid pulling in `getIssue` directly (cyclic risk during init): list
  // the cohort of issues and pick the matching id. The issues file is
  // small (low hundreds at most), so this is fine for the debounce path.
  const issues = await listIssues({ includeDeleted: true }).catch(() => []);
  const found = issues.find((i) => i.id === issueId);
  return found?.seriesId || null;
}

/**
 * Re-fire `pushRecordToPeer` for every subscription targeting `peerId`.
 * Fires on `peer:online` so the federation converges after offline edits
 * or out-of-band file changes (e.g., a cleanup script that wrote tombstones
 * directly to disk while PM2 was offline). The `lastPushedHash` short-
 * circuit inside `pushRecordToPeer` skips the network call for any sub
 * whose record content is byte-identical to what was last pushed, so a
 * steady-state peer:online with N converged records pays N hash passes but
 * zero HTTP requests.
 *
 * Originally this only retried subs with `lastPushedAt == null` (initial
 * push never landed). That left a gap: any state change recorded directly
 * on disk (a CLI cleanup script, a hand-edit, a recovered backup) AFTER an
 * initial push succeeded would never re-push because `lastPushedAt` was
 * set. The unconditional retry + hash short-circuit covers both the
 * "initial push" and "out-of-band drift" cases with the same code path.
 *
 * Failures stay non-fatal — the next `peer:online` (or the user's next
 * edit) gets another attempt.
 */
export async function retryPendingPushesForPeer(peerId) {
  if (!isNonEmptyStr(peerId)) return { walked: 0, pushed: 0 };
  const subs = await listPeerSubscriptions({ peerId });
  if (subs.length === 0) return { walked: 0, pushed: 0 };
  // Separate counter for the log line — only count subs that were never
  // pushed (genuine retries) so steady-state convergence runs stay quiet.
  const neverPushedCount = subs.filter(s => !s.lastPushedAt).length;
  if (neverPushedCount > 0) {
    console.log(`🔄 peerSync: retrying ${neverPushedCount} pending push${neverPushedCount === 1 ? '' : 'es'} → ${peerId}`);
  }
  // Track `walked` (subs we iterated) and `pushed` (HTTP call landed)
  // separately. `walked === pushed` would be misleading at steady state
  // because the lastPushedHash short-circuit inside pushRecordToPeer skips
  // the network call for any sub whose content is unchanged — we still
  // "walked" the sub but never pushed it.
  let pushed = 0;
  // Coalesce the per-push base-hash flushes: this loop pushes every subscribed
  // record in sequence, and each push would otherwise rewrite
  // sync_base_hashes.json once. The flush batch defers them into a single
  // terminal write covering all N records' stamps.
  await withBaseHashFlushBatch(async () => {
    for (const sub of subs) {
      // peer:online fired — re-probe schema-blocked subs immediately (peer
      // may have upgraded since the last 409). Edit-triggered pushes still
      // respect the cooldown.
      const result = await pushRecordToPeer(sub, { bypassSchemaCooldown: true }).catch((err) => {
        console.log(`⚠️ peerSync: retry push failed for ${sub.id}: ${err.message}`);
        return null;
      });
      if (result?.pushed) pushed += 1;
    }
  });
  return { walked: subs.length, pushed };
}

/**
 * Force a push for a specific (peer, kind, record) regardless of the
 * unchanged-hash short-circuit. Resolves or creates the subscription first,
 * then pushes with lastPushedHash nulled so pushRecordToPeer always fires a
 * network call (idempotent LWW on the receiver).
 *
 * `subscribePeer` fires its own initial push on first insert; `forcePushRecord`
 * then force-pushes again. The double-push is acceptable — the receiver's
 * merge*FromSync paths are LWW and the second push is a no-op content-wise.
 */
export async function forcePushRecord(peerId, recordKind, recordId) {
  const existing = await findPeerSubscription(peerId, recordKind, recordId);
  const sub = existing || await subscribePeer({ peerId, recordKind, recordId });
  // Null the lastPushedHash to bypass the unchanged short-circuit in pushRecordToPeer.
  console.log(`🔄 peerSync: force-push ${recordKind}/${recordId} → ${peerId}`);
  return pushRecordToPeer({ ...sub, lastPushedHash: null }, { bypassSchemaCooldown: true });
}

/**
 * Build the push-payload for a single record WITHOUT a subscription — backs the
 * peer-facing `GET /api/peer-sync/record` endpoint so a peer can PULL this
 * record (and its assets) from us. Returns null when the record doesn't exist
 * locally. Same shape `pushRecordToPeer` sends, so the puller reuses
 * `applyIncomingPush` verbatim.
 */
export async function getRecordPayloadForPeer(recordKind, recordId) {
  // Mirror pushRecordToPeer's identity guard: if our self-identity can't be read
  // or isn't initialized yet, do NOT emit a payload — a missing/UNKNOWN
  // sourceInstanceId would 500 here or poison the puller (applyIncomingPush
  // rejects sourceInstanceId='unknown'). Return null → the route 404s.
  const instanceId = await getInstanceId().catch(() => null);
  if (!isNonEmptyStr(instanceId) || instanceId === UNKNOWN_INSTANCE_ID) return null;
  return buildPushPayload({ recordKind, recordId }, instanceId);
}

/**
 * Receiver-initiated PULL — the mirror of forcePushRecord. Fetch a record's
 * push-payload from `peerId` and apply it locally (merging the record + its
 * bundled collection and background-pulling missing asset bytes via
 * applyIncomingPush). Lets a machine that is BEHIND on a record fix itself,
 * instead of "Sync to peer" being the only (push-only) action — which can't
 * help when the LOCAL side is the one missing data. Best-effort: returns
 * `{ pulled, reason?, missingAssets? }`.
 */
export async function pullRecordFromPeer(peerId, recordKind, recordId) {
  const peers = await getPeers().catch(() => []);
  const peer = peers.find((p) => p.instanceId === peerId) || null;
  if (!peer) return { pulled: false, reason: 'peer-not-found' };

  const url = `${peerBaseUrl(peer)}/api/peer-sync/record?kind=${encodeURIComponent(recordKind)}&id=${encodeURIComponent(recordId)}`;
  // Abort a hung peer after PUSH_TIMEOUT_MS — peerFetch has no built-in timeout,
  // so without this a stalled peer would hang the pull (and the UI action)
  // indefinitely. Mirrors the push path; an abort rejects → caught as null →
  // 'peer-unreachable'.
  // maxBytes caps the HTTPS shim's in-memory buffering (see lib/httpClient.js);
  // a buggy/misbehaving peer streaming an oversized body is aborted mid-stream
  // rather than buffered whole. The shim rejects with an "exceed" Error.
  let tooLarge = false;
  const res = await withAbortTimeout(PUSH_TIMEOUT_MS, (signal) =>
    peerFetch(url, { signal, maxBytes: RECORD_PAYLOAD_MAX_BYTES }, peer))
    .catch((err) => {
      if (err?.message?.includes('exceed')) {
        tooLarge = true; // HTTPS shim tripped the cap — same condition as the Content-Length check
        console.log(`⚠️ peerSync: pull-record ${recordKind}/${recordId} exceeded payload cap — ${err.message}`);
      }
      return null;
    });
  if (tooLarge) return { pulled: false, reason: 'payload-too-large' };
  if (!res) return { pulled: false, reason: 'peer-unreachable' };
  if (res.status === 404) return { pulled: false, reason: 'not-on-peer' };
  if (!res.ok) return { pulled: false, reason: `http-${res.status}` };
  // Plain-HTTP path: Node's fetch ignores maxBytes, but Express sets
  // Content-Length on JSON — reject an oversized declared body before buffering.
  const declaredLen = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > RECORD_PAYLOAD_MAX_BYTES) {
    console.log(`⚠️ peerSync: pull-record ${recordKind}/${recordId} declared ${declaredLen} bytes > cap`);
    return { pulled: false, reason: 'payload-too-large' };
  }

  const body = await res.json().catch(() => null);
  // The peer response is untrusted — validate with the SAME schema the inbound
  // /push route uses before handing it to applyIncomingPush.
  const parsed = peerSyncPushSchema.safeParse(body);
  if (!parsed.success) return { pulled: false, reason: 'invalid-payload' };
  // The payload self-reports its origin via `sourceInstanceId`; applyIncomingPush
  // uses it to wire the reverse subscription + pull asset bytes. We fetched from
  // `peer`, so the origin MUST be that peer — a record claiming to originate
  // elsewhere (misconfigured/buggy peer returning the wrong record) would bind
  // our subscription/asset-pull to a peer we never contacted. Reject the mismatch.
  if (parsed.data.sourceInstanceId !== peer.instanceId) {
    return { pulled: false, reason: 'invalid-payload' };
  }
  // Likewise, the payload must be the record we asked for — a buggy peer that
  // returns a different kind/id would otherwise merge unexpected data locally.
  if (parsed.data.kind !== recordKind || parsed.data.record?.id !== recordId) {
    return { pulled: false, reason: 'invalid-payload' };
  }

  console.log(`🔄 peerSync: pull-record ${recordKind}/${recordId} ← ${peer.name || peerId}`);
  const result = await applyIncomingPush(parsed.data);
  return { pulled: true, missingAssets: result?.missingAssets?.length ?? 0 };
}

/**
 * Trigger an immediate full-sync for a single peer: backfill subscriptions for
 * every enabled category and then retry all pending/stale pushes. Best-effort
 * — per-kind failures are swallowed so one bad kind doesn't block the rest.
 */
export async function syncNowForPeer(peerId) {
  const peer = await findPeerById(peerId);
  if (!peer?.instanceId) return { ok: false };
  for (const kind of PEER_SUBSCRIBABLE_KINDS) {
    if (peerHasCategory(peer, kind)) {
      await autoSubscribePeerToAllRecords(peer.instanceId, kind).catch((err) => {
        console.log(`⚠️ peerSync: syncNow backfill ${kind} → ${peerId} failed: ${err.message}`);
      });
    }
  }
  await retryPendingPushesForPeer(peer.instanceId).catch((err) => {
    console.log(`⚠️ peerSync: syncNow retry pushes → ${peerId} failed: ${err.message}`);
  });
  return { ok: true };
}

let onUpdated = null;
let onDeleted = null;
let onPeerOnline = null;

/** Attach the `recordEvents` + `peer:online` listeners — call once during sharing init. */
export function installPeerSyncListener() {
  if (onUpdated) return;
  onUpdated = ({ recordKind, recordId }) => {
    triggerPushForRecord(recordKind, recordId).catch((err) => {
      console.log(`⚠️ peerSync: listener error for ${recordKind}/${recordId}: ${err.message}`);
    });
  };
  recordEvents.on('updated', onUpdated);
  // ALSO listen for `deleted` events so soft-deletes propagate immediately via
  // the per-record push pipeline. `deleteUniverse` / `deleteSeries` emit
  // `recordEvents.deleted` (NOT `updated`); without this listener a delete on
  // a still-subscribed record would only reach peers on the next 60s snapshot
  // cycle (and historically not at all, when the snapshot category was skipped
  // wholesale for subscribed peers). Route delete events through the same
  // `triggerPushForRecord` path: pushRecordToPeer reads the record with
  // `includeDeleted: true` and the wire sanitizer lets tombstones cross even
  // for ephemeral records. (Tombstones for records whose sub was ALREADY torn
  // down — the ephemeralize-then-delete case — have no live sub to push, so
  // they ride the per-peer-scoped snapshot instead: the source no longer
  // excludes them once their sub is gone. See dataSync.getSnapshot's
  // `forPeerId` scoping.)
  onDeleted = ({ recordKind, recordId }) => {
    triggerPushForRecord(recordKind, recordId).catch((err) => {
      console.log(`⚠️ peerSync: delete listener error for ${recordKind}/${recordId}: ${err.message}`);
    });
  };
  recordEvents.on('deleted', onDeleted);
  // On peer:online, drive the local subscription state to convergence with
  // the user's intent. Two cases:
  //
  // (1) Backfill missed at toggle time. `instances.updatePeer` runs the
  //     `autoSubscribePeerToAllRecords` backfill inline ONLY when the peer
  //     already has a known instanceId; for a freshly-added peer that
  //     hasn't been probed yet, instanceId is null and the inline backfill
  //     silently no-ops. By re-running it here for every category the peer
  //     has enabled, we recover that intent the moment the peer comes
  //     online and we learn its instanceId.
  //
  // (2) Initial-push retry. Subscriptions whose `lastPushedAt == null`
  //     (typically because the peer was offline when subscribePeer fired
  //     the initial push) get a second attempt now that the peer is
  //     reachable. Already-pushed subs are filtered inside the helper.
  //
  // Both helpers are idempotent: (1) calls subscribePeer which short-
  // circuits on existing subs, (2) filters by lastPushedAt. Safe to fire
  // both unconditionally per peer:online.
  onPeerOnline = (peer) => {
    if (!peer?.instanceId) return;
    (async () => {
      // peerHasCategory owns the (kind → category) mapping and the fullSync
      // short-circuit, so iterate the kinds and let it decide.
      for (const kind of PEER_SUBSCRIBABLE_KINDS) {
        // peerHasCategory short-circuits true for a full-sync peer, so a peer
        // that came online with its category bits off (or a freshly-added
        // full-sync peer whose instanceId we only just learned) still back-
        // subscribes every kind here.
        if (peerHasCategory(peer, kind)) {
          await autoSubscribePeerToAllRecords(peer.instanceId, kind).catch(() => {});
        }
      }
      await retryPendingPushesForPeer(peer.instanceId).catch(() => {});
      // A full-sync peer added (via defaultPeerFullSync) or toggled before its
      // instanceId was known couldn't be reciprocated by updatePeer — no identity
      // yet. peer:online is the first point we know it, so request the mutual
      // mirror now; otherwise the remote never adopts full-sync until the user
      // clicks "Make mutual". Echo-guarded on the receiver, so a redundant send
      // on a later reconnect is a no-op.
      if (peer.fullSync === true && peer.id) {
        await enqueueReciprocalSync(peer.id).catch(() => {});
      }
    })().catch(() => {});
  };
  instanceEvents.on('peer:online', onPeerOnline);
}

/**
 * Detach the recordEvents + instanceEvents listeners and clear pending
 * debounces. Mirror image of `installPeerSyncListener`. Called from
 * `shutdownSharing` so the peer-sync service has a clean stop/start
 * lifecycle (otherwise listeners leak across server re-inits and pollute
 * test teardown when a follow-up test re-creates events).
 */
export function uninstallPeerSyncListener() {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  if (onUpdated) recordEvents.off('updated', onUpdated);
  if (onDeleted) recordEvents.off('deleted', onDeleted);
  if (onPeerOnline) instanceEvents.off('peer:online', onPeerOnline);
  onUpdated = null;
  onDeleted = null;
  onPeerOnline = null;
}

/**
 * Test-only: full reset including a `writeTail` await so the test can
 * rm-rf its tmpdir without an ENOTEMPTY race. Wraps uninstallPeerSyncListener
 * so the listener-detach logic stays single-sourced.
 */
export async function __resetForTests() {
  uninstallPeerSyncListener();
  await drainWriteTail();
}

/**
 * Test-only: await the in-flight write/push tail WITHOUT resetting state or
 * detaching listeners, so a test can deterministically settle the fire-and-forget
 * pushes a `subscribePeer` kicks off before asserting on the network mock. Awaits
 * twice because a push's `persistPushSuccess` only enqueues on `writeTail` after
 * its `peerFetch` resolves — i.e. a tick after the subscribe returned.
 */
export async function __drainForTests() {
  await drainWriteTail();
  await new Promise((r) => setTimeout(r, 0));
  await drainWriteTail();
}

// Register the subscription-lifecycle implementation with the import-light
// adapter in recordEvents.js. Domain services (universeBuilder, series,
// mediaCollections, instances) call the adapter instead of importing this
// module — peerSync statically imports their merge entry points, so an import
// in the other direction (even a dynamic one) formed a load-order-sensitive
// cycle. Module-load registration is safe: sharing/index.js imports this file
// during server boot, before any HTTP write can fire an adapter call.
registerSubscriptionAdapter({
  autoSubscribeRecordToAllPeers,
  unsubscribeAllForRecord,
  autoSubscribePeerToAllRecords,
});
