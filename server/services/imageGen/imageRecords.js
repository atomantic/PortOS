/**
 * A gallery image as a federated record. Images are files in `data/images`
 * with a sidecar, keyed everywhere by filename, so this module supplies what a
 * video history row carries for remote delete and tombstones: the record held
 * here, its owner (`originInstanceId`, set once at creation and synced), and
 * the merge of an authorized peer tombstone. Kept light: the sync paths load it,
 * and local.js (the render graph) is imported lazily.
 */
import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile } from '../../lib/fileUtils.js';
import { isPlainObject } from '../../lib/objects.js';
import { isNonBlankStr } from '../../lib/textUtils.js';
import { stripImageSidecarLocalFields, imageLiveStamp } from '../../lib/assetHash.js';
import { isSafeFilename } from '../../lib/pathSafety.js';
import { isTombstoned, tombstoneTimestamp } from '../../lib/tombstones.js';
import { parseTsMs } from '../../lib/lwwTimestamp.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { mergeMediaTombstones, listMediaTombstones } from '../mediaTombstones.js';

// The check assertGalleryFilename applies, as a predicate for peer-supplied keys.
const isGalleryName = (filename) => isSafeFilename(filename, ['.png']);

const sidecarPaths = (filename) => [
  join(PATHS.images, filename.replace(/\.png$/i, '.metadata.json')),
  join(PATHS.images, `${filename}.metadata.json`),
];

async function readSidecar(filename) {
  for (const path of sidecarPaths(filename)) {
    if (!existsSync(path)) continue;
    const parsed = await readJSONFile(path, null, { logError: false });
    return isPlainObject(parsed) ? parsed : {};
  }
  return null;
}

/**
 * The image held here as a record, `{ filename, createdAt?, originInstanceId?,
 * suppliedByInstanceId?, pendingDelete?, hidden? }`, or null when neither its
 * bytes nor its sidecar are on this machine. `createdAt` is the live stamp a
 * tombstone must postdate (imageLiveStamp: the sidecar's, else the file's), so
 * a stale delete of an earlier image under a re-used name spares this one.
 */
export async function readHeldImage(filename) {
  if (!isGalleryName(filename)) return null;
  const sidecar = await readSidecar(filename);
  const fileStat = await stat(join(PATHS.images, filename)).catch(() => null);
  if (!sidecar && !fileStat) return null;
  const record = { filename };
  const createdAt = imageLiveStamp(sidecar, fileStat);
  if (createdAt) record.createdAt = createdAt;
  for (const key of ['originInstanceId', 'suppliedByInstanceId']) {
    if (isNonBlankStr(sidecar?.[key])) record[key] = sidecar[key];
  }
  if (isPlainObject(sidecar?.pendingDelete)) record.pendingDelete = sidecar.pendingDelete;
  if (sidecar?.hidden === true) record.hidden = true;
  return record;
}

export async function localInstanceId() {
  const identity = await import('../instanceIdentity.js');
  const id = await identity.getInstanceId().catch(() => null);
  return isNonBlankStr(id) && id !== identity.UNKNOWN_INSTANCE_ID ? id : null;
}

/**
 * `meta` for an image made on this machine from another one (a variant, an
 * upload): this machine is its origin, and the source's machine-local fields
 * do not carry over.
 */
export async function withLocalImageOrigin(meta) {
  const { originInstanceId: _source, ...rest } = stripImageSidecarLocalFields(isPlainObject(meta) ? meta : {}); // eslint-disable-line no-unused-vars
  const id = await localInstanceId();
  return id ? { ...rest, originInstanceId: id } : rest;
}

async function stampRenderOrigin(payload) {
  const filename = payload?.filename;
  // A temp render (no gallery path) has no sidecar to own.
  if (payload?.temp || payload?.path === null || !isGalleryName(filename)) return;
  const id = await localInstanceId();
  if (!id) return;
  const { fillImageSidecarFields } = await import('./local.js');
  // Fills only an absent origin, so a set origin never changes.
  await fillImageSidecarFields(filename, { originInstanceId: id });
}

