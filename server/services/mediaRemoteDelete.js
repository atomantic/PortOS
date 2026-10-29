/**
 * Delete a media row (a video history row by id, a gallery image by filename)
 * on the machine that owns it.
 *
 * A row this machine owns is deleted here (deleteHistoryItem / deleteImage
 * records the tombstone and announces it). A row owned elsewhere is never tombstoned here
 * first: the delete command goes to the owner (`POST /api/peer-media/delete`),
 * the row carries a machine-local `pendingDelete` flag meanwhile, and the
 * local copy goes only once the owner acks, through the same authorization and
 * tombstone path a peer's own delete frame takes. An unreachable owner leaves
 * the command in `data/media-delete-queue.json`, drained on `peer:online`.
 * A row no registered peer can own is deleted here like a local one.
 * The queue describes this machine's own work and never federates.
 */
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { rowOwnerCandidates } from '../lib/mediaRowOwners.js';
import { peerSyncTombstoneSchema } from '../lib/peerSyncEventSchema.js';
import { peerFetch, readPeerBody } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { loadHistory, getHistoryItem, mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { readHeldImage, localInstanceId } from './imageGen/imageRecords.js';
import { isSafeFilename } from '../lib/pathSafety.js';
import { emitMediaHistoryChanged } from './peerSyncEventBus.js';
import { instanceEvents } from './instanceEvents.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';

const QUEUE_FILE = () => join(PATHS.data, 'media-delete-queue.json');
const SCHEMA_VERSION = 1;
const KINDS = ['video', 'image'];
export const MEDIA_DELETE_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15_000;
const queueWrite = createFileWriteQueue();

// Lazy: the hosted index pulls in the peer registry, which the routes that load
// this module do not otherwise need.
const hostedModule = () => import('./peerHostedMedia.js');
const hostedIndex = () => hostedModule().then((m) => m.listHostedEntries());
// A collection image a host-mode peer holds has no png or sidecar here, only a
// hosted-index entry; its pending delete lives in the queue entry alone.
const hostedImageEntry = async (kind, key) => (kind === 'image' ? (await hostedIndex())[`image:${key}`] ?? null : null);
// The hosted entry is stale (or acked away): forget it and purge this machine's references.
async function settleHostedOnly(kind, key, opts) {
  await (await hostedModule()).dropHostedEntry(kind, key);
  return deleteLocally(kind, key, opts);
}
const peerIsPaired = (peer) => typeof peer?.syncSecret === 'string' && peer.syncSecret.length >= 32;
const peerLabel = (peer) => peer?.name || peer?.id || 'peer';
const isEntry = (e) => isPlainObject(e) && KINDS.includes(e.kind) && isNonBlankStr(e.key) && isNonBlankStr(e.peerId)
  && Number.isFinite(Date.parse(e.queuedAt));

// STRICT: an unreadable queue rejects rather than being rewritten as empty.
async function readQueue() {
  const raw = await readJSONFile(QUEUE_FILE(), null, { strict: true });
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return entries.filter(isEntry).map(({ peerId, kind, key, queuedAt, holderDeleted, ackTombstone }) => ({
    peerId, kind, key, queuedAt,
    ...(holderDeleted === true ? { holderDeleted } : {}),
    // The owner's acknowledged tombstone, kept when retiring the copy here failed.
    ...(isPlainObject(ackTombstone) ? { ackTombstone } : {}),
  }));
}

// `fn(entries)` returns the next list; the file is rewritten only when it changes.
function updateQueue(fn) {
  return queueWrite(async () => {
    const entries = await readQueue();
    const next = fn(entries);
    if (next.length !== entries.length || next.some((e, i) => e !== entries[i])) {
      await atomicWrite(QUEUE_FILE(), { version: SCHEMA_VERSION, entries: next });
    }
    return next;
  });
}

// Resolves the number of entries removed.
async function dropEntriesFor(kind, key) {
  let removed = 0;
  await updateQueue((entries) => {
    const next = entries.filter((e) => !(e.kind === kind && e.key === key));
    removed = entries.length - next.length;
    return next;
  });
  return removed;
}

// `pending` = `{ peerId, queuedAt }` sets the flag; null clears it. Machine-local:
// snapshots, frames, served sidecars and merges strip it like `hidden`.
async function setVideoPending(key, pending) {
  let changed = false;
  await mutateVideoHistory((history) => {
    const item = history.find((h) => h?.id === key);
    if (!item || (!pending && !('pendingDelete' in item))) return HISTORY_UNCHANGED;
    if (pending) item.pendingDelete = pending;
    else delete item.pendingDelete;
    changed = true;
    return history;
  });
  return changed;
}

async function setImagePending(key, pending) {
  const held = await readHeldImage(key);
  if (!held || (!pending && !held.pendingDelete)) return false;
  const { setImagePendingDelete } = await import('./imageGen/local.js');
  return (await setImagePendingDelete(key, pending)) === true;
}

/**
 * What each kind needs from the shared flow: its row as `rowOwnerCandidates`
 * reads it, the machine-local pending/hidden flags, the full local delete, and
 * the merge of an authorized owner tombstone.
 */
const MEDIA = {
  video: {
    label: 'Video',
    validKey: isNonBlankStr,
    getRow: getHistoryItem,
    setPending: setVideoPending,
    hide: async (key) => (await import('./videoGen/historyOps.js')).setHistoryItemHidden(key, true),
    deleteHere: async (key, opts) => (await import('./videoGen/historyOps.js')).deleteHistoryItem(key, opts),
    applyTombstone: async (tombstone, opts) => (await import('./dataSync.js')).applyRemoteVideoTombstones([tombstone], opts),
  },
  image: {
    label: 'Image',
    validKey: (key) => isSafeFilename(key, ['.png']),
    getRow: readHeldImage,
    setPending: setImagePending,
    hide: async (key) => (await import('./imageGen/local.js')).setImageHidden(key, true),
    deleteHere: async (key, opts) => (await import('./galleryImageDeletion.js')).deleteGalleryImage(key, opts),
    applyTombstone: async (tombstone, opts) => (await import('./imageGen/imageRecords.js')).applyRemoteImageTombstones([tombstone], opts),
  },
};

async function setPendingFlag(kind, key, pending) {
  if (await MEDIA[kind].setPending(key, pending)) emitMediaHistoryChanged({ kind, op: 'upsert', ids: [key] });
}

async function hideLocally(kind, key) {
  await MEDIA[kind].hide(key);
  emitMediaHistoryChanged({ kind, op: 'upsert', ids: [key] });
}

/**
 * Send the delete command to one peer. Resolves `{ outcome, tombstone?, detail? }`:
 * `ok`, `forbidden` (the owner refused), `not-held`, `unreachable` (network,
 * timeout or a server fault, worth retrying) or `error` (a refusal that
 * retrying will not change, e.g. an older peer without the route).
 */
async function sendDeleteCommand(peer, kind, key) {
  let res;
  try {
    res = await withAbortTimeout(COMMAND_TIMEOUT_MS, (signal) => peerFetch(`${peerBaseUrl(peer)}/api/peer-media/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key }),
      signal,
    }, peer));
  } catch (err) {
    return { outcome: 'unreachable', detail: err?.message || String(err) };
  }
  const body = await readPeerBody(res, 'json', { maxBytes: 64 * 1024, idleTimeoutMs: 5000 }).catch(() => null);
  if (res.ok && body?.ok === true) {
    // The reply names what to delete here, so it must be the tombstone for the
    // row we asked about and nothing else; anything else is a failed command.
    const parsed = peerSyncTombstoneSchema.safeParse(body.tombstone);
    if (!parsed.success || parsed.data.key !== key) return { outcome: 'invalid-ack', detail: 'reply carried no tombstone for this row' };
    return { outcome: 'ok', tombstone: parsed.data };
  }
  if (res.status === 403 && body?.code === 'MEDIA_DELETE_FORBIDDEN') return { outcome: 'forbidden' };
  if (res.status === 404 && body?.code === 'MEDIA_NOT_HELD') return { outcome: 'not-held' };
  const detail = `http-${res.status}${body?.code ? ` ${body.code}` : ''}`;
  if (res.status >= 500 && res.status !== 501) return { outcome: 'unreachable', detail };
  return { outcome: 'error', detail };
}

// Tombstone refusals that mean the owner's reply itself is unusable.
const BAD_TOMBSTONE_REASONS = new Set(['invalid-key', 'future-or-invalid-deletedAt']);

/**
 * The owner deleted its copy; retire ours through the rule every remote media
 * tombstone passes (the owner is one of this row's owner candidates), so the
 * tombstone is recorded by the same merge and nothing is re-announced.
 * Resolves `deleted` (gone here too), `deleted-remote` (the owner's copy is
 * gone, this one stays; `hiddenHere` when it was hidden) or `invalid-ack`.
 */
async function retireLocalCopy(kind, peer, key, tombstone, opts) {
  const media = MEDIA[kind];
  // A queued command for the origin after another holder's ack already retired
  // the copy here (holderDeleted): nothing is left to retire.
  if (!(await media.getRow(key))) {
    // The host acked a hosted-only image: forget the entry and purge the references here.
    if (await hostedImageEntry(kind, key)) await settleHostedOnly(kind, key, opts);
    return { status: 'deleted' };
  }
  const { authorizeRemoteMediaTombstone } = await import('./mediaTombstoneAuthorization.js');
  const verdict = authorizeRemoteMediaTombstone({
    peer, tombstone, localRow: await media.getRow(key), hostedIndex: await hostedIndex(), via: 'event',
  });
  if (!verdict.allowed && BAD_TOMBSTONE_REASONS.has(verdict.reason)) return { status: 'invalid-ack', reason: verdict.reason };
  if (verdict.allowed) {
    await media.applyTombstone(tombstone, opts);
    if (!(await media.getRow(key))) return { status: 'deleted' };
    // The tombstone predates this copy (re-created since) or its removal failed
    // (already logged): the copy here stays, and is no longer pending.
    await setPendingFlag(kind, key, null);
    console.log(`⏭️ ${media.label} ${key} deleted on ${peerLabel(peer)}; the copy here was not removed`);
    return { status: 'deleted-remote', hiddenHere: false };
  }
  // This machine does not accept that peer's tombstones (e.g. its media delete
  // is off here), so the local copy stays, hidden on this machine only.
  console.log(`⏭️ ${media.label} ${key} deleted on ${peerLabel(peer)}; local copy hidden, its tombstone is not accepted here: ${verdict.reason}`);
  await setPendingFlag(kind, key, null);
  await hideLocally(kind, key);
  return { status: 'deleted-remote', hiddenHere: true };
}

async function deleteLocally(kind, key, opts) {
  const result = await MEDIA[kind].deleteHere(key, opts);
  await dropEntriesFor(kind, key);
  return { ...(isPlainObject(result) ? result : {}), status: 'deleted' };
}

const forbidden = (peer) => new ServerError(`${peerLabel(peer)} refused the delete: media delete is turned off there for this machine`, {
  status: 403, code: 'MEDIA_DELETE_FORBIDDEN',
});
const commandFailed = (peer, kind, detail) => new ServerError(`${peerLabel(peer)} could not delete this ${kind} (${detail}); it may need an update`, {
  status: 502, code: 'MEDIA_DELETE_FAILED',
});

// cancelPendingDelete bumps a row's generation; an attempt or drain that sees
// it change stops before re-queuing or re-flagging the row.
const cancelGenerations = new Map();
const generationOf = (kind, key) => cancelGenerations.get(`${kind}:${key}`) ?? 0;

// Last drain attempt per peer registry id, so an online owner that keeps
// failing is retried from `peers:updated` at most once per RETRY_INTERVAL_MS.
const RETRY_INTERVAL_MS = 60_000;
const lastAttemptAt = new Map();

async function deleteAnywhere(kind, key, opts) {
  const media = MEDIA[kind];
  const generation = generationOf(kind, key);
  const cancelled = () => generationOf(kind, key) !== generation;
  let row = await media.getRow(key);
  let hostedOnly = false;
  if (!row) {
    if (kind !== 'image') throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
    // An image with no bytes or sidecar here is a hosted collection item when a
    // peer hosts it: its delete goes to the host. With no host it keeps the
    // plain local delete, which retires this machine's references.
    if (!(await hostedImageEntry(kind, key))) return deleteLocally(kind, key, opts);
    row = { filename: key };
    hostedOnly = true;
  }
  const localId = await localInstanceId();
  if (localId && row.originInstanceId === localId) return deleteLocally(kind, key, opts);
  const candidates = rowOwnerCandidates(row, await hostedIndex()).filter((id) => id !== localId);

  const { getPeers } = await import('./instances.js');
  const peers = await getPeers();
  const registered = candidates
    .map((id) => peers.find((p) => p.instanceId === id))
    .filter(Boolean);
  if (registered.length === 0) {
    // No registered machine can own it (its origin peer was removed, or a
    // pre-upgrade row has no origin), so no command could ever be answered:
    // delete it here, missing files included. A former owner that re-pairs
    // keeps its own copy, since it never accepts this machine's tombstone.
    return deleteLocally(kind, key, opts);
  }
  // Fail closed: a registered owner this machine cannot reach would keep its
  // copy. The origin is the authority every other copy re-syncs from, so an
  // unpaired origin refuses the delete even when another holder could take it.
  const usable = (p) => p.enabled !== false && peerIsPaired(p);
  const targets = registered.filter(usable);
  const origin = registered.find((p) => p.instanceId === row.originInstanceId) ?? null;
  if (targets.length === 0 || (origin && !usable(origin))) {
    const peer = origin ?? registered[0];
    const action = peer.enabled === false ? `Turn ${peerLabel(peer)} back on` : `Pair with ${peerLabel(peer)}`;
    throw new ServerError(`${action} to delete its media from here`, {
      status: 409, code: 'MEDIA_OWNER_NOT_PAIRED',
    });
  }

  const queuedAt = new Date().toISOString();
  const withdrawn = async () => {
    await setPendingFlag(kind, key, null);
    console.log(`↩️ Delete of ${kind} ${key} withdrawn before its owner answered`);
    return { status: 'cancelled' };
  };
  await setPendingFlag(kind, key, { peerId: targets[0].id, queuedAt });
  if (cancelled()) return withdrawn();
  const unreachable = [];
  let failure = null;
  // Another holder's ack while the origin is unreachable: its copy is gone,
  // but the delete is not done until the origin has it too.
  let holderAck = null;
  try {
    for (const peer of targets) {
      // A peer the probe marks offline is queued for its `peer:online` rather than dialed.
      const result = peer.status === 'offline'
        ? { outcome: 'unreachable', detail: 'offline' }
        : await sendDeleteCommand(peer, kind, key);
      if (result.outcome === 'ok') {
        // The owner already deleted, so a cancel that raced the dial cannot undo it.
        const retired = await retireLocalCopy(kind, peer, key, result.tombstone, opts);
        if (retired.status === 'invalid-ack') throw commandFailed(peer, kind, `unusable tombstone: ${retired.reason}`);
        console.log(`🗑️ ${media.label} ${key} deleted on ${peerLabel(peer)}`);
        if (origin && peer !== origin && unreachable.includes(origin)) {
          holderAck = { peer, retired };
          break;
        }
        await dropEntriesFor(kind, key);
        return { ...retired, peerName: peerLabel(peer) };
      }
      if (cancelled()) return withdrawn();
      if (result.outcome === 'invalid-ack') throw commandFailed(peer, kind, result.detail);
      if (result.outcome === 'forbidden') throw forbidden(peer);
      if (result.outcome === 'unreachable') unreachable.push(peer);
      if (result.outcome === 'error' && !failure) failure = { peer, detail: result.detail };
    }
  } catch (err) {
    await setPendingFlag(kind, key, null);
    throw err;
  }
  if (holderAck) return queueForOrigin(kind, key, { origin, queuedAt, holderAck, cancelled });
  if (unreachable.length > 0) {
    const peer = unreachable[0];
    const entry = { peerId: peer.id, kind, key, queuedAt };
    lastAttemptAt.set(peer.id, Date.now());
    let queued = false;
    // Re-checked inside the queue lock, the same lock cancelPendingDelete's dequeue takes.
    await updateQueue((entries) => {
      if (cancelled()) return entries;
      queued = true;
      return [...entries.filter((e) => !(e.kind === kind && e.key === key)), entry];
    });
    if (!queued) return withdrawn();
    await setPendingFlag(kind, key, { peerId: peer.id, queuedAt });
    if (cancelled()) return withdrawn();
    console.log(`🔌 ${media.label} ${key} delete queued until ${peerLabel(peer)} is reachable`);
    return { status: 'pending', pendingDelete: { peerId: peer.id, queuedAt }, peerName: peerLabel(peer) };
  }
  await setPendingFlag(kind, key, null);
  if (failure) throw commandFailed(failure.peer, kind, failure.detail);
  // Every candidate answered that it does not hold the row.
  if (hostedOnly) {
    console.log(`⏭️ ${media.label} ${key}: no host holds it; forgotten here`);
    return { ...(await settleHostedOnly(kind, key, opts)), status: 'owner-unknown' };
  }
  await hideLocally(kind, key);
  console.log(`⏭️ ${media.label} ${key}: no owner candidate holds it; hidden on this machine only`);
  return { status: 'owner-unknown' };
}

/**
 * Another holder deleted its copy (and the one here was retired by its
 * tombstone) while the origin was unreachable. The origin refuses other
 * machines' tombstones, so it only learns of the delete from this command:
 * queue it, marked `holderDeleted` so it outlives the row here, and report the
 * delete pending until the origin acks. A cancel only stops the queuing; the
 * holder's delete already happened.
 */
async function queueForOrigin(kind, key, { origin, queuedAt, holderAck, cancelled }) {
  const media = MEDIA[kind];
  const { peer: holder, retired } = holderAck;
  const done = { ...retired, peerName: peerLabel(holder) };
  lastAttemptAt.set(origin.id, Date.now());
  let queued = false;
  await updateQueue((entries) => {
    if (cancelled()) return entries;
    queued = true;
    const entry = { peerId: origin.id, kind, key, queuedAt, holderDeleted: true };
    return [...entries.filter((e) => !(e.kind === kind && e.key === key)), entry];
  });
  const pendingDelete = { peerId: origin.id, queuedAt };
  if (!queued) {
    await setPendingFlag(kind, key, null);
    return done;
  }
  // A copy that stayed here (re-created since, or only hidden) shows the pending origin.
  await setPendingFlag(kind, key, pendingDelete);
  console.log(`🔌 ${media.label} ${key} delete queued until its origin ${peerLabel(origin)} is reachable`);
  return {
    status: 'pending',
    pendingDelete,
    peerName: peerLabel(origin),
    deletedOn: peerLabel(holder),
    removedHere: retired.status === 'deleted' || retired.hiddenHere === true,
  };
}

// One delete per row at a time; a repeated click joins the one in flight.
const inFlight = new Map();

/**
 * Delete `kind:key` wherever it is owned. Resolves `{ status }`:
 * `deleted` (gone here and on its owner), `deleted-remote` (gone on its owner;
 * the copy here stays, `hiddenHere` when hidden), `pending` (queued for an
 * unreachable owner; also `pendingDelete` and `peerName`; when another holder
 * already deleted its copy, also `deletedOn` and `removedHere`), `owner-unknown`
 * (hidden here only) or `cancelled` (withdrawn while the owner was dialed).
 * `forgetInMusicVideos: false` leaves the music-video cleanup to a caller that
 * already holds the project mutation boundary (a pool batch delete).
 * Throws 403 `MEDIA_DELETE_FORBIDDEN` when the owner refuses and 502
 * `MEDIA_DELETE_FAILED` when its answer is unusable.
 */
const unknownMedia = () => new ServerError('Unknown media', { status: 400, code: 'VALIDATION_ERROR' });

export function deleteMediaAnywhere(kind, key, { forgetInMusicVideos = true } = {}) {
  if (!MEDIA[kind]?.validKey(key)) return Promise.reject(unknownMedia());
  // Keyed by the cleanup mode too: a pool batch holds the project mutation
  // boundary and must not join a delete whose cleanup waits on that boundary.
  const id = `${kind}:${key}:${forgetInMusicVideos}`;
  if (inFlight.has(id)) return inFlight.get(id);
  const run = deleteAnywhere(kind, key, { forgetInMusicVideos }).finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  return run;
}

/** Queued image deletes by key: `Map<filename, { peerId, queuedAt }>`; empty when the queue is unreadable. */
export async function listQueuedImageDeletes() {
  const entries = await readQueue().catch(() => []);
  return new Map(entries.filter((e) => e.kind === 'image').map((e) => [e.key, { peerId: e.peerId, queuedAt: e.queuedAt }]));
}

/** Withdraw a queued delete and clear the row's pending flag. Resolves `{ ok, cancelled }`. */
export async function cancelPendingDelete(kind, key) {
  if (!MEDIA[kind]?.validKey(key)) throw unknownMedia();
  cancelGenerations.set(`${kind}:${key}`, generationOf(kind, key) + 1);
  const dequeued = await dropEntriesFor(kind, key);
  const row = await MEDIA[kind].getRow(key);
  if (!row && !(await hostedImageEntry(kind, key))) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  const cancelled = isPlainObject(row?.pendingDelete) || dequeued > 0;
  await setPendingFlag(kind, key, null);
  if (cancelled) console.log(`↩️ Pending delete of ${kind} ${key} cancelled`);
  return { ok: true, cancelled };
}

const entryExpired = (entry, nowMs) => nowMs - Date.parse(entry.queuedAt) > MEDIA_DELETE_QUEUE_TTL_MS;
// The row was re-created after the delete was queued, so the command no longer applies.
const rowRecreated = (row, entry) => Date.parse(row?.createdAt) > Date.parse(entry.queuedAt);

/**
 * Drop entries that expired (30 days), target a peer no longer registered
 * (unpaired), or whose row is gone or was re-created; clears each dropped
 * row's pending flag. `peers` is the current registry list.
 */
async function pruneMediaDeleteQueue(peers, nowMs = Date.now()) {
  const queued = await readQueue();
  if (queued.length === 0) return 0;
  const known = new Set((Array.isArray(peers) ? peers : []).map((p) => p?.id).filter(isNonBlankStr));
  const staleReason = (entry) => (entryExpired(entry, nowMs) ? 'expired' : !known.has(entry.peerId) ? 'peer removed' : null);
  // Rows are read only for entries that survive the cheap checks.
  const survivors = queued.filter((entry) => !staleReason(entry));
  const rows = new Map();
  if (survivors.some((entry) => entry.kind === 'video')) {
    const history = await loadHistory();
    for (const r of Array.isArray(history) ? history : []) if (isNonBlankStr(r?.id)) rows.set(`video:${r.id}`, r);
  }
  for (const entry of survivors.filter((e) => e.kind === 'image')) {
    const row = await readHeldImage(entry.key) ?? ((await hostedImageEntry('image', entry.key)) && {});
    if (row) rows.set(`image:${entry.key}`, row);
  }
  const dropped = [];
  // Only entries in the snapshot whose rows were read above are judged; one
  // queued since then has no row in the map and is not "gone".
  await updateQueue((entries) => entries.filter((entry) => {
    if (!queued.some((seen) => sameEntry(seen, entry))) return true;
    const row = rows.get(`${entry.kind}:${entry.key}`);
    const reason = staleReason(entry)
      ?? (!row ? (entry.holderDeleted ? null : 'row gone') : rowRecreated(row, entry) ? 're-created' : null);
    if (reason) dropped.push({ entry, reason });
    return !reason;
  }));
  for (const { entry, reason } of dropped) {
    console.log(`⏭️ Queued delete of ${entry.kind} ${entry.key} dropped: ${reason}`);
    await setPendingFlag(entry.kind, entry.key, null);
  }
  return dropped.length;
}

const FAILURE_REASONS = {
  refused: 'refused the delete',
  'not-held': 'does not hold it',
  unusable: 'replied without a usable confirmation',
};

// A queued delete outlives the page that asked for it, so a dropped one is
// told through the notification bell rather than a toast. Never rejects.
async function notifyQueuedDeleteFailed(entry, peer, reason) {
  try {
    const row = await MEDIA[entry.kind].getRow(entry.key).catch(() => null);
    const prompt = typeof row?.prompt === 'string' ? row.prompt.trim().replace(/\s+/g, ' ') : '';
    const subject = prompt ? `"${prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt}"` : entry.key;
    await addNotification({
      type: NOTIFICATION_TYPES.MEDIA_DELETE_FAILED,
      title: `Queued ${entry.kind} delete did not go through`,
      description: `${peerLabel(peer)} ${FAILURE_REASONS[reason]}, so ${MEDIA[entry.kind].label.toLowerCase()} ${subject} was not deleted there.`,
      priority: PRIORITY_LEVELS.MEDIUM,
      link: '/media/history',
      metadata: { kind: entry.kind, key: entry.key, peerId: peer.id, reason },
    });
  } catch (err) {
    console.error(`❌ Queued delete notification for ${entry.kind} ${entry.key} failed: ${err.message}`);
  }
}

const draining = new Set();
const sameEntry = (a, b) => a.peerId === b.peerId && a.kind === b.kind && a.key === b.key && a.queuedAt === b.queuedAt;
const dropEntry = (entry) => updateQueue((entries) => entries.filter((e) => !sameEntry(e, entry)));

/** Send every queued command for `peer` (it is online). Never rejects. */
async function drainMediaDeleteQueue(peer) {
  if (!isNonBlankStr(peer?.id) || draining.has(peer.id)) return 0;
  draining.add(peer.id);
  lastAttemptAt.set(peer.id, Date.now());
  let done = 0;
  try {
    const { getPeers } = await import('./instances.js');
    const peers = await getPeers();
    await pruneMediaDeleteQueue(peers);
    const current = peers.find((p) => p.id === peer.id) ?? null;
    const mine = (await readQueue()).filter((e) => e.peerId === peer.id);
    for (const entry of mine) {
      try {
        if (!current || !peerIsPaired(current)) {
          console.log(`⏭️ Queued delete of ${entry.kind} ${entry.key} kept: ${peerLabel(peer)} is not paired`);
          continue;
        }
        // A cancel (or a fresh attempt) since the list was read has withdrawn or replaced it.
        if (!(await readQueue()).some((e) => sameEntry(e, entry))) continue;
        // The owner already deleted and acknowledged; only the retirement here is left.
        const result = entry.ackTombstone
          ? { outcome: 'ok', tombstone: entry.ackTombstone }
          : await sendDeleteCommand(current, entry.kind, entry.key);
        if (result.outcome === 'unreachable') {
          console.log(`🔌 Queued delete of ${entry.kind} ${entry.key} still waiting on ${peerLabel(current)}: ${result.detail}`);
          continue;
        }
        let retired = null;
        if (result.outcome === 'ok') {
          try {
            retired = await retireLocalCopy(entry.kind, current, entry.key, result.tombstone);
          } catch (err) {
            if (err?.code === 'NOT_FOUND') {
              await dropEntry(entry);
              throw err;
            }
            // Keep the command with the owner's ack so the next drain retries the
            // retirement here; re-sending would find the owner no longer holds it.
            await updateQueue((entries) => entries.map((e) => (sameEntry(e, entry) ? { ...e, ackTombstone: result.tombstone } : e)));
            throw err;
          }
        }
        // Only this command: a cancel and a fresh attempt for the same media while
        // it was out must keep the newer entry.
        await dropEntry(entry);
        if (retired && retired.status !== 'invalid-ack') {
          console.log(`🗑️ Queued delete of ${entry.kind} ${entry.key} completed on ${peerLabel(current)} (${retired.status})`);
          done++;
        } else if (result.outcome === 'not-held') {
          await setPendingFlag(entry.kind, entry.key, null);
          if (await MEDIA[entry.kind].getRow(entry.key)) await hideLocally(entry.kind, entry.key);
          else if (await hostedImageEntry(entry.kind, entry.key)) await settleHostedOnly(entry.kind, entry.key);
          await notifyQueuedDeleteFailed(entry, current, 'not-held');
          console.log(`⏭️ ${peerLabel(current)} does not hold ${entry.kind} ${entry.key}; hidden on this machine only`);
        } else if (retired || result.outcome === 'invalid-ack') {
          await setPendingFlag(entry.kind, entry.key, null);
          await notifyQueuedDeleteFailed(entry, current, 'unusable');
          console.warn(`⚠️ ${peerLabel(current)} answered queued delete of ${entry.kind} ${entry.key} without a usable tombstone; nothing deleted here`);
        } else {
          await setPendingFlag(entry.kind, entry.key, null);
          await notifyQueuedDeleteFailed(entry, current, 'refused');
          console.log(`🚫 ${peerLabel(current)} refused queued delete of ${entry.kind} ${entry.key}: ${result.outcome}${result.detail ? ` ${result.detail}` : ''}`);
        }
      } catch (err) {
        // The row went while its command was out (deleted or retired here): nothing left to hide.
        if (err?.code === 'NOT_FOUND') console.log(`⏭️ Queued delete of ${entry.kind} ${entry.key}: the row is already gone here`);
        else console.error(`❌ Queued delete of ${entry.kind} ${entry.key} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Media delete queue drain for ${peerLabel(peer)} failed: ${err.message}`);
  } finally {
    draining.delete(peer.id);
  }
  return done;
}

// After a registry change (every probe cycle emits one): prune, then retry the
// queued commands of owners that are online now, once per RETRY_INTERVAL_MS.
async function reconcileMediaDeleteQueue(peers) {
  await pruneMediaDeleteQueue(peers);
  const waiting = new Set((await readQueue()).map((e) => e.peerId));
  const now = Date.now();
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (!waiting.has(peer?.id) || peer.status !== 'online' || peer.enabled === false) continue;
    if (now - (lastAttemptAt.get(peer.id) ?? -Infinity) < RETRY_INTERVAL_MS) continue;
    await drainMediaDeleteQueue(peer);
  }
}

let disarm = null;

/**
 * Arm the queue listeners: drain on `peer:online`; on registry changes prune
 * (a removed peer's commands go with it) and retry owners already online.
 * Idempotent; returns the disarm function.
 */
export function initMediaRemoteDelete() {
  if (disarm) return disarm;
  // Each returns its settling promise (the emitter ignores it; tests await it).
  const onOnline = (peer) => drainMediaDeleteQueue(peer);
  const onPeers = (peers) => reconcileMediaDeleteQueue(peers)
    .catch((err) => console.error(`❌ Media delete queue upkeep failed: ${err.message}`));
  instanceEvents.on('peer:online', onOnline);
  instanceEvents.on('peers:updated', onPeers);
  disarm = () => {
    instanceEvents.removeListener('peer:online', onOnline);
    instanceEvents.removeListener('peers:updated', onPeers);
    disarm = null;
  };
  return disarm;
}

/**
 * Receiver side of `POST /api/peer-media/delete`. `senderPeerId` is the
 * registry id authGate verified from the pair credential. Deletes the row here
 * with the ordinary local delete, which records and announces the tombstone,
 * and returns that tombstone so the sender can retire its own copy.
 */
export async function executePeerMediaDelete(senderPeerId, { kind, key }) {
  const { getPeers, peerMayDeleteMedia } = await import('./instances.js');
  const peer = (await getPeers()).find((p) => p.id === senderPeerId) ?? null;
  if (!peer || peer.enabled === false || !peerIsPaired(peer)) {
    throw new ServerError('A paired peer credential is required', { status: 403, code: 'PEER_CREDENTIAL_REQUIRED' });
  }
  if (!peerMayDeleteMedia(peer)) {
    console.log(`🚫 Media delete from ${peerLabel(peer)} refused: media delete is off for this peer`);
    throw new ServerError('Media delete is turned off for this peer', { status: 403, code: 'MEDIA_DELETE_FORBIDDEN' });
  }
  const media = MEDIA[kind];
  if (!media?.validKey(key)) throw unknownMedia();
  const notHeld = () => new ServerError('This machine does not hold that media', { status: 404, code: 'MEDIA_NOT_HELD' });
  if (!(await media.getRow(key))) throw notHeld();
  await media.deleteHere(key).catch((err) => { throw err?.code === 'NOT_FOUND' ? notHeld() : err; });
  await dropEntriesFor(kind, key);
  const { listMediaTombstones } = await import('./mediaTombstones.js');
  const tombstone = (await listMediaTombstones(kind)).find((t) => t.key === key) ?? null;
  console.log(`🗑️ ${media.label} ${key} deleted at the request of ${peerLabel(peer)}`);
  return { ok: true, tombstone };
}
