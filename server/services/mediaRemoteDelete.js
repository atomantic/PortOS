/**
 * Delete a media row on the machine that owns it.
 *
 * A row this machine owns is deleted here (deleteHistoryItem records the
 * tombstone and announces it). A row owned elsewhere is never tombstoned here
 * first: the delete command goes to the owner (`POST /api/peer-media/delete`),
 * the row carries a machine-local `pendingDelete` flag meanwhile, and the
 * local copy goes only once the owner acks, through the same authorization and
 * tombstone path a peer's own delete frame takes. An unreachable owner leaves
 * the command in `data/media-delete-queue.json`, drained on `peer:online`.
 * The queue describes this machine's own work and never federates.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { rowOwnerCandidates } from '../lib/mediaRowOwners.js';
import { peerFetch, readPeerBody } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { safeUnder } from '../lib/ffmpeg.js';
import { loadHistory, getHistoryItem, mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { emitMediaHistoryChanged } from './peerSyncEventBus.js';
import { instanceEvents } from './instanceEvents.js';

const QUEUE_FILE = () => join(PATHS.data, 'media-delete-queue.json');
const SCHEMA_VERSION = 1;
const KINDS = ['video', 'image'];
export const MEDIA_DELETE_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15_000;
const queueWrite = createFileWriteQueue();

// Lazy: the hosted index pulls in the peer registry, which the routes that load
// this module do not otherwise need.
const hostedIndex = () => import('./peerHostedMedia.js').then((m) => m.listHostedEntries());
const peerIsPaired = (peer) => typeof peer?.syncSecret === 'string' && peer.syncSecret.length >= 32;
const peerLabel = (peer) => peer?.name || peer?.id || 'peer';
const isEntry = (e) => isPlainObject(e) && KINDS.includes(e.kind) && isNonBlankStr(e.key) && isNonBlankStr(e.peerId)
  && Number.isFinite(Date.parse(e.queuedAt));

// STRICT: an unreadable queue rejects rather than being rewritten as empty.
async function readQueue() {
  const raw = await readJSONFile(QUEUE_FILE(), null, { strict: true });
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return entries.filter(isEntry).map(({ peerId, kind, key, queuedAt }) => ({ peerId, kind, key, queuedAt }));
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

async function localInstanceId() {
  const identity = await import('./instanceIdentity.js');
  const id = await identity.getInstanceId().catch(() => null);
  return isNonBlankStr(id) && id !== identity.UNKNOWN_INSTANCE_ID ? id : null;
}

// `pending` = `{ peerId, queuedAt }` sets the flag; null clears it. Machine-local:
// snapshots, frames and merges strip it like `hidden`.
async function setPendingFlag(key, pending) {
  let changed = false;
  await mutateVideoHistory((history) => {
    const item = history.find((h) => h?.id === key);
    if (!item || (!pending && !('pendingDelete' in item))) return HISTORY_UNCHANGED;
    if (pending) item.pendingDelete = pending;
    else delete item.pendingDelete;
    changed = true;
    return history;
  });
  if (changed) emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: [key] });
}

async function hideLocally(key) {
  const { setHistoryItemHidden } = await import('./videoGen/historyOps.js');
  await setHistoryItemHidden(key, true);
  emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: [key] });
}

function fileIsLocal(row) {
  const file = isNonBlankStr(row?.filename) ? safeUnder(PATHS.videos, row.filename) : null;
  return Boolean(file && existsSync(file));
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
  if (res.ok && body?.ok === true) return { outcome: 'ok', tombstone: body.tombstone ?? null };
  if (res.status === 403 && body?.code === 'MEDIA_DELETE_FORBIDDEN') return { outcome: 'forbidden' };
  if (res.status === 404 && body?.code === 'MEDIA_NOT_HELD') return { outcome: 'not-held' };
  const detail = `http-${res.status}${body?.code ? ` ${body.code}` : ''}`;
  if (res.status >= 500 && res.status !== 501) return { outcome: 'unreachable', detail };
  return { outcome: 'error', detail };
}

// The owner deleted its copy; retire ours through the rule every remote video
// tombstone passes (the owner is one of this row's owner candidates), so the
// tombstone is recorded by the same merge and nothing is re-announced.
async function retireLocalCopy(peer, key, tombstone) {
  const [{ authorizeRemoteVideoTombstone }, { applyRemoteVideoTombstones }] = await Promise.all([
    import('./videoTombstoneAuthorization.js'), import('./dataSync.js'),
  ]);
  const verdict = authorizeRemoteVideoTombstone({
    peer, tombstone, localRow: await getHistoryItem(key), hostedIndex: await hostedIndex(), via: 'event',
  });
  if (verdict.allowed) {
    await applyRemoteVideoTombstones([tombstone]);
    // A removal that failed (already logged) must not leave the row marked pending forever.
    if (await getHistoryItem(key)) await setPendingFlag(key, null);
    return;
  }
  // This machine does not accept that peer's tombstones (e.g. its media delete
  // is off here), so the local copy stays, hidden on this machine only.
  console.log(`⏭️ Video ${key} deleted on ${peerLabel(peer)}; local copy hidden, its tombstone is not accepted here: ${verdict.reason}`);
  await setPendingFlag(key, null);
  await hideLocally(key);
}

async function deleteLocally(key) {
  const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
  await deleteHistoryItem(key);
  await dropEntriesFor('video', key);
  return { status: 'deleted' };
}

const forbidden = (peer) => new ServerError(`${peerLabel(peer)} refused the delete: media delete is turned off there for this machine`, {
  status: 403, code: 'MEDIA_DELETE_FORBIDDEN',
});

async function deleteVideoAnywhere(key) {
  const row = await getHistoryItem(key);
  if (!row) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  const localId = await localInstanceId();
  const candidates = rowOwnerCandidates(row, await hostedIndex()).filter((id) => id !== localId);
  if ((localId && row.originInstanceId === localId) || (candidates.length === 0 && fileIsLocal(row))) return deleteLocally(key);

  const { getPeers } = await import('./instances.js');
  const peers = await getPeers();
  const registered = candidates
    .map((id) => peers.find((p) => p.instanceId === id && p.enabled !== false))
    .filter(Boolean);
  if (registered.length === 0) {
    // Fail closed: nobody to send the command to, so only this machine's view changes.
    await hideLocally(key);
    console.log(`⏭️ Video ${key} has no known owner; hidden on this machine only`);
    return { status: 'owner-unknown' };
  }
  const targets = registered.filter(peerIsPaired);
  if (targets.length === 0) {
    throw new ServerError(`Pair with ${peerLabel(registered[0])} to delete its media from here`, {
      status: 409, code: 'MEDIA_OWNER_NOT_PAIRED',
    });
  }

  const queuedAt = new Date().toISOString();
  await setPendingFlag(key, { peerId: targets[0].id, queuedAt });
  const unreachable = [];
  let failure = null;
  try {
    for (const peer of targets) {
      // A peer the probe marks offline is queued for its `peer:online` rather than dialed.
      const result = peer.status === 'offline'
        ? { outcome: 'unreachable', detail: 'offline' }
        : await sendDeleteCommand(peer, 'video', key);
      if (result.outcome === 'ok') {
        await retireLocalCopy(peer, key, result.tombstone);
        await dropEntriesFor('video', key);
        console.log(`🗑️ Video ${key} deleted on its owner ${peerLabel(peer)}`);
        return { status: 'deleted' };
      }
      if (result.outcome === 'forbidden') throw forbidden(peer);
      if (result.outcome === 'unreachable') unreachable.push(peer);
      if (result.outcome === 'error' && !failure) failure = { peer, detail: result.detail };
    }
  } catch (err) {
    await setPendingFlag(key, null);
    throw err;
  }
  if (unreachable.length > 0) {
    const peer = unreachable[0];
    const entry = { peerId: peer.id, kind: 'video', key, queuedAt };
    await updateQueue((entries) => [...entries.filter((e) => !(e.kind === 'video' && e.key === key)), entry]);
    await setPendingFlag(key, { peerId: peer.id, queuedAt });
    console.log(`🔌 Video ${key} delete queued until ${peerLabel(peer)} is reachable`);
    return { status: 'pending', pendingDelete: { peerId: peer.id, queuedAt }, peerName: peerLabel(peer) };
  }
  await setPendingFlag(key, null);
  if (failure) {
    throw new ServerError(`${peerLabel(failure.peer)} could not delete this video (${failure.detail}); it may need an update`, {
      status: 502, code: 'MEDIA_DELETE_FAILED',
    });
  }
  // Every candidate answered that it does not hold the row.
  await hideLocally(key);
  console.log(`⏭️ Video ${key}: no owner candidate holds it; hidden on this machine only`);
  return { status: 'owner-unknown' };
}

// One delete per row at a time; a repeated click joins the one in flight.
const inFlight = new Map();

/**
 * Delete `kind:key` wherever it is owned. Resolves `{ status }`:
 * `deleted` (gone here and on its owner), `pending` (queued for an unreachable
 * owner; also `pendingDelete` and `peerName`) or `owner-unknown` (hidden here
 * only). Throws a 403 `MEDIA_DELETE_FORBIDDEN` when the owner refuses.
 */
