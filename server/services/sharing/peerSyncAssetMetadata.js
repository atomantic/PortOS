/** Resolve asset paths, tombstones, and video history for federation manifests and transfers. */

import { extname, join } from 'path';
import { stat } from 'fs/promises';
import { PATHS, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/textUtils.js';
import { mediaTombstoneStamps } from '../mediaTombstones.js';
import { parseTsMs } from '../../lib/lwwTimestamp.js';
import { VIDEO_FILE_EXTENSIONS } from '../collectionVideoFiles.js';

// A gallery image deleted here, unless the incoming copy says it was made after
// the delete (a re-used name). An asset with no usable stamp stays blocked, so
// an older peer's copy cannot resurrect the deleted image.
export const deletedImageStamps = (entries) => (entries.some((entry) => entry?.kind === 'image') ? mediaTombstoneStamps('image') : new Map());
export function blockedByImageTombstone(stamps, entry) {
  if (entry?.kind !== 'image' || !stamps.has(entry.filename)) return false;
  const incoming = parseTsMs(entry.createdAt);
  return incoming === null || !(incoming > stamps.get(entry.filename));
}

// Video tombstones key on the history row id, but the bytes ride the library
// sweep as `<id>.<ext>`. A re-created video has a new id, so the stem never matches it.
export const deletedVideoIds = async (entries) => (entries.some((entry) => entry?.kind === 'video') ? new Set((await mediaTombstoneStamps('video')).keys()) : new Set());
export const blockedByVideoTombstone = (ids, entry) => entry?.kind === 'video' && isStr(entry.filename) && ids.has(entry.filename.replace(/\.[^.]+$/, ''));

// The receiving peer must never persist navigable HTML or SVG into an asset
// mount on the PortOS origin. Keep these in step with the writers into each
// directory, including catalog voice memos (.webm) and video uploads (.ogv).
const ASSET_KIND_EXTENSIONS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']),
  'image-ref': new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']),
  video: new Set(VIDEO_FILE_EXTENSIONS),
  music: new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus']),
  model: new Set(['.glb']),
  audio: new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.webm']),
};

export function isTransferMediaFilename(kind, filename) {
  return !filename.startsWith('.') && !/[\u0000-\u001f\u007f]/.test(filename) && ASSET_KIND_EXTENSIONS[kind]?.has(extname(filename).toLowerCase()) === true;
}

export function hasAllowedAssetExtension(kind, filename) {
  if (ASSET_KIND_EXTENSIONS[kind]?.has(extname(filename).toLowerCase())) return true;
  // Do not echo a peer-controlled filename into the log (it can contain CR/LF).
  console.warn(`⚠️ peerSync: skipped unsupported ${kind} asset extension`);
  return false;
}

export function directoryForAssetKind(kind) {
  if (kind === 'model') return PATHS.models;
  if (kind === 'image') return PATHS.images;
  if (kind === 'image-ref') return PATHS.imageRefs;
  if (kind === 'video') return PATHS.videos;
  if (kind === 'music') return PATHS.music;
  if (kind === 'audio') return PATHS.audio; // #1566 standalone media-library sweep
  return null;
}

// `data/video-history.json` is a FLAT array of video-generation rows
// (`{ id, filename, thumbnail, ... }`). The same store dataSync's `videoHistory`
// category federates as metadata; the two lookups below read it to map between a
// row's id, its on-disk basename under PATHS.videos, and its poster basename
// under PATHS.videoThumbnails. Mirrors dataSync's direct readJSONFile (no
// videoGen import — that drags in ffmpeg/spawn machinery we don't need here).
export async function readVideoHistoryRows() {
  const raw = await readJSONFile(join(PATHS.data, 'video-history.json'), []);
  return Array.isArray(raw) ? raw : [];
}

// Stat-keyed SHA-256 cache for flat (non-image) media assets so repeated
// manifest diffs, post-pull re-diffs, and pre-pull hash rechecks do not
// re-read multi-GB video/audio/music/model files when unchanged on disk.
const ASSET_SHA_CACHE_MAX = 200_000;
const assetShaCache = new Map(); // fullPath → { stamp, sha256 }

export async function sha256FileCached(fullPath) {
  const info = await stat(fullPath).catch(() => null);
  if (!info?.isFile()) {
    assetShaCache.delete(fullPath);
    return null;
  }
  const stamp = `${info.mtimeMs}:${info.size}:${info.ino}:${info.ctimeMs}`;
  const cached = assetShaCache.get(fullPath);
  if (cached?.stamp === stamp) return cached.sha256;
  assetShaCache.delete(fullPath);
  const sha256 = await sha256File(fullPath).catch(() => null);
  if (!sha256) return null;
  if (assetShaCache.size >= ASSET_SHA_CACHE_MAX) {
    const oldestKey = assetShaCache.keys().next().value;
    if (oldestKey !== undefined) assetShaCache.delete(oldestKey);
  }
  assetShaCache.set(fullPath, { stamp, sha256 });
  return sha256;
}
