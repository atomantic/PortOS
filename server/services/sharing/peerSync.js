/**
 * Federated peer-sync: per-record subscription store + push pipeline.
 *
 * Sibling of `subscriptions.js` (which targets share-buckets exported to
 * Google Drive). This module targets *other PortOS instances over Tailnet*
 * — when you subscribe Universe X to Peer B, every local edit fires a push
 * to B with the record (sanitized through `syncWire.sanitizeRecordForWire`)
 * plus a manifest of every asset filename the record references. The
 * receiver merges via the existing `merge*FromSync` LWW path and responds
 * with the subset of asset filenames it doesn't yet have on disk; it then
 * pulls those over HTTP from the sender's `/data/images/*` static mount
 * (no sender push — receiver-pulls per the user's locked-in decision).
 *
 * Soft-deletes ride the same push (the record carries `deleted: true,
 * deletedAt`); receiver advances its `peerTombstoneCursors` cursor for the
 * sender to allow GC of the tombstone once every subscribed peer has seen
 * it. Snapshot sync (`dataSync.js` 60s loop) remains the safety net for
 * (peer, kind) pairs that DON'T have per-record subscriptions; the
 * `syncOrchestrator` consults `listPeerSubscriptions` per cycle and skips
 * the snapshot category for any kind a peer-sub already covers.
 *
 * State files (under `data/sharing/`):
 *   - `peer_subscriptions.json` — outgoing subscriptions FROM this instance.
 *     Receiver-side auto-created reverse subscriptions also live here.
 *   - `peer_tombstone_cursors.json` — per-peer tombstone ack water-marks
 *     (managed by `peerTombstoneCursors.js`, this module advances it).
 *
 * Transport: pushes POST to the peer's `/api/peer-sync/push` (wired in
 * `server/routes/peerSync.js`) via `peerFetch` — an HTTPS-or-HTTP node-fetch
 * variant that accepts the Tailnet's self-signed certs. Receiver pulls
 * missing assets back over the sender's `/data/{images,image-refs,videos}/`
 * static mounts (accept-ranges enabled). All five stages of the federated
 * peer-sync project are live: subscription store + asset manifest (this
 * module), HTTP routes (Stage 3), UI + receiver-side asset pull (Stage 4),
 * and tombstone GC (Stage 5; `sharing/tombstoneGc.js`).
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir, sha256File } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getOrComputeImageSha256, sidecarGenParamsHash } from '../../lib/assetHash.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { sanitizeRecordForWire } from '../../lib/syncWire.js';
import { setSyncBaseHash, contentHashForRecord, flushBaseHashes, withBaseHashFlushBatch } from '../../lib/conflictJournal.js';
import { collectAssetReferences } from './exporter.js';
import { imageSidecarName, sanitizeAssetFilename } from './buckets.js';
import { pullSidecarForImage } from './sidecarSync.js';
import { recordEvents, registerSubscriptionAdapter } from './recordEvents.js';
import {
  PORTOS_SCHEMA_VERSIONS,
  RECORD_KIND_SCHEMA_CATEGORIES,
  buildPortosMeta,
  compareSchemaVersions,
  scopeVersionDiff,
  formatVersionGap,
  getPortosVersion,
} from '../../lib/schemaVersions.js';
import { getInstanceId, getPeers, enqueueReciprocalSync, UNKNOWN_INSTANCE_ID } from '../instances.js';
import { peerSyncPushSchema, peerLibraryManifestSchema, peerCosHistoryManifestSchema, peerCosTasksSchema, COS_ARCHIVE_DATE_RE, COS_AGENT_ID_RE, COS_ARCHIVE_FILES } from '../../lib/validation.js';
import { instanceEvents } from '../instanceEvents.js';
import { getUniverse, mergeUniversesFromSync } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync } from '../pipeline/series.js';
import { listIssues, mergeIssuesFromSync } from '../pipeline/issues.js';
import {
  getCollection,
  listCollections,
  findCollectionByUniverseId,
  findCollectionBySeriesId,
  mergeMediaCollectionsFromSync,
} from '../mediaCollections.js';
import {
  getAuthor,
  listAuthors,
  mergeAuthorsFromSync,
  headshotImageFilename,
} from '../authors/index.js';
import {
  getArtist,
  listArtists,
  mergeArtistsFromSync,
  portraitImageFilename,
} from '../artists/index.js';
import {
  getAlbum,
  listAlbums,
  mergeAlbumsFromSync,
  coverImageFilename,
} from '../albums/index.js';
import {
  getTrack,
  listTracks,
  mergeTracksFromSync,
  trackAudioFilename,
} from '../tracks/index.js';
import {
  getProject,
  listProjects,
  mergeProjectsFromSync,
  startingImageFilename,
} from '../creativeDirector/local.js';
import {
  getBoard,
  listBoards,
  mergeBoardsFromSync,
  imageUrlToAppAsset,
} from '../moodBoard/index.js';
import {
  getWorkForSync,
  listWorksForSync,
  mergeWorksFromSync,
  buildWorkBodyManifest,
  diffWorkBodyManifest,
  getFolderForSync,
  listFoldersForSync,
  mergeFoldersFromSync,
  getExerciseForSync,
  listExercisesForSync,
  mergeExercisesFromSync,
} from '../writersRoom/sync.js';
import { WRITERS_ROOM_DRAFT_ASSET_KIND } from '../writersRoom/syncLogic.js';
import { WORK_ID_RE, DRAFT_ID_RE, wrWorkDir, wrDraftPath } from '../writersRoom/_shared.js';
import { parseKey } from '../../lib/mediaItemKey.js';
import {
  initCursor,
  ackDeletesUpTo,
  removeCursor as removeTombstoneCursor,
} from './peerTombstoneCursors.js';

export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(['universe', 'series', 'mediaCollection', 'author', 'artist', 'album', 'track', 'creativeDirectorProject', 'moodBoard', 'writersRoomWork', 'writersRoomFolder', 'writersRoomExercise']);

/**
 * Cross-cutting event bus for the peer-sync receiver. The asset-pull worker
 * emits `asset-arrived` ({ filename, kind, peerId }) when a previously-missing
 * file lands locally; `sharing/index.js` wires that to a socket emission so
 * the client's MediaImage component can swap its "syncing" placeholder for
 * the real bytes without polling. `maybeCreateReverseSubscription` emits
 * `subscription-created` ({ peerId, recordKind, recordId, subId }) when an
 * incoming push auto-creates a reverse subscription, which `sharing/index.js`
 * relays as the `peerSync:subscription:created` socket event so the Instances
 * page can re-fetch that peer's subscriptions without a manual reload.
 */
export const peerSyncEvents = new EventEmitter();
peerSyncEvents.setMaxListeners(100);

export const ERR_NOT_FOUND = 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND';
export const ERR_VALIDATION = 'PEER_SYNC_SUBSCRIPTION_VALIDATION';
// Receiver-side rejection — the incoming payload's `portosMeta.schemaVersions`
// is ahead of our local PORTOS_SCHEMA_VERSIONS for one or more categories,
// so applying the record would corrupt local state. The HTTP route maps this
// to 409 + a structured body { ahead, behind, senderPortosVersion } so the
// sender can persist the gap on the subscription and surface it in the UI.
export const ERR_SCHEMA_VERSION_AHEAD = 'PEER_SYNC_SCHEMA_VERSION_AHEAD';
const makeErr = (message, code, details = null) => {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
};

const STATE_PATH = () => join(PATHS.data, 'sharing', 'peer_subscriptions.json');
const DEBOUNCE_MS = 3000;
const PUSH_TIMEOUT_MS = 30000;

const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

function subscriptionId({ peerId, recordKind, recordId }) {
  return `peer-${recordKind}-${recordId}-${peerId}`;
}

async function readState() {
  await ensureDir(join(PATHS.data, 'sharing'));
  const raw = await readJSONFile(STATE_PATH(), { subscriptions: [] }, { logError: false });
  const subs = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  return { subscriptions: subs };
}

async function writeState(state) {
  await ensureDir(join(PATHS.data, 'sharing'));
  await atomicWrite(STATE_PATH(), state);
}