export function deleteMediaAnywhere(kind, key) {
  if (kind === 'image') {
    return Promise.reject(new ServerError('Remote image delete is not supported yet', { status: 501, code: 'IMAGE_DELETE_NOT_SUPPORTED' }));
  }
  if (kind !== 'video' || !isNonBlankStr(key)) return Promise.reject(new ServerError('Unknown media', { status: 400, code: 'VALIDATION_ERROR' }));
  const id = `${kind}:${key}`;
  if (inFlight.has(id)) return inFlight.get(id);
  const run = deleteVideoAnywhere(key).finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  return run;
}

/** Withdraw a queued delete and clear the row's pending flag. Resolves `{ ok, cancelled }`. */
export async function cancelPendingDelete(kind, key) {
  if (kind !== 'video') throw new ServerError('Unknown media kind', { status: 400, code: 'VALIDATION_ERROR' });
  const dequeued = await dropEntriesFor(kind, key);
  const row = await getHistoryItem(key);
  if (!row) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  const cancelled = isPlainObject(row.pendingDelete) || dequeued > 0;
  await setPendingFlag(key, null);
  if (cancelled) console.log(`↩️ Pending delete of video ${key} cancelled`);
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
  const known = new Set((Array.isArray(peers) ? peers : []).map((p) => p?.id).filter(isNonBlankStr));
  const dropped = [];
  const history = await loadHistory();
  const rows = new Map((Array.isArray(history) ? history : []).filter((r) => isNonBlankStr(r?.id)).map((r) => [r.id, r]));
  await updateQueue((entries) => entries.filter((entry) => {
    const row = rows.get(entry.key);
    const reason = entryExpired(entry, nowMs) ? 'expired'
      : !known.has(entry.peerId) ? 'peer removed'
        : !row ? 'row gone'
          : rowRecreated(row, entry) ? 're-created' : null;
    if (reason) dropped.push({ entry, reason });
    return !reason;
  }));
  for (const { entry, reason } of dropped) {
    console.log(`⏭️ Queued delete of ${entry.kind} ${entry.key} dropped: ${reason}`);
    await setPendingFlag(entry.key, null);
  }
  return dropped.length;
}

