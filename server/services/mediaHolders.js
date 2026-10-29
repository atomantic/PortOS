/**
 * Which machines hold a media file's bytes, and "Make primary": keep one
 * holder's copy and release every other one.
 *
 * Holders of `<kind>:<filename>` as this machine sees them:
 * - this machine, when the file is on local disk;
 * - a host-mode peer named by `peer-hosted-media.json` (inventory-verified);
 * - any peer whose reported holdings list it: its byte inventory, pulled on the
 *   sync safety net, and its realtime `holding` frames ("I hold / no longer
 *   hold <file>").
 * Reported holdings and this machine's queued release commands live in
 * `data/media-holders.json`: machine-local evidence (`file-primary`,
 * docs/STORAGE.md) that never federates as a file.
 *
 * A release keeps the row and drops only the bytes: the holder seeds its hosted
 * index with the primary, so the item streams from there, then trashes its copy.
 * Every releasing holder first checks the primary really holds the bytes. An
 * unreachable holder's release is queued, drained on `peer:online`, and the item
 * stays multi-host until that peer confirms.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { trashFiles } from '../lib/trashFiles.js';
import { peerFetch, readPeerBody } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { parseTsMs } from '../lib/lwwTimestamp.js';
import { isPairedPeer } from '../lib/peerPairing.js';
import { sanitizeAssetFilename } from './sharing/buckets.js';
import { loadHistory, mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { readHeldImage, localInstanceId } from './imageGen/imageRecords.js';
import { emitMediaHistoryChanged, emitMediaHoldersChanged, announceLocalHolding } from './peerSyncEventBus.js';
import { instanceEvents } from './instanceEvents.js';

const STORE_FILE = () => join(PATHS.data, 'media-holders.json');
const SCHEMA_VERSION = 1;
const KINDS = ['video', 'image'];
const KIND_DIR = { video: () => PATHS.videos, image: () => PATHS.images };
const KIND_MOUNT = { video: '/data/videos/', image: '/data/images/' };
const MEDIA_RELEASE_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15_000;
const storeWrite = createFileWriteQueue();

const peerLabel = (peer) => peer?.name || peer?.id || 'peer';
const usablePeer = (peer) => Boolean(peer) && peer.enabled !== false && isPairedPeer(peer) && isNonBlankStr(peer.instanceId);
const validName = (filename) => isNonBlankStr(filename) && sanitizeAssetFilename(filename) === filename;
const fileKey = (kind, filename) => `${kind}:${filename}`;
const localPath = (kind, filename) => join(KIND_DIR[kind](), filename);
const holdsHere = (kind, filename) => existsSync(localPath(kind, filename));

const isRelease = (e) => isPlainObject(e) && KINDS.includes(e.kind) && validName(e.filename) && isNonBlankStr(e.peerId)
  && isNonBlankStr(e.primaryInstanceId) && parseTsMs(e.primaryAt) !== null && Number.isFinite(Date.parse(e.queuedAt));

// STRICT: an unreadable store rejects rather than being rewritten as empty.
async function readStore() {
  const raw = await readJSONFile(STORE_FILE(), null, { strict: true });
  const holdings = {};
  for (const [instanceId, kinds] of Object.entries(isPlainObject(raw?.holdings) ? raw.holdings : {})) {
    if (!isNonBlankStr(instanceId) || !isPlainObject(kinds)) continue;
    holdings[instanceId] = {};
    for (const kind of KINDS) {
      if (isPlainObject(kinds[kind])) holdings[instanceId][kind] = Object.fromEntries(Object.entries(kinds[kind]).filter(([name]) => validName(name)));
    }
  }
  const releases = (Array.isArray(raw?.releases) ? raw.releases : []).filter(isRelease)
    .map(({ peerId, kind, filename, primaryInstanceId, primaryAt, queuedAt }) => ({ peerId, kind, filename, primaryInstanceId, primaryAt, queuedAt }));
  return { holdings, releases };
}
const readStoreOrEmpty = () => readStore().catch(() => ({ holdings: {}, releases: [] }));

// `fn(store)` mutates the store in place and returns true when it changed.
function updateStore(fn) {
  return storeWrite(async () => {
    const store = await readStore();
    const changed = fn(store);
    if (changed) await atomicWrite(STORE_FILE(), { version: SCHEMA_VERSION, ...store });
    return changed;
  });
}

const notifyHoldersChanged = (changed) => {
  if (changed) emitMediaHoldersChanged();
  return changed;
};

/**
 * One peer's authoritative byte inventory for `kind`: `filenames` it holds out
 * of the `checked` names it examined. Names it did not examine keep their state,
 * and a report with any malformed name is inconclusive as a whole. A file it
 * does not hold stops being streamed from it when a Make primary pointed there;
 * `direct` evidence about single files (a frame, a check, a command's answer)
 * retires it as a host outright.
 */