// Serialize every readState→modify→writeState pair through a single tail
// promise. The push pipeline runs fire-and-forget after each subscribe; its
// `persistPushSuccess` writes race the subscribe's own writes for the same
// file, and a naive concurrent run can clobber a just-persisted record
// (subscribe-s1 reads [u1] from file, push-u1 finishes by writing [u1+meta],
// subscribe-s1 writes [u1, s1] from its stale in-memory copy, AND VICE VERSA
// where push-u1 reads [u1] mid-write and clobbers [u1, s1] with [u1+meta]).
// Single-user / single-instance app, so a module-level tail is sufficient.
let writeTail = Promise.resolve();
function withStateLock(fn) {
  const next = writeTail.then(() => fn(), () => fn());
  writeTail = next.catch(() => {});
  return next;
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

// Map a subscribable record kind to the per-peer `syncCategories` key that
// controls whether auto-subscribe is allowed for that kind. Matches the
// inverse mapping in syncOrchestrator.js `categoriesCoveredByPeerSync`.
const KIND_TO_CATEGORY = Object.freeze({
  universe: 'universe',
  series: 'pipeline',
  mediaCollection: 'mediaCollections',
  author: 'authors',
  artist: 'artists',
  album: 'albums',
  track: 'tracks',
  creativeDirectorProject: 'creativeDirectorProjects',
  moodBoard: 'moodBoards',
  writersRoomWork: 'writersRoomWorks',
  writersRoomFolder: 'writersRoomFolders',
  writersRoomExercise: 'writersRoomExercises',
});

function peerAllowsOutbound(peer) {
  if (!peer || peer.enabled === false) return false;
  // `syncEnabled` is the global "sync this peer at all" toggle (separate from
  // per-category `syncCategories.*`). When the user has globally disabled sync
  // for a peer, auto-subscribe MUST NOT create subscriptions or fire pushes —
  // doing so would leak records to a peer the user explicitly silenced. The
  // per-category check (peerHasCategory) is necessary but not sufficient on
  // its own, because syncCategories can be set independently.
  if (peer.syncEnabled === false) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  if (directions.length > 0 && !directions.includes('outbound')) return false;
  return true;
}

function peerHasCategory(peer, recordKind) {
  const cat = KIND_TO_CATEGORY[recordKind];
  if (!cat) return false;
  // A full-sync ("mirror everything") peer implies every current and future
  // category on — so a newly added subscribable kind is covered with no
  // per-peer change. This is what makes the back-subscribe sweep, the
  // peer:online convergence, and auto-subscribe-on-create all fan a full-sync
  // peer's mirror without enumerating categories by hand.
  if (peer?.fullSync === true) return true;
  const cats = peer?.syncCategories;
  return !!(cats && cats[cat] === true);
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

// --- Asset manifest -----------------------------------------------------

/**
 * Given a record, produce a flat manifest `[{ filename, kind, sha256 }]`
 * the receiver can diff against its local `data/images/` (and friends).
 *
 * Stage 2 scope: direct asset filenames only (`imageRefs`, character sheet
 * pointers, `videoPath`). Job-id resolution (looking up media-job records
 * to find their result filenames) lands alongside the HTTP route wiring in
 * Stage 3 — pulling in the media-job-queue dependency would broaden this
 * module's import graph without a corresponding push-path consumer yet.
 *
 * Assets with no readable SHA (file missing, unreadable) are skipped
 * silently: a sender can't ship bytes it doesn't have on disk, and
 * including a null-hash entry in the manifest would make every receiver
 * diff report the asset as missing even though the sender can't fulfill.
 */
export async function buildAssetManifest(record) {
  const refs = collectAssetReferences(record);
  const out = [];
  // Each kind maps to a different on-disk directory. We compute SHA only
  // for images via the sidecar cache (the canonical content-addressed path);
  // image-refs + videos use `sha256File` on demand and DON'T persist a
  // sidecar — they don't carry the gen-params provenance images do, and
  // adding cache writes here would surprise the broader system.
  for (const filename of refs.directImageFilenames) {
    const entry = await hashImageForManifest(filename);
    if (entry) out.push(entry);
  }
  for (const filename of refs.directImageRefFilenames) {
    const entry = await hashSimpleAsset(filename, 'image-ref', PATHS.imageRefs);
    if (entry) out.push(entry);
  }
  for (const filename of refs.directVideoFilenames) {
    const entry = await hashSimpleAsset(filename, 'video', PATHS.videos);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Map a collection's items array to the `{ directImageFilenames,
 * directImageRefFilenames, directVideoFilenames }` shape consumed by the
 * per-item manifest hashers. Collections store items as
 * `{ kind:'image'|'video', ref, addedAt }` and carry no image-ref kind.
 */
export function collectCollectionAssetReferences(collection) {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  const directImageFilenames = [];
  const directVideoFilenames = [];
  for (const it of items) {
    if (it?.kind === 'image' && typeof it.ref === 'string') directImageFilenames.push(it.ref);
    else if (it?.kind === 'video' && typeof it.ref === 'string') directVideoFilenames.push(it.ref);
  }
  return { directImageFilenames, directImageRefFilenames: [], directVideoFilenames };
}

// Video collection items store the BARE video id (e.g. a UUID), while the
// on-disk file is `<id>.mp4` (today every PortOS-managed video is mp4 —
// confirmed by inspecting video-history.json). The image side stores refs
// WITH the extension already. Append `.mp4` unless the ref already carries an
// extension (defensive — older state may have stamped a filename instead of an
// id, and a future video format would land as `.webm` etc.). Shared by BOTH
// collection manifest builders (`buildCollectionAssetManifest` for standalone
// mediaCollection pushes, `buildAssetManifestForCollection` for the
// linkedCollection bundle) so the two can't diverge on the extension rule.
function collectionVideoRefToFilename(ref) {
  return /\.[a-z0-9]+$/i.test(ref) ? ref : `${ref}.mp4`;
}

async function buildCollectionAssetManifest(collection) {
  const refs = collectCollectionAssetReferences(collection);
  const out = [];
  for (const filename of refs.directImageFilenames) {
    const entry = await hashImageForManifest(filename);
    if (entry) out.push(entry);
  }
  for (const ref of refs.directVideoFilenames) {
    const entry = await hashSimpleAsset(collectionVideoRefToFilename(ref), 'video', PATHS.videos);
    if (entry) out.push(entry);
  }
  return out;
}

function summarizeAssetManifest(manifest) {
  const entries = Array.isArray(manifest) ? manifest : [];
  return {
    assetHashes: entries.map((e) => e.sha256).filter(Boolean).sort(),
    metadataMissing: entries.some((e) => e?.kind === 'image' && !isNonEmptyStr(e.sidecarSha256)),
  };
}

async function buildIntegrityAssetManifest(kind, record) {
  if (kind === 'mediaCollection') return buildCollectionAssetManifest(record);
  if (kind === 'author') return buildAuthorAssetManifest(record);
  if (kind === 'artist') return buildArtistAssetManifest(record);
  if (kind === 'album') return buildAlbumAssetManifest(record);
  if (kind === 'track') return buildTrackAssetManifest(record);
  if (kind === 'creativeDirectorProject') return buildProjectAssetManifest(record);
  if (kind === 'moodBoard') return buildBoardAssetManifest(record);
  if (kind === 'series') {
    const childIssues = await listIssues({ seriesId: record?.id, includeDeleted: true }).catch(() => []);
    const manifestIssues = childIssues.filter(
      (i) => i?.deleted !== true && i?.ephemeral !== true,
    );
    const linkedCollection = await findCollectionBySeriesId(record?.id).catch(() => null);
    return buildAssetManifestForSeries(record, manifestIssues, linkedCollection);
  }
  return buildAssetManifest(record);
}

/**
 * Returns the integrity-facing asset summary for a record: sorted file hashes
 * plus whether any hashed image lacks a gen-params sidecar. `series` mirrors
 * the push manifest path so child issue assets participate in integrity.
 *
 * @param {'universe'|'series'|'mediaCollection'} kind
 * @param {object} record
 * @returns {Promise<{assetHashes:string[], metadataMissing:boolean}>}
 */
export async function assetIntegrityForRecord(kind, record) {
  const manifest = await buildIntegrityAssetManifest(kind, record);
  return summarizeAssetManifest(manifest);
}

/**
 * Back-compat helper for callers/tests that only need hashes.
 *
 * @param {'universe'|'series'|'mediaCollection'} kind
 * @param {object} record
 * @returns {Promise<string[]>} sorted sha256 strings (falsy hashes omitted)
 */
export async function assetShaListForRecord(kind, record) {
  const { assetHashes } = await assetIntegrityForRecord(kind, record);
  return assetHashes;
}

async function hashImageForManifest(filename) {
  // Sanitize before join — a record with `imageRefs` containing a path-
  // traversal filename (peer-pushed via linkedCollection, hand-edited,
  // or import bug) would otherwise let us stat/hash files outside
  // PATHS.images. The share exporter has the same `base !== filename`
  // posture (services/sharing/exporter.js); peer-sync needs to match.
  const safeName = sanitizeAssetFilename(filename);
  if (!safeName) return null;
  const fullPath = join(PATHS.images, safeName);
  const result = await getOrComputeImageSha256(fullPath);
  if (!result) return null;
  // Advertise a sidecarSha256 only when the sidecar carries gen-params beyond
  // the `sha256` cache block. CRITICAL: we hash the GEN-PARAMS ONLY (sorted-key
  // canonical form, `sha256` cache key stripped) via `sidecarGenParamsHash` —
  // NOT the raw sidecar file. The `sha256` block embeds the LOCAL image's
  // mtime+size, so hashing the whole file would never converge across machines
  // (the receiver re-stamps its own mtime after every pull and re-diverges,
  // re-pulling the sidecar every sync cycle). `sidecarGenParamsHash` returns
  // null when there are no gen-params, so we never advertise a hash for a
  // pure cache-only sidecar.
  const sidecarSha256 = sidecarGenParamsHash(result.sidecar);
  return { filename: safeName, kind: 'image', sha256: result.hash, ...(sidecarSha256 ? { sidecarSha256 } : {}) };
}

async function hashSimpleAsset(filename, kind, sourceDir) {
  if (!isStr(sourceDir)) return null;
  const safeName = sanitizeAssetFilename(filename);
  if (!safeName) return null;
  const fullPath = join(sourceDir, safeName);
  if (!existsSync(fullPath)) return null;
  const hash = await sha256File(fullPath).catch(() => null);
  if (!hash) return null;
  return { filename: safeName, kind, sha256: hash };
}

// --- Receiver-side asset diff -------------------------------------------

/**
 * Given an incoming asset manifest, return the subset the local instance
 * does NOT have on disk OR whose local hash differs (peer has a newer
 * render under the same UUID — rare but possible during concurrent edits).
 *
 * The receiver will background-fetch each missing asset from the sender's
 * `/data/{images,image-refs,videos}/<filename>` static mount.
 */
export async function diffAssetManifestAgainstLocal(manifest) {
  if (!Array.isArray(manifest)) return [];
  const missing = [];
  for (const entry of manifest) {
    if (!isPlainObject(entry) || !isStr(entry.filename) || !isStr(entry.kind)) continue;
    const dir = directoryForAssetKind(entry.kind);
    if (!dir) continue;
    // Peer-supplied filenames go straight into a local `join(dir, name)` here
    // and via the receiver's reverse-pull GET in Stage 3 — a malicious peer
    // could probe / hash arbitrary local files with a `../etc/passwd` style
    // entry. Reject anything that isn't a bare basename before any FS op.
    const safeName = sanitizeAssetFilename(entry.filename);
    if (!safeName) continue;
    // Build a sanitized projection: only the known fields the receiver needs
    // to pull. Echoing the raw peer-supplied entry would amplify any
    // junk fields it shipped (large strings, extra kinds, prototype-pollution
    // attempts) into the response — wire-symmetry should not let untrusted
    // input round-trip through our process untouched.
    const sanitizedEntry = {
      filename: safeName,
      kind: entry.kind,
      ...(isStr(entry.sha256) ? { sha256: entry.sha256 } : {}),
      ...(isStr(entry.sidecarSha256) ? { sidecarSha256: entry.sidecarSha256 } : {}),
    };
    const fullPath = join(dir, safeName);
    if (!existsSync(fullPath)) {
      missing.push(sanitizedEntry);
      continue;
    }
    // For images, compute the hash result once up front: it carries both the
    // sha256 AND the parsed sidecar JSON, so the sidecarSha256 comparison below
    // reuses it instead of re-reading the same file (one sidecar read per image
    // instead of two). Only touch the cache machinery when a comparison will
    // actually use it (sha256 or sidecarSha256 advertised by the peer).
    let imageHashResult = null;
    if (entry.kind === 'image' && (isStr(entry.sha256) || isStr(entry.sidecarSha256))) {
      imageHashResult = await getOrComputeImageSha256(fullPath);
    }
    // Compare SHA when the manifest carries one — for ALL kinds, not just
    // images. The image path uses the sidecar cache (fast for the common
    // ~200-asset universe case); image-ref/video stream-hash on demand.
    // Existence-only would let a renamed-in-place asset on the receiver
    // silently mismatch the sender, and the snapshot-sync fallback is the
    // ONLY thing that would catch it 60s later — better to detect on push.
    if (isStr(entry.sha256)) {
      const localHash = entry.kind === 'image'
        ? imageHashResult?.hash ?? null
        : await sha256File(fullPath).catch(() => null);
      if (localHash !== entry.sha256) {
        missing.push(sanitizedEntry);
        continue;
      }
    }
    // Sidecar-only divergence: image bytes are already present and hash-match,
    // but the peer has a gen-params sidecar we're missing or have stale.
    // Pull the entry so the worker can fetch ONLY the sidecar (it checks the
    // image hash before deciding whether to re-pull the image bytes).
    //
    // We MUST recompute the local sidecar hash the SAME way the sender did
    // (`sidecarGenParamsHash` — gen-params only, sorted-key canonical, `sha256`
    // cache block stripped). Hashing the raw sidecar file would never match the
    // sender's gen-params-only hash and would re-flag the image every cycle.
    if (entry.kind === 'image' && isStr(entry.sidecarSha256)) {
      // Reuse the sidecar already loaded by getOrComputeImageSha256; only fall
      // back to a direct read if that result was unavailable (e.g. the image
      // became unreadable between the existsSync check and the stat).
      const localSidecar = imageHashResult?.sidecar
        ?? await readJSONFile(join(PATHS.images, imageSidecarName(safeName)), null, { logError: false });
      const localSidecarHash = sidecarGenParamsHash(localSidecar);
      if (localSidecarHash !== entry.sidecarSha256) missing.push(sanitizedEntry);
    }
  }
  return missing;
}

function directoryForAssetKind(kind) {
  if (kind === 'image') return PATHS.images;
  if (kind === 'image-ref') return PATHS.imageRefs;
  if (kind === 'video') return PATHS.videos;
  if (kind === 'music') return PATHS.music;
  if (kind === 'audio') return PATHS.audio; // #1566 standalone media-library sweep
  return null;
}

// --- Push pipeline (sender side) ----------------------------------------

/**
 * Load the live record, sanitize for wire, build the asset manifest, and
 * POST to the peer's `/api/peer-sync/push`. Updates `lastPushedAt` +
 * `lastPushedHash` on success.
 *
 * `lastPushedHash` lets the listener short-circuit no-op edits — if the
 * sanitized record is byte-for-byte identical to what we last pushed, skip
 * the network round-trip. (Useful when the snapshot-sync path and the
 * per-record push path both fire for the same merge.)
 *
 * For series subscriptions, the push payload bundles the child issues in
 * `record.issues` so the receiver applies the series + every issue
 * atomically per merge cycle. Issue records are filtered through
 * `sanitizeRecordForWire('issue', ...)` too.
 */
// Cool-down between re-probes when a peer has rejected our push for schema-
// version reasons. Without it, every local edit would HTTP-roundtrip a 409
// while the peer is on the older PortOS, spamming the network. The retry
// loop on `peer:online` bypasses this — that's the canonical "did the peer
// upgrade?" probe point.
const SCHEMA_BLOCK_RETRY_COOLDOWN_MS = 5 * 60_000;

async function isSubscriptionRecordTombstone(sub) {
  if (sub.recordKind === 'universe') {
    const record = await getUniverse(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'series') {
    const record = await getSeries(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'mediaCollection') {
    const record = await getCollection(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'author') {
    const record = await getAuthor(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'artist') {
    const record = await getArtist(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'album') {
    const record = await getAlbum(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'track') {
    const record = await getTrack(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'creativeDirectorProject') {
    const record = await getProject(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'moodBoard') {
    const record = await getBoard(sub.recordId, { includeDeleted: true }).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'writersRoomWork') {
    const record = await getWorkForSync(sub.recordId).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'writersRoomFolder') {
    const record = await getFolderForSync(sub.recordId).catch(() => null);
    return record?.deleted === true;
  }
  if (sub.recordKind === 'writersRoomExercise') {
    const record = await getExerciseForSync(sub.recordId).catch(() => null);
    return record?.deleted === true;
  }
  return false;
}

export async function pushRecordToPeer(sub, options = {}) {
  if (
    !isPlainObject(sub)
    || !isNonEmptyStr(sub.peerId)
    || !isNonEmptyStr(sub.recordKind)
    || !isNonEmptyStr(sub.recordId)
  ) {
    return { pushed: false, reason: 'invalid-subscription' };
  }
  // SCHEMA-BLOCK COOLDOWN — if the peer rejected our last push for being
  // schema-ahead, hold off re-probing on every local edit. Re-probes happen
  // on the next `peer:online` (where `retryPendingPushesForPeer` passes
  // `bypassSchemaCooldown: true`) or after the cooldown elapses.
  if (sub.blockedBySchema && !options.bypassSchemaCooldown) {
    const tombstonePush = await isSubscriptionRecordTombstone(sub);
    if (!tombstonePush) {
      const detectedAtMs = Date.parse(sub.blockedBySchema.detectedAt || '');
      const stillCooling = Number.isFinite(detectedAtMs)
        && (Date.now() - detectedAtMs) < SCHEMA_BLOCK_RETRY_COOLDOWN_MS;
      if (stillCooling) {
        return { pushed: false, reason: 'peer-schema-behind-cooldown', blockedBySchema: true };
      }
    }
  }
  const peer = await findPeerById(sub.peerId);
  if (!peer) return { pushed: false, reason: 'peer-not-found' };
  // Re-gate on the same peer flags the auto-subscribe path checks. An
  // existing subscription is NOT a license to keep pushing after the user
  // has globally disabled sync (`syncEnabled: false`), disabled the peer
  // (`enabled: false`), switched the peer to inbound-only (`directions:
  // ['inbound']`), or toggled the matching category off (`syncCategories.*
  // === false`). Without these guards, stale subs would silently outlive
  // the user's intent and leak records on the next edit.
  if (!peerAllowsOutbound(peer)) return { pushed: false, reason: 'peer-disallows-outbound' };
  if (!peerHasCategory(peer, sub.recordKind)) return { pushed: false, reason: 'category-disabled' };

  const ourInstanceId = await getInstanceId().catch(() => null);
  if (!isNonEmptyStr(ourInstanceId) || ourInstanceId === UNKNOWN_INSTANCE_ID) {
    return { pushed: false, reason: 'unknown-local-instance' };
  }

  const payload = await buildPushPayload(sub, ourInstanceId);
  if (!payload) return { pushed: false, reason: 'record-not-found' };

  // No-op short-circuit: don't re-push bytes we already pushed. Hash the
  // FULL logical payload (record + bundled issues + linked collection +
  // asset manifest) — not just the record — so an issue-only edit, an
  // asset-only re-render, a collection-only item add, or a new image
  // landing under the same series still propagates instead of collapsing
  // to "unchanged" because the parent series didn't move.
  // sourceInstanceId is intentionally excluded: it's an envelope field, not
  // a content field, and hashing it would force a re-push every time we
  // bumped instance metadata.
  const hash = simplePayloadHash({
    record: payload.record,
    issues: payload.issues ?? null,
    linkedCollection: payload.linkedCollection ?? null,
    manuscriptReview: payload.manuscriptReview ?? null,
    reverseOutline: payload.reverseOutline ?? null,
    assetManifest: payload.assetManifest ?? [],
    draftBodyManifest: payload.draftBodyManifest ?? [],
  });
  if (sub.lastPushedHash && sub.lastPushedHash === hash) {
    return { pushed: false, reason: 'unchanged', hash };
  }

  const url = `${peerBaseUrl(peer)}/api/peer-sync/push`;
  // peerFetch wraps node-fetch with the Tailnet-insecure agent. fetchWithTimeout
  // can't be reused here because it always calls global fetch (no custom-client
  // hook), so the timeout is enforced inline with an AbortController so a
  // hung peer can't keep the push promise pending forever and block subsequent
  // debounced pushes for the same sub.
  const postPayload = async (body) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    return peerFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, peer).catch((err) => {
      console.log(`⚠️ peerSync: push to ${peer.name || peer.instanceId} failed: ${err.message}`);
      return null;
    }).finally(() => clearTimeout(timeoutId));
  };
  let res = await postPayload(payload);
  // Set when the older-peer retry below strips `manuscriptReview`: the retry
  // succeeds with the review removed, so saving the full-payload hash would
  // make the next push short-circuit as `unchanged` and never deliver the
  // review once that peer upgrades. Withhold the hash (like reviewSyncPending)
  // so the next cycle re-sends.
  let reviewStrippedForLegacyPeer = false;
  // Same as reviewStrippedForLegacyPeer, for the bundled reverse-outline doc —
  // a pre-#1348 peer's strict series schema rejects the `reverseOutline` key, so
  // the retry strips it and we withhold the hash to re-send once it upgrades.
  let outlineStrippedForLegacyPeer = false;
  // MIXED-VERSION COMPAT: an older receiver's push schema is still `.strict()`
  // without a `portosMeta` field, so it 400-rejects our envelope at Zod
  // validation BEFORE its schema-version gate code (which doesn't exist on
  // that version anyway) can run. Detect that specific rejection — Zod emits
  // "Unrecognized key(s) in object: 'portosMeta'" — and retry once without
  // the envelope so the push lands on the older peer. The older peer can't
  // see schemaVersions, but until the user upgrades it that's the
  // best-effort behavior we want (vs. permanently stranded pushes). Once
  // they upgrade, the next push round naturally re-includes `portosMeta`.
  // `catalogBundle` (catalog-federation push enrichment) is a second new
  // top-level key an even-newer-than-version-gate-but-pre-catalog peer's strict
  // schema also rejects. `manuscriptReview` (the bundled "Finish the draft"
  // review doc) is a third — a pre-feature peer's series push schema is still
  // `.strict()` without it, so it 400-rejects a review-bearing series push and
  // would strand the series + issues. This retry is exactly what makes the
  // review's "degrades gracefully on older peers" contract hold (see
  // schemaVersions.js): strip the unknown key the older peer can't parse so the
  // record/issues still land; the review reaches it once it upgrades. Strip
  // whichever key(s) the receiver actually named — surgically, so a peer that
  // supports `portosMeta` but not `catalogBundle`/`manuscriptReview` keeps its
  // version-gate handshake. Zod `.strict()` lists all unrecognized keys in one
  // issue, so a single retry covers all of them.
  // A 400 from the receiver is Zod rejecting our envelope BEFORE its schema-version
  // gate (the 409 path below) runs. Parse the body ONCE and route on which part it
  // couldn't accept — two distinct mixed-version cases share this block:
  if (res && res.status === 400) {
    const errBody = await res.clone().json().catch(() => null);
    const isValidationError = errBody?.code === 'VALIDATION_ERROR';
    const details = Array.isArray(errBody?.context?.details) ? errBody.context.details : [];
    const mentions = (key) => details.some((d) => new RegExp(key).test(`${d?.path || ''} ${d?.message || ''}`));
    if (
      isValidationError
      && (payload.portosMeta || payload.catalogBundle || payload.manuscriptReview || payload.reverseOutline)
      && (mentions('portosMeta') || mentions('catalogBundle') || mentions('manuscriptReview') || mentions('reverseOutline'))
    ) {
      // (1) UNKNOWN ENVELOPE KEY — the peer recognizes the record `kind` but its
      // `.strict()` schema predates a newer top-level key we sent. Strip whichever
      // key(s) it named and retry so the record/issues still land; the stripped
      // feature reaches it once it upgrades (the re-push re-includes the key).
      const legacyPayload = { ...payload };
      const stripped = [];
      if (mentions('portosMeta') && 'portosMeta' in legacyPayload) { delete legacyPayload.portosMeta; stripped.push('portosMeta'); }
      if (mentions('catalogBundle') && 'catalogBundle' in legacyPayload) { delete legacyPayload.catalogBundle; stripped.push('catalogBundle'); }
      if (mentions('manuscriptReview') && 'manuscriptReview' in legacyPayload) { delete legacyPayload.manuscriptReview; stripped.push('manuscriptReview'); reviewStrippedForLegacyPeer = true; }
      if (mentions('reverseOutline') && 'reverseOutline' in legacyPayload) { delete legacyPayload.reverseOutline; stripped.push('reverseOutline'); outlineStrippedForLegacyPeer = true; }
      console.log(
        `ℹ️ peerSync: ${peer.name || peer.instanceId} rejected newer envelope key(s) ${stripped.join(', ')} — retrying push without them`,
      );
      res = await postPayload(legacyPayload);
    } else if (isValidationError && details.some((d) => d?.path === 'kind' && /discriminator|enum/i.test(d?.message || ''))) {
      // (2) UNKNOWN RECORD KIND → schema-version block (NOT a bare http-400 retry).
      // When we introduce a NEW federated record kind (authors did this;
      // mediaCollection had the same gap when it landed), a peer on an older PortOS
      // whose `peerSyncPushSchema` discriminated union has no arm for that `kind`
      // rejects the push at the discriminator — so unlike case (1) there's no
      // smuggled key to drop: the record KIND itself is what the peer can't parse,
      // and retrying changes nothing. Treat it like the 409: persist an empty-gap
      // `peer-pre-feature` block so the SchemaGapBadge surfaces "peer needs to update
      // PortOS to sync <kind>" and the edit-push cooldown engages, instead of letting
      // the sub churn as a bare `http-400` the UI never explains. The block clears on
      // the next successful push once the peer upgrades (same recovery as the 409
      // path). The signal is a `kind`-path discriminator/enum error — a value WE
      // always send as a valid literal, so the only reason a receiver faults on
      // `kind` is that its schema doesn't know this record kind yet.
      await persistSchemaVersionBlock(sub.id, { reason: 'peer-pre-feature' });
      console.warn(
        `⚠️ peerSync: ${peer.name || peer.instanceId} rejected push — its PortOS doesn't recognize the ` +
        `'${sub.recordKind}' record kind yet. Re-tries pause until they upgrade.`,
      );
      return { pushed: false, reason: 'peer-schema-behind', blockedBySchema: true };
    }
  }
  // 409 with `code: SCHEMA_VERSION_AHEAD` means the receiver is on an OLDER
  // PortOS and can't parse our newer storage layout. Persist the gap on the
  // subscription so the Instances UI can surface "Peer X needs to update
  // PortOS to receive your updates" — and short-circuit retries to that
  // peer for the affected record kind. We don't tear down the subscription;
  // when the peer upgrades and reconnects, `peer:online` will re-fire
  // pushRecordToPeer and the next response either clears the block (success)
  // or refreshes the gap info (still behind).
  if (res && res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body?.code === ERR_SCHEMA_VERSION_AHEAD) {
      // The global error handler nests our `err.details` under `context.details`
      // (see server/routes/peerSync.js `mapAndRethrow`), so reach in two levels
      // to get the original payload from the peerSync service.
      const details = isPlainObject(body.context?.details) ? body.context.details : {};
      // `peerPortosVersion` describes the REJECTING peer's PortOS version
      // (what we want to show in the SchemaGapBadge), so read
      // `receiverPortosVersion` from the receiver-supplied details — NOT
      // `senderPortosVersion`, which is our own version round-tripped from
      // the payload we sent.
      await persistSchemaVersionBlock(sub.id, {
        ahead: Array.isArray(details.ahead) ? details.ahead : [],
        behind: Array.isArray(details.behind) ? details.behind : [],
        peerPortosVersion: typeof details.receiverPortosVersion === 'string' ? details.receiverPortosVersion : null,
        peerSchemaVersions: isPlainObject(details.receiverSchemaVersions) ? details.receiverSchemaVersions : null,
      });
      console.warn(
        `⚠️ peerSync: ${peer.name || peer.instanceId} rejected push — peer is on an older PortOS schema. ` +
        `Re-tries will pause until they upgrade. ${formatVersionGap({ ahead: details.ahead || [], behind: details.behind || [] })}`,
      );
      return { pushed: false, reason: 'peer-schema-behind', blockedBySchema: true };
    }
  }
  if (!res || !res.ok) {
    return { pushed: false, reason: res ? `http-${res.status}` : 'network' };
  }
  const body = await res.json().catch(() => null);

  // Push succeeded — clear any prior schema-version block so the sub goes
  // back to normal. Either the peer upgraded or the gap was transient.
  if (sub.blockedBySchema) {
    await clearSchemaVersionBlock(sub.id);
  }

  // Persist push metadata to peer_subscriptions.json, then advance the
  // tombstone cursor in peer_tombstone_cursors.json if the receiver acked
  // any deletions. These are two separate files; a crash between them
  // leaves the cursor un-advanced for one push cycle, which is safe —
  // `ackDeletesUpTo` is monotonic + idempotent, so the receiver re-acks
  // the same deletedAt on the next push and the cursor catches up.
  //
  // ASSETS-STRANDED GUARD: don't save lastPushedHash when the receiver
  // reported missing assets. The receiver pulls them asynchronously,
  // and any pull failure (transient Tailnet flake, rejected
  // Content-Length, receiver restart mid-pull) would otherwise be
  // permanently masked — the next `peer:online` retry would short-
  // circuit on `unchanged` and never re-POST the manifest, so the
  // receiver never gets a fresh asset list to retry against. The
  // record itself still landed (mergeXxxFromSync ran on the receiver),
  // so we just advance `lastPushedAt` without the hash, and the next
  // push cycle will re-send with the same asset manifest until pulls
  // complete (manifest hash-equal pushes are no-ops on the receiver's
  // merge LWW path; only cost is one redundant POST per push cycle
  // until the receiver finishes pulling).
  // Count BOTH generic assets and Writers Room draft bodies as "stranded" — a
  // body the receiver still has to pull keeps the push un-confirmed for the same
  // reason an asset does (a once-failed pull would otherwise be masked by the
  // next `unchanged` short-circuit and the prose body stranded).
  const missingCount = (Array.isArray(body?.missingAssets) ? body.missingAssets.length : 0)
    + (Array.isArray(body?.missingDraftBodies) ? body.missingDraftBodies.length : 0);
  // REVIEW-STRANDED GUARD: the receiver merged the record/issues (returned 2xx)
  // but its bundled manuscript-review merge threw. Withhold lastPushedHash like
  // the missing-assets case so the next push cycle re-sends the review instead
  // of short-circuiting on `unchanged` — the review has no independent
  // reconciliation path, so a saved hash here would strand the update.
  const reviewSyncPending = body?.reviewSyncPending === true || reviewStrippedForLegacyPeer;
  // OUTLINE-STRANDED GUARD: same as the review above — the receiver merged the
  // record/issues but its bundled reverse-outline merge threw (or we stripped
  // the key for a pre-#1348 peer). The outline has no independent reconciliation
  // path, so withhold lastPushedHash to re-send next cycle.
  const outlineSyncPending = body?.outlineSyncPending === true || outlineStrippedForLegacyPeer;
  // This push landed (receiver returned 2xx). Stamp the per-record confirmed-
  // delivery water-mark so tombstoneGc won't prune THIS record's tombstone
  // until its delete-push has been confirmed — even if a later push for a
  // DIFFERENT record advances the per-peer ack cursor past it. We stamp on
  // every confirmed push (not just deletes): a successful pre-delete push
  // establishes the floor, and the subsequent delete-push raises it above
  // the tombstone's deletedAt once it lands. The `missingAssets` case still
  // counts as confirmed delivery of the RECORD (merge ran on the receiver);
  // only the asset-stranded hash is withheld, not the confirmation mark.
  await persistPushSuccess(sub.id, (missingCount > 0 || reviewSyncPending || outlineSyncPending) ? null : hash, { confirmedAtMs: Date.now() });
  if (Number.isFinite(body?.ackedDeletesUpTo) && body.ackedDeletesUpTo > 0) {
    await ackDeletesUpTo(sub.peerId, body.ackedDeletesUpTo).catch(() => {});
  }
  // Conflict-journal base hash: this record's content now lives on the peer too
  // (the record always lands even when assets are still pulling), so stamp the
  // shared-state base for the two journaled kinds. This is the symmetric
  // convergence point to the receiver advancing its base in mergeXxxFromSync —
  // it keeps a peer's echo (reverse-subscription push-back) from later looking
  // like a divergence. Best-effort; never block the push result on a slow DISK
  // — only the filesystem flush runs fire-and-forget. The in-memory stamps ARE
  // awaited: `setSyncBaseHash` just mutates the cached map (no disk I/O), so
  // awaiting it costs nothing once the map is loaded, and it guarantees
  // `_baseDirty` is set before this push returns. That matters under
  // `withBaseHashFlushBatch` — the batch's terminal flush only writes when a
  // stamp landed, so a stamp still pending when the batch closed would be lost
  // until the next flush. The `.catch()` keeps a rejection from escaping.
  if (PEER_SUBSCRIBABLE_KINDS.includes(sub.recordKind) && payload.record) {
    // For mediaCollection, contentHashForRecord hashes only the scalar subset
    // (items are union-merged on the receiver, so the post-push collections are
    // NOT byte-identical — but their scalars converge, which is what the base
    // hash tracks). For universe/series it's the full wire record. Same call
    // either way; the narrowing lives in contentHashForRecord.
    const stamps = [setSyncBaseHash(sub.recordKind, sub.recordId, contentHashForRecord(sub.recordKind, payload.record))];
    // A series push bundles its child issues (`payload.issues`, already in
    // wire form). The receiver seeds each issue's base hash on insert in
    // mergeIssuesFromSync; stamp the SAME base here so the SENDER side also
    // detects the first issue divergence on a later push-back. Issues never
    // carry their own subscription — they ride the series push — so this is
    // the only place the origin can seed an `issue`-keyed base hash. Without
    // it, issue conflict journaling would be one-sided (receiver-only).
    if (sub.recordKind === 'series' && Array.isArray(payload.issues)) {
      for (const issue of payload.issues) {
        if (issue?.id) stamps.push(setSyncBaseHash('issue', issue.id, contentHashForRecord('issue', issue)));
      }
    }
    await Promise.all(stamps).catch((err) => console.log(`⚠️ peerSync: base-hash stamp after push failed: ${err?.message || err}`));
    // Non-blocking disk write. Inside a flush batch this is a no-op (the batch's
    // terminal flush coalesces every record's stamps into one rewrite); outside
    // a batch it fires async exactly as before.
    flushBaseHashes().catch((err) => console.log(`⚠️ peerSync: base-hash flush after push failed: ${err?.message || err}`));
  }
  return {
    pushed: true,
    hash,
    response: body || {},
    missingAssets: Array.isArray(body?.missingAssets) ? body.missingAssets : [],
  };
}

