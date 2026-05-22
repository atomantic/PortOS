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
 * orchestrator skip-when-subscribed wiring lands in Stage 3.
 *
 * State files (under `data/sharing/`):
 *   - `peer_subscriptions.json` — outgoing subscriptions FROM this instance.
 *     Receiver-side auto-created reverse subscriptions also live here.
 *   - `peer_tombstone_cursors.json` — per-peer tombstone ack water-marks
 *     (managed by `peerTombstoneCursors.js`, this module advances it).
 *
 * Stage 2 boundary: the push uses `peerFetch` (an HTTPS-or-HTTP client) and
 * targets a `/api/peer-sync/push` endpoint that doesn't exist yet — the
 * actual HTTP route + the orchestrator wiring land in Stage 3. Until then
 * pushes fail closed (logged + retried on next event), which is the right
 * behavior even in the deployed system.
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

  const sub = await withStateLock(async () => {
    const state = await readState();
    const id = subscriptionId({ peerId, recordKind, recordId });
    const now = new Date().toISOString();
    let existing = state.subscriptions.find((s) => s.id === id);
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
    }
    return existing;
  });
  // initCursor manages its own state file; no need to hold the subscription
  // lock across it.
  await initCursor(peerId);

  // Trigger initial push unless this was auto-created by a reverse-subscribe
  // (the peer just pushed us their latest, so pushing back is a no-op cycle).
  if (!opts.adoptedFromReverse) {
    pushRecordToPeer(sub).catch((err) => {
      console.log(`⚠️ peerSync: initial push failed for ${sub.id}: ${err.message}`);
    });
  }
  return sub;
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
    const assetManifest = await buildAssetManifest(record);
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
    const assetManifest = await buildAssetManifestForSeries(record, childIssues);
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

  // Honor the per-peer `directions` flag. A peer marked inbound-only is one
  // we accept pushes FROM but never push back TO — auto-creating a reverse
  // subscription would break that explicit configuration.
  const peer = await findPeerById(peerId);
  if (!peer) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  if (directions.length > 0 && !directions.includes('outbound')) return false;

  await subscribePeer({ peerId, recordKind, recordId }, { adoptedFromReverse: true });
  return true;
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

let onUpdated = null;

/** Attach the `recordEvents` listener — call once during sharing init. */
export function installPeerSyncListener() {
  if (onUpdated) return;
  onUpdated = ({ recordKind, recordId }) => {
    triggerPushForRecord(recordKind, recordId).catch((err) => {
      console.log(`⚠️ peerSync: listener error for ${recordKind}/${recordId}: ${err.message}`);
    });
  };
  recordEvents.on('updated', onUpdated);
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
  onUpdated = null;
  await writeTail.catch(() => {});
}