export async function recordPeerInventory(instanceId, kind, filenames, checked, { direct = false } = {}) {
  if (!isNonBlankStr(instanceId) || !KINDS.includes(kind) || !Array.isArray(filenames) || !Array.isArray(checked)) return false;
  if (![...filenames, ...checked].every(validName)) return false;
  const present = new Set(filenames);
  const examined = new Set(checked);
  const absent = [...examined].filter((name) => !present.has(name));
  const at = new Date().toISOString();
  const { dropHostOf } = await import('./peerHostedMedia.js');
  const hostsDropped = await dropHostOf(kind, absent, instanceId, { onlyPrimary: !direct });
  const recorded = await updateStore((store) => {
    const held = { ...(store.holdings[instanceId]?.[kind] ?? {}) };
    let changed = false;
    for (const name of examined) {
      if (present.has(name) && !held[name]) { held[name] = at; changed = true; }
      if (!present.has(name) && held[name]) { delete held[name]; changed = true; }
    }
    if (changed) store.holdings[instanceId] = { ...(store.holdings[instanceId] ?? {}), [kind]: held };
    return changed;
  });
  return notifyHoldersChanged(hostsDropped || recorded);
}

/** A single "I hold / no longer hold" report from `instanceId` (a frame, a command's answer or a HEAD check). */
export function notePeerHolding(instanceId, kind, filename, held) {
  return recordPeerInventory(instanceId, kind, held ? [filename] : [], [filename], { direct: true });
}

/**
 * Ask `peer` whether it serves `kind:filename` from its own disk: `held`,
 * `not-held` (absent, or only streamed from another peer) or `unreachable`. A
 * HEAD on the static mount, so an older peer without the holders routes answers too.
 */
async function peerHoldsFile(peer, kind, filename) {
  let res;
  try {
    res = await withAbortTimeout(COMMAND_TIMEOUT_MS, (signal) => peerFetch(
      `${peerBaseUrl(peer)}${KIND_MOUNT[kind]}${encodeURIComponent(filename)}`, { method: 'HEAD', signal }, peer,
    ));
  } catch {
    return 'unreachable';
  }
  if (res.status === 404) return 'not-held';
  if (!res.ok) return 'unreachable';
  return res.headers?.get('x-portos-media-location') === 'remote' ? 'not-held' : 'held';
}

/**
 * Record the primary on this machine's row (a video history row matched by
 * filename, or an image sidecar). Field LWW on `primaryAt`: an older designation
 * never replaces a newer one. Resolves true when the row changed.
 */
async function setPrimaryOnRow(kind, filename, primaryInstanceId, primaryAt) {
  if (kind === 'image') {
    // A sidecar-less image has nowhere to record it (setImagePrimary returns null).
    const { setImagePrimary } = await import('./imageGen/local.js');
    const changed = (await setImagePrimary(filename, { instanceId: primaryInstanceId, at: primaryAt }).catch(() => null)) === true;
    if (changed) emitMediaHistoryChanged({ kind: 'image', op: 'upsert', ids: [filename] });
    return changed;
  }
  const ids = [];
  await mutateVideoHistory((history) => {
    for (const row of history) {
      if (row?.filename !== filename || typeof row.id !== 'string') continue;
      if ((parseTsMs(row.primaryAt) ?? -Infinity) >= parseTsMs(primaryAt)) continue;
      row.primaryInstanceId = primaryInstanceId;
      row.primaryAt = primaryAt;
      ids.push(row.id);
    }
    return ids.length > 0 ? history : HISTORY_UNCHANGED;
  }, { stampOrigin: false });
  emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids });
  return ids.length > 0;
}