const draining = new Set();

/** Send every queued command for `peer` (it just came online). Never rejects. */
async function drainMediaDeleteQueue(peer) {
  if (!isNonBlankStr(peer?.id) || draining.has(peer.id)) return 0;
  draining.add(peer.id);
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
        const result = await sendDeleteCommand(current, entry.kind, entry.key);
        if (result.outcome === 'unreachable') {
          console.log(`🔌 Queued delete of ${entry.kind} ${entry.key} still waiting on ${peerLabel(current)}: ${result.detail}`);
          continue;
        }
        await dropEntriesFor(entry.kind, entry.key);
        if (result.outcome === 'ok') {
          await retireLocalCopy(current, entry.key, result.tombstone);
          console.log(`🗑️ Queued delete of ${entry.kind} ${entry.key} completed on ${peerLabel(current)}`);
          done++;
        } else if (result.outcome === 'not-held') {
          await setPendingFlag(entry.key, null);
          await hideLocally(entry.key);
          console.log(`⏭️ ${peerLabel(current)} does not hold ${entry.kind} ${entry.key}; hidden on this machine only`);
        } else {
          await setPendingFlag(entry.key, null);
          console.log(`🚫 ${peerLabel(current)} refused queued delete of ${entry.kind} ${entry.key}: ${result.outcome}${result.detail ? ` ${result.detail}` : ''}`);
        }
      } catch (err) {
        console.error(`❌ Queued delete of ${entry.kind} ${entry.key} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Media delete queue drain for ${peerLabel(peer)} failed: ${err.message}`);
  } finally {
    draining.delete(peer.id);
  }
  return done;
}

let disarm = null;

/**
 * Arm the queue listeners: drain on `peer:online`, prune on registry changes
 * (a removed peer's commands go with it). Idempotent; returns the disarm function.
 */
export function initMediaRemoteDelete() {
  if (disarm) return disarm;
  const onOnline = (peer) => { void drainMediaDeleteQueue(peer); };
  const onPeers = (peers) => {
    pruneMediaDeleteQueue(peers).catch((err) => console.error(`❌ Media delete queue prune failed: ${err.message}`));
  };
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
  if (kind === 'image') throw new ServerError('Remote image delete is not supported yet', { status: 501, code: 'IMAGE_DELETE_NOT_SUPPORTED' });
  const notHeld = () => new ServerError('This machine does not hold that media', { status: 404, code: 'MEDIA_NOT_HELD' });
  if (!(await getHistoryItem(key))) throw notHeld();
  const { deleteHistoryItem } = await import('./videoGen/historyOps.js');
  await deleteHistoryItem(key).catch((err) => { throw err?.code === 'NOT_FOUND' ? notHeld() : err; });
  await dropEntriesFor('video', key);
  const { listMediaTombstones } = await import('./mediaTombstones.js');
  const tombstone = (await listMediaTombstones('video')).find((t) => t.key === key) ?? null;
  console.log(`🗑️ Video ${key} deleted at the request of ${peerLabel(peer)}`);
  return { ok: true, tombstone };
}
