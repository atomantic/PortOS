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

import { join, basename } from 'path';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { PATHS, atomicWrite, readJSONFile, ensureDir, sha256File } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { getOrComputeImageSha256 } from '../../lib/assetHash.js';
import { sanitizeRecordForWire } from '../../lib/syncWire.js';
import { collectAssetReferences } from './exporter.js';
import { recordEvents } from './recordEvents.js';
import { getInstanceId, getPeers, UNKNOWN_INSTANCE_ID } from '../instances.js';
import { instanceEvents } from '../instanceEvents.js';
import { getUniverse, mergeUniversesFromSync } from '../universeBuilder.js';
import { getSeries, mergeSeriesFromSync } from '../pipeline/series.js';
import { listIssues, mergeIssuesFromSync } from '../pipeline/issues.js';
import {
  initCursor,
  ackDeletesUpTo,
  removeCursor as removeTombstoneCursor,
} from './peerTombstoneCursors.js';

export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(['universe', 'series']);

/**
 * Cross-cutting event bus for the peer-sync receiver. The asset-pull worker
 * emits `asset-arrived` ({ filename, kind, peerId }) when a previously-missing
 * file lands locally; `sharing/index.js` wires that to a socket emission so
 * the client's MediaImage component can swap its "syncing" placeholder for
 * the real bytes without polling.
 */
export const peerSyncEvents = new EventEmitter();
peerSyncEvents.setMaxListeners(100);

export const ERR_NOT_FOUND = 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND';
export const ERR_VALIDATION = 'PEER_SYNC_SUBSCRIPTION_VALIDATION';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

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
 * Create a peer subscription. Idempotent — re-subscribing returns the existing
 * record. The first subscribe also initializes the tombstone cursor with
 * `subscribedSince=now` so tombstones older than the subscription aren't
 * replayed to the peer.
 *
 * `opts.adoptedFromReverse` marks the subscription as auto-created by the
 * receiver-side reverse-subscribe path; it suppresses the immediate push so
 * we don't ping-pong (the peer that triggered the reverse just pushed us
 * the latest state by definition).
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
    pushRecordToPeer(sub).catch((err) => {
      console.log(`⚠️ peerSync: initial push failed for ${sub.id}: ${err.message}`);
    });
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
  for (const peer of targets) {
    const sub = await subscribePeer({ peerId: peer.instanceId, recordKind, recordId }).catch((err) => {
      console.log(`⚠️ peerSync: auto-subscribe ${recordKind}/${recordId} → ${peer.name || peer.instanceId} failed: ${err.message}`);
      return null;
    });
    if (sub && sub.created) {
      created.push({ peerId: peer.instanceId, subscriptionId: sub.id });
      console.log(`🔗 peerSync: auto-subscribed ${recordKind}/${recordId} → ${peer.name || peer.instanceId}`);
    }
  }
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
  let records = [];
  if (recordKind === 'universe') {
    const { listUniverses } = await import('../universeBuilder.js');
    records = await listUniverses({ includeDeleted: false }).catch(() => []);
  } else if (recordKind === 'series') {
    const { listSeries } = await import('../pipeline/series.js');
    records = await listSeries({ includeDeleted: false }).catch(() => []);
  }
  // Drop ephemeral records before the set-difference / sub creation. The wire
  // sanitizer would short-circuit any push anyway, but creating a sub that
  // can never push leaves an orphan row in peer_subscriptions.json that
  // confuses unsubscribe-all / tombstone-cursor lifecycle assumptions.
  records = records.filter(r => r?.ephemeral !== true);
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
  for (const rec of missing) {
    const sub = await subscribePeer({ peerId, recordKind, recordId: rec.id }, { skipCursorInit: cursorInited }).catch((err) => {
      console.log(`⚠️ peerSync: backfill-subscribe ${recordKind}/${rec.id} → ${peerId} failed: ${err.message}`);
      return null;
    });
    if (sub && sub.created) created.push({ recordId: rec.id, subscriptionId: sub.id });
  }
  if (created.length > 0) {
    console.log(`🔗 peerSync: backfill-subscribed ${created.length} ${recordKind} record(s) → ${peerId}`);
  }
  return created;
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

async function hashImageForManifest(filename) {
  if (!isStr(filename)) return null;
  const fullPath = join(PATHS.images, filename);
  const result = await getOrComputeImageSha256(fullPath);
  if (!result) return null;
  return { filename, kind: 'image', sha256: result.hash };
}