/** This machine's recorded designation for a file: `{ instanceId, at }`, or null. */
async function currentPrimary(kind, filename) {
  if (kind === 'image') {
    const held = await readHeldImage(filename);
    return held?.primaryInstanceId ? { instanceId: held.primaryInstanceId, at: held.primaryAt ?? null } : null;
  }
  const history = await loadHistory();
  let newest = null;
  for (const row of Array.isArray(history) ? history : []) {
    if (row?.filename !== filename || !isNonBlankStr(row.primaryInstanceId)) continue;
    if (!newest || (parseTsMs(row.primaryAt) ?? -Infinity) > (parseTsMs(newest.at) ?? -Infinity)) newest = { instanceId: row.primaryInstanceId, at: row.primaryAt ?? null };
  }
  return newest;
}

/**
 * Drop this machine's copy in favor of `primary` (a registered peer that was
 * just verified to hold the bytes): the hosted index points at it first, then
 * the local file goes to the trash.
 */
async function releaseLocalCopy(kind, filename, primary, primaryAt) {
  const { hostFileOn } = await import('./peerHostedMedia.js');
  await hostFileOn(kind, filename, primary.instanceId);
  await trashFiles([localPath(kind, filename)]);
  await setPrimaryOnRow(kind, filename, primary.instanceId, primaryAt);
  void announceLocalHolding(kind, filename, false);
  emitMediaHoldersChanged();
  console.log(`🗂️ ${kind} ${filename}: local copy released; it now streams from ${peerLabel(primary)}`);
}

const RETRYABLE_CODES = new Set(['PRIMARY_UNREACHABLE', 'MEDIA_BUSY']);

/**
 * Send the release command to one holder. Resolves `{ outcome, detail? }`:
 * `ok`, `not-held`, `forbidden`, `superseded` (a newer primary is recorded
 * there), `unreachable` (worth retrying) or `error`
 * (a refusal retrying will not change, e.g. an older peer without the route).
 */
