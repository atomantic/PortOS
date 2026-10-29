/**
 * Settle the origin of federated media copies no record can attribute (#14133).
 * A video row or gallery image with no `originInstanceId`, no supplier and no
 * hosted entry is either made here or a copy pulled before suppliers were
 * recorded. Paired peers report each held file's modify time in their hosted
 * media inventory; this machine stamps the earliest holder as the origin only
 * when every paired peer reported and that holder is strictly earliest
 * (lib/mediaOriginClaim.js). All holders run the same rule, so they agree.
 *
 * `data/peer-media-holdings.json` is `file-primary` and machine-local: what
 * each peer last reported, never federated.
 */
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { earliestHolderOrigin } from '../lib/mediaOriginClaim.js';
import { sanitizeAssetFilename } from './sharing/buckets.js';
import { getPeers, peerMayDeleteMedia } from './instances.js';
import { peerIsPaired } from './mediaTombstoneAuthorization.js';
import { listHostedEntries, hostedKey } from './peerHostedMedia.js';
import { mutateVideoHistory, loadHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { emitMediaHistoryChanged } from './peerSyncEventBus.js';

const HOLDINGS_FILE = () => join(PATHS.data, 'peer-media-holdings.json');
const SCHEMA_VERSION = 1;
// A report older than this no longer proves what the peer holds; treated as unreported.
const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A scan that found nothing to attribute is not repeated every sync cycle.
const EMPTY_RECHECK_MS = 10 * 60 * 1000;
const KINDS = { video: () => PATHS.videos, image: () => PATHS.images };
const queueWrite = createFileWriteQueue();
const emptyUntil = new Map();

async function readHoldings() {
  // STRICT: an unreadable file must not be written back as an empty one.
  const raw = await readJSONFile(HOLDINGS_FILE(), null, { strict: true });
  return isPlainObject(raw) && isPlainObject(raw.peers) ? raw.peers : {};
}

/**
 * Remember what `peerId` reported for one inventory scope (`category`): the
 * modify times of the files it holds (`{ filename: mtimeMs }`) and the
 * filenames it examined. Scopes differ (history rows vs collection assets), so
 * a report speaks only for the names it `checked`, never for the whole kind.
 */
export function recordPeerHoldings(peerId, kind, category, { mtimes, checked }) {
  if (!KINDS[kind] || !isNonBlankStr(peerId) || !isNonBlankStr(category) || !isPlainObject(mtimes) || !Array.isArray(checked)) return Promise.resolve(false);
  const valid = (name) => typeof name === 'string' && sanitizeAssetFilename(name) === name;
  const clean = {};
  for (const [name, ms] of Object.entries(mtimes)) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && valid(name)) clean[name] = ms;
  }
  return queueWrite(async () => {
    const peers = await readHoldings();
    const entry = isPlainObject(peers[peerId]) ? peers[peerId] : {};
    const scopes = isPlainObject(entry[kind]) ? entry[kind] : {};
    peers[peerId] = { ...entry, [kind]: { ...scopes, [category]: { at: new Date().toISOString(), mtimes: clean, checked: checked.filter(valid) } } };
    await atomicWrite(HOLDINGS_FILE(), { version: SCHEMA_VERSION, peers });
    return true;
  });
}

const mtimeOf = (kind, filename) => stat(join(KINDS[kind](), filename)).then((s) => s.mtimeMs, () => null);

/** Held files with nothing recording who made them: `[{ filename, mtimeMs, id? }]`. */
async function unattributedFiles(kind) {
  const hosted = await listHostedEntries();
  const out = [];
  if (kind === 'video') {
    const rows = await loadHistory().catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) {
      const filename = typeof row?.filename === 'string' ? sanitizeAssetFilename(row.filename) : null;
      if (!filename || typeof row.id !== 'string' || isNonBlankStr(row.originInstanceId) || isNonBlankStr(row.suppliedByInstanceId)) continue;
      if (hosted[hostedKey('video', filename)]) continue;
      const mtimeMs = await mtimeOf('video', filename);
      if (mtimeMs) out.push({ id: row.id, filename, mtimeMs });
    }
    return out;
  }
  const [{ getHostedMediaInventory }, { readHeldImage }] = await Promise.all([import('./dataSync.js'), import('./imageGen/imageRecords.js')]);
  const { filenames } = await getHostedMediaInventory('mediaCollections', 'image');
  for (const filename of filenames) {
    const record = await readHeldImage(filename);
    if (!record || isNonBlankStr(record.originInstanceId) || isNonBlankStr(record.suppliedByInstanceId) || hosted[hostedKey('image', filename)]) continue;
    const mtimeMs = await mtimeOf('image', filename);
    if (mtimeMs) out.push({ filename, mtimeMs });
  }
  return out;
}