async function persistPushSuccess(subId, hash, { confirmedAtMs = Date.now() } = {}) {
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub) return;
    const now = new Date().toISOString();
    sub.lastPushedAt = now;
    sub.lastPushedHash = hash;
    sub.updatedAt = now;
    // Advance the per-record confirmed-delivery water-mark monotonically — an
    // out-of-order retry must not retract it (mirrors ackDeletesUpTo's
    // never-move-backward guarantee). tombstoneGc reads MIN-of-this across a
    // kind's rows, so a regression here would let a stale tombstone prune.
    if (Number.isFinite(confirmedAtMs) && confirmedAtMs > (sub.lastConfirmedPushedAt ?? 0)) {
      sub.lastConfirmedPushedAt = confirmedAtMs;
    }
    // A successful push (or even a no-asset-stranded push) clears any prior
    // schema-version block — the peer can receive again.
    if (sub.blockedBySchema) delete sub.blockedBySchema;
    await writeState(state);
  });
}

/**
 * Persist a `blockedBySchema` field on the subscription so subsequent pushes
 * short-circuit until the peer upgrades. Stored on the same record as
 * `lastPushedAt` / `lastPushedHash` so the Instances UI can read everything
 * from a single subscription fetch. We capture both directions of the gap
 * (`ahead` = what the PEER needs to gain to receive our pushes; `behind` =
 * what the peer has that we don't — informational) along with the peer's
 * PortOS version string for the user-visible message.
 */
async function persistSchemaVersionBlock(subId, { ahead, behind, peerPortosVersion, peerSchemaVersions, reason = 'schema-version-ahead' }) {
  // Capture peerId inside the lock so the emitted event carries it — lets each
  // Instances PeerCard filter on its own peer instead of every card refetching.
  let blockedPeerId = null;
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub) return;
    blockedPeerId = sub.peerId || null;
    const now = new Date().toISOString();
    sub.blockedBySchema = {
      detectedAt: now,
      // `schema-version-ahead` = the 409 version-gate path (the peer parsed our
      // envelope but its per-category gate rejected an ahead schema). `peer-pre-feature`
      // = the 400 unknown-kind path below (the peer's push schema has no arm for
      // this record kind at all, so it 400s at Zod before the gate runs). Both
      // surface the same SchemaGapBadge + engage the same cooldown; the marker just
      // distinguishes them in state/logs.
      reason,
      ahead: Array.isArray(ahead) ? ahead : [],
      behind: Array.isArray(behind) ? behind : [],
      peerPortosVersion: peerPortosVersion || null,
      peerSchemaVersions: peerSchemaVersions || null,
    };
    sub.updatedAt = now;
    await writeState(state);
  });
  peerSyncEvents.emit('subscription-blocked', { subId, peerId: blockedPeerId });
}

async function clearSchemaVersionBlock(subId) {
  let clearedPeerId = null;
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub || !sub.blockedBySchema) return;
    clearedPeerId = sub.peerId || null;
    delete sub.blockedBySchema;
    sub.updatedAt = new Date().toISOString();
    await writeState(state);
  });
  peerSyncEvents.emit('subscription-unblocked', { subId, peerId: clearedPeerId });
}