async function sendReleaseCommand(peer, { kind, filename, primaryInstanceId, primaryAt }) {
  let res;
  try {
    res = await withAbortTimeout(COMMAND_TIMEOUT_MS, (signal) => peerFetch(`${peerBaseUrl(peer)}/api/peer-media/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, filename, primaryInstanceId, primaryAt }),
      signal,
    }, peer));
  } catch (err) {
    return { outcome: 'unreachable', detail: err?.message || String(err) };
  }
  const body = await readPeerBody(res, 'json', { maxBytes: 64 * 1024, idleTimeoutMs: 5000 }).catch(() => null);
  if (res.ok && body?.ok === true) return { outcome: 'ok' };
  if (res.status === 404 && body?.code === 'MEDIA_NOT_HELD') return { outcome: 'not-held' };
  if (res.status === 403 && body?.code === 'MEDIA_DELETE_FORBIDDEN') return { outcome: 'forbidden' };
  if (res.status === 409 && body?.code === 'PRIMARY_SUPERSEDED') return { outcome: 'superseded' };
  const detail = `http-${res.status}${body?.code ? ` ${body.code}` : ''}`;
  // The holder could not reach the primary, or is mid-change on the same file: retry later.
  if (res.status === 409 && RETRYABLE_CODES.has(body?.code)) return { outcome: 'unreachable', detail };
  if (res.status >= 500 && res.status !== 501) return { outcome: 'unreachable', detail };
  return { outcome: 'error', detail };
}

/** Holder instance ids per `<kind>:<filename>` with at least one other machine, plus this machine's id. */
async function collectHolders() {
  const { getPeers } = await import('./instances.js');
  const { listHostedEntries } = await import('./peerHostedMedia.js');
  const [self, peers, store, hosted] = await Promise.all([
    localInstanceId(), getPeers().catch(() => []), readStoreOrEmpty(), listHostedEntries(),
  ]);
  const registered = new Map(peers.filter((p) => isNonBlankStr(p?.instanceId)).map((p) => [p.instanceId, p]));
  const remote = new Map();
  const add = (kind, filename, instanceId) => {
    if (!KINDS.includes(kind) || !validName(filename) || instanceId === self || !registered.has(instanceId)) return;
    const key = fileKey(kind, filename);
    if (!remote.has(key)) remote.set(key, new Set());
    remote.get(key).add(instanceId);
  };
  for (const [key, entry] of Object.entries(hosted)) {
    const kind = key.slice(0, key.indexOf(':'));
    const hosts = Array.isArray(entry?.hosts) ? entry.hosts : [entry];
    for (const host of hosts) add(kind, key.slice(kind.length + 1), host?.peerId);
  }
  for (const [instanceId, kinds] of Object.entries(store.holdings)) {
    for (const kind of KINDS) for (const filename of Object.keys(kinds[kind] ?? {})) add(kind, filename, instanceId);
  }
  return { self, registered, remote, releases: store.releases };
}

/**
 * Every item another machine holds, keyed `<kind>:<filename>`: `{ kind,
 * filename, cardKeys, primaryInstanceId, holders: [{ instanceId, name, self, primary, releasePending }] }`.
 * Items held only here are left out. `self` is this machine's instance id.
 */
export async function listMediaHolders() {
  const { self, registered, remote, releases } = await collectHolders();
  const history = remote.size > 0 && [...remote.keys()].some((k) => k.startsWith('video:')) ? await loadHistory().catch(() => []) : [];
  const videoPrimary = new Map();
  const videoIds = new Map();
  for (const r of Array.isArray(history) ? history : []) {
    if (!isNonBlankStr(r?.filename) || !isNonBlankStr(r?.id)) continue;
    if (isNonBlankStr(r.primaryInstanceId)) videoPrimary.set(r.filename, r.primaryInstanceId);
    videoIds.set(r.filename, [...(videoIds.get(r.filename) ?? []), r.id]);
  }
  const pendingByKey = new Map();
  const byRegistryId = new Map([...registered.values()].map((p) => [p.id, p]));
  for (const entry of releases) {
    const peer = byRegistryId.get(entry.peerId);
    if (!peer) continue;
    const key = fileKey(entry.kind, entry.filename);
    if (!pendingByKey.has(key)) pendingByKey.set(key, new Set());
    pendingByKey.get(key).add(peer.instanceId);
  }
  const items = {};
  for (const [key, instanceIds] of remote) {
    const kind = key.slice(0, key.indexOf(':'));
    const filename = key.slice(kind.length + 1);
    const primaryInstanceId = kind === 'video' ? videoPrimary.get(filename) ?? null : (await readHeldImage(filename))?.primaryInstanceId ?? null;
    const ids = [...(holdsHere(kind, filename) ? [self] : []), ...instanceIds];
    const pending = pendingByKey.get(key) ?? new Set();
    items[key] = {
      kind,
      filename,
      // The media cards' own keys for this file (`video:<history id>` / `image:<filename>`).
      cardKeys: kind === 'video' ? (videoIds.get(filename) ?? []).map((id) => `video:${id}`) : [`image:${filename}`],
      primaryInstanceId,
      holders: ids.map((instanceId) => ({
        instanceId,
        name: instanceId === self ? 'This machine' : peerLabel(registered.get(instanceId)),
        self: instanceId === self,
        primary: instanceId === primaryInstanceId,
        releasePending: pending.has(instanceId),
      })),
    };
  }
  return { self, items };
}

// Files with a Make primary or an incoming release in progress on this machine.
// Two machines making different holders primary at once must not each verify
// the other's copy and then both release theirs: a release that arrives while
// this machine is changing the same file answers busy (retryable, so it stays
// queued) instead of waiting, which cannot deadlock the two commands.
const busyFiles = new Set();

async function withFileBusy(kind, filename, busyError, fn) {
  const key = fileKey(kind, filename);
  if (busyFiles.has(key)) throw busyError();
  busyFiles.add(key);
  try {
    return await fn();
  } finally {
    busyFiles.delete(key);
  }
}

const KEPT_REASONS = {
  forbidden: 'media delete is turned off there',
  superseded: 'a newer primary is recorded there',
};

/**
 * Keep `instanceId`'s copy of `kind:filename` and release every other holder's.
 * Refused (409) while the chosen holder is unreachable or does not hold the
 * bytes. Resolves `{ primaryInstanceId, released, pending, kept }`, each a list
 * of `{ instanceId, name, reason? }`: released copies are gone, pending ones are
 * queued for an unreachable holder, kept ones were refused by their holder.
 */
export async function makeMediaPrimary({ kind, filename, instanceId }) {
  if (!KINDS.includes(kind) || !validName(filename)) throw new ServerError('Unknown media', { status: 400, code: 'VALIDATION_ERROR' });
  const busy = () => new ServerError('Make primary is already running for this media', { status: 409, code: 'MEDIA_BUSY' });
  return withFileBusy(kind, filename, busy, () => designatePrimary(kind, filename, instanceId));
}

async function designatePrimary(kind, filename, instanceId) {
  const { self, registered, remote } = await collectHolders();
  const others = [...(remote.get(fileKey(kind, filename)) ?? [])];
  const selfHolds = holdsHere(kind, filename);
  if (instanceId === self ? !selfHolds : !others.includes(instanceId)) {
    throw new ServerError('That machine does not hold this media', { status: 409, code: 'NOT_A_HOLDER' });
  }

  let primary = null;
  if (instanceId !== self) {
    primary = registered.get(instanceId);
    if (!usablePeer(primary)) {
      throw new ServerError(`Pair with ${peerLabel(primary)} to make it primary`, { status: 409, code: 'PRIMARY_NOT_PAIRED' });
    }
    const verdict = await peerHoldsFile(primary, kind, filename);
    if (verdict === 'unreachable') {
      throw new ServerError(`${peerLabel(primary)} is unreachable; it can be made primary once it is online`, { status: 409, code: 'PRIMARY_UNREACHABLE' });
    }
    if (verdict === 'not-held') {
      await notePeerHolding(instanceId, kind, filename, false);
      throw new ServerError(`${peerLabel(primary)} no longer holds this ${kind}`, { status: 409, code: 'PRIMARY_NOT_HOLDING' });
    }
  }

  const primaryAt = new Date().toISOString();
  const command = { kind, filename, primaryInstanceId: instanceId, primaryAt };
  if (primary && selfHolds) {
    // Before this machine gives up its copy, the primary confirms it keeps its
    // own under its busy guard (the release route, addressed to the primary):
    // two machines naming each other at once both answer busy, so neither lets go.
    const confirmed = await sendReleaseCommand(primary, command);
    if (confirmed.outcome !== 'ok') {
      const why = confirmed.outcome === 'unreachable' ? 'it is busy or unreachable; try again' : KEPT_REASONS[confirmed.outcome] ?? `${confirmed.detail}; it may need an update`;
      throw new ServerError(`${peerLabel(primary)} did not confirm it keeps this ${kind} (${why}); nothing was deleted`, { status: 409, code: 'PRIMARY_NOT_CONFIRMED' });
    }
  }
  await setPrimaryOnRow(kind, filename, instanceId, primaryAt);
  const result = { primaryInstanceId: instanceId, released: [], pending: [], kept: [] };
  const queued = [];
  for (const holderId of others.filter((id) => id !== instanceId)) {
    const peer = registered.get(holderId);
    const name = peerLabel(peer);
    if (!usablePeer(peer)) {
      result.kept.push({ instanceId: holderId, name, reason: 'not paired' });
      continue;
    }
    const sent = peer.status === 'offline' ? { outcome: 'unreachable' } : await sendReleaseCommand(peer, command);
    if (sent.outcome === 'ok' || sent.outcome === 'not-held') {
      await notePeerHolding(holderId, kind, filename, false);
      result.released.push({ instanceId: holderId, name });
    } else if (sent.outcome === 'unreachable') {
      queued.push({ peerId: peer.id, ...command, queuedAt: primaryAt });
      result.pending.push({ instanceId: holderId, name });
    } else {
      result.kept.push({ instanceId: holderId, name, reason: KEPT_REASONS[sent.outcome] ?? `refused (${sent.detail}); it may need an update` });
    }
  }
  // This designation supersedes every release queued earlier for the file.
  await updateStore((store) => {
    const before = store.releases.length;
    store.releases = [...store.releases.filter((e) => !(e.kind === kind && e.filename === filename)), ...queued];
    return queued.length > 0 || store.releases.length !== before;
  });
  if (primary && selfHolds) {
    await releaseLocalCopy(kind, filename, primary, primaryAt);
    result.released.push({ instanceId: self, name: 'This machine' });
  } else if (primary) {
    // No copy here: stream from the primary rather than a holder that released.
    const { hostFileOn } = await import('./peerHostedMedia.js');
    await hostFileOn(kind, filename, primary.instanceId);
  }
  emitMediaHoldersChanged();
  console.log(`🗂️ ${kind} ${filename}: primary is ${primary ? peerLabel(primary) : 'this machine'} (released ${result.released.length}, pending ${result.pending.length}, kept ${result.kept.length})`);
  return result;
}

/**
 * Receiver side of `POST /api/peer-media/release`. `senderPeerId` is the
 * registry id authGate verified from the pair credential. Releasing a copy
 * destroys local bytes, so it takes the same standing `media.delete` grant as a
 * remote delete. The primary must be a registered, paired peer here that holds
 * the bytes (checked before anything is trashed); this machine keeps the row and
 * streams the item from the primary afterwards.
 */
export async function executePeerMediaRelease(senderPeerId, { kind, filename, primaryInstanceId, primaryAt }) {
  const { getPeers, peerMayDeleteMedia } = await import('./instances.js');
  const peers = await getPeers();
  const sender = peers.find((p) => p.id === senderPeerId) ?? null;
  if (!sender || sender.enabled === false || !isPairedPeer(sender)) {
    throw new ServerError('A paired peer credential is required', { status: 403, code: 'PEER_CREDENTIAL_REQUIRED' });
  }
  if (!peerMayDeleteMedia(sender)) {
    console.log(`🚫 Media release from ${peerLabel(sender)} refused: media delete is off for this peer`);
    throw new ServerError('Media delete is turned off for this peer', { status: 403, code: 'MEDIA_DELETE_FORBIDDEN' });
  }
  if (!KINDS.includes(kind) || !validName(filename)) throw new ServerError('Unknown media', { status: 400, code: 'VALIDATION_ERROR' });
  const busy = () => new ServerError('This machine is changing that media; retry later', { status: 409, code: 'MEDIA_BUSY' });
  return withFileBusy(kind, filename, busy, () => releaseForPeer(peers, sender, { kind, filename, primaryInstanceId, primaryAt }));
}

async function releaseForPeer(peers, sender, { kind, filename, primaryInstanceId, primaryAt }) {
  if (!holdsHere(kind, filename)) throw new ServerError('This machine does not hold that media', { status: 404, code: 'MEDIA_NOT_HELD' });
  // A delayed (queued) release must not undo a newer designation recorded here.
  const recorded = await currentPrimary(kind, filename);
  if (recorded && recorded.instanceId !== primaryInstanceId && (parseTsMs(recorded.at) ?? -Infinity) >= parseTsMs(primaryAt)) {
    console.log(`⏭️ Release of ${kind} ${filename} from ${peerLabel(sender)} refused: a newer primary is recorded here`);
    throw new ServerError('A newer primary is recorded for this media here; the copy was kept', { status: 409, code: 'PRIMARY_SUPERSEDED' });
  }
  if (primaryInstanceId === await localInstanceId()) {
    // This machine is the primary: it keeps its copy.
    await setPrimaryOnRow(kind, filename, primaryInstanceId, primaryAt);
    return { ok: true, released: false };
  }
  const primary = peers.find((p) => p.instanceId === primaryInstanceId) ?? null;
  if (!usablePeer(primary)) {
    throw new ServerError('The primary is not a paired peer of this machine, so its copy could not be streamed from here', { status: 409, code: 'PRIMARY_NOT_PAIRED' });
  }
  const verdict = await peerHoldsFile(primary, kind, filename);
  if (verdict !== 'held') {
    throw new ServerError(`${peerLabel(primary)} ${verdict === 'unreachable' ? 'is unreachable from here' : 'does not hold this media'}; the copy here was kept`, {
      status: 409, code: verdict === 'unreachable' ? 'PRIMARY_UNREACHABLE' : 'PRIMARY_NOT_HOLDING',
    });
  }
  await releaseLocalCopy(kind, filename, primary, primaryAt);
  await notePeerHolding(primary.instanceId, kind, filename, true);
  console.log(`🗂️ ${kind} ${filename} released at the request of ${peerLabel(sender)}`);
  return { ok: true, released: true };
}

const entryExpired = (entry, nowMs) => nowMs - Date.parse(entry.queuedAt) > MEDIA_RELEASE_QUEUE_TTL_MS;

/**
 * Drop holdings of machines that are no longer registered, and queued releases
 * that expired (30 days) or whose peer was removed.
 */
async function pruneStore(peers) {
  const list = Array.isArray(peers) ? peers : [];
  const instanceIds = new Set(list.map((p) => p?.instanceId).filter(isNonBlankStr));
  const registryIds = new Set(list.map((p) => p?.id).filter(isNonBlankStr));
  const nowMs = Date.now();
  return notifyHoldersChanged(await updateStore((store) => {
    let changed = false;
    for (const instanceId of Object.keys(store.holdings)) {
      if (!instanceIds.has(instanceId)) { delete store.holdings[instanceId]; changed = true; }
    }
    const next = store.releases.filter((e) => registryIds.has(e.peerId) && !entryExpired(e, nowMs));
    if (next.length !== store.releases.length) {
      for (const e of store.releases.filter((x) => !next.includes(x))) console.log(`⏭️ Queued release of ${e.kind} ${e.filename} dropped`);
      store.releases = next;
      changed = true;
    }
    return changed;
  }));
}

const draining = new Set();

/** Send every queued release for `peer` (it is online). Never rejects. */
export async function drainMediaReleases(peer) {
  if (!isNonBlankStr(peer?.id) || draining.has(peer.id)) return 0;
  draining.add(peer.id);
  let done = 0;
  try {
    const { getPeers } = await import('./instances.js');
    const current = (await getPeers()).find((p) => p.id === peer.id) ?? null;
    const mine = (await readStore()).releases.filter((e) => e.peerId === peer.id);
    if (!usablePeer(current) || mine.length === 0) return 0;
    for (const entry of mine) {
      const sent = await sendReleaseCommand(current, entry);
      if (sent.outcome === 'unreachable') {
        console.log(`🔌 Queued release of ${entry.kind} ${entry.filename} still waiting on ${peerLabel(current)}`);
        continue;
      }
      await updateStore((store) => {
        const next = store.releases.filter((e) => !(e.peerId === entry.peerId && e.kind === entry.kind && e.filename === entry.filename && e.queuedAt === entry.queuedAt));
        const changed = next.length !== store.releases.length;
        store.releases = next;
        return changed;
      });
      if (sent.outcome === 'ok' || sent.outcome === 'not-held') {
        await notePeerHolding(current.instanceId, entry.kind, entry.filename, false);
        done++;
        console.log(`🗂️ Queued release of ${entry.kind} ${entry.filename} completed on ${peerLabel(current)}`);
      } else {
        console.log(`🚫 ${peerLabel(current)} refused queued release of ${entry.kind} ${entry.filename}: ${sent.outcome}${sent.detail ? ` ${sent.detail}` : ''}`);
      }
    }
    emitMediaHoldersChanged();
  } catch (err) {
    console.error(`❌ Media release queue drain for ${peerLabel(peer)} failed: ${err.message}`);
  } finally {
    draining.delete(peer.id);
  }
  return done;
}

let disarm = null;

/** Arm the queue listeners: drain on `peer:online`, prune on registry changes. Idempotent. */
export function initMediaHolders() {
  if (disarm) return disarm;
  const onOnline = (peer) => drainMediaReleases(peer);
  const onPeers = (peers) => pruneStore(peers)
    .catch((err) => console.error(`❌ Media holders upkeep failed: ${err.message}`));
  instanceEvents.on('peer:online', onOnline);
  instanceEvents.on('peers:updated', onPeers);
  disarm = () => {
    instanceEvents.removeListener('peer:online', onOnline);
    instanceEvents.removeListener('peers:updated', onPeers);
    disarm = null;
  };
  return disarm;
}