/** Cheap gate for the sync cycle: is anything of `kind` still unattributed here? */
export async function hasUnattributedMedia(kind) {
  if (!KINDS[kind] || (emptyUntil.get(kind) ?? 0) > Date.now()) return false;
  const found = (await unattributedFiles(kind)).length > 0;
  if (!found) emptyUntil.set(kind, Date.now() + EMPTY_RECHECK_MS);
  return found;
}

const stampVideoOrigins = async (claims) => {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const stamped = [];
  await mutateVideoHistory((rows) => {
    let changed = false;
    const next = rows.map((row) => {
      const claim = byId.get(row?.id);
      // Re-checked under the writer: a supplier or origin recorded since the scan wins.
      if (!claim || row.filename !== claim.filename || isNonBlankStr(row.originInstanceId) || isNonBlankStr(row.suppliedByInstanceId)) return row;
      changed = true;
      stamped.push(row.id);
      return { ...row, originInstanceId: claim.origin };
    });
    return changed ? next : HISTORY_UNCHANGED;
  }, { stampOrigin: false });
  if (stamped.length > 0) emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: stamped });
  return stamped.length;
};

const stampImageOrigin = async ({ filename, origin }) => {
  const { editImageSidecar } = await import('./imageGen/sidecarStore.js');
  const changed = await editImageSidecar(filename, (metadata) => {
    if (!isPlainObject(metadata) || Object.keys(metadata).length === 0 || isNonBlankStr(metadata.originInstanceId) || isNonBlankStr(metadata.suppliedByInstanceId)) return null;
    metadata.originInstanceId = origin;
    return true;
  });
  return changed === true;
};

/**
 * Stamp the origin of every unattributed file of `kind` whose earliest holder is
 * provable. Returns the number stamped. A file is only attributed when EVERY
 * enabled paired peer has a fresh report that examined it.
 */
export async function reconcileMediaOrigins(kind, { nowMs = Date.now() } = {}) {
  if (!KINDS[kind]) return 0;
  const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
  const localId = await getInstanceId().catch(() => null);
  if (!isNonBlankStr(localId) || localId === UNKNOWN_INSTANCE_ID) return 0;
  const peers = (await getPeers().catch(() => [])).filter((p) => p?.enabled !== false && peerIsPaired(p) && isNonBlankStr(p.instanceId));
  if (peers.length === 0) return 0;
  const holdings = await readHoldings().catch(() => null);
  if (!holdings) return 0;
  // Fresh scope reports per peer; one speaks for a file only if the peer examined its name.
  const scopesOf = (peer) => Object.values(isPlainObject(holdings[peer.instanceId]?.[kind]) ? holdings[peer.instanceId][kind] : {})
    .filter((scope) => isPlainObject(scope?.mtimes) && Array.isArray(scope.checked) && nowMs - Date.parse(scope.at) <= REPORT_MAX_AGE_MS);
  const candidates = await unattributedFiles(kind);
  const claims = [];
  for (const file of candidates) {
    const holders = [];
    let covered = true;
    for (const peer of peers) {
      const scopes = scopesOf(peer).filter((scope) => scope.checked.includes(file.filename) || scope.mtimes[file.filename] !== undefined);
      // A peer that did not examine the file is unreported for it: nobody claims.
      if (scopes.length === 0) { covered = false; break; }
      const held = scopes.find((scope) => scope.mtimes[file.filename] !== undefined);
      if (held) holders.push({ peerId: peer.instanceId, mtimeMs: held.mtimes[file.filename], mayDelete: peerMayDeleteMedia(peer) });
    }
    if (!covered) continue;
    const origin = earliestHolderOrigin({ localId, localMtimeMs: file.mtimeMs, holders });
    if (origin) claims.push({ ...file, origin });
  }
  if (claims.length === 0) return 0;
  const stamped = kind === 'video'
    ? await stampVideoOrigins(claims)
    : (await Promise.all(claims.map(stampImageOrigin))).filter(Boolean).length;
  if (stamped > 0) console.log(`🧭 mediaOrigin: attributed ${stamped} ${kind}(s) to their earliest holder`);
  emptyUntil.delete(kind);
  return stamped;
}