async function hashSimpleAsset(filename, kind, sourceDir) {
  if (!isStr(filename) || !isStr(sourceDir)) return null;
  const fullPath = join(sourceDir, filename);
  if (!existsSync(fullPath)) return null;
  const hash = await sha256File(fullPath).catch(() => null);
  if (!hash) return null;
  return { filename, kind, sha256: hash };
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
    // Build a sanitized projection: only the three fields the sender needs
    // back to pull. Echoing the raw peer-supplied entry would amplify any
    // junk fields it shipped (large strings, extra kinds, prototype-pollution
    // attempts) into the response — wire-symmetry should not let untrusted
    // input round-trip through our process untouched.
    const sanitizedEntry = {
      filename: safeName,
      kind: entry.kind,
      ...(isStr(entry.sha256) ? { sha256: entry.sha256 } : {}),
    };
    const fullPath = join(dir, safeName);
    if (!existsSync(fullPath)) {
      missing.push(sanitizedEntry);
      continue;
    }
    // Compare SHA when the manifest carries one — for ALL kinds, not just
    // images. The image path uses the sidecar cache (fast for the common
    // ~200-asset universe case); image-ref/video stream-hash on demand.
    // Existence-only would let a renamed-in-place asset on the receiver
    // silently mismatch the sender, and the snapshot-sync fallback is the
    // ONLY thing that would catch it 60s later — better to detect on push.
    if (isStr(entry.sha256)) {
      const localHash = entry.kind === 'image'
        ? (await getOrComputeImageSha256(fullPath))?.hash ?? null
        : await sha256File(fullPath).catch(() => null);
      if (localHash !== entry.sha256) missing.push(sanitizedEntry);
    }
  }
  return missing;
}

function directoryForAssetKind(kind) {
  if (kind === 'image') return PATHS.images;
  if (kind === 'image-ref') return PATHS.imageRefs;
  if (kind === 'video') return PATHS.videos;
  return null;
}

/**
 * Returns the filename if it's safe to use as a path segment under the asset
 * directory, otherwise null. Rejects path separators, parent-directory
 * tokens, and any value that doesn't match its own basename — same posture
 * as `jobFromSidecar` in services/sharing/exporter.js for symmetry with
 * how the share-bucket importer validates inbound asset filenames.
 */