async function buildPushPayload(sub, sourceInstanceId) {
  const portosMeta = await buildPortosMeta();
  if (sub.recordKind === 'universe') {
    const record = await getUniverse(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('universe', record);
    if (!sanitized) return null;
    // Look up the linked media collection (auto-managed "Universe: X" bucket)
    // and bundle it in the payload. Without this, collection-only edits (a
    // new image added to the universe's gallery) wouldn't move the universe
    // record itself, so the lastPushedHash short-circuit would treat the
    // push as "unchanged" and the receiver's collection would diverge
    // permanently. Tombstone pushes skip the collection bundle — a deleted
    // universe's collection gets unlinked + orphaned locally, and shipping
    // it would re-create an empty bucket on the receiver.
    const linkedCollection = record.deleted === true
      ? null
      : await findCollectionByUniverseId(sub.recordId).catch(() => null);
    // Tombstone push: deleted records carry no on-disk assets the receiver
    // should pull. Sending an empty manifest avoids triggering
    // pullMissingAssetsFromPeer for a record we're telling the peer to
    // delete — both wasteful (network + disk for bytes the receiver will
    // immediately orphan) and privacy-sensitive (e.g. a record deleted
    // BECAUSE the user wanted the assets off-peer would otherwise still
    // ship them with the tombstone push).
    const assetManifest = record.deleted === true
      ? []
      : await buildAssetManifestWithCollection(record, linkedCollection);
    // Bundle the catalog rows referenced by this universe (ingredients + the
    // universe→ingredient ref links). The embedded canon already replicates
    // via the universe record, but the catalog row's enrichments (tags,
    // embedding, payload.summary) live ONLY in Postgres — without this bundle
    // the receiver re-derives a strictly-lossy view on its first backfill.
    // Skip for tombstone pushes (the universe is being deleted; its ref rows
    // tombstone locally and ride a later catalog-sync cycle if needed).
    const catalogBundle = record.deleted === true
      ? null
      : await buildCatalogBundleForRef('universe', sub.recordId);
    return {
      kind: 'universe',
      record: sanitized,
      assetManifest,
      sourceInstanceId,
      portosMeta,
      ...(linkedCollection ? { linkedCollection } : {}),
      ...(catalogBundle ? { catalogBundle } : {}),
    };
  }
  if (sub.recordKind === 'series') {
    const record = await getSeries(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('series', record);
    if (!sanitized) return null;
    // Bundle child issues — the series + its issues form one unit of edit
    // for downstream consumers (panels, comic pages), so the receiver
    // applies them atomically per merge cycle.
    const childIssues = await listIssues({ seriesId: sub.recordId, includeDeleted: true }).catch(() => []);
    const sanitizedIssues = childIssues
      .map((i) => sanitizeRecordForWire('issue', i))
      .filter(Boolean);
    // Drop ephemeral child issues BEFORE feeding into the asset-manifest
    // builder. sanitizedIssues above already filters them via
    // sanitizeRecordForWire's ephemeral check, but the asset-manifest builder
    // takes the raw `childIssues` array — without the parallel filter here,
    // ephemeral issues' image / video / image-ref filenames would still
    // appear in the manifest the receiver pulls. The user-visible effect:
    // private/scratch image bytes for an issue the user said "don't sync"
    // would land on every peer's disk via pullMissingAssetsFromPeer.
    // ALSO drop deleted child issues from the manifest input — their
    // tombstones still ride along in `sanitizedIssues` (so the receiver
    // can finish its delete cascade), but shipping the deleted issues'
    // asset filenames would trigger needless / privacy-sensitive pulls
    // for bytes that are about to be orphaned on the receiver.
    // Tombstoned ephemeral issues (deleted=true + ephemeral=true) ALSO
    // stay out of the manifest input by this filter.
    const manifestIssues = childIssues.filter(
      (i) => i?.deleted !== true && i?.ephemeral !== true,
    );
    // Same collection-bundle reasoning as the universe branch: a "Series: X"
    // collection's item changes don't move the series record, so without
    // bundling the collection here the per-record push would short-circuit
    // and the receiver's collection would diverge.
    const linkedCollection = record.deleted === true
      ? null
      : await findCollectionBySeriesId(sub.recordId).catch(() => null);
    // Tombstone push at the series level: same reasoning as universe above.
    // When the series itself is deleted, send an empty asset manifest so
    // the receiver doesn't pull bytes for a record it's about to tombstone.
    const assetManifest = record.deleted === true
      ? []
      : await buildAssetManifestForSeries(record, manifestIssues, linkedCollection);
    // Bundle the manuscript-review sibling doc (the "Finish the draft" comment
    // set) so review-only edits — which don't move the series record — still
    // propagate. Same reasoning as the linkedCollection bundle above: the
    // review rides the payload AND the push hash, defeating the lastPushedHash
    // short-circuit. Skip for tombstones (a deleted series ships no review).
    // Dynamic import keeps manuscriptReview's arcPlanner graph off peerSync's
    // boot load path (matches the catalogBundle pattern).
    const manuscriptReview = record.deleted === true
      ? null
      : await import('../pipeline/manuscriptReview.js')
        .then(({ getReview }) => getReview(sub.recordId))
        .catch(() => null);
    // Bundle the reverse-outline sibling doc (the scene-by-scene segmentation)
    // on the same terms as the review above: a regenerate-only change doesn't
    // move the series record, so without bundling it the per-record push would
    // short-circuit and the receiver's outline would diverge. Only a `complete`
    // outline is worth shipping. Skip for tombstones. Dynamic import keeps
    // reverseOutline's arcPlanner graph off peerSync's boot load path.
    const reverseOutline = record.deleted === true
      ? null
      : await import('../pipeline/reverseOutline.js')
        .then(({ getStoredOutline }) => getStoredOutline(sub.recordId))
        .catch(() => null);
    return {
      kind: 'series',
      record: sanitized,
      issues: sanitizedIssues,
      assetManifest,
      sourceInstanceId,
      portosMeta,
      ...(linkedCollection ? { linkedCollection } : {}),
      ...(manuscriptReview && manuscriptReview.comments?.length ? { manuscriptReview } : {}),
      ...(reverseOutline && reverseOutline.status === 'complete' ? { reverseOutline } : {}),
    };
  }
  if (sub.recordKind === 'mediaCollection') {
    const record = await getCollection(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('mediaCollection', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildCollectionAssetManifest(record);
    return { kind: 'mediaCollection', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'author') {
    const record = await getAuthor(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('author', record);
    if (!sanitized) return null;
    // Tombstone push ships no assets — the receiver is about to delete the
    // record, so pulling its headshot would be wasteful + privacy-sensitive
    // (same reasoning as the universe/series branches above).
    const assetManifest = record.deleted === true ? [] : await buildAuthorAssetManifest(record);
    return { kind: 'author', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'artist') {
    const record = await getArtist(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('artist', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildArtistAssetManifest(record);
    return { kind: 'artist', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'album') {
    const record = await getAlbum(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('album', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildAlbumAssetManifest(record);
    return { kind: 'album', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'track') {
    const record = await getTrack(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('track', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildTrackAssetManifest(record);
    return { kind: 'track', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'creativeDirectorProject') {
    const record = await getProject(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('creativeDirectorProject', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildProjectAssetManifest(record);
    return { kind: 'creativeDirectorProject', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'moodBoard') {
    const record = await getBoard(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('moodBoard', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildBoardAssetManifest(record);
    return { kind: 'moodBoard', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'writersRoomWork') {
    const record = await getWorkForSync(sub.recordId).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('writersRoomWork', record);
    if (!sanitized) return null;
    // The work manifest carries draft-version METADATA; the file-primary `.md`
    // prose bodies ride a separate `draftBodyManifest` (SHA256 per draft) the
    // receiver diffs + pulls. A tombstone ships neither asset manifest.
    const draftBodyManifest = record.deleted === true ? [] : await buildWorkBodyManifest(record);
    return { kind: 'writersRoomWork', record: sanitized, assetManifest: [], draftBodyManifest, sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'writersRoomFolder') {
    // Body-less (#1645) — no asset/body manifest, just the LWW record envelope.
    const record = await getFolderForSync(sub.recordId).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('writersRoomFolder', record);
    if (!sanitized) return null;
    return { kind: 'writersRoomFolder', record: sanitized, assetManifest: [], sourceInstanceId, portosMeta };
  }
  if (sub.recordKind === 'writersRoomExercise') {
    const record = await getExerciseForSync(sub.recordId).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('writersRoomExercise', record);
    if (!sanitized) return null;
    return { kind: 'writersRoomExercise', record: sanitized, assetManifest: [], sourceInstanceId, portosMeta };
  }
  return null;
}

/**
 * Hash an author's referenced headshot image (if any) so the receiver can pull
 * the bytes from `/data/images/`. `headshotImageFilename` returns null for an
 * external URL / non-local path, so those never ship as assets (the receiver
 * resolves the same URL itself). A missing local file is skipped silently by
 * `hashImageForManifest` — can't ship bytes we don't have.
 */
async function buildAuthorAssetManifest(author) {
  const filename = headshotImageFilename(author?.headshotImageUrl);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

async function buildArtistAssetManifest(artist) {
  const filename = portraitImageFilename(artist?.portraitImageUrl);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

async function buildAlbumAssetManifest(album) {
  const filename = coverImageFilename(album?.coverImageUrl);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

async function buildTrackAssetManifest(track) {
  // A track now carries a render history — every render's audio must ride the
  // manifest, not just the active pointer, so a peer can play any received card.
  // Union the active filename with each render's; de-dup (the active render's
  // bytes are also in renders[]).
  const filenames = new Set();
  const active = trackAudioFilename(track?.audioFilename);
  if (active) filenames.add(active);
  for (const r of Array.isArray(track?.renders) ? track.renders : []) {
    const f = trackAudioFilename(r?.audioFilename);
    if (f) filenames.add(f);
  }
  const entries = await Promise.all(
    [...filenames].map((filename) => hashSimpleAsset(filename, 'music', PATHS.music)),
  );
  return entries.filter(Boolean);
}

/**
 * Hash a Creative Director project's direct image input (`startingImageFile`) so
 * the receiver can pull the bytes from `/data/images/`. `startingImageFilename`
 * returns null for an external URL / non-local path, so those never ship (the
 * receiver resolves the same URL itself). Scene VIDEO renders are NOT hashed
 * here: they live in the project's linked media collection, which federates as
 * its own record and ships its bytes via that collection's manifest — duplicating
 * them here would double the transfer. This mirrors buildAuthorAssetManifest:
 * one direct asset, missing-local-file skipped silently.
 */
async function buildProjectAssetManifest(project) {
  const filename = startingImageFilename(project?.startingImageFile);
  if (!filename) return [];
  const entry = await hashImageForManifest(filename);
  return entry ? [entry] : [];
}

/**
 * Hash the local image bytes a mood board's items reference so the receiver can
 * pull them from `/data/{images,image-refs,videos}/`. An image item points at
 * local bytes two ways: a media-key (`image:<ref>` / `video:<ref>`) into the
 * gallery, or an app-path `imageUrl` — a gallery render (`/data/images/...`) OR a
 * character/canon reference sheet (`/data/image-refs/...`, the form
 * PinToMoodBoardMenu pins synthetic `canon-sheet:`/`noun:` sources under).
 * External URLs (http(s)/data/blob) resolve on the receiver itself → skipped.
 * Mirrors `buildAssetManifestForCollection`: path-traversal-guarded,
 * missing-local-file skipped silently (including a null-hash entry would make
 * every receiver re-request bytes the sender can't fulfill),
 * dedup-by-`<kind>:<filename>` so a media-key and imageUrl pointing at the same
 * file ship once. Text items carry no bytes.
 */
async function buildBoardAssetManifest(board) {
  const dedup = new Map();
  for (const it of board?.items || []) {
    if (!it || it.type !== 'image') continue;
    const pending = [];
    if (typeof it.mediaKey === 'string') {
      const parsed = parseKey(it.mediaKey);
      if (parsed) {
        const safeName = sanitizeAssetFilename(parsed.ref);
        if (safeName) {
          pending.push(parsed.kind === 'video'
            ? hashSimpleAsset(collectionVideoRefToFilename(safeName), 'video', PATHS.videos)
            : hashImageForManifest(safeName));
        }
      }
    }
    if (typeof it.imageUrl === 'string') {
      const asset = imageUrlToAppAsset(it.imageUrl);
      const safeName = asset ? sanitizeAssetFilename(asset.filename) : null;
      if (safeName) {
        // `image-ref` bytes stream-hash from PATHS.imageRefs (same kind/dir the
        // universe-canon manifest uses); gallery `image` bytes go through the
        // sidecar-aware hashImageForManifest.
        pending.push(asset.kind === 'image-ref'
          ? hashSimpleAsset(safeName, 'image-ref', PATHS.imageRefs)
          : hashImageForManifest(safeName));
      }
    }
    for (const entry of await Promise.all(pending)) {
      if (entry) dedup.set(`${entry.kind}:${entry.filename}`, entry);
    }
  }
  return [...dedup.values()];
}

/**
 * Build the catalog bundle (`{ ingredients, refs }`) that piggy-backs on a
 * universe record push. Catalog data lives in Postgres only — on a non-Postgres
 * install (or when the catalog tables don't exist yet) there's nothing to
 * bundle, so we gate on the backend and swallow any read failure: a missing
 * bundle is non-fatal (the universe record still replicates; the receiver's
 * backfill re-derives a lossy view, exactly as before this bundle existed).
 *
 * Returns `null` (omit the key) when there's nothing to ship — both the
 * non-Postgres case and the genuinely-empty case (a universe with no catalog
 * refs yet). Dynamic import keeps catalogDB's pg module graph off peerSync's
 * load path on installs that never touch Postgres.
 */
async function buildCatalogBundleForRef(refKind, refId) {
  const { getBackendName } = await import('../memoryBackend.js');
  if (getBackendName() !== 'postgres') return null;
  const { getCatalogBundleForRef } = await import('../catalogDB.js');
  const bundle = await getCatalogBundleForRef(refKind, refId).catch((err) => {
    console.log(`⚠️ peerSync: catalog bundle for ${refKind}/${refId} failed: ${err.message}`);
    return null;
  });
  if (!bundle) return null;
  const ingredients = Array.isArray(bundle.ingredients) ? bundle.ingredients : [];
  const refs = Array.isArray(bundle.refs) ? bundle.refs : [];
  if (ingredients.length === 0 && refs.length === 0) return null;
  return { ingredients, refs };
}

/**
 * Apply a received catalog bundle on the receiver. Reuses
 * `catalogSync.applyRemoteChanges` so the bundle goes through the exact same
 * per-row LWW upsert + schema gate + try/catch isolation as direct catalog
 * sync — we forward `portosMeta` so applyRemoteChanges runs the gate itself
 * (defense in depth; the push-level gate already ran). Postgres-only; the
 * applyIncomingPush caller already null-checks `catalogBundle`, but we re-gate
 * the backend here so a stray call on a non-Postgres install is a clean no-op.
 */
async function applyCatalogBundle(catalogBundle, portosMeta) {
  const { getBackendName } = await import('../memoryBackend.js');
  if (getBackendName() !== 'postgres') return;
  const { applyRemoteChanges } = await import('../catalogSync.js');
  await applyRemoteChanges({
    ingredients: Array.isArray(catalogBundle.ingredients) ? catalogBundle.ingredients : [],
    refs: Array.isArray(catalogBundle.refs) ? catalogBundle.refs : [],
    portosMeta,
  });
}

async function buildAssetManifestForSeries(series, issues, linkedCollection = null) {
  const seriesAssets = await buildAssetManifest(series);
  const dedup = new Map(seriesAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  for (const issue of issues) {
    const issueAssets = await buildAssetManifest(issue);
    for (const a of issueAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  if (linkedCollection) {
    const collectionAssets = await buildAssetManifestForCollection(linkedCollection);
    for (const a of collectionAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  return [...dedup.values()];
}

/**
 * Combined record + collection asset manifest for the universe push. Same
 * dedup-by-`<kind>:<filename>` semantics as the series path so a render that
 * lives in both the universe's canon (`imageRefs`) and the collection's
 * `items[]` only ships once.
 */
async function buildAssetManifestWithCollection(record, linkedCollection) {
  const recordAssets = await buildAssetManifest(record);
  const dedup = new Map(recordAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  if (linkedCollection) {
    const collectionAssets = await buildAssetManifestForCollection(linkedCollection);
    for (const a of collectionAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  return [...dedup.values()];
}

/**
 * Hash each item in a media collection so the receiver can pull missing
 * bytes from `/data/images/` (or `/data/videos/`) via the existing asset-pull
 * worker. Collections are append-mostly and items refer to filenames the
 * sender has on disk; an item whose file is missing (e.g. half-imported
 * from another peer) is skipped silently — including a null-hash entry
 * would make every receiver re-request bytes the sender can't fulfill.
 *
 * Items with `kind: 'video'` route through the video PATHS dir; other kinds
 * (today only 'image') route through the image PATHS dir. This mirrors
 * `collectAssetReferences` and the `directoryForAssetKind` map.
 */
async function buildAssetManifestForCollection(collection) {
  const out = [];
  for (const it of collection?.items || []) {
    if (!it || typeof it.ref !== 'string') continue;
    // Path-traversal guard: collection items can arrive from a peer (via
    // `linkedCollection` push or the snapshot-sync mediaCollections
    // category), and a malicious `ref` like `../etc/passwd` would otherwise
    // let `join(PATHS, ref)` read arbitrary local files when THIS instance
    // is the sender — leaking the hash of the targeted file to peers. Same
    // posture as the receiver-side `diffAssetManifestAgainstLocal`.
    // `sanitizeItem` in mediaCollections.js also rejects path-traversal
    // refs on the inbound merge boundary; this is defense in depth.
    const safeName = sanitizeAssetFilename(it.ref);
    if (!safeName) continue;
    if (it.kind === 'video') {
      // Bare videoId → `<id>.mp4` via the shared helper (see
      // collectionVideoRefToFilename). `sanitizeAssetFilename` already ran on
      // `it.ref` above; the extension append is purely the on-disk naming rule.
      const entry = await hashSimpleAsset(collectionVideoRefToFilename(safeName), 'video', PATHS.videos);
      if (entry) out.push(entry);
    } else {
      // Treat 'image' (and any unknown kind that isn't 'video') as a gallery
      // image — the receiver's diff path will only accept entries whose kind
      // maps to a known directory in `directoryForAssetKind`, so a junk kind
      // gets filtered there without polluting disk.
      const entry = await hashImageForManifest(safeName);
      if (entry) out.push(entry);
    }
  }
  return out;
}

// Tiny stable-string hash for the push short-circuit. NOT a cryptographic
// hash — we just need "is this the same record we last pushed". Collisions
// at this size mean we MIGHT skip a real edit, but the snapshot sync would
// catch it within 60s, so the cost is bounded.
function simplePayloadHash(record) {
  // JSON.stringify is key-order sensitive, and sanitizeRecordForWire
  // guarantees a canonical key order — so two identical logical records
  // produce identical hashes here.
  const json = JSON.stringify(record);
  let h = 0;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) - h + json.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

async function findPeerById(peerId) {
  const peers = await getPeers().catch(() => []);
  return peers.find((p) => p.instanceId === peerId) || null;
}

// --- Receiver-side push handler -----------------------------------------

/**
 * Apply an incoming push to local state. Wraps the existing `merge*FromSync`
 * dispatch + computes the asset-diff response + (best-effort) creates a
 * reverse subscription back to the sender so subsequent edits flow both
 * ways without manual re-configuration.
 *
 * The HTTP route in Stage 3 will be a thin wrapper around this — validate
 * the body shape, call this function, return the response.
 */
export async function applyIncomingPush(payload) {
  if (!isPlainObject(payload)) {
    throw makeErr('payload must be an object', ERR_VALIDATION);
  }
  const { kind, record, issues, linkedCollection, catalogBundle, manuscriptReview, reverseOutline, assetManifest, draftBodyManifest, sourceInstanceId, portosMeta } = payload;
  if (!PEER_SUBSCRIBABLE_KINDS.includes(kind)) {
    throw makeErr(`unknown kind: ${kind}`, ERR_VALIDATION);
  }
  // Identity + record-shape checks happen BEFORE the schema-version gate.
  // The gate's 409 body includes `receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS`
  // — a (mild) version-fingerprint disclosure — and we don't want to surface
  // it to callers that haven't even identified themselves correctly. Move
  // the cheap shape validation first so unidentified or malformed requests
  // get a clean 400 with no version information.
  if (!isNonEmptyStr(sourceInstanceId) || sourceInstanceId === UNKNOWN_INSTANCE_ID) {
    throw makeErr('sourceInstanceId required (and not "unknown")', ERR_VALIDATION);
  }
  if (!isPlainObject(record) || !isNonEmptyStr(record.id)) {
    throw makeErr('record must be an object with a string id', ERR_VALIDATION);
  }

  // SCHEMA-VERSION GATE — runs BEFORE any merge so a sender on a newer
  // storage layout can't corrupt local state. Legacy senders without
  // `portosMeta` pass through (comparator treats absent as zero/no-contract;
  // their record went through the same v0 → vN sanitizer chain we already
  // run). When the sender is AHEAD on any category, we reject with a
  // structured error the route layer maps to HTTP 409 + body so the sender
  // can persist the gap on the subscription and surface it in the UI.
  //
  // We do NOT reject on "sender behind" here — the sanitizer's existing
  // backfill chain handles older inputs in-place. A future forward-only
  // contract (e.g. a required field that the sanitizer can't synthesize)
  // can opt into a behind-gate; the comparator already surfaces both
  // directions for that purpose.
  const senderSchemaVersions = isPlainObject(portosMeta?.schemaVersions) ? portosMeta.schemaVersions : {};
  const senderPortosVersion = typeof portosMeta?.portosVersion === 'string' ? portosMeta.portosVersion : null;
  // Per-category gate, scoped to the categories THIS push actually writes a
  // LIVE (non-tombstone) record into. A sender ahead on an unrelated category
  // no longer rejects this push; the full union diff stays for diagnostics.
  //
  // Tombstones are folded INTO the per-category scoping rather than exempted
  // wholesale. A tombstone payload carries only id+deleted+deletedAt+updatedAt
  // — fields that exist at EVERY schema version and can't corrupt local state
  // — so its category needn't gate, and exempting it keeps federated deletes
  // converging even when one peer upgrades ahead (otherwise blockedBySchema →
  // edit-push cooldown → the delete never lands). BUT a deleted `series` push
  // still bundles its LIVE child issues (deleteSeries does not cascade-
  // tombstone them; buildPushPayload ships every child so the receiver can
  // finish its cascade), and those live, full-shape issue records WOULD
  // corrupt an older receiver. So gate a category only when it carries at
  // least one live record:
  const relevantCategories = new Set();
  if (record.deleted !== true) {
    for (const c of (RECORD_KIND_SCHEMA_CATEGORIES[kind] || [])) relevantCategories.add(c);
  }
  if (kind === 'series' && Array.isArray(issues) && issues.some((i) => i?.deleted !== true)) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.issue) relevantCategories.add(c);
  }
  // A linked collection only rides a non-deleted push (buildPushPayload drops
  // it for tombstones) and is itself a live record when present. This gate
  // mirrors the merge predicate's OWNER-tombstone check (the merge refuses the
  // collection when the owner record is a tombstone) — so the gate never
  // blocks `mediaCollections` over a collection the merge would ignore. It is
  // intentionally MORE permissive on the collection itself: the extra
  // `linkedCollection.deleted !== true` check here is defensive (today's
  // exporter never bundles a deleted collection), and a tombstone collection
  // is schema-version-safe at any version anyway, so it needn't gate.
  if (record.deleted !== true && isPlainObject(linkedCollection) && linkedCollection.deleted !== true) {
    for (const c of RECORD_KIND_SCHEMA_CATEGORIES.mediaCollection) relevantCategories.add(c);
  }
  // A catalog bundle ships catalog-schema-shaped ingredient rows. Gate the
  // `catalog` category whenever the bundle carries at least one LIVE ingredient
  // — a sender ahead on `catalog` would push forward-shaped payload an older
  // receiver can't interpret. Tombstone-only bundles (all ingredients deleted)
  // are id+deleted+deletedAt+updatedAt — safe at every version, so they needn't
  // gate (same reasoning as the tombstone-record exemption above).
  if (record.deleted !== true && isPlainObject(catalogBundle) &&
      Array.isArray(catalogBundle.ingredients) &&
      catalogBundle.ingredients.some((i) => i?.deleted !== true)) {
    for (const c of (RECORD_KIND_SCHEMA_CATEGORIES['cat-ingredient'] || ['catalog'])) relevantCategories.add(c);
  }
  const fullDiff = compareSchemaVersions(senderSchemaVersions, PORTOS_SCHEMA_VERSIONS);
  const versionDiff = scopeVersionDiff(fullDiff, [...relevantCategories]);
  if (versionDiff.ahead.length > 0) {
    console.warn(
      `⚠️ peerSync: rejecting push from ${sourceInstanceId} — ${formatVersionGap(versionDiff)} (sender PortOS ${senderPortosVersion || 'unknown'})`,
    );
    // Surface the receiver's PortOS version so the sender can show the user
    // *which* version their peer is on (the label the user thinks of as "the
    // peer's PortOS version"). Without this field the sender's UI would fall
    // back to its own version, which is misleading.
    const receiverPortosVersion = await getPortosVersion().catch(() => null);
    throw makeErr(
      `sender's schema is ahead — receiver cannot apply (${formatVersionGap(versionDiff)})`,
      ERR_SCHEMA_VERSION_AHEAD,
      {
        ahead: versionDiff.ahead,
        behind: versionDiff.behind,
        senderPortosVersion,
        receiverPortosVersion,
        receiverSchemaVersions: PORTOS_SCHEMA_VERSIONS,
      },
    );
  }

  // Look up the LOCAL record state BEFORE merging so we can detect the
  // "local user marked this record ephemeral" case. The merge functions
  // already silently drop ephemeral records, but the side effects below
  // (linkedCollection merge, asset pull, reverse subscription) ran
  // unconditionally — meaning a stale peer subscription could still
  // mutate a local collection, download bytes the user opted out of, and
  // auto-create a reverse sub the user explicitly torn down. Computing
  // `localEphemeral` here is one extra read but closes the gap.
  let localEphemeral = false;
  if (kind === 'universe') {
    const local = await getUniverse(record.id, { includeDeleted: true }).catch(() => null);
    localEphemeral = local?.ephemeral === true;
  } else if (kind === 'series') {
    const local = await getSeries(record.id, { includeDeleted: true }).catch(() => null);
    localEphemeral = local?.ephemeral === true;
  }

  // Merge into local state via the existing LWW path. The merge functions
  // honor `deleted: true` + bump `updatedAt`, so this is the single
  // tombstone-aware reconciliation point. Attribute any conflict journaled by
  // the merge to THIS push's origin peer so the Conflicts tab can show which
  // peer collided (without `source`, the merge fns fall back to
  // `{ via:'sync', peerId:null }` and the attribution is lost).
  const source = { via: 'peer-push', peerId: sourceInstanceId };
  // Set true when a bundled manuscript-review merge throws — returned to the
  // sender so it withholds lastPushedHash and retries (the review has no other
  // reconciliation path; see the merge block below).
  let reviewSyncPending = false;
  // Same contract as reviewSyncPending, for the bundled reverse-outline doc.
  let outlineSyncPending = false;
  // Set true when a writersRoomWork merge accepted the remote (insert/remote-won)
  // — gates whether a present-but-different local draft body may be overwritten.
  let workMergeApplied = false;
  if (kind === 'universe') {
    await mergeUniversesFromSync([record], { source });
  } else if (kind === 'series') {
    await mergeSeriesFromSync([record], { source });
    // Bundled issues: skip the entire batch if the LOCAL series is
    // ephemeral. mergeSeriesFromSync already refused the parent record on
    // its own, but child issue merges are a separate code path —
    // `updateSeries` doesn't auto-flip child issues' `ephemeral` flag when
    // the parent is marked ephemeral, so without this gate a stale reverse
    // subscription could overwrite the private fork's issue stages.
    if (!localEphemeral && Array.isArray(issues) && issues.length > 0) {
      await mergeIssuesFromSync(issues, { source });
    }
    // Merge the bundled manuscript-review sibling doc, LWW-per-comment. Same
    // guards as the issue batch + linkedCollection below: skip for local-
    // ephemeral records (the user opted this series out of sync) and tombstone
    // pushes (a deleted series carries no live review). A merge failure must
    // NOT fail the push (the series/issues already merged) — but unlike the
    // linkedCollection bundle, the review has NO independent reconciliation
    // cycle, so a swallowed failure could never resend once the sender saves
    // lastPushedHash. Signal `reviewSyncPending` so the sender withholds the
    // hash (mirrors the missing-assets guard) and retries next cycle.
    // Dynamic import keeps the arcPlanner graph off peerSync's load path.
    if (!localEphemeral && record.deleted !== true && isPlainObject(manuscriptReview)) {
      const { mergeReviewFromSync } = await import('../pipeline/manuscriptReview.js');
      await mergeReviewFromSync(record.id, manuscriptReview).catch((err) => {
        console.log(`⚠️ peerSync: manuscriptReview merge failed: ${err.message}`);
        reviewSyncPending = true;
      });
    }
    // Merge the bundled reverse-outline sibling doc, whole-doc LWW on
    // generatedAt. Same ephemeral/tombstone guards + pending-signal contract as
    // the review above: a merge failure must withhold the sender's hash so the
    // outline (which has no independent reconciliation cycle) re-sends next
    // cycle. Dynamic import keeps the arcPlanner graph off peerSync's load path.
    if (!localEphemeral && record.deleted !== true && isPlainObject(reverseOutline)) {
      const { mergeOutlineFromSync } = await import('../pipeline/reverseOutline.js');
      await mergeOutlineFromSync(record.id, reverseOutline).catch((err) => {
        console.log(`⚠️ peerSync: reverseOutline merge failed: ${err.message}`);
        outlineSyncPending = true;
      });
    }
  } else if (kind === 'mediaCollection') {
    await mergeMediaCollectionsFromSync([record], { source });
  } else if (kind === 'author') {
    await mergeAuthorsFromSync([record], { source });
  } else if (kind === 'artist') {
    await mergeArtistsFromSync([record], { source });
  } else if (kind === 'album') {
    await mergeAlbumsFromSync([record], { source });
  } else if (kind === 'track') {
    await mergeTracksFromSync([record], { source });
  } else if (kind === 'creativeDirectorProject') {
    await mergeProjectsFromSync([record], { source });
  } else if (kind === 'moodBoard') {
    await mergeBoardsFromSync([record], { source });
  } else if (kind === 'writersRoomWork') {
    const mergeResult = await mergeWorksFromSync([record], { source });
    // Did the receiver accept the remote work (insert / remote-won LWW)? This
    // gates whether a PRESENT-but-different local draft body may be overwritten —
    // a stale push that lost the LWW must NOT clobber newer local prose.
    workMergeApplied = mergeResult?.applied === true;
  } else if (kind === 'writersRoomFolder') {
    await mergeFoldersFromSync([record], { source });
  } else if (kind === 'writersRoomExercise') {
    await mergeExercisesFromSync([record], { source });
  }

  // Apply the bundled collection (if any) — same LWW + union-of-items
  // semantics as the snapshot-sync mediaCollections category. Failures here
  // don't fail the push: the record itself is already merged and the next
  // snapshot-sync cycle will reconcile the collection if it diverged. The
  // sanitizer in mediaCollections drops a peer-supplied `id` that isn't a
  // valid path-segment (the store's id allowlist), so a bogus payload can't
  // plant a malformed row or abort the batch.
  //
  // Defense in depth on the peer-supplied envelope:
  //   - plain-object check (arrays would get wrapped and the sanitizer
  //     would drop them, but skipping early avoids the wasted call)
  //   - refuse to merge when the record is a tombstone (`deleted === true`)
  //     — the sender already skips bundling for tombstones, so a present
  //     `linkedCollection` on a tombstone push is either a bug or a
  //     malicious peer trying to resurrect a collection during delete
  //     propagation.
  //   - refuse to merge when the LOCAL record is ephemeral — the user
  //     explicitly opted out of sync for this record, so peer-pushed
  //     collection mutations must not land.
  if (!localEphemeral && record.deleted !== true && isPlainObject(linkedCollection)) {
    await mergeMediaCollectionsFromSync([linkedCollection], { source }).catch((err) => {
      console.log(`⚠️ peerSync: linkedCollection merge failed: ${err.message}`);
    });
  }

  // Apply the bundled catalog rows (ingredients + universe→ingredient refs)
  // through the same LWW upsert path as direct catalog sync. Same guards as the
  // linkedCollection merge: skip for local-ephemeral records and tombstone
  // pushes (a deleted universe's catalog refs tombstone locally on the next
  // catalog-sync cycle; resurrecting them here would be wrong). Postgres-only
  // and best-effort — a failure doesn't fail the push (the universe record is
  // already merged; the receiver's backfill still derives a lossy view, and
  // the next catalog-sync cycle reconciles the enriched rows).
  if (!localEphemeral && record.deleted !== true && isPlainObject(catalogBundle)) {
    await applyCatalogBundle(catalogBundle, portosMeta).catch((err) => {
      console.log(`⚠️ peerSync: catalog bundle apply failed: ${err.message}`);
    });
  }

  // Diff incoming asset manifest against local disk. We (the receiver) are
  // the ones that will background-pull `missingAssets` from the sender's
  // `/data/{images,image-refs,videos}/<filename>` static mount in Stage 3
  // — the sender just needs to keep those files served, no action required
  // from it here. We return the list to the sender in the response so it
  // can surface progress in its UI ("N/M assets still syncing to peer X").
  // For local-ephemeral records, skip the diff entirely so we don't even
  // report a non-empty missingAssets back to the sender (which would
  // surface a "still syncing" UI for a record we silently refused).
  const missingAssets = localEphemeral ? [] : await diffAssetManifestAgainstLocal(assetManifest);

  // Compute the deletedAt water-mark we can ack. Use the maximum across the
  // record + its issues (a single push can carry multiple tombstones).
  // We return this to the sender so THEY can advance THEIR cursor (which
  // tracks what we — the receiver — have acked of THEIR pushes). We do
  // NOT call ackDeletesUpTo here: that would write
  // `localCursors[sourceInstanceId] = ackedDeletesUpTo`, which is
  // mis-directional. Our cursors track "what peer X has acked of OUR
  // local deletions" so tombstoneGc can prune our local tombstones once
  // every subscribed peer has confirmed receipt. The receive-side ack
  // here would let GC prune OUR older local tombstones as if peer-A had
  // seen them — even though peer-A is just telling us about ITS own
  // tombstones. In bidirectional sync, that lets peer-A's stale live
  // records resurrect after GC drops our tombstones.
  const ackedDeletesUpTo = computeAckedDeletesFromPayload(record, issues);

  // Best-effort reverse subscription. Failures don't fail the push — the
  // record is already merged and the response will tell the sender what
  // assets to push next. The reverse subscription only affects whether
  // future edits flow BACK; the user can also create one manually.
  // Skip for local-ephemeral: the user said "don't sync this record"; we
  // shouldn't auto-create a sub the next edit would push out to a peer.
  const reverseSubscriptionCreated = localEphemeral ? false : await maybeCreateReverseSubscription({
    peerId: sourceInstanceId,
    recordKind: kind,
    recordId: record.id,
  }).catch(() => false);

  // Schedule background pulls for every asset we're missing. The sender just
  // told us they have these files — fetch them via their `/data/{kind-dir}/`
  // static mount (acceptRanges enabled so resumes work over flaky Tailnet).
  // Fire-and-forget so the push response isn't blocked on a slow pull; the
  // worker emits a socket event when each asset lands so the UI can swap
  // the MediaImage placeholder for the real bytes.
  // (missingAssets is already [] for localEphemeral above, so the worker
  // can never schedule pulls for opted-out records.)
  if (missingAssets.length > 0) {
    pullMissingAssetsFromPeer(sourceInstanceId, missingAssets).catch((err) => {
      console.log(`⚠️ peerSync: asset pull from ${sourceInstanceId} failed: ${err.message}`);
    });
  }

  // Writers Room: the file-primary draft `.md` bodies ride their own manifest
  // (the generic asset pipeline keys on a flat basename + single dir per kind;
  // bodies live at works/<workId>/drafts/<draftId>.md). Diff against local disk
  // and background-pull the missing ones from the sender's /data/writers-room
  // static mount. `includeMismatched: workMergeApplied` is the data-safety gate —
  // a present-but-different local body is only replaced when the receiver also
  // accepted the remote record (so a stale push can't clobber newer local prose);
  // an absent body is always pulled (fills inserts + retries a failed pull).
  // Same guards as the asset path: skip for local-ephemeral and tombstone pushes.
  let missingDraftBodies = [];
  if (kind === 'writersRoomWork' && !localEphemeral && record.deleted !== true) {
    // Scope the manifest to THIS work: a body entry's path is works/<workId>/...,
    // so an entry whose workId != the pushed record's id would write bytes into a
    // DIFFERENT local work's draft (clobbering unrelated prose when the merge
    // accepted the remote). A peer may only replicate the bodies of the work it
    // actually pushed.
    const ownBodies = Array.isArray(draftBodyManifest)
      ? draftBodyManifest.filter((e) => e && e.workId === record.id)
      : [];
    missingDraftBodies = await diffWorkBodyManifest(ownBodies, { includeMismatched: workMergeApplied });
    if (missingDraftBodies.length > 0) {
      pullMissingWorkBodies(sourceInstanceId, missingDraftBodies).catch((err) => {
        console.log(`⚠️ peerSync: draft-body pull from ${sourceInstanceId} failed: ${err.message}`);
      });
    }
  }

  return {
    missingAssets,
    // Surfaced like missingAssets so the sender withholds lastPushedHash while
    // bodies are still pending and keeps re-pushing until the pulls land.
    ...(missingDraftBodies.length > 0 ? { missingDraftBodies } : {}),
    reverseSubscriptionCreated,
    ackedDeletesUpTo,
    ...(reviewSyncPending ? { reviewSyncPending: true } : {}),
    ...(outlineSyncPending ? { outlineSyncPending: true } : {}),
  };
}

function computeAckedDeletesFromPayload(record, issues) {
  let max = 0;
  const consider = (rec) => {
    if (!rec?.deleted || !isStr(rec.deletedAt)) return;
    const ms = Date.parse(rec.deletedAt);
    if (Number.isFinite(ms) && ms > max) max = ms;
  };
  consider(record);
  if (Array.isArray(issues)) for (const i of issues) consider(i);
  return max;
}

async function maybeCreateReverseSubscription({ peerId, recordKind, recordId }) {
  // Skip if a subscription back to the sender already exists.
  const existing = await findPeerSubscription(peerId, recordKind, recordId);
  if (existing) return false;

  // Cheap in-memory checks FIRST. Honor the per-peer `directions` flag — a
  // peer marked inbound-only is one we accept pushes FROM but never push
  // back TO — auto-creating a reverse subscription would break that
  // explicit configuration. Doing this BEFORE the ephemeral-record disk
  // read means inbound-only / unknown peers don't trigger an extra
  // getUniverse / getSeries on every incoming push.
  const peer = await findPeerById(peerId);
  if (!peer) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  if (directions.length > 0 && !directions.includes('outbound')) return false;

  // Now the disk read: only reverse-subscribe when the local record exists
  // AND is non-ephemeral. Three reasons to hard-stop on missing/read-failed:
  //
  // 1. Ephemeral: auto-creating a reverse sub for a local-only record
  //    would accumulate orphan rows in peer_subscriptions.json. Every
  //    future edit on the local side fires recordEvents.updated →
  //    triggerPushForRecord → pushRecordToPeer → buildPushPayload →
  //    sanitizeRecordForWire returns null (ephemeral filter) → push
  //    aborts with "record-not-found". The sub burns an asset-manifest
  //    sha-pass on every edit and never sends bytes. The merge path
  //    upstream already refused the inbound edit (local-ephemeral →
  //    continue), so the sender's record state isn't reflected locally
  //    anyway — there's nothing meaningful to push back.
  //
  // 2. Record-missing: the sender pushed a record that passed Zod but was
  //    dropped by the service sanitizer (missing name, etc.). The merge
  //    never created the local copy, so a reverse sub would point at a
  //    nonexistent record and every push would resolve to null. Same
  //    orphan-row dynamic as ephemeral, but worse because there's never
  //    going to be a record to clear it via the ephemeral lifecycle
  //    transition.
  //
  // 3. Read-failed: a transient IO error reading the record file —
  //    treating it as "non-ephemeral, go ahead and subscribe" can create
  //    a sub for a record that turns out to be ephemeral once the IO
  //    settles. Conservative default: don't subscribe.
  const localState = await classifyLocalRecord(recordKind, recordId);
  if (localState !== 'syncable') return false;

  const sub = await subscribePeer({ peerId, recordKind, recordId }, { adoptedFromReverse: true });
  // subscribePeer is idempotent — only announce when a row was genuinely
  // inserted (created=true). The existing-sub short-circuit at the top of
  // this function already returns early, but guarding on `created` keeps the
  // event honest if a race ever lands an identical row between the
  // findPeerSubscription check and the insert. `sharing/index.js` wires this
  // to the `peerSync:subscription:created` socket event so the Instances page
  // re-fetches that peer's subs without a manual reload.
  if (sub?.created) {
    peerSyncEvents.emit('subscription-created', {
      peerId,
      recordKind,
      recordId,
      subId: sub.id,
    });
  }
  return true;
}

/**
 * Look up the local record (live or tombstoned) and tri-state-classify it
 * for the reverse-subscribe gate. Returns one of:
 *
 *   'syncable'   — record exists, is non-ephemeral; safe to reverse-subscribe.
 *   'ephemeral'  — record exists but is local-only; reverse-subscribe would
 *                  accumulate an orphan sub that never sends bytes.
 *   'missing'    — record is not on disk OR a read error occurred; can't
 *                  classify, so the conservative default is to skip the
 *                  reverse-subscribe (callers treat anything other than
 *                  'syncable' as a no-go).
 *
 * Includes deleted records on the lookup so a tombstone-as-state record
 * still gets classified as 'syncable' (we WANT peer pushes to converge
 * a deleted record's tombstone if they're targeting it).
 */
async function classifyLocalRecord(recordKind, recordId) {
  if (recordKind === 'universe') {
    const u = await getUniverse(recordId, { includeDeleted: true }).catch(() => undefined);
    if (!u) return 'missing';
    return u.ephemeral === true ? 'ephemeral' : 'syncable';
  }
  if (recordKind === 'series') {
    const s = await getSeries(recordId, { includeDeleted: true }).catch(() => undefined);
    if (!s) return 'missing';
    return s.ephemeral === true ? 'ephemeral' : 'syncable';
  }
  if (recordKind === 'mediaCollection') {
    // Collections have no `ephemeral` concept, so a found record is always
    // 'syncable'. Without this branch, maybeCreateReverseSubscription's
    // `localState !== 'syncable'` guard would never bootstrap bidirectional
    // collection sync from an inbound push. No ping-pong risk — the
    // lastPushedHash short-circuit + LWW same-`updatedAt` no-op merge prevent
    // it, same as universe/series.
    const c = await getCollection(recordId, { includeDeleted: true }).catch(() => null);
    return c ? 'syncable' : 'missing';
  }
  if (recordKind === 'author') {
    // Authors have no `ephemeral` concept (like mediaCollection) — a found
    // record (live or tombstoned) is always 'syncable'. Lets an inbound author
    // push bootstrap bidirectional sync. No ping-pong risk: lastPushedHash +
    // LWW same-`updatedAt` no-op merge prevent it, same as the others.
    const a = await getAuthor(recordId, { includeDeleted: true }).catch(() => null);
    return a ? 'syncable' : 'missing';
  }
  if (recordKind === 'artist') {
    const a = await getArtist(recordId, { includeDeleted: true }).catch(() => null);
    return a ? 'syncable' : 'missing';
  }
  if (recordKind === 'album') {
    const a = await getAlbum(recordId, { includeDeleted: true }).catch(() => null);
    return a ? 'syncable' : 'missing';
  }
  if (recordKind === 'track') {
    const t = await getTrack(recordId, { includeDeleted: true }).catch(() => null);
    return t ? 'syncable' : 'missing';
  }
  if (recordKind === 'creativeDirectorProject') {
    // CD projects have no `ephemeral` concept (like the persona/music kinds) — a
    // found record (live or tombstoned) is always 'syncable'. No ping-pong risk:
    // lastPushedHash + LWW same-`updatedAt` no-op merge prevent it.
    const p = await getProject(recordId, { includeDeleted: true }).catch(() => null);
    return p ? 'syncable' : 'missing';
  }
  if (recordKind === 'moodBoard') {
    // Mood boards have no `ephemeral` concept (like the persona/music/CD kinds) —
    // a found record (live or tombstoned) is always 'syncable'. No ping-pong risk:
    // lastPushedHash + LWW same-`updatedAt` no-op merge prevent it.
    const b = await getBoard(recordId, { includeDeleted: true }).catch(() => null);
    return b ? 'syncable' : 'missing';
  }
  if (recordKind === 'writersRoomWork') {
    // Works have no `ephemeral` concept (like the persona/music/CD/board kinds) —
    // a found work (live or tombstoned) is always 'syncable', so an inbound work
    // push bootstraps bidirectional sync. No ping-pong risk: lastPushedHash + LWW
    // same-`updatedAt` no-op merge prevent it.
    const w = await getWorkForSync(recordId).catch(() => null);
    return w ? 'syncable' : 'missing';
  }
  if (recordKind === 'writersRoomFolder') {
    // Body-less, no `ephemeral` concept (#1645) — a found folder (live or
    // tombstoned) is always 'syncable'. Same no-ping-pong guards as works.
    const f = await getFolderForSync(recordId).catch(() => null);
    return f ? 'syncable' : 'missing';
  }
  if (recordKind === 'writersRoomExercise') {
    const e = await getExerciseForSync(recordId).catch(() => null);
    return e ? 'syncable' : 'missing';
  }
  return 'missing';
}

// --- Receiver-side asset pull worker ------------------------------------

const ASSET_KIND_TO_URL_PREFIX = Object.freeze({
  image: '/data/images',
  'image-ref': '/data/image-refs',
  video: '/data/videos',
  music: '/data/music',
  // `audio` (#1566) — pipeline TTS / generated audio under data/audio, pulled by
  // the standalone media-library sweep. (video-thumbnails are NOT pulled: a video
  // pull regenerates its thumbnail locally — see doPullOneAsset's video branch.)
  audio: '/data/audio',
});

const ASSET_PULL_TIMEOUT_MS = 60000;
const ASSET_PULL_MAX_BYTES = 100 * 1024 * 1024; // 100MB hard cap per asset
// A record pull returns JSON (the record + its asset *manifest* of hashes, not
// the bytes). Even a large series+issues record is metadata, so 16MB is a
// generous ceiling that still caps a buggy/runaway peer's response.
const RECORD_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

// In-flight pull dedup. A peer can push multiple records that reference the
// same asset in quick succession (universe edit → child collection re-link
// → series under that universe), and without this guard we'd kick off
// duplicate downloads of the same UUID-named PNG — wasting bandwidth,
// doubling the 100MB memory ceiling per asset, and racing on the same
// destination filename. Key on (peerId, kind, filename) so concurrent
// pushes from DIFFERENT peers for the same filename are still allowed
// (e.g. peer-A re-renders and peer-B caches the old bytes — we want the
// newer-pushing peer to win, and the snapshot-sync safety net catches
// any divergence).
const inflightPulls = new Set();
function inflightKey(peerId, kind, filename) {
  return `${peerId}:${kind}:${filename}`;
}

/**
 * Background-fetch every asset in `missingAssets` from the named peer's
 * static `/data/{kind-dir}/` mount, writing each to the local PATHS dir for
 * that kind. Emits `peerSyncEvents 'asset-arrived'` per file so the client's
 * MediaImage placeholder can swap to the live asset.
 *
 * Each fetch is best-effort: a single failure does NOT abort the others, and
 * the asset will be retried on the next push cycle (since the receiver will
 * still report it as missing). The 60s loop's snapshot path also catches
 * up if push-driven pulls keep failing — defense in depth.
 *
 * Stage 4 keeps this simple — sequential per-asset fetches, no parallelism
 * cap. A future enhancement could pool 2-4 concurrent fetches if individual
 * universes routinely ship hundreds of assets.
 */
async function pullMissingAssetsFromPeer(senderInstanceId, missingAssets) {
  if (!isStr(senderInstanceId) || !Array.isArray(missingAssets) || missingAssets.length === 0) return;
  // Trust posture: `senderInstanceId` arrives in the push payload (the route
  // is Tailnet-only per the project's documented threat model — see
  // CLAUDE.md "Security Model"). We DON'T derive it from the TCP origin
  // because Express behind Tailscale loses that fidelity to the SO_REUSEADDR
  // socket. The guard below means even a payload that *spoofs* a different
  // peer's id can only redirect the asset pull at one of our OWN registered
  // peers — `findPeerById` returns null for any unknown id, aborting the
  // pull. So the worst case is fetching from peer-B when peer-A actually
  // pushed; both are trusted Tailnet peers, the fetch either succeeds (we
  // get the bytes peer-A wanted us to have) or 404s (we re-request next
  // push cycle). Outside the Tailnet trust boundary, the right answer is
  // mutual TLS or an HMAC over the payload — explicitly out of scope for
  // PortOS's stated security model.
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull assets — peer ${senderInstanceId} not in registry`);
    return;
  }
  const base = peerBaseUrl(peer);
  for (const entry of missingAssets) {
    await pullOneAsset(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: asset pull ${entry.filename} from ${peer.name || senderInstanceId} failed: ${err.message}`);
    });
  }
}

/**
 * Fetch a peer's static-mount asset URL into a size-capped Buffer, or null on
 * any failure. Centralizes the content-length guards shared by the generic
 * asset pull (`doPullOneAsset`) and the Writers Room draft-body pull
 * (`pullOneWorkBody`): REQUIRE a trustworthy content-length header up front
 * (Express serve-static always sets it) so a hostile peer can't OOM us by
 * shipping a huge body under a small filename before the `.arrayBuffer()` cap
 * runs. `label` is the filename used in log lines.
 */
async function fetchCappedAssetBuffer(peer, url, label, maxBytes, { allowEmpty = false } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ASSET_PULL_TIMEOUT_MS);
  // maxBytes propagates into the HTTPS shim's streaming cap (see
  // server/lib/httpClient.js); the plain-HTTP path falls back to the
  // post-resolve content-length checks below (serve-static always sets it).
  const res = await peerFetch(url, { signal: controller.signal, maxBytes }, peer)
    .finally(() => clearTimeout(timeoutId))
    .catch((err) => {
      if (err?.message?.includes('exceed')) {
        console.log(`⚠️ peerSync: ${label} exceeded asset size cap — ${err.message}`);
      }
      return null;
    });
  if (!res || !res.ok) return null;
  // Use has() to distinguish "header missing" from "header is '0'" — without it
  // `Number(null)` is 0 and slips past the finite-non-negative guard.
  if (!res.headers.has('content-length')) {
    console.log(`⚠️ peerSync: asset ${label} has no content-length — refusing pull`);
    return null;
  }
  const contentLength = Number(res.headers.get('content-length'));
  // Writers Room draft bodies can legitimately be EMPTY (a brand-new or cleared
  // draft is a 0-byte .md), so they pass `allowEmpty` to permit Content-Length: 0;
  // for every other asset kind a 0-byte body is meaningless and stays rejected.
  const lengthOk = Number.isFinite(contentLength) && (allowEmpty ? contentLength >= 0 : contentLength > 0);
  if (!lengthOk) {
    console.log(`⚠️ peerSync: asset ${label} has invalid content-length (${res.headers.get('content-length')}) — refusing pull`);
    return null;
  }
  if (contentLength > maxBytes) {
    console.log(`⚠️ peerSync: asset ${label} too large (${contentLength}) — refusing pull`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  // Defense in depth: the server claimed length X but actually sent more.
  if (buffer.length > maxBytes || buffer.length !== contentLength) {
    console.log(`⚠️ peerSync: asset ${label} length mismatch (header=${contentLength}, body=${buffer.length}) — refusing pull`);
    return null;
  }
  return buffer;
}

// --- Receiver-side Writers Room draft-body pull -------------------------
// Bodies live at works/<workId>/drafts/<draftId>.md (nested), not a flat
// basename under one dir, so they ride a dedicated manifest + pull instead of
// the generic flat-asset pipeline. The sender serves them from its
// /data/writers-room/works static mount (server/index.js).
const WORK_BODY_PULL_MAX_BYTES = 16 * 1024 * 1024; // bodies are ≤5MB (validated); 16MB is generous

async function pullMissingWorkBodies(senderInstanceId, missingBodies) {
  if (!isStr(senderInstanceId) || !Array.isArray(missingBodies) || missingBodies.length === 0) return;
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull draft bodies — peer ${senderInstanceId} not in registry`);
    return;
  }
  const base = peerBaseUrl(peer);
  for (const entry of missingBodies) {
    await pullOneWorkBody(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: draft-body pull ${entry?.draftId} from ${peer.name || senderInstanceId} failed: ${err.message}`);
    });
  }
}

async function pullOneWorkBody(peer, base, entry) {
  const { workId, draftId } = entry || {};
  // Re-validate the path segments here even though diffWorkBodyManifest already
  // did — belt-and-suspenders against a future refactor that bypasses the diff.
  if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) return;
  if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) return;
  const safeLabel = `${workId}/${draftId}.md`;
  const key = inflightKey(peer.instanceId, WRITERS_ROOM_DRAFT_ASSET_KIND, safeLabel);
  if (inflightPulls.has(key)) return;
  inflightPulls.add(key);
  try {
    const url = `${base}/data/writers-room/works/${encodeURIComponent(workId)}/drafts/${encodeURIComponent(draftId)}.md`;
    const buffer = await fetchCappedAssetBuffer(peer, url, safeLabel, WORK_BODY_PULL_MAX_BYTES, { allowEmpty: true });
    if (!buffer) return;
    // Integrity: the bytes must hash to the advertised sha256 (discard a corrupt
    // or wrong download instead of writing it over the draft).
    const bufHash = createHash('sha256').update(buffer).digest('hex');
    if (bufHash !== entry.sha256) {
      console.log(`⚠️ peerSync: draft body ${safeLabel} hash mismatch — discarding (got ${bufHash.slice(0, 8)}, want ${String(entry.sha256).slice(0, 8)})`);
      return;
    }
    // Compare-and-swap against a local save that landed DURING this slow pull:
    // the draft's merged metadata `contentHash` equals entry.sha256 right after
    // the merge, but a local saveDraftBody bumps it (+ updatedAt) to the newer
    // prose. If it no longer matches, the local copy is newer/authoritative (and
    // will re-push) — don't clobber it with the older peer bytes. A vanished
    // draft/work (deleted mid-pull) also skips. (sha256File of the .md equals
    // contentHash(text) since the body is the file verbatim.)
    const current = await getWorkForSync(workId).catch(() => null);
    const draft = Array.isArray(current?.drafts) ? current.drafts.find((d) => d?.id === draftId) : null;
    if (!draft || draft.contentHash !== entry.sha256) {
      console.log(`⚠️ peerSync: draft body ${safeLabel} target moved since diff — skipping write`);
      return;
    }
    await ensureDir(join(wrWorkDir(workId), 'drafts'));
    await atomicWrite(wrDraftPath(workId, draftId), buffer);
    peerSyncEvents.emit('asset-arrived', {
      filename: `${draftId}.md`,
      kind: WRITERS_ROOM_DRAFT_ASSET_KIND,
      peerId: peer.instanceId,
    });
    console.log(`📥 peerSync: pulled draft body ${safeLabel} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
  } finally {
    inflightPulls.delete(key);
  }
}

async function pullOneAsset(peer, base, entry) {
  const urlPrefix = ASSET_KIND_TO_URL_PREFIX[entry.kind];
  const localDir = directoryForAssetKind(entry.kind);
  // Re-validate the filename here even though the receiver already
  // sanitized it in diffAssetManifestAgainstLocal — belt-and-suspenders
  // against any future refactor that bypasses the diff path.
  const safeName = sanitizeAssetFilename(entry.filename);
  if (!urlPrefix || !localDir || !safeName) return;
  // Dedup in-flight pulls — if the same (peer, kind, filename) is already
  // being downloaded, skip rather than starting a second concurrent pull.
  // The first pull's `asset-arrived` event will resolve the UI for both
  // the original triggering push AND any subsequent push that wanted the
  // same bytes.
  const key = inflightKey(peer.instanceId, entry.kind, safeName);
  if (inflightPulls.has(key)) return;
  inflightPulls.add(key);
  try {
    await doPullOneAsset(peer, base, entry, urlPrefix, localDir, safeName);
  } finally {
    inflightPulls.delete(key);
  }
}

async function doPullOneAsset(peer, base, entry, urlPrefix, localDir, safeName) {
  // Sidecar-only divergence: image bytes are already present and hash-match
  // the sender's manifest (diffAssetManifestAgainstLocal still returned this
  // entry because the local sidecar is absent or stale). Skip the image
  // re-pull and go straight to the sidecar fetch — avoids re-downloading a
  // potentially large PNG for a metadata-only update.
  if (entry.kind === 'image' && isStr(entry.sha256)) {
    const localFullPath = join(localDir, safeName);
    if (existsSync(localFullPath)) {
      const localHash = (await getOrComputeImageSha256(localFullPath))?.hash ?? null;
      if (localHash === entry.sha256) {
        // Image bytes already up-to-date — pull sidecar only.
        await pullSidecarForImage(peer, base, safeName).catch(() => {});
        return;
      }
    }
  }

  const url = `${base}${urlPrefix}/${encodeURIComponent(safeName)}`;
  const buffer = await fetchCappedAssetBuffer(peer, url, safeName, ASSET_PULL_MAX_BYTES);
  if (!buffer) return;
  await ensureDir(localDir);
  const fullPath = join(localDir, safeName);
  // atomicWrite (temp + rename) so a crash mid-write doesn't leave a
  // half-written file that subsequent `diffAssetManifestAgainstLocal`
  // calls would see as "present" and stop re-requesting.
  await atomicWrite(fullPath, buffer);
  peerSyncEvents.emit('asset-arrived', {
    filename: safeName,
    kind: entry.kind,
    peerId: peer.instanceId,
  });
  console.log(`📥 peerSync: pulled ${entry.kind}/${safeName} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
  // After a successful image pull, also fetch the gen-params sidecar if present
  // on the sender. Best-effort: the image is already safely written above;
  // a missing sidecar just means the image lands in Unsorted without a prompt.
  if (entry.kind === 'image') {
    await pullSidecarForImage(peer, base, safeName).catch(() => {});
  }
  // After a video pull, regenerate the thumbnail LOCALLY rather than pulling it
  // as a sibling asset. Cheaper end-to-end: no new asset kind / URL-prefix /
  // manifest-diff plumbing, and the thumbnail filename is deterministic
  // (`<jobId>.jpg`, where jobId === the video filename minus `.mp4`). The
  // synced video-history row already carries `thumbnail: '<jobId>.jpg'`, so
  // once this file exists on disk `normalizeVideo` renders the collection
  // tile. Best-effort: if ffmpeg is missing the row still syncs (the item
  // stops being filtered as "missing"); the tile just falls back to no
  // preview. Mirrors generateThumbnail's null-on-failure contract.
  if (entry.kind === 'video') {
    const jobId = safeName.replace(/\.[a-z0-9]+$/i, '');
    const videoPath = join(localDir, safeName);
    await generateThumbnail(videoPath, jobId).catch(() => null);
  }
}

// --- Standalone media-library federation (#1566) ------------------------
//
// The per-record pipeline above replicates only the bytes a SYNCED creative
// record references. For a declared full-sync peer pair we ALSO mirror the
// STANDALONE media library — every generated image/video, pipeline audio, and
// user-uploaded music — so each peer's Media tab is a complete replica.
//
// Shape: the sender advertises a library-level manifest (filename + sha256 per
// asset) at GET /api/peer-sync/library-manifest; a receiver (only for peers it
// has flagged fullSync) fetches it, diffs vs local disk via the SAME
// diffAssetManifestAgainstLocal + pullOneAsset machinery the per-record path
// uses, and rebuilds the derived media_assets index once bytes land. Notably:
//   - video THUMBNAILS are regenerated locally on each video pull
//     (doPullOneAsset's video branch), not byte-federated;
//   - video-history METADATA already union-merges via the `videoHistory`
//     dataSync category — the bytes are what this adds;
//   - the generic data/history.jsonl action log is machine-local and never
//     federated (it's app activity, not media gen history).

// The on-disk media kinds the library manifest covers, resolved at CALL TIME
// (not frozen at module load) so a redirected PATHS — the test-suite tmpdir
// pattern, and consistent with directoryForAssetKind reading PATHS live — is
// honored. `image` carries a gen-params sidecar (rides via hashImageForManifest);
// the rest are flat bytes. image-refs are EXCLUDED (ephemeral FLUX multi-ref
// scratch); video-thumbnails are EXCLUDED (regenerated locally on video pull).
function mediaLibraryDirs() {
  return [
    { kind: 'image', dir: PATHS.images },
    { kind: 'video', dir: PATHS.videos },
    { kind: 'audio', dir: PATHS.audio },
    { kind: 'music', dir: PATHS.music },
  ];
}

// Stable data-root-relative basename per kind, used only to match backup
// exclude patterns. Independent of PATHS so a redirected path can't change which
// exclude pattern applies.
const MEDIA_LIBRARY_KIND_DIRNAMES = Object.freeze({
  image: 'images', video: 'videos', audio: 'audio', music: 'music',
});

// Cap so a pathologically large library can't build an unbounded manifest. 100k
// assets is far beyond any realistic single-user library; when exceeded we LOG
// and truncate (per CLAUDE.md "no silent caps") rather than ship an open-ended
// list. Pagination is a clean follow-up if ever hit. Kept in sync with the
// `assets` array cap in peerLibraryManifestSchema.
const MEDIA_LIBRARY_MANIFEST_CAP = 100_000;

/**
 * Pure matcher: given a list of effective rsync exclude patterns, return the Set
 * of media-library KINDS the user has excluded from backup (and therefore from
 * federation, per the #1566 acceptance criterion). Checked at DIRECTORY
 * granularity — recognizes a whole-dir exclude (`/videos`, `/videos/`,
 * `/videos/**`, or the bare `videos/` form). Per-file glob granularity is out of
 * scope: none of the media dirs are excluded by DEFAULT_EXCLUDES, so this only
 * fires on a custom user exclude like `/music/`, and excluding individual files
 * from federation isn't a supported control.
 *
 * Exported for unit testing without mocking the settings/backup IO.
 */
export function libraryKindsExcludedByPatterns(effectiveExcludes) {
  const excluded = new Set();
  const patterns = Array.isArray(effectiveExcludes) ? effectiveExcludes : [];
  // Normalize each pattern to its bare anchored segment in one pass: strip
  // leading slashes, a trailing `/**`/`/*`, or a trailing slash → `/videos/**`
  // and `videos/` both collapse to `videos`.
  const normalized = patterns.map((p) => String(p).replace(/^\/+|\/+\*+$|\/+$/g, ''));
  for (const [kind, name] of Object.entries(MEDIA_LIBRARY_KIND_DIRNAMES)) {
    if (normalized.includes(name)) excluded.add(kind);
  }
  return excluded;
}

// Honor the backup exclusion contract (#1566 acceptance). Best-effort: a
// settings/backup read failure federates everything (the prior behavior), never
// throws. Composes the IO (read settings, compute effective excludes) with the
// pure `libraryKindsExcludedByPatterns` matcher above.
async function excludedLibraryKinds() {
  const settingsMod = await import('../settings.js').catch(() => null);
  const backupMod = await import('../backup.js').catch(() => null);
  if (!settingsMod?.getSettings || !backupMod?.computeEffectiveExcludes) return new Set();
  const settings = await settingsMod.getSettings().catch(() => null);
  const excludePaths = Array.isArray(settings?.backup?.excludePaths) ? settings.backup.excludePaths : [];
  const disabledDefaultExcludes = Array.isArray(settings?.backup?.disabledDefaultExcludes) ? settings.backup.disabledDefaultExcludes : [];
  const effective = backupMod.computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes });
  return libraryKindsExcludedByPatterns(effective);
}

// In-memory hash cache for the flat (non-image) library kinds, keyed by full
// path → { mtimeMs, size, entry }. The manifest is rebuilt on every poll (each
// full-sync peer fetches it ~every 60s), and video/music files can be large —
// re-`sha256File`-ing a multi-GB library every poll is real, avoidable disk I/O.
// Images already cache their sha in the sidecar (getOrComputeImageSha256), so
// this only covers video/audio/music. Invalidated on (mtimeMs, size) change —
// the same cheap signal the image sidecar cache uses; a re-render writes a new
// file (new mtime), so staleness isn't a concern.
const libraryFlatHashCache = new Map(); // fullPath → { mtimeMs, size, entry }

async function hashCachedLibraryAsset(name, kind, dir) {
  const safeName = sanitizeAssetFilename(name);
  if (!safeName) return null;
  const fullPath = join(dir, safeName);
  const st = await stat(fullPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  const cached = libraryFlatHashCache.get(fullPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entry;
  const entry = await hashSimpleAsset(safeName, kind, dir);
  if (entry) libraryFlatHashCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, entry });
  return entry;
}

/**
 * Build the standalone media-library manifest this instance advertises to
 * full-sync peers. Walks each media dir, hashes every file (reusing the
 * per-record hashers so the wire shape is identical), and stamps a `manifestHash`
 * over the sorted entries so a receiver can short-circuit an unchanged library.
 *
 * @returns {Promise<{ schemaVersion:number, manifestHash:string, assets:Array }>}
 */
export async function buildMediaLibraryManifest() {
  const excluded = await excludedLibraryKinds();
  const assets = [];
  let truncated = false;
  for (const { kind, dir } of mediaLibraryDirs()) {
    if (truncated) break;
    if (excluded.has(kind)) continue;
    const names = await readdir(dir).catch(() => []); // missing dir → empty (nothing of that kind yet)
    for (const name of names) {
      // Image sidecars are metadata, not standalone assets — they ride the image
      // entry's sidecarSha256 + the receiver's pullSidecarForImage, so skip the
      // `.json` files in the images dir.
      if (kind === 'image' && name.endsWith('.json')) continue;
      const entry = kind === 'image'
        ? await hashImageForManifest(name)        // sidecar-cached
        : await hashCachedLibraryAsset(name, kind, dir); // (mtime,size)-cached
      if (!entry) continue;
      if (assets.length >= MEDIA_LIBRARY_MANIFEST_CAP) { truncated = true; break; }
      assets.push(entry);
    }
  }
  if (truncated) {
    console.log(`⚠️ peerSync: media-library manifest hit the ${MEDIA_LIBRARY_MANIFEST_CAP}-asset cap — truncating (some assets won't federate; pagination is a follow-up)`);
  }
  // Deterministic order (sort by filename) so the manifestHash converges across
  // machines regardless of readdir order / filesystem.
  const sorted = assets.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const manifestHash = createHash('sha256')
    .update(sorted.map((e) => `${e.kind}:${e.filename}:${e.sha256 || ''}:${e.sidecarSha256 || ''}`).join('\n'))
    .digest('hex');
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary, manifestHash, assets: sorted };
}

// Receiver-side: last manifestHash fully processed per peer, so an unchanged
// library skips the diff entirely. In-memory (rebuilt on restart — the first
// post-boot sweep just re-confirms disk, cheap because the diff finds everything
// present and pulls nothing).
const lastLibraryManifestHash = new Map(); // peerInstanceId → manifestHash
// Consecutive unchanged-manifest ticks per peer; after FORCE_REVALIDATE_EVERY we
// force a full re-diff even though the remote manifest is unchanged, so a local
// file loss self-heals without waiting for a restart or a remote library change.
const libraryUnchangedSkips = new Map(); // peerInstanceId → count
const FORCE_REVALIDATE_EVERY = 10; // ~10 min at the 60s sweep cadence
// Per-peer re-entrancy guard so a slow sweep (large pull) can't overlap itself
// when the periodic tick fires again before it finishes.
const librarySweepInFlight = new Set(); // peerInstanceId
// The manifest JSON itself (not the bytes — those ride the per-asset 100MB cap).
const MEDIA_LIBRARY_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

async function reconcileMediaLibraryIndex() {
  // Dynamic import keeps the DB-backed index module out of peerSync's static
  // graph (it no-ops under the file/test backend). image+video rows are rebuilt
  // from disk; audio/music aren't indexed (served from disk directly).
  const mod = await import('../mediaAssetIndex/index.js').catch(() => null);
  if (!mod?.reconcileMediaAssets) return;
  await mod.reconcileMediaAssets().catch((err) => {
    console.log(`⚠️ peerSync: media_assets reconcile after library sweep failed: ${err.message}`);
  });
}

/**
 * Receiver-pull the standalone media library from ONE full-sync peer: fetch its
 * manifest, gate on schema version, diff vs local disk, pull missing bytes, then
 * rebuild the derived media_assets index. No-op for a non-full-sync peer.
 *
 * Best-effort + idempotent: every guard returns rather than throws so a periodic
 * caller can fire it unconditionally.
 *
 * @param {object} peer  a peer entry from getPeers()
 * @returns {Promise<{ pulled:number, skipped?:string }>}
 */
export async function syncMediaLibraryFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { pulled: 0, skipped: 'not-fullsync' };
  }
  if (librarySweepInFlight.has(peer.instanceId)) return { pulled: 0, skipped: 'in-flight' };
  librarySweepInFlight.add(peer.instanceId);
  try {
    const url = `${peerBaseUrl(peer)}/api/peer-sync/library-manifest`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ASSET_PULL_TIMEOUT_MS);
    const res = await peerFetch(url, { signal: controller.signal, maxBytes: MEDIA_LIBRARY_MANIFEST_MAX_BYTES }, peer)
      .finally(() => clearTimeout(timeoutId))
      .catch(() => null);
    if (!res || !res.ok) return { pulled: 0, skipped: 'unreachable' };
    // Enforce the manifest cap before buffering the body. peerFetch's `maxBytes`
    // only streams-caps the HTTPS (host) shim; for a plain-HTTP (address) peer it
    // delegates to native fetch, which ignores `maxBytes`, so `res.json()` would
    // otherwise buffer an unbounded body. Express on the sender sets Content-Length
    // for the JSON response, so a content-length check here is the real cap (mirrors
    // the record-pull path's RECORD_PAYLOAD_MAX_BYTES guard). A peer that omits it
    // is a trusted tailnet peer per the threat model.
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > MEDIA_LIBRARY_MANIFEST_MAX_BYTES) {
      console.log(`⚠️ peerSync: media-library manifest from ${peer.name || peer.instanceId} too large (${declaredLen} > ${MEDIA_LIBRARY_MANIFEST_MAX_BYTES}) — skipping`);
      return { pulled: 0, skipped: 'too-large' };
    }
    const body = await res.json().catch(() => null);
    const parsed = peerLibraryManifestSchema.safeParse(body);
    if (!parsed.success) {
      console.log(`⚠️ peerSync: media-library manifest from ${peer.name || peer.instanceId} failed validation — skipping`);
      return { pulled: 0, skipped: 'invalid' };
    }
    const manifest = parsed.data;
    // Schema gate — GENTLE skip (not reject): the sender's manifest envelope is
    // newer than this instance understands. Wait for the local PortOS to upgrade
    // rather than mis-pull against a contract we can't read. (Bytes are
    // version-agnostic, but a manifest-SHAPE bump means a new field we'd mishandle.)
    if (manifest.schemaVersion > PORTOS_SCHEMA_VERSIONS.mediaLibrary) {
      console.log(`⏸️ peerSync: ${peer.name || peer.instanceId} media-library manifest is schema v${manifest.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.mediaLibrary} — skipping until this instance updates`);
      return { pulled: 0, skipped: 'schema-ahead' };
    }
    // Unchanged-library short-circuit — but force a full re-diff every
    // FORCE_REVALIDATE_EVERY consecutive unchanged ticks so a LOCAL file loss /
    // corruption self-heals even while the REMOTE manifest stays put. (The
    // recorded hash is in-memory, so a process restart also re-diffs; this covers
    // the mid-session window between restarts.)
    if (lastLibraryManifestHash.get(peer.instanceId) === manifest.manifestHash) {
      const skips = (libraryUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        libraryUnchangedSkips.set(peer.instanceId, skips);
        return { pulled: 0, skipped: 'unchanged' };
      }
      libraryUnchangedSkips.set(peer.instanceId, 0); // periodic forced re-diff — fall through
    }
    const missing = await diffAssetManifestAgainstLocal(manifest.assets);
    if (missing.length === 0) {
      lastLibraryManifestHash.set(peer.instanceId, manifest.manifestHash);
      return { pulled: 0 };
    }
    const requested = missing.length;
    // Reuse the per-record pull worker (in-flight dedup, image-sidecar fetch,
    // video-thumbnail regen).
    await pullMissingAssetsFromPeer(peer.instanceId, missing);
    // `pullMissingAssetsFromPeer` swallows per-asset failures (peer drops
    // mid-sweep, 404, size-cap reject) and always resolves — so a resolved pull
    // does NOT mean every byte landed. Re-diff against disk to see what actually
    // arrived; this is the authoritative signal, not the pull's resolution.
    const stillMissing = await diffAssetManifestAgainstLocal(manifest.assets);
    const pulled = requested - stillMissing.length;
    // Rebuild the derived media_assets index when any image/video bytes landed so
    // the gallery/Media tab reflects them. Idempotent; best-effort.
    if (pulled > 0) await reconcileMediaLibraryIndex();
    if (stillMissing.length === 0) {
      // Full sweep — safe to short-circuit future ticks on this manifestHash.
      lastLibraryManifestHash.set(peer.instanceId, manifest.manifestHash);
      console.log(`📥 peerSync: media-library sweep from ${peer.name || peer.instanceId} — pulled ${pulled} asset(s)`);
    } else {
      // Partial pull — do NOT record the hash, so the next tick re-diffs and
      // retries the still-missing assets instead of being marked done.
      console.log(`⚠️ peerSync: media-library sweep from ${peer.name || peer.instanceId} — pulled ${pulled}/${requested}, ${stillMissing.length} still missing; retrying next tick`);
    }
    return { pulled, missing: stillMissing.length };
  } finally {
    librarySweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Periodic driver: sweep the standalone media library from every full-sync peer.
 * Called on a timer from initSharing. Each peer's sweep is independent and
 * best-effort; the per-peer re-entrancy guard + manifestHash short-circuit keep
 * an unchanged library cheap.
 */
export async function syncMediaLibraryWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  const fullSyncPeers = peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId));
  for (const peer of fullSyncPeers) {
    await syncMediaLibraryFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: media-library sweep for ${peer.name || peer.instanceId} failed: ${err.message}`);
    });
  }
}

// --- Completed-agent CoS history federation (#1650) ---------------------
//
// For a declared full-sync peer pair we mirror the STANDALONE completed-agent
// archive tree (data/cos/agents/<YYYY-MM-DD>/<agentId>/{metadata,output,prompt})
// so each peer's CoS history UI is a complete replica. Archives are immutable
// once written (an agent never re-completes; agentIds are globally unique), so
// this is pure append/union byte replication — no merge, no conflict.
//
// Shape mirrors the media-library sweep (#1566): the sender advertises a
// content-addressed manifest at GET /api/peer-sync/cos-history-manifest; a
// receiver (only for peers it flags fullSync) fetches it, diffs vs local disk,
// receiver-pulls the missing archive files via the nested-path byte route
// (GET /api/peer-sync/cos-agent-archive), then merges the lightweight
// agentId→date index so the history UI lists the arrivals. The pull/integrity
// path mirrors the Writers Room draft-body pull (nested paths, sha256-verified).
//
// Running-agent state (state.json slots), live PTY buffers, the in-flight
// spawningTasks guard, and worktree working dirs are deliberately NOT federated
// — only the date-bucketed COMPLETED archives.

// Resolved at CALL TIME (not module load) so a redirected PATHS — the test
// tmpdir pattern, consistent with mediaLibraryDirs reading PATHS live — is honored.
function cosAgentsDir() {
  return join(PATHS.cos, 'agents');
}

// Cap so a pathologically large history can't build an unbounded manifest. Each
// agent contributes up to 3 files; 150k entries ≈ 50k agents, far beyond any
// realistic single-user history. When exceeded we LOG + truncate (CLAUDE.md "no
// silent caps"). Kept in sync with the `entries` cap in peerCosHistoryManifestSchema.
// Chosen so the worst-case serialized manifest (~180 bytes/entry ≈ 27MB) stays
// UNDER COS_HISTORY_MANIFEST_MAX_BYTES below — otherwise this sender-side
// truncation never engages and a receiver instead rejects the whole manifest on
// its content-length check (mirrors media-library's 100k-entries-under-32MB).
const COS_HISTORY_MANIFEST_CAP = 150_000;
// The manifest JSON itself (not the archive bytes — those ride the per-file cap).
const COS_HISTORY_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
// Per-archive-file hard cap. Agent transcripts (output.txt) can be large; 64MB is
// generous while still bounding a hostile/runaway peer. An oversized file is
// logged + skipped (it stays "missing" and is retried, never silently dropped).
const COS_ARCHIVE_PULL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Build the completed-agent history manifest this instance advertises to
 * full-sync peers. Walks data/cos/agents/<date>/<agentId>/, hashing each of the
 * three archive files that exist, and stamps a `manifestHash` over the sorted
 * entries so a receiver can short-circuit an unchanged history.
 *
 * @returns {Promise<{ schemaVersion:number, manifestHash:string, entries:Array }>}
 */
export async function buildCosHistoryManifest() {
  const root = cosAgentsDir();
  const entries = [];
  let truncated = false;
  // Top level: date buckets only. Skip index.json and any flat (running-agent)
  // dirs — only date-bucketed dirs hold COMPLETED archives.
  const dates = (await readdir(root).catch(() => [])).filter((d) => COS_ARCHIVE_DATE_RE.test(d));
  outer: for (const date of dates.sort()) {
    const dateDir = join(root, date);
    const agentIds = (await readdir(dateDir).catch(() => [])).filter((a) => COS_AGENT_ID_RE.test(a));
    for (const agentId of agentIds.sort()) {
      const agentDir = join(dateDir, agentId);
      for (const file of COS_ARCHIVE_FILES) {
        const full = join(agentDir, file);
        if (!existsSync(full)) continue;
        const sha256 = await sha256File(full).catch(() => null);
        if (!sha256) continue;
        if (entries.length >= COS_HISTORY_MANIFEST_CAP) { truncated = true; break outer; }
        entries.push({ date, agentId, file, sha256 });
      }
    }
  }
  if (truncated) {
    console.log(`⚠️ peerSync: cos-history manifest hit the ${COS_HISTORY_MANIFEST_CAP}-entry cap — truncating (some archives won't federate; pagination is a follow-up)`);
  }
  // Deterministic order so the manifestHash converges across machines regardless
  // of readdir order. (date, agentId already sorted above; sort by file too.)
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1
      : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const manifestHash = createHash('sha256')
    .update(entries.map((e) => `${e.date}:${e.agentId}:${e.file}:${e.sha256}`).join('\n'))
    .digest('hex');
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.cosHistory, manifestHash, entries };
}

/**
 * Receiver-side: return the manifest entries whose local archive file is absent
 * or hash-mismatched. Re-validates every path segment (belt-and-suspenders
 * against a future refactor that bypasses the Zod schema) before any FS op.
 */
export async function diffCosHistoryManifestAgainstLocal(manifestEntries) {
  if (!Array.isArray(manifestEntries)) return [];
  const root = cosAgentsDir();
  const missing = [];
  for (const entry of manifestEntries) {
    if (!isPlainObject(entry)) continue;
    const { date, agentId, file, sha256 } = entry;
    if (!COS_ARCHIVE_DATE_RE.test(date || '') || !COS_AGENT_ID_RE.test(agentId || '') || !COS_ARCHIVE_FILES.includes(file)) continue;
    const full = join(root, date, agentId, file);
    if (!existsSync(full)) { missing.push(entry); continue; }
    const localHash = await sha256File(full).catch(() => null);
    if (localHash !== sha256) missing.push(entry);
  }
  return missing;
}

// Receiver-side state — mirrors the media-library sweep's bookkeeping.
const lastCosHistoryManifestHash = new Map(); // peerInstanceId → manifestHash
const cosHistoryUnchangedSkips = new Map(); // peerInstanceId → count
const cosHistorySweepInFlight = new Set(); // peerInstanceId

async function pullMissingCosArchives(senderInstanceId, missing) {
  if (!isStr(senderInstanceId) || !Array.isArray(missing) || missing.length === 0) return [];
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull cos archives — peer ${senderInstanceId} not in registry`);
    return [];
  }
  const base = peerBaseUrl(peer);
  const landed = [];
  for (const entry of missing) {
    const pair = await pullOneCosArchiveFile(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: cos-archive pull ${entry?.agentId}/${entry?.file} from ${peer.name || senderInstanceId} failed: ${err.message}`);
      return null;
    });
    if (pair) landed.push(pair);
  }
  return landed;
}

async function pullOneCosArchiveFile(peer, base, entry) {
  const { date, agentId, file, sha256 } = entry || {};
  // Re-validate segments here even though the diff already did.
  if (!COS_ARCHIVE_DATE_RE.test(date || '') || !COS_AGENT_ID_RE.test(agentId || '') || !COS_ARCHIVE_FILES.includes(file)) return null;
  const safeLabel = `${date}/${agentId}/${file}`;
  const key = inflightKey(peer.instanceId, 'cos-archive', safeLabel);
  if (inflightPulls.has(key)) return null;
  inflightPulls.add(key);
  try {
    const url = `${base}/api/peer-sync/cos-agent-archive?date=${encodeURIComponent(date)}&agentId=${encodeURIComponent(agentId)}&file=${encodeURIComponent(file)}`;
    // allowEmpty: output.txt / prompt.txt can legitimately be 0 bytes.
    const buffer = await fetchCappedAssetBuffer(peer, url, safeLabel, COS_ARCHIVE_PULL_MAX_BYTES, { allowEmpty: true });
    if (!buffer) return null;
    // Integrity: discard a corrupt/wrong download instead of writing it.
    const bufHash = createHash('sha256').update(buffer).digest('hex');
    if (bufHash !== sha256) {
      console.log(`⚠️ peerSync: cos archive ${safeLabel} hash mismatch — discarding (got ${bufHash.slice(0, 8)}, want ${String(sha256).slice(0, 8)})`);
      return null;
    }
    const destDir = join(cosAgentsDir(), date, agentId);
    await ensureDir(destDir);
    await atomicWrite(join(destDir, file), buffer);
    peerSyncEvents.emit('asset-arrived', { filename: safeLabel, kind: 'cos-archive', peerId: peer.instanceId });
    console.log(`📥 peerSync: pulled cos archive ${safeLabel} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
    return { date, agentId };
  } finally {
    inflightPulls.delete(key);
  }
}

/**
 * Merge the manifest's completed-agent archives into the local agentId→date
 * index so the CoS history UI lists them. Called ONLY when the manifest's files
 * are confirmed present on disk (the diff returned empty), so every referenced
 * agent — including its metadata.json — exists; a half-pulled agent is never
 * indexed. Dynamic import keeps cosAgents out of peerSync's static graph (mirrors
 * reconcileMediaLibraryIndex). addAgentArchivesToIndex unions and never
 * overwrites a locally-owned id.
 */
async function reconcileCosHistoryIndex(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  // One {date, agentId} pair per agent (entries carry up to 3 files per agent).
  const seen = new Set();
  const pairs = [];
  for (const e of entries) {
    const key = `${e.date}/${e.agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ date: e.date, agentId: e.agentId });
  }
  const mod = await import('../cosAgents.js').catch(() => null);
  if (!mod?.addAgentArchivesToIndex) return;
  await mod.addAgentArchivesToIndex(pairs).catch((err) => {
    console.log(`⚠️ peerSync: cos-history index merge failed: ${err.message}`);
  });
}

/**
 * Receiver-pull the standalone completed-agent history from ONE full-sync peer.
 * Best-effort + idempotent (every guard returns rather than throws), mirroring
 * syncMediaLibraryFromPeer. No-op for a non-full-sync peer.
 *
 * @param {object} peer  a peer entry from getPeers()
 * @returns {Promise<{ pulled:number, skipped?:string, missing?:number }>}
 */
export async function syncCosHistoryFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { pulled: 0, skipped: 'not-fullsync' };
  }
  if (cosHistorySweepInFlight.has(peer.instanceId)) return { pulled: 0, skipped: 'in-flight' };
  cosHistorySweepInFlight.add(peer.instanceId);
  try {
    const url = `${peerBaseUrl(peer)}/api/peer-sync/cos-history-manifest`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ASSET_PULL_TIMEOUT_MS);
    const res = await peerFetch(url, { signal: controller.signal, maxBytes: COS_HISTORY_MANIFEST_MAX_BYTES }, peer)
      .finally(() => clearTimeout(timeoutId))
      .catch(() => null);
    if (!res || !res.ok) return { pulled: 0, skipped: 'unreachable' };
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > COS_HISTORY_MANIFEST_MAX_BYTES) {
      console.log(`⚠️ peerSync: cos-history manifest from ${peer.name || peer.instanceId} too large (${declaredLen} > ${COS_HISTORY_MANIFEST_MAX_BYTES}) — skipping`);
      return { pulled: 0, skipped: 'too-large' };
    }
    const body = await res.json().catch(() => null);
    const parsed = peerCosHistoryManifestSchema.safeParse(body);
    if (!parsed.success) {
      console.log(`⚠️ peerSync: cos-history manifest from ${peer.name || peer.instanceId} failed validation — skipping`);
      return { pulled: 0, skipped: 'invalid' };
    }
    const manifest = parsed.data;
    // Schema gate — GENTLE skip (not reject): wait for the local PortOS to
    // upgrade rather than mis-pull against a manifest shape we can't read.
    if (manifest.schemaVersion > PORTOS_SCHEMA_VERSIONS.cosHistory) {
      console.log(`⏸️ peerSync: ${peer.name || peer.instanceId} cos-history manifest is schema v${manifest.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.cosHistory} — skipping until this instance updates`);
      return { pulled: 0, skipped: 'schema-ahead' };
    }
    // Unchanged short-circuit, with a periodic forced re-diff so a LOCAL file
    // loss self-heals even while the REMOTE manifest stays put.
    if (lastCosHistoryManifestHash.get(peer.instanceId) === manifest.manifestHash) {
      const skips = (cosHistoryUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        cosHistoryUnchangedSkips.set(peer.instanceId, skips);
        return { pulled: 0, skipped: 'unchanged' };
      }
      cosHistoryUnchangedSkips.set(peer.instanceId, 0); // forced re-diff — fall through
    }
    const missing = await diffCosHistoryManifestAgainstLocal(manifest.entries);
    if (missing.length === 0) {
      // Everything the manifest references is already on disk — reconcile the
      // index BEFORE caching the hash so a present-but-unindexed archive (e.g. a
      // prior sweep landed the bytes but crashed before the index persisted)
      // becomes visible, instead of being skipped forever by the unchanged
      // short-circuit above.
      await reconcileCosHistoryIndex(manifest.entries);
      lastCosHistoryManifestHash.set(peer.instanceId, manifest.manifestHash);
      return { pulled: 0 };
    }
    const requested = missing.length;
    await pullMissingCosArchives(peer.instanceId, missing);
    // Re-diff: a resolved pull does NOT mean every byte landed (peer dropped,
    // 404, size-cap reject) — this is the authoritative signal.
    const stillMissing = await diffCosHistoryManifestAgainstLocal(manifest.entries);
    const pulled = requested - stillMissing.length;
    if (stillMissing.length === 0) {
      // Full manifest now present — reconcile the index from the manifest (every
      // referenced agent, incl. its metadata.json, is confirmed on disk) before
      // caching the hash so the arrivals show in the history UI.
      await reconcileCosHistoryIndex(manifest.entries);
      lastCosHistoryManifestHash.set(peer.instanceId, manifest.manifestHash);
      console.log(`📥 peerSync: cos-history sweep from ${peer.name || peer.instanceId} — pulled ${pulled} archive file(s)`);
    } else {
      // Partial pull — do NOT record the hash, so the next tick re-diffs and
      // retries the still-missing files; the index is reconciled once the
      // manifest is fully present (above), never from a half-pulled agent.
      console.log(`⚠️ peerSync: cos-history sweep from ${peer.name || peer.instanceId} — pulled ${pulled}/${requested}, ${stillMissing.length} still missing; retrying next tick`);
    }
    return { pulled, missing: stillMissing.length };
  } finally {
    cosHistorySweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Periodic driver: sweep completed-agent history from every full-sync peer.
 * Each peer's sweep is independent + best-effort.
 */
export async function syncCosHistoryWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  const fullSyncPeers = peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId));
  for (const peer of fullSyncPeers) {
    await syncCosHistoryFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: cos-history sweep for ${peer.name || peer.instanceId} failed: ${err.message}`);
    });
  }
}

// === Live CoS task-list + claim-metadata federation (#1712) ================
//
// The second half of #1650. Where the completed-agent HISTORY above federates as
// pure append-only byte replication, the LIVE task files (data/COS-TASKS.md /
// data/TASKS.md) are mutated by BOTH peers and carry claim/lease metadata (#1563),
// so they ride a claim-aware per-task LWW MERGE — never a byte/whole-file copy
// that would clobber a peer's fresh claim and re-open the double-spawn hazard.
//
// Transport mirrors the cos-history sweep's receiver-pull shape: the sender
// advertises its backlog at GET /api/peer-sync/cos-tasks; a receiver (only for
// peers it flags fullSync) fetches it, version-gates it, short-circuits on an
// unchanged listHash, and merges per task into its own files via
// cosTaskStore.mergePeerTasks (dynamic import — keeps the CoS task graph out of
// peerSync's static import chain, mirroring reconcileCosHistoryIndex's import of
// cosAgents). The merge itself is the pure cosTaskMerge module.
//
// Running-agent state (state.json slots), live PTY buffers, the in-flight
// spawningTasks guard, and worktree working dirs are deliberately NOT federated —
// only the task RECORDS + their claim metadata.

// The task payload JSON (not bytes — there are none). Generous vs any real
// single-user backlog; the build truncates beyond the entry cap and the receiver
// rejects an over-cap response on its content-length check.
const COS_TASKS_ENTRY_CAP = 50_000;
const COS_TASKS_MAX_BYTES = 32 * 1024 * 1024;

// Reduce a parsed task to its wire entry: the fields the receiver's merge +
// markdown round-trip need, plus the `taskType` discriminator telling it which
// file the task belongs in. Metadata rides verbatim (claim fields included);
// the receiver re-escapes/re-parses it safely on its next file read.
function taskToWireEntry(task, taskType) {
  const entry = {
    id: task.id,
    taskType,
    status: task.status,
    priority: task.priority,
    description: task.description,
    metadata: isPlainObject(task.metadata) ? task.metadata : {},
  };
  if (typeof task.approvalRequired === 'boolean') entry.approvalRequired = task.approvalRequired;
  if (typeof task.autoApproved === 'boolean') entry.autoApproved = task.autoApproved;
  return entry;
}

/**
 * Build the live task payload this instance advertises to full-sync peers.
 * Unions the user (TASKS.md) and internal (COS-TASKS.md) backlogs, stamps a
 * `listHash` over the sorted entries so a receiver can short-circuit an
 * unchanged backlog, and caps the entry count (logs + truncates beyond it).
 *
 * Dynamic import of cosTaskStore keeps the CoS task graph out of peerSync's
 * static import chain (mirrors reconcileCosHistoryIndex).
 *
 * @returns {Promise<{ schemaVersion:number, listHash:string, tasks:Array }>}
 */
export async function buildCosTasksPayload() {
  const empty = { schemaVersion: PORTOS_SCHEMA_VERSIONS.cosTasks, listHash: createHash('sha256').update('').digest('hex'), tasks: [] };
  const mod = await import('../cosTaskStore.js').catch(() => null);
  if (!mod?.getUserTasks || !mod?.getCosTasks) return empty;
  const [userRes, cosRes] = await Promise.all([
    mod.getUserTasks().catch(() => null),
    mod.getCosTasks().catch(() => null),
  ]);
  let entries = [
    ...((userRes?.tasks || []).map((t) => taskToWireEntry(t, 'user'))),
    ...((cosRes?.tasks || []).map((t) => taskToWireEntry(t, 'internal'))),
  ];
  if (entries.length > COS_TASKS_ENTRY_CAP) {
    console.log(`⚠️ peerSync: cos-tasks payload hit the ${COS_TASKS_ENTRY_CAP}-entry cap — truncating (some tasks won't federate this tick)`);
    entries = entries.slice(0, COS_TASKS_ENTRY_CAP);
  }
  // Deterministic order so the listHash is stable across ticks regardless of
  // file/section order. Hash EVERY field the receiver's merge can act on —
  // status, priority, description, approval flags, and metadata (incl. claim
  // metadata) — so any edit the merge would propagate flips the hash and
  // re-triggers a sweep. Omitting description/approval here would let a receiver
  // short-circuit `unchanged` and never pull a same-status content edit until the
  // forced-revalidation window. Pure reordering does not change the hash.
  entries.sort((a, b) => (a.taskType < b.taskType ? -1 : a.taskType > b.taskType ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listHash = createHash('sha256')
    .update(entries.map((e) => `${e.taskType}:${e.id}:${e.status}:${e.priority}:${e.description || ''}:${e.approvalRequired ?? ''}:${e.autoApproved ?? ''}:${JSON.stringify(e.metadata || {})}`).join('\n'))
    .digest('hex');
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.cosTasks, listHash, tasks: entries };
}

// Receiver-side bookkeeping — mirrors the cos-history sweep.
const lastCosTasksListHash = new Map(); // peerInstanceId → listHash
const cosTasksUnchangedSkips = new Map(); // peerInstanceId → count
const cosTasksSweepInFlight = new Set(); // peerInstanceId

/**
 * Apply a peer's task payload into the LOCAL task files via a claim-aware merge.
 * Splits the entries by taskType and hands each file's tasks to
 * cosTaskStore.mergePeerTasks (which runs the pure merge under the state lock).
 * Returns the number of files actually changed.
 */
async function mergeCosTasksFromPayload(tasks) {
  const mod = await import('../cosTaskStore.js').catch(() => null);
  if (!mod?.mergePeerTasks) return 0;
  const user = [];
  const internal = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.taskType === 'internal') internal.push(t);
    else if (t?.taskType === 'user') user.push(t);
  }
  let changed = 0;
  // Always merge BOTH files (even when one side is empty) so a task the peer
  // resolved/removed from a file converges — an empty list still merges (union
  // keeps local-only tasks, so it never wipes the local backlog).
  const userRes = await mod.mergePeerTasks('user', user).catch((err) => {
    console.log(`⚠️ peerSync: cos-tasks user merge failed: ${err.message}`); return null;
  });
  if (userRes?.changed) changed++;
  const internalRes = await mod.mergePeerTasks('internal', internal).catch((err) => {
    console.log(`⚠️ peerSync: cos-tasks internal merge failed: ${err.message}`); return null;
  });
  if (internalRes?.changed) changed++;
  return changed;
}

/**
 * Receiver-pull the live task backlog from ONE full-sync peer and merge it.
 * Best-effort + idempotent (every guard returns rather than throws), mirroring
 * syncCosHistoryFromPeer. No-op for a non-full-sync peer.
 *
 * @param {object} peer  a peer entry from getPeers()
 * @returns {Promise<{ merged:number, skipped?:string }>}
 */
export async function syncCosTasksFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { merged: 0, skipped: 'not-fullsync' };
  }
  if (cosTasksSweepInFlight.has(peer.instanceId)) return { merged: 0, skipped: 'in-flight' };
  cosTasksSweepInFlight.add(peer.instanceId);
  try {
    const url = `${peerBaseUrl(peer)}/api/peer-sync/cos-tasks`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ASSET_PULL_TIMEOUT_MS);
    const res = await peerFetch(url, { signal: controller.signal, maxBytes: COS_TASKS_MAX_BYTES }, peer)
      .finally(() => clearTimeout(timeoutId))
      .catch(() => null);
    if (!res || !res.ok) return { merged: 0, skipped: 'unreachable' };
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > COS_TASKS_MAX_BYTES) {
      console.log(`⚠️ peerSync: cos-tasks payload from ${peer.name || peer.instanceId} too large (${declaredLen} > ${COS_TASKS_MAX_BYTES}) — skipping`);
      return { merged: 0, skipped: 'too-large' };
    }
    const body = await res.json().catch(() => null);
    const parsed = peerCosTasksSchema.safeParse(body);
    if (!parsed.success) {
      console.log(`⚠️ peerSync: cos-tasks payload from ${peer.name || peer.instanceId} failed validation — skipping`);
      return { merged: 0, skipped: 'invalid' };
    }
    const payload = parsed.data;
    // Schema gate — GENTLE skip (not reject): wait for the local PortOS to
    // upgrade rather than mis-merge against a payload shape we can't read.
    if (payload.schemaVersion > PORTOS_SCHEMA_VERSIONS.cosTasks) {
      console.log(`⏸️ peerSync: ${peer.name || peer.instanceId} cos-tasks payload is schema v${payload.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.cosTasks} — skipping until this instance updates`);
      return { merged: 0, skipped: 'schema-ahead' };
    }
    // Unchanged short-circuit, with a periodic forced re-merge so a LOCAL task
    // loss self-heals even while the REMOTE backlog stays put. Unlike cos-history
    // the merge depends on TIME (lease expiry), so the forced re-merge also lets
    // an expired remote claim become re-claimable locally without a remote change.
    if (lastCosTasksListHash.get(peer.instanceId) === payload.listHash) {
      const skips = (cosTasksUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        cosTasksUnchangedSkips.set(peer.instanceId, skips);
        return { merged: 0, skipped: 'unchanged' };
      }
      cosTasksUnchangedSkips.set(peer.instanceId, 0); // forced re-merge — fall through
    }
    const changed = await mergeCosTasksFromPayload(payload.tasks);
    lastCosTasksListHash.set(peer.instanceId, payload.listHash);
    if (changed > 0) {
      console.log(`📥 peerSync: cos-tasks sweep from ${peer.name || peer.instanceId} — merged ${changed} task file(s)`);
    }
    return { merged: changed };
  } finally {
    cosTasksSweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Periodic driver: merge the live task backlog from every full-sync peer.
 * Each peer's sweep is independent + best-effort.
 */
export async function syncCosTasksWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  const fullSyncPeers = peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId));
  for (const peer of fullSyncPeers) {
    await syncCosTasksFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: cos-tasks sweep for ${peer.name || peer.instanceId} failed: ${err.message}`);
    });
  }
}

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
    return listPeerSubscriptions({ recordKind, recordId });
  }
  if (recordKind === 'issue') {
    const seriesId = await getIssueSeriesId(recordId);
    if (!seriesId) return [];
    return listPeerSubscriptions({ recordKind: 'series', recordId: seriesId });
  }
  return [];
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  // maxBytes caps the HTTPS shim's in-memory buffering (see lib/httpClient.js);
  // a buggy/misbehaving peer streaming an oversized body is aborted mid-stream
  // rather than buffered whole. The shim rejects with an "exceed" Error.
  let tooLarge = false;
  const res = await peerFetch(url, { signal: controller.signal, maxBytes: RECORD_PAYLOAD_MAX_BYTES }, peer)
    .finally(() => clearTimeout(timeoutId))
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
  await writeTail.catch(() => {});
}

/**
 * Test-only: await the in-flight write/push tail WITHOUT resetting state or
 * detaching listeners, so a test can deterministically settle the fire-and-forget
 * pushes a `subscribePeer` kicks off before asserting on the network mock. Awaits
 * twice because a push's `persistPushSuccess` only enqueues on `writeTail` after
 * its `peerFetch` resolves — i.e. a tick after the subscribe returned.
 */
export async function __drainForTests() {
  await writeTail.catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  await writeTail.catch(() => {});
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
