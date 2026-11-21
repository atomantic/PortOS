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
 * Reported holdings (filenames, plus each inventory scope's file modify times
 * that origin attribution reads, services/mediaOriginReconcile.js) and this
 * machine's queued release commands live in `data/media-holders.json`.
 *
 * Storage: `file-primary` — machine-local evidence and pending work, never
 * federated as a file (the primary designation syncs on the row instead). No
 * seed: an absent file is empty. Reports older than 7 days stop counting, and a
 * removed peer's entries are pruned.
 *
 * A release keeps the row and drops only the bytes: the holder seeds its hosted
 * index with the primary, so the item streams from there, then trashes its copy.
 * Every releasing holder first checks the primary really holds the bytes. An
 * unreachable holder's release is queued, drained on `peer:online`, and the item
 * stays multi-host until that peer confirms.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { lstat } from 'node:fs/promises';
import { PATHS, readJSONFile, atomicWrite, sha256File } from '../lib/fileUtils.js';
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
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { sanitizeAssetFilename } from './sharing/buckets.js';
import { loadHistory, mutateVideoHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { readImagePrimary, localInstanceId } from './imageGen/imageRecords.js';
import { emitMediaHistoryChanged, emitMediaHoldersChanged, announceLocalHolding } from './peerSyncEventBus.js';
import { instanceEvents } from './instanceEvents.js';

const STORE_FILE = () => join(PATHS.data, 'media-holders.json');
const SCHEMA_VERSION = 1;
const KINDS = ['video', 'image'];
const KIND_DIR = { video: () => PATHS.videos, image: () => PATHS.images };
const MEDIA_RELEASE_QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15_000;
const VERIFIED_COMMAND_TIMEOUT_MS = 120_000;
const IMAGE_PRIMARY_READ_CONCURRENCY = 16;
const storeWrite = createFileWriteQueue();

const peerLabel = (peer) => peer?.name || peer?.id || 'peer';
const usablePeer = (peer) => Boolean(peer) && peer.enabled !== false && isPairedPeer(peer) && isNonBlankStr(peer.instanceId);
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validName = (filename) => isNonBlankStr(filename) && sanitizeAssetFilename(filename) === filename;
const fileKey = (kind, filename) => `${kind}:${filename}`;
const localPath = (kind, filename) => join(KIND_DIR[kind](), filename);
const holdsHere = (kind, filename) => existsSync(localPath(kind, filename));

async function heldHash(kind, filename) {
  const path = localPath(kind, filename);
  return lstat(path).then((info) => info.isFile() && info.size > 0 ? sha256File(path) : null).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

const isRelease = (e) => isPlainObject(e) && KINDS.includes(e.kind) && validName(e.filename) && isNonBlankStr(e.peerId)
  && isNonBlankStr(e.primaryInstanceId) && parseTsMs(e.primaryAt) !== null && Number.isFinite(Date.parse(e.queuedAt))
  && (e.sha256 === undefined || validHash(e.sha256));

// STRICT: an unreadable store rejects rather than being rewritten as empty.
const isReport = (r) => isPlainObject(r) && isPlainObject(r.mtimes) && Array.isArray(r.checked) && Number.isFinite(Date.parse(r.at));

async function readStore() {
  const raw = await readJSONFile(STORE_FILE(), null, { strict: true });
  const reports = {};
  for (const [instanceId, kinds] of Object.entries(isPlainObject(raw?.reports) ? raw.reports : {})) {
    if (!isNonBlankStr(instanceId) || !isPlainObject(kinds)) continue;
    for (const kind of KINDS) {
      if (!isPlainObject(kinds[kind])) continue;
      const scopes = Object.fromEntries(Object.entries(kinds[kind]).filter(([scope, r]) => isNonBlankStr(scope) && isReport(r)));
      if (Object.keys(scopes).length > 0) reports[instanceId] = { ...reports[instanceId], [kind]: scopes };
    }
  }
  const holdings = {};
  for (const [instanceId, kinds] of Object.entries(isPlainObject(raw?.holdings) ? raw.holdings : {})) {
    if (!isNonBlankStr(instanceId) || !isPlainObject(kinds)) continue;
    holdings[instanceId] = {};
    for (const kind of KINDS) {
      if (isPlainObject(kinds[kind])) holdings[instanceId][kind] = Object.fromEntries(Object.entries(kinds[kind]).filter(([name]) => validName(name)));
    }
  }
  const releases = (Array.isArray(raw?.releases) ? raw.releases : []).filter(isRelease)
    .map(({ peerId, kind, filename, primaryInstanceId, primaryAt, queuedAt, sha256 }) => ({ peerId, kind, filename, primaryInstanceId, primaryAt, queuedAt, sha256 }));
  return { holdings, reports, releases };
}
const readStoreOrEmpty = () => readStore().catch(() => ({ holdings: {}, reports: {}, releases: [] }));

/** Each peer's last inventory reports with file times: `{ instanceId: { kind: { scope: { at, mtimes, checked, complete? } } } }`. */
export async function readPeerReports() {
  return (await readStore()).reports;
}

/**
 * Remember what `instanceId` reported for one inventory scope (`scope`): the
 * modify times of the files it holds (`{ filename: mtimeMs }`) and the names it
 * examined. Scopes differ (history rows vs collection assets), so a report
 * speaks only for the names it `checked`, never for the whole kind, unless it is
 * `complete` (a full listing of the folder: absence means not held).
 */
export function recordPeerReport(instanceId, kind, scope, { mtimes, checked, complete = false }) {
  if (!KINDS.includes(kind) || !isNonBlankStr(instanceId) || !isNonBlankStr(scope) || !isPlainObject(mtimes) || !Array.isArray(checked)) return Promise.resolve(false);
  const clean = {};
  for (const [name, ms] of Object.entries(mtimes)) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && validName(name)) clean[name] = ms;
  }
  return updateStore((store) => {
    const entry = store.reports[instanceId] ?? {};
    store.reports[instanceId] = { ...entry, [kind]: { ...entry[kind], [scope]: { at: new Date().toISOString(), mtimes: clean, checked: checked.filter(validName), ...(complete === true && { complete: true }) } } };
    return true;
  });
}

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
    // Origin attribution reads the same evidence: a peer that stops holding a file stops
    // counting as a holder there, and one that starts holding it (no file time yet)
    // invalidates every report that called the file absent, until a fresh inventory.
    for (const report of Object.values(store.reports[instanceId]?.[kind] ?? {})) {
      for (const name of absent) {
        if (report.mtimes[name] !== undefined) { delete report.mtimes[name]; changed = true; }
      }
      if (!direct) continue;
      for (const name of present) {
        if (examined.has(name) && report.mtimes[name] === undefined && (report.complete === true || report.checked.includes(name))) {
          report.checked = report.checked.filter((n) => n !== name);
          delete report.complete;
          changed = true;
        }
      }
    }
    return changed;
  });
  return notifyHoldersChanged(hostsDropped || recorded);
}