function sanitizeAssetFilename(name) {
  if (typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (basename(name) !== name) return null;
  return name;
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
export async function pushRecordToPeer(sub) {
  if (
    !isPlainObject(sub)
    || !isNonEmptyStr(sub.peerId)
    || !isNonEmptyStr(sub.recordKind)
    || !isNonEmptyStr(sub.recordId)
  ) {
    return { pushed: false, reason: 'invalid-subscription' };
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
  // FULL logical payload (record + bundled issues + asset manifest) — not
  // just the record — so an issue-only edit, an asset-only re-render, or a
  // new image landing under the same series still propagates instead of
  // collapsing to "unchanged" because the parent series didn't move.
  // sourceInstanceId is intentionally excluded: it's an envelope field, not
  // a content field, and hashing it would force a re-push every time we
  // bumped instance metadata.
  const hash = simplePayloadHash({
    record: payload.record,
    issues: payload.issues ?? null,
    assetManifest: payload.assetManifest ?? [],
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  const res = await peerFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).catch((err) => {
    console.log(`⚠️ peerSync: push to ${peer.name || peer.instanceId} failed: ${err.message}`);
    return null;
  }).finally(() => clearTimeout(timeoutId));
  if (!res || !res.ok) {
    return { pushed: false, reason: res ? `http-${res.status}` : 'network' };
  }
  const body = await res.json().catch(() => null);

  // Persist push metadata to peer_subscriptions.json, then advance the
  // tombstone cursor in peer_tombstone_cursors.json if the receiver acked
  // any deletions. These are two separate files; a crash between them
  // leaves the cursor un-advanced for one push cycle, which is safe —
  // `ackDeletesUpTo` is monotonic + idempotent, so the receiver re-acks
  // the same deletedAt on the next push and the cursor catches up.
  await persistPushSuccess(sub.id, hash);
  if (Number.isFinite(body?.ackedDeletesUpTo) && body.ackedDeletesUpTo > 0) {
    await ackDeletesUpTo(sub.peerId, body.ackedDeletesUpTo).catch(() => {});
  }
  return {
    pushed: true,
    hash,
    response: body || {},
    missingAssets: Array.isArray(body?.missingAssets) ? body.missingAssets : [],
  };
}

async function persistPushSuccess(subId, hash) {
  await withStateLock(async () => {
    const state = await readState();
    const sub = state.subscriptions.find((s) => s.id === subId);
    if (!sub) return;
    const now = new Date().toISOString();
    sub.lastPushedAt = now;
    sub.lastPushedHash = hash;
    sub.updatedAt = now;
    await writeState(state);
  });
}

async function buildPushPayload(sub, sourceInstanceId) {
  if (sub.recordKind === 'universe') {
    const record = await getUniverse(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('universe', record);
    if (!sanitized) return null;
    // Tombstone push: deleted records carry no on-disk assets the receiver
    // should pull. Sending an empty manifest avoids triggering
    // pullMissingAssetsFromPeer for a record we're telling the peer to
    // delete — both wasteful (network + disk for bytes the receiver will
    // immediately orphan) and privacy-sensitive (e.g. a record deleted
    // BECAUSE the user wanted the assets off-peer would otherwise still
    // ship them with the tombstone push).
    const assetManifest = record.deleted === true ? [] : await buildAssetManifest(record);
    return { kind: 'universe', record: sanitized, assetManifest, sourceInstanceId };
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
    // Tombstone push at the series level: same reasoning as universe above.
    // When the series itself is deleted, send an empty asset manifest so
    // the receiver doesn't pull bytes for a record it's about to tombstone.
    const assetManifest = record.deleted === true
      ? []
      : await buildAssetManifestForSeries(record, manifestIssues);
    return {
      kind: 'series',
      record: sanitized,
      issues: sanitizedIssues,
      assetManifest,
      sourceInstanceId,
    };
  }
  return null;
}

async function buildAssetManifestForSeries(series, issues) {
  const seriesAssets = await buildAssetManifest(series);
  const dedup = new Map(seriesAssets.map((a) => [`${a.kind}:${a.filename}`, a]));
  for (const issue of issues) {
    const issueAssets = await buildAssetManifest(issue);
    for (const a of issueAssets) {
      dedup.set(`${a.kind}:${a.filename}`, a);
    }
  }
  return [...dedup.values()];
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
  const { kind, record, issues, assetManifest, sourceInstanceId } = payload;
  if (!PEER_SUBSCRIBABLE_KINDS.includes(kind)) {
    throw makeErr(`unknown kind: ${kind}`, ERR_VALIDATION);
  }
  // sourceInstanceId is the key we hang the per-peer tombstone cursor on;
  // empty / "unknown" would poison the cursor table with a synthetic entry
  // that never gets cleaned up.
  if (!isNonEmptyStr(sourceInstanceId) || sourceInstanceId === UNKNOWN_INSTANCE_ID) {
    throw makeErr('sourceInstanceId required (and not "unknown")', ERR_VALIDATION);
  }
  if (!isPlainObject(record) || !isNonEmptyStr(record.id)) {
    throw makeErr('record must be an object with a string id', ERR_VALIDATION);
  }

  // Merge into local state via the existing LWW path. The merge functions
  // honor `deleted: true` + bump `updatedAt`, so this is the single
  // tombstone-aware reconciliation point.
  if (kind === 'universe') {
    await mergeUniversesFromSync([record]);
  } else if (kind === 'series') {
    await mergeSeriesFromSync([record]);
    if (Array.isArray(issues) && issues.length > 0) {
      await mergeIssuesFromSync(issues);
    }
  }

  // Diff incoming asset manifest against local disk. We (the receiver) are
  // the ones that will background-pull `missingAssets` from the sender's
  // `/data/{images,image-refs,videos}/<filename>` static mount in Stage 3
  // — the sender just needs to keep those files served, no action required
  // from it here. We return the list to the sender in the response so it
  // can surface progress in its UI ("N/M assets still syncing to peer X").
  const missingAssets = await diffAssetManifestAgainstLocal(assetManifest);

  // Compute the deletedAt water-mark we can ack. Use the maximum across the
  // record + its issues (a single push can carry multiple tombstones).
  const ackedDeletesUpTo = computeAckedDeletesFromPayload(record, issues);
  if (ackedDeletesUpTo > 0) {
    await ackDeletesUpTo(sourceInstanceId, ackedDeletesUpTo).catch(() => {});
  }

  // Best-effort reverse subscription. Failures don't fail the push — the
  // record is already merged and the response will tell the sender what
  // assets to push next. The reverse subscription only affects whether
  // future edits flow BACK; the user can also create one manually.
  const reverseSubscriptionCreated = await maybeCreateReverseSubscription({
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
  if (missingAssets.length > 0) {
    pullMissingAssetsFromPeer(sourceInstanceId, missingAssets).catch((err) => {
      console.log(`⚠️ peerSync: asset pull from ${sourceInstanceId} failed: ${err.message}`);
    });
  }

  return {
    missingAssets,
    reverseSubscriptionCreated,
    ackedDeletesUpTo,
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

  await subscribePeer({ peerId, recordKind, recordId }, { adoptedFromReverse: true });
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
  return 'missing';
}

// --- Receiver-side asset pull worker ------------------------------------

const ASSET_KIND_TO_URL_PREFIX = Object.freeze({
  image: '/data/images',
  'image-ref': '/data/image-refs',
  video: '/data/videos',
});

const ASSET_PULL_TIMEOUT_MS = 60000;
const ASSET_PULL_MAX_BYTES = 100 * 1024 * 1024; // 100MB hard cap per asset

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
  const url = `${base}${urlPrefix}/${encodeURIComponent(safeName)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ASSET_PULL_TIMEOUT_MS);
  const res = await peerFetch(url, { signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
  if (!res || !res.ok) return;
  // Size-cap enforcement: REQUIRE a trustworthy content-length header up
  // front and refuse the pull if missing or over-cap. Without the header
  // we'd have to buffer the whole response before checking buffer.length,
  // which defeats the cap (a hostile peer could ship a 10GB file under a
  // small filename and OOM the receiver before the check runs). Express's
  // `serve-static` always sets content-length for static files (verified
  // by the `acceptRanges: true` mount config in server/index.js), so this
  // is enforceable in the real deployment path.
  const contentLength = Number(res.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    console.log(`⚠️ peerSync: asset ${safeName} has no content-length — refusing pull`);
    return;
  }
  if (contentLength > ASSET_PULL_MAX_BYTES) {
    console.log(`⚠️ peerSync: asset ${safeName} too large (${contentLength}) — refusing pull`);
    return;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  // Defense in depth: the server claimed length X but actually sent more
  // (shouldn't happen with serve-static, but content-length is just a
  // header). Refuse to write the partial / over-cap result.
  if (buffer.length > ASSET_PULL_MAX_BYTES || buffer.length !== contentLength) {
    console.log(`⚠️ peerSync: asset ${safeName} length mismatch (header=${contentLength}, body=${buffer.length}) — refusing pull`);
    return;
  }
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
async function collectSubscriptionsForUpdate(recordKind, recordId) {
  if (recordKind === 'universe' || recordKind === 'series') {
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
  for (const sub of subs) {
    const result = await pushRecordToPeer(sub).catch((err) => {
      console.log(`⚠️ peerSync: retry push failed for ${sub.id}: ${err.message}`);
      return null;
    });
    if (result?.pushed) pushed += 1;
  }
  return { walked: subs.length, pushed };
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
  // ALSO listen for `deleted` events so soft-deletes propagate via the
  // per-record push pipeline. Without this, `deleteUniverse` /
  // `deleteSeries` (which emit `recordEvents.deleted`, NOT `updated`) only
  // reached peers via the 60s snapshot loop — and that loop is skipped for
  // any (peer, kind) pair covered by a per-record sub
  // (syncOrchestrator.categoriesCoveredByPeerSync). The result was that
  // every soft-delete on a record with active peer subs got stranded
  // locally. Route delete events through the same `triggerPushForRecord`
  // path: pushRecordToPeer reads the record with `includeDeleted: true`
  // and the wire sanitizer (now updated) lets tombstones cross even for
  // ephemeral records.
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
      const cats = peer.syncCategories || {};
      // KIND_TO_CATEGORY['universe']='universe', ['series']='pipeline'.
      // Iterate the kind keys so the (kind, category) mapping stays single-
      // sourced from KIND_TO_CATEGORY.
      for (const kind of PEER_SUBSCRIBABLE_KINDS) {
        const cat = KIND_TO_CATEGORY[kind];
        if (cats[cat] === true) {
          await autoSubscribePeerToAllRecords(peer.instanceId, kind).catch(() => {});
        }
      }
      await retryPendingPushesForPeer(peer.instanceId).catch(() => {});
    })().catch(() => {});
  };
  instanceEvents.on('peer:online', onPeerOnline);
}

/**
 * Test-only: clear pending debounces, detach our listener, and await any
 * in-flight state writes so the test can rm-rf the tmpdir without an
 * ENOTEMPTY race. Async so callers can `await __resetForTests()`.
 */
export async function __resetForTests() {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  if (onUpdated) recordEvents.off('updated', onUpdated);
  if (onDeleted) recordEvents.off('deleted', onDeleted);
  if (onPeerOnline) instanceEvents.off('peer:online', onPeerOnline);
  onUpdated = null;
  onDeleted = null;
  onPeerOnline = null;
  await writeTail.catch(() => {});
}
