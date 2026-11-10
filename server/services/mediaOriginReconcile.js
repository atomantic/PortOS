/**
 * Settle the origin of federated media copies no record can attribute (#14133).
 * A video row or gallery image with no `originInstanceId`, no supplier and no
 * hosted entry is either made here or a copy pulled before suppliers were
 * recorded. Paired peers report each held file's modify time in their hosted
 * media inventory; this machine stamps the earliest holder as the origin only
 * when every paired peer reported and that holder is strictly earliest
 * (lib/mediaOriginClaim.js). All holders run the same rule, so they agree.
 *
 * The same proof corrects a claim naming THIS machine that the evidence does
 * not support (migration 450 on an install whose peers were all removed, #15664):
 * a file written well after its record's `createdAt`, or a record without one,
 * is re-attributed when the proof names an earlier holder. An origin naming
 * another machine is never replaced, and nothing changes without a proof.
 *
 * What each peer last reported lives with the holders in `data/media-holders.json`
 * (services/mediaHolders.js): machine-local, never federated.
 */
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { earliestHolderOrigin, localOriginMayBeReplaced } from '../lib/mediaOriginClaim.js';
import { sanitizeAssetFilename } from './sharing/buckets.js';
import { getPeers, peerMayDeleteMedia } from './instances.js';
import { peerIsPaired } from './mediaTombstoneAuthorization.js';
import { listHostedEntries, hostedKey } from './peerHostedMedia.js';
import { mutateVideoHistory, loadHistory, HISTORY_UNCHANGED } from './videoGen/history.js';
import { emitMediaHistoryChanged } from './peerSyncEventBus.js';

// A report older than this no longer proves what the peer holds; treated as unreported.
const REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A scan that found nothing to attribute is not repeated every sync cycle.
const EMPTY_RECHECK_MS = 10 * 60 * 1000;
// A proof that keeps this machine's own claims stands, so they alone re-ask the
// gallery-wide library once a day (well inside REPORT_MAX_AGE_MS).
const LOCAL_CLAIM_RECHECK_MS = 24 * 60 * 60 * 1000;
const KINDS = { video: () => PATHS.videos, image: () => PATHS.images };
const emptyUntil = new Map();
const localClaimsDueAt = new Map();

/** Record one peer's inventory scope with its file times (the shared holdings record, services/mediaHolders.js). */
export async function recordPeerHoldings(peerId, kind, category, report) {
  const { recordPeerReport } = await import('./mediaHolders.js');
  return recordPeerReport(peerId, kind, category, report);
}

const mtimeOf = (kind, filename) => stat(join(KINDS[kind](), filename)).then((s) => s.mtimeMs, () => null);

async function resolveLocalId() {
  const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
  const id = await getInstanceId().catch(() => null);
  return isNonBlankStr(id) && id !== UNKNOWN_INSTANCE_ID ? id : null;
}

// A record with no origin, or one whose claim naming this machine the proof may replace.
const isAttributable = (originInstanceId, localId, mtimeMs, createdAt) => !isNonBlankStr(originInstanceId)
  || (originInstanceId === localId && localOriginMayBeReplaced({ mtimeMs, createdAt }));
const candidate = (file, originInstanceId) => (isNonBlankStr(originInstanceId) ? { ...file, replacesLocal: true } : file);

/**
 * Held files the earliest-holder proof may attribute: `[{ filename, mtimeMs, id?, replacesLocal? }]`.
 * `replacesLocal` marks a claim naming this machine (`localId`) that may be replaced.
 */