/** A single "I hold / no longer hold" report from `instanceId` (a frame, a command's answer or a HEAD check). */
export function notePeerHolding(instanceId, kind, filename, held) {
  return recordPeerInventory(instanceId, kind, held ? [filename] : [], [filename], { direct: true });
}

/**
 * `held` | `not-held` | `unreachable`: a HEAD on the static mount, so an older
 * peer without the holders routes answers too.
 */
async function peerHoldsFile(peer, kind, filename) {
  const { peerServesFile } = await import('./peerHostedMedia.js');
  return peerServesFile(peer, kind, filename);
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
    const primary = await readImagePrimary(filename);
    return primary ? { instanceId: primary.primaryInstanceId, at: primary.primaryAt } : null;
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
async function releaseLocalCopy(kind, filename, primary, primaryAt, sha256) {
  if (sha256 && await heldHash(kind, filename) !== sha256) throw differentBytes();
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
async function sendReleaseCommand(peer, { kind, filename, primaryInstanceId, primaryAt, sha256 }) {
  let res;
  try {
    res = await withAbortTimeout(sha256 ? VERIFIED_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS, (signal) => peerFetch(`${peerBaseUrl(peer)}/api/peer-media/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, filename, primaryInstanceId, primaryAt, sha256 }),
      signal,
    }, peer));
  } catch (err) {
    return { outcome: 'unreachable', detail: err?.message || String(err) };
  }
  const body = await readPeerBody(res, 'json', { maxBytes: 64 * 1024, idleTimeoutMs: 5000 }).catch(() => null);
  if (res.ok && body?.ok === true) return { outcome: 'ok' };
  if (res.status === 404 && body?.code === 'MEDIA_NOT_HELD') return { outcome: 'not-held' };
  if (res.status === 403 && body?.code === 'MEDIA_DELETE_FORBIDDEN') return { outcome: 'forbidden' };
  if (res.status === 409 && body?.code === 'MEDIA_CONTENT_DIFFERS') return { outcome: 'different' };
  if (res.status === 409 && body?.code === 'PRIMARY_SUPERSEDED') return { outcome: 'superseded' };
  const detail = `http-${res.status}${body?.code ? ` ${body.code}` : ''}`;
  // The holder could not reach the primary, or is mid-change on the same file: retry later.
  if (res.status === 409 && RETRYABLE_CODES.has(body?.code)) return { outcome: 'unreachable', detail };
  if (res.status >= 500 && res.status !== 501) return { outcome: 'unreachable', detail };
  return { outcome: 'error', detail };
}

/** Holder instance ids per `<kind>:<filename>` with at least one other machine, plus this machine's id. */
async function collectHolders({ strict = false } = {}) {
  const { getPeers } = await import('./instances.js');
  const { listHostedEntries } = await import('./peerHostedMedia.js');
  const peersRead = getPeers();
  const [self, peers, store, hosted] = await Promise.all([
    localInstanceId(), strict ? peersRead : peersRead.catch(() => []), strict ? readStore() : readStoreOrEmpty(), listHostedEntries(),
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
  const remoteKeys = [...remote.keys()];
  const [imagePrimaryEntries, history] = await Promise.all([
    mapWithConcurrency(remoteKeys.filter((key) => key.startsWith('image:')), IMAGE_PRIMARY_READ_CONCURRENCY, async (key) => {
      const primary = await readImagePrimary(key.slice('image:'.length));
      return [key, primary?.primaryInstanceId ?? null];
    }),
    remoteKeys.some((key) => key.startsWith('video:')) ? loadHistory().catch(() => []) : [],
  ]);
  const imagePrimary = new Map(imagePrimaryEntries);
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
    const primaryInstanceId = (kind === 'video' ? videoPrimary.get(filename) : imagePrimary.get(key)) ?? null;
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
  different: 'this copy has different bytes',
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

async function designatePrimary(kind, filename, instanceId, holders, sha256, discovered = []) {
  const { self, registered, remote } = holders ?? await collectHolders();
  const others = new Set([...(remote.get(fileKey(kind, filename)) ?? []), ...discovered]);
  const selfHolds = holdsHere(kind, filename);
  if (instanceId === self ? !selfHolds : !sha256 && !others.has(instanceId)) {
    throw new ServerError('That machine does not hold this media', { status: 409, code: 'NOT_A_HOLDER' });
  }

  let primary = null;
  if (instanceId !== self) {
    primary = registered.get(instanceId);
    if (!usablePeer(primary)) {
      throw new ServerError(`Pair with ${peerLabel(primary)} to make it primary`, { status: 409, code: 'PRIMARY_NOT_PAIRED' });
    }
    const verdict = sha256 ? null : await peerHoldsFile(primary, kind, filename);
    if (verdict === 'unreachable') {
      throw new ServerError(`${peerLabel(primary)} is unreachable; it can be made primary once it is online`, { status: 409, code: 'PRIMARY_UNREACHABLE' });
    }
    if (verdict === 'not-held') {
      await notePeerHolding(instanceId, kind, filename, false);
      throw new ServerError(`${peerLabel(primary)} no longer holds this ${kind}`, { status: 409, code: 'PRIMARY_NOT_HOLDING' });
    }
  }

  const primaryAt = new Date().toISOString();
  const command = { kind, filename, primaryInstanceId: instanceId, primaryAt, sha256 };
  if (primary && (selfHolds || sha256)) {
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
  for (const holderId of others) {
    if (holderId === instanceId) continue;
    const peer = registered.get(holderId);
    const name = peerLabel(peer);
    if (!usablePeer(peer)) {
      result.kept.push({ instanceId: holderId, name, reason: 'not paired' });
      continue;
    }
    const sent = peer.status === 'offline' ? { outcome: 'unreachable' } : await sendReleaseCommand(peer, command);
    if (sent.outcome === 'ok' || sent.outcome === 'not-held') {
      await notePeerHolding(holderId, kind, filename, false);
      if (sent.outcome === 'ok' || !sha256) result.released.push({ instanceId: holderId, name });
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
  if (!primary && sha256) {
    const { unmarkHosted } = await import('./peerHostedMedia.js');
    await unmarkHosted(kind, filename);
  }
  if (primary && selfHolds) {
    try {
      if (sha256 && await peerCopyHash(primary, { kind, filename }) !== sha256) throw differentBytes();
      await releaseLocalCopy(kind, filename, primary, primaryAt, sha256);
      result.released.push({ instanceId: self, name: 'This machine' });
    } catch (err) {
      if (!sha256 || !(err instanceof ServerError)) throw err;
      result.kept.push({ instanceId: self, name: 'This machine', reason: err.message });
    }
  } else if (primary) {
    // No copy here: stream from the primary rather than a holder that released.
    const { hostFileOn } = await import('./peerHostedMedia.js');
    await hostFileOn(kind, filename, primary.instanceId);
  }
  emitMediaHoldersChanged();
  console.log(`🗂️ ${kind} ${filename}: primary is ${primary ? peerLabel(primary) : 'this machine'} (released ${result.released.length}, pending ${result.pending.length}, kept ${result.kept.length})`);
  return result;
}

const differentBytes = () => new ServerError('The media copies have different bytes; the copy was kept', {
  status: 409, code: 'MEDIA_CONTENT_DIFFERS',
});
const mediaBusy = () => new ServerError('This machine is changing that media; retry later', { status: 409, code: 'MEDIA_BUSY' });

async function peerCopyHash(peer, { kind, filename, sha256 }) {
  const { VERIFIED_MEDIA_COPY_TIMEOUT_MS } = await import('./sharing/peerSyncAssets.js');
  const res = await withAbortTimeout(sha256 ? VERIFIED_MEDIA_COPY_TIMEOUT_MS + VERIFIED_COMMAND_TIMEOUT_MS : VERIFIED_COMMAND_TIMEOUT_MS, (signal) =>
    peerFetch(`${peerBaseUrl(peer)}/api/peer-media/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      maxBytes: 64 * 1024,
      body: JSON.stringify({ kind, filename, sha256 }),
      signal,
    }, peer)).catch(() => {
    throw new ServerError(`${peerLabel(peer)} could not be reached`, { status: 409, code: 'PRIMARY_UNREACHABLE' });
  });
  const body = await readPeerBody(res, 'json', { maxBytes: 64 * 1024, idleTimeoutMs: 5000 }).catch(() => null);
  if (res.ok && validHash(body?.sha256)) return body.sha256;
  if (res.status === 404 && body?.code === 'MEDIA_NOT_HELD') return null;
  if (res.status === 409 && body?.code === 'MEDIA_BUSY') throw mediaBusy();
  if (res.status === 409 && body?.code === 'MEDIA_CONTENT_DIFFERS') throw differentBytes();
  throw new ServerError(`${peerLabel(peer)} could not verify a copy (HTTP ${res.status}). Check its PortOS version and peer settings.`, {
    status: 409, code: 'MEDIA_COPY_FAILED',
  });
}

async function pullVerifiedCopy(peer, { kind, filename, sha256 }) {
  const { pullVerifiedMediaCopy } = await import('./sharing/peerSyncAssets.js');
  await pullVerifiedMediaCopy(peer, { kind, filename, sha256 });
  const hash = await heldHash(kind, filename);
  if (hash && hash !== sha256) throw differentBytes();
  return hash;
}

/** Inspect local bytes or fill a missing file from the authenticated caller. */
export async function executePeerMediaCopy(senderPeerId, { kind, filename, sha256 }) {
  const { getPeers, peerMayDeleteMedia } = await import('./instances.js');
  const sender = (await getPeers()).find((peer) => peer.id === senderPeerId);
  if (!usablePeer(sender)) throw new ServerError('A paired peer credential is required', { status: 403, code: 'PEER_CREDENTIAL_REQUIRED' });
  const { isTransferMediaFilename } = await import('./sharing/peerSyncAssets.js');
  if (!KINDS.includes(kind) || !validName(filename) || !isTransferMediaFilename(kind, filename) || (sha256 !== undefined && !validHash(sha256))) {
    throw new ServerError('Unknown media', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (sha256 && (sender.syncEnabled === false ||
    (sender.directions?.length && !sender.directions.includes('inbound')))) {
    throw new ServerError('Incoming media transfers are turned off for this peer', { status: 403, code: 'PEER_SYNC_NOT_ADMITTED' });
  }
  if (sha256 && !peerMayDeleteMedia(sender)) {
    throw new ServerError('Media delete is turned off for this peer', { status: 403, code: 'MEDIA_DELETE_FORBIDDEN' });
  }

  // Read-only verification is also called from a holder while the operator
  // keeps its own file busy. Only the writing path acquires the busy guard.
  const hash = sha256 ? await withFileBusy(kind, filename, mediaBusy, async () => {
    const current = await heldHash(kind, filename) ?? await pullVerifiedCopy(sender, { kind, filename, sha256 });
    if (current && current !== sha256) throw differentBytes();
    return current;
  }) : await heldHash(kind, filename);
  if (!hash) throw new ServerError('This machine does not hold that media', { status: 404, code: 'MEDIA_NOT_HELD' });
  return { sha256: hash };
}

export async function listMediaPrimaryMachines() {
  const { getPeers } = await import('./instances.js');
  const { peerAllowsOutbound } = await import('./sharing/peerSyncShared.js');
  const [self, peers] = await Promise.all([localInstanceId(), getPeers()]);
  return [
    ...(self ? [{ instanceId: self, name: 'This machine' }] : []),
    ...peers.filter((peer) => usablePeer(peer) && peerAllowsOutbound(peer) && peer.instanceId !== self)
      .map((peer) => ({ instanceId: peer.instanceId, name: peerLabel(peer) })),
  ];
}

/** Snapshot the known holders once for a batch; each release still checks live bytes. */
export async function prepareMediaConsolidation(instanceId) {
  const holders = await collectHolders({ strict: true });
  const { isTransferMediaFilename } = await import('./sharing/peerSyncAssets.js');
  const { peerAllowsOutbound } = await import('./sharing/peerSyncShared.js');
  const { self, registered, remote } = holders;
  const primary = instanceId === self ? null : registered.get(instanceId);
  if (instanceId !== self && (!usablePeer(primary) || !peerAllowsOutbound(primary))) {
    throw new ServerError('Choose this machine or an enabled, paired peer', { status: 400, code: 'PRIMARY_NOT_PAIRED' });
  }

  return ({ kind, filename }) => {
    if (!KINDS.includes(kind) || !validName(filename) || !isTransferMediaFilename(kind, filename)) {
      throw new ServerError('Unknown media', { status: 400, code: 'VALIDATION_ERROR' });
    }
    return withFileBusy(kind, filename, mediaBusy, async () => {
      const entry = { kind, filename };
      const known = remote.get(fileKey(kind, filename)) ?? new Set();
      // A file can arrive since the last inventory. Verify online peers that
      // have not reported it before assuming their copies need no cleanup.
      const discovered = (await Promise.all([...registered.values()]
        .filter((peer) => peer.instanceId !== instanceId && !known.has(peer.instanceId) && usablePeer(peer) && peer.status === 'online')
        .map(async (peer) => await peerHoldsFile(peer, kind, filename) === 'held' ? peer.instanceId : null)))
        .filter(Boolean);
      let sha256 = primary ? await peerCopyHash(primary, entry) : await heldHash(kind, filename);
      if (!sha256) {
        let sourceHash = await heldHash(kind, filename);
        let sourceError;
        for (const id of [...known, ...discovered]) {
          if (sourceHash) break;
          const peer = registered.get(id);
          if (id === instanceId || !usablePeer(peer) || peer.status === 'offline') continue;
          try {
            const hash = await peerCopyHash(peer, entry);
            if (hash) sourceHash = await pullVerifiedCopy(peer, { ...entry, sha256: hash });
          } catch (err) {
            sourceError = err;
          }
        }
        if (!sourceHash && sourceError) throw sourceError;
        if (!sourceHash) throw new ServerError('No reachable machine supplied a verified copy', { status: 409, code: 'MEDIA_COPY_UNAVAILABLE' });
        sha256 = primary ? await peerCopyHash(primary, { ...entry, sha256: sourceHash }) : sourceHash;
        if (sha256 !== sourceHash) throw new ServerError('The selected machine could not store a verified copy', { status: 409, code: 'MEDIA_COPY_FAILED' });
      }
      return designatePrimary(kind, filename, instanceId, holders, sha256, discovered);
    });
  };
}

/**
 * Receiver side of `POST /api/peer-media/release`. `senderPeerId` is the
 * registry id authGate verified from the pair credential. Releasing a copy
 * destroys local bytes, so it takes the same standing `media.delete` grant as a
 * remote delete. The primary must be a registered, paired peer here that holds
 * the bytes (checked before anything is trashed); this machine keeps the row and
 * streams the item from the primary afterwards.
 */
export async function executePeerMediaRelease(senderPeerId, { kind, filename, primaryInstanceId, primaryAt, sha256 }) {
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
  return withFileBusy(kind, filename, mediaBusy, () => releaseForPeer(peers, sender, { kind, filename, primaryInstanceId, primaryAt, sha256 }));
}

async function releaseForPeer(peers, sender, { kind, filename, primaryInstanceId, primaryAt, sha256 }) {
  if (!holdsHere(kind, filename)) throw new ServerError('This machine does not hold that media', { status: 404, code: 'MEDIA_NOT_HELD' });
  if (sha256 && await heldHash(kind, filename) !== sha256) throw differentBytes();
  // A delayed (queued) release must not undo a newer designation recorded here.
  const recorded = await currentPrimary(kind, filename);
  if (recorded && recorded.instanceId !== primaryInstanceId && (parseTsMs(recorded.at) ?? -Infinity) >= parseTsMs(primaryAt)) {
    console.log(`⏭️ Release of ${kind} ${filename} from ${peerLabel(sender)} refused: a newer primary is recorded here`);
    throw new ServerError('A newer primary is recorded for this media here; the copy was kept', { status: 409, code: 'PRIMARY_SUPERSEDED' });
  }
  if (primaryInstanceId === await localInstanceId()) {
    // This machine is the primary: it keeps its copy.
    if (sha256) {
      const { unmarkHosted } = await import('./peerHostedMedia.js');
      await unmarkHosted(kind, filename);
    }
    await setPrimaryOnRow(kind, filename, primaryInstanceId, primaryAt);
    return { ok: true, released: false };
  }
  const primary = peers.find((p) => p.instanceId === primaryInstanceId) ?? null;
  if (!usablePeer(primary)) {
    throw new ServerError('The primary is not a paired peer of this machine, so its copy could not be streamed from here', { status: 409, code: 'PRIMARY_NOT_PAIRED' });
  }
  if (sha256) {
    if (await peerCopyHash(primary, { kind, filename }) !== sha256) throw differentBytes();
  } else {
    const verdict = await peerHoldsFile(primary, kind, filename);
    if (verdict !== 'held') {
      throw new ServerError(`${peerLabel(primary)} ${verdict === 'unreachable' ? 'is unreachable from here' : 'does not hold this media'}; the copy here was kept`, {
        status: 409, code: verdict === 'unreachable' ? 'PRIMARY_UNREACHABLE' : 'PRIMARY_NOT_HOLDING',
      });
    }
  }
  await releaseLocalCopy(kind, filename, primary, primaryAt, sha256);
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
    for (const instanceId of Object.keys(store.reports)) {
      if (!instanceIds.has(instanceId)) { delete store.reports[instanceId]; changed = true; }
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
      if (busyFiles.has(fileKey(entry.kind, entry.filename))) continue;
      const released = await withFileBusy(entry.kind, entry.filename, mediaBusy, () => drainRelease(current, entry));
      if (released) done++;
    }
    emitMediaHoldersChanged();
  } catch (err) {
    console.error(`❌ Media release queue drain for ${peerLabel(peer)} failed: ${err.message}`);
  } finally {
    draining.delete(peer.id);
  }
  return done;
}

async function drainRelease(peer, entry) {
  const matches = (other) => other.peerId === entry.peerId && other.kind === entry.kind
    && other.filename === entry.filename && other.queuedAt === entry.queuedAt;
  if (!(await readStore()).releases.some(matches)) return false;

  const sent = await sendReleaseCommand(peer, entry);
  if (sent.outcome === 'unreachable') {
    console.log(`🔌 Queued release of ${entry.kind} ${entry.filename} still waiting on ${peerLabel(peer)}`);
    return false;
  }
  await updateStore((store) => {
    const next = store.releases.filter((other) => !matches(other));
    if (next.length === store.releases.length) return false;
    store.releases = next;
    return true;
  });
  if (sent.outcome === 'ok' || sent.outcome === 'not-held') {
    await notePeerHolding(peer.instanceId, entry.kind, entry.filename, false);
    console.log(`🗂️ Queued release of ${entry.kind} ${entry.filename} completed on ${peerLabel(peer)}`);
    return true;
  }
  console.log(`🚫 ${peerLabel(peer)} refused queued release of ${entry.kind} ${entry.filename}: ${sent.outcome}${sent.detail ? ` ${sent.detail}` : ''}`);
  return false;
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