let stampHandler = null;

/**
 * Every provider's finished gallery render emits `completed` after its sidecar
 * write; stamp this machine as the render's origin there, the one point all
 * providers share. Idempotent; returns the disarm function.
 */
export function initImageOriginStamping() {
  if (!stampHandler) {
    stampHandler = (payload) => {
      stampRenderOrigin(payload).catch((err) => console.error(`❌ Image origin stamp failed for ${payload?.filename}: ${err.message}`));
    };
    imageGenEvents.on('completed', stampHandler);
  }
  return () => {
    if (stampHandler) imageGenEvents.removeListener('completed', stampHandler);
    stampHandler = null;
  };
}

/**
 * Merge an ALREADY AUTHORIZED image tombstone list (mediaTombstoneAuthorization.js)
 * and run the full gallery delete for every held image it covers. An image
 * created after the delete survives. Returns the number of images removed.
 * `fromRemoteTombstone` keeps deleteImage from re-recording or re-announcing.
 */
export async function applyRemoteImageTombstones(remoteTombstones) {
  if (!Array.isArray(remoteTombstones) || remoteTombstones.length === 0) return 0;
  await mergeMediaTombstones('image', remoteTombstones);
  const tombstones = await listMediaTombstones('image');
  const { deleteGalleryImage } = await import('../galleryImageDeletion.js');
  let removed = 0;
  for (const { key } of remoteTombstones) {
    const held = await readHeldImage(key);
    if (!held || !isTombstoned(tombstones, key, held.createdAt, 'key')) continue;
    try {
      await deleteGalleryImage(key, { fromRemoteTombstone: true });
      removed++;
    } catch (err) {
      console.error(`❌ Image tombstone removal failed for ${key}: ${err.message}`);
    }
  }
  return removed;
}

/**
 * Admit image tombstones from `peer` through the shared rule, then apply them:
 * a held image goes through the full delete, and an event's tombstone for an
 * image not held here is only recorded (a manifest's is refused; see the rule).
 * Resolves `{ removed, recorded, refused }`.
 */
export async function admitPeerImageTombstones(peer, tombstones, { via = 'snapshot', eventOriginInstanceId = null } = {}) {
  const list = Array.isArray(tombstones) ? tombstones : [];
  if (list.length === 0) return { removed: 0, recorded: 0, refused: 0 };
  const [{ authorizeRemoteMediaTombstone }, { listHostedEntries }] = await Promise.all([
    import('../mediaTombstoneAuthorization.js'), import('../peerHostedMedia.js'),
  ]);
  const hostedIndex = await listHostedEntries();
  // A delete already recorded here at the same or a later instant was applied
  // then; a manifest repeats every tombstone on each changed sweep.
  const local = await listMediaTombstones('image');
  const alreadyApplied = (t) => {
    const mine = parseTsMs(tombstoneTimestamp(local, t?.key, 'key'));
    const theirs = parseTsMs(t?.deletedAt);
    return mine !== null && theirs !== null && mine >= theirs;
  };
  const held = [];
  const notHeld = [];
  let refused = 0;
  for (const tombstone of list) {
    if (!isGalleryName(tombstone?.key)) { refused++; continue; }
    if (alreadyApplied(tombstone)) continue;
    const localRow = await readHeldImage(tombstone.key);
    const verdict = authorizeRemoteMediaTombstone({ peer, tombstone, localRow, hostedIndex, via, eventOriginInstanceId });
    if (!verdict.allowed) refused++;
    else if (localRow) held.push(tombstone);
    else notHeld.push(tombstone);
  }
  if (notHeld.length > 0) await mergeMediaTombstones('image', notHeld);
  const removed = await applyRemoteImageTombstones(held);
  return { removed, recorded: notHeld.length, refused };
}