async function unattributedFiles(kind, localId) {
  const hosted = await listHostedEntries();
  const out = [];
  if (kind === 'video') {
    const rows = await loadHistory().catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) {
      const filename = typeof row?.filename === 'string' ? sanitizeAssetFilename(row.filename) : null;
      if (!filename || typeof row.id !== 'string' || isNonBlankStr(row.suppliedByInstanceId)) continue;
      if (isNonBlankStr(row.originInstanceId) && row.originInstanceId !== localId) continue;
      if (hosted[hostedKey('video', filename)]) continue;
      const mtimeMs = await mtimeOf('video', filename);
      if (mtimeMs && isAttributable(row.originInstanceId, localId, mtimeMs, row.createdAt)) out.push(candidate({ id: row.id, filename, mtimeMs }, row.originInstanceId));
    }
    return out;
  }
  const { readHeldImage } = await import('./imageGen/imageRecords.js');
  const { readImageSidecar } = await import('./imageGen/sidecarStore.js');
  // The whole gallery, not only collection-referenced images (#14137).
  const filenames = (await readdir(PATHS.images, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png')).map((e) => e.name);
  for (const filename of filenames) {
    const record = await readHeldImage(filename);
    if (!record || isNonBlankStr(record.suppliedByInstanceId) || hosted[hostedKey('image', filename)]) continue;
    if (isNonBlankStr(record.originInstanceId) && record.originInstanceId !== localId) continue;
    const mtimeMs = await mtimeOf('image', filename);
    if (!mtimeMs) continue;
    // The record's createdAt falls back to the file time for a local origin; the sidecar's own is the evidence.
    const createdAt = isNonBlankStr(record.originInstanceId) ? (await readImageSidecar(filename)).metadata.createdAt : undefined;
    if (isAttributable(record.originInstanceId, localId, mtimeMs, createdAt)) out.push(candidate({ filename, mtimeMs }, record.originInstanceId));
  }
  return out;
}

/** Cheap gate for the sync cycle: is anything of `kind` still to attribute here? */
export async function hasUnattributedMedia(kind) {
  if (!KINDS[kind] || (emptyUntil.get(kind) ?? 0) > Date.now()) return false;
  const files = await unattributedFiles(kind, await resolveLocalId());
  if (files.some((file) => !file.replacesLocal)) return true;
  const now = Date.now();
  if (files.length > 0 && (localClaimsDueAt.get(kind) ?? 0) <= now) {
    localClaimsDueAt.set(kind, now + LOCAL_CLAIM_RECHECK_MS);
    return true;
  }
  emptyUntil.set(kind, now + EMPTY_RECHECK_MS);
  return false;
}

// Re-checked under the writer: a supplier recorded since the scan wins, and a
// claim is only replaced while it still names this machine on the same evidence.
const stillAttributable = (record, claim, localId) => !isNonBlankStr(record.suppliedByInstanceId) && (claim.replacesLocal
  ? record.originInstanceId === localId && localOriginMayBeReplaced({ mtimeMs: claim.mtimeMs, createdAt: record.createdAt })
  : !isNonBlankStr(record.originInstanceId));

// `stampOrigin: false`: the writer must not restore the claim this replaces.
const stampVideoOrigins = async (claims, localId) => {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const stamped = [];
  await mutateVideoHistory((rows) => {
    let changed = false;
    const next = rows.map((row) => {
      const claim = byId.get(row?.id);
      if (!claim || row.filename !== claim.filename || !stillAttributable(row, claim, localId)) return row;
      changed = true;
      stamped.push(row.id);
      return { ...row, originInstanceId: claim.origin };
    });
    return changed ? next : HISTORY_UNCHANGED;
  }, { stampOrigin: false });
  if (stamped.length > 0) emitMediaHistoryChanged({ kind: 'video', op: 'upsert', ids: stamped });
  return stamped.length;
};

const stampImageOrigin = async (claim, localId) => {
  const { editImageSidecar } = await import('./imageGen/sidecarStore.js');
  const { filename, origin } = claim;
  const changed = await editImageSidecar(filename, (metadata) => {
    if (!isPlainObject(metadata) || Object.keys(metadata).length === 0 || !stillAttributable(metadata, claim, localId)) return null;
    metadata.originInstanceId = origin;
    return true;
  });
  return changed === true;
};

/**
 * Stamp the origin of every unattributed file of `kind` (or replaceable claim
 * naming this machine) whose earliest holder is provable. Returns the number stamped. A file is only attributed when EVERY
 * enabled paired peer has a fresh report that examined it.
 */
export async function reconcileMediaOrigins(kind, { nowMs = Date.now() } = {}) {
  if (!KINDS[kind]) return 0;
  const localId = await resolveLocalId();
  if (!localId) return 0;
  const peers = (await getPeers().catch(() => [])).filter((p) => p?.enabled !== false && peerIsPaired(p) && isNonBlankStr(p.instanceId));
  if (peers.length === 0) return 0;
  const holdings = await import('./mediaHolders.js').then((m) => m.readPeerReports()).catch(() => null);
  if (!holdings) return 0;
  // Fresh scope reports per peer; one speaks for a file only if the peer examined its name.
  const scopesOf = (peer) => Object.values(isPlainObject(holdings[peer.instanceId]?.[kind]) ? holdings[peer.instanceId][kind] : {})
    .filter((scope) => isPlainObject(scope?.mtimes) && Array.isArray(scope.checked) && nowMs - Date.parse(scope.at) <= REPORT_MAX_AGE_MS);
  const candidates = await unattributedFiles(kind, localId);
  const claims = [];
  for (const file of candidates) {
    const holders = [];
    let covered = true;
    for (const peer of peers) {
      const scopes = scopesOf(peer).filter((scope) => scope.complete === true || scope.checked.includes(file.filename) || scope.mtimes[file.filename] !== undefined);
      // A peer that did not examine the file is unreported for it: nobody claims.
      if (scopes.length === 0) { covered = false; break; }
      // Overlapping scopes: the newest report that covers the name is the peer's current answer.
      const newest = scopes.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
      if (newest.mtimes[file.filename] !== undefined) holders.push({ peerId: peer.instanceId, mtimeMs: newest.mtimes[file.filename], mayDelete: peerMayDeleteMedia(peer) });
    }
    if (!covered) continue;
    const origin = earliestHolderOrigin({ localId, localMtimeMs: file.mtimeMs, holders });
    // A proof naming this machine leaves its own claim as it is.
    if (origin && !(file.replacesLocal && origin === localId)) claims.push({ ...file, origin });
  }
  if (claims.length === 0) return 0;
  const stamped = kind === 'video'
    ? await stampVideoOrigins(claims, localId)
    : (await Promise.all(claims.map((claim) => stampImageOrigin(claim, localId)))).filter(Boolean).length;
  if (stamped > 0) console.log(`🧭 mediaOrigin: attributed ${stamped} ${kind}(s) to their earliest holder`);
  emptyUntil.delete(kind);
  return stamped;
}
