/**
 * Gallery video upload (#4188) — the video counterpart of
 * `saveUploadedGalleryImage` (imageGen/local.js), built on the same "derived,
 * not a generation" tail as videoDownload.js: land the bytes under
 * PATHS.videos, generate a thumbnail, and write a `source: 'upload'` entry
 * into the shared video-history store so the file shows up in the existing
 * media library/gallery, federates through the peer-sync asset manifest, and
 * gets picked up by the mediaAssetIndex `videoGenEvents 'completed'` hook
 * unmodified.
 *
 * This exists because `POST /api/uploads` lands files in `data/uploads/`,
 * which does NOT federate — a mood-board (or collection) item referencing an
 * upload there 404s on every peer. Board-referenced media must live in a
 * peer-syncable directory; for video that is PATHS.videos.
 *
 * The filename is `upload-<uuid8>.<ext>` — the stem doubles as the history id
 * AND the thumbnail name (`<stem>.jpg`), matching the convention the
 * receiver-side asset pull regenerates thumbnails under, so a poster URL built
 * from the stem resolves identically on the sender and on every peer.
 */

import { open, stat, rename } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { PATHS, ensureDir, atomicWrite, unlinkGuarded, copyFileGuarded } from '../lib/fileUtils.js';
import { MAX_BASE64_UPLOAD_BYTES } from '../lib/uploadLimits.js';
import { generateThumbnail, probeVideoDuration } from '../lib/ffmpeg.js';
import { mutateVideoHistory } from './videoGen/history.js';
import { videoGenEvents } from './videoGen/events.js';

// Compatibility export for the separate remote browser-download path.
// User uploads stream to disk without this legacy JSON transport bound.
export const MAX_GALLERY_VIDEO_UPLOAD_BYTES = MAX_BASE64_UPLOAD_BYTES;

// Container sniff — extension comes from the BYTES, not the client filename.
// ISO-BMFF (`ftyp` box at offset 4) covers mp4/m4v/mov; the `qt` major brand
// distinguishes QuickTime. EBML magic covers webm/mkv (served as .webm — the
// same h264/vp9 payloads browsers already play).
export function detectVideoContainer(buffer) {
  if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    return brand.startsWith('qt') ? 'mov' : 'mp4';
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

// Pure + exported so the load-bearing shape (the fields normalizeVideo,
// mediaAssetIndex videoToRow, and deleteHistoryItem depend on) is pinned by a
// unit test — same rationale as buildDownloadHistoryEntry (videoDownload.js).
export function buildUploadHistoryEntry({ id, filename, thumbnail, durationSec, title }) {
  return {
    id,
    filename,
    thumbnail,
    createdAt: new Date().toISOString(),
    source: 'upload',
    title: title || 'Uploaded video',
    ...(durationSec != null ? { durationSec } : {}),
  };
}

/**
 * Save an uploaded video into the shared gallery. Returns the video-history
 * entry (`{ id, filename, thumbnail, source: 'upload', … }`); the served file
 * is `/data/videos/<filename>`.
 */
export async function saveUploadedGalleryVideoBuffer(buffer, originalName = '') {
  if (!Buffer.isBuffer(buffer)) {
    throw new ServerError('Invalid video upload', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (buffer.length === 0) {
    throw new ServerError('Empty video upload', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return persistGalleryVideo(buffer, originalName, buffer.length, (outPath) => atomicWrite(outPath, buffer));
}

// Read only the container signature; copy the streamed file without buffering it.
export async function saveUploadedGalleryVideoFile(tempPath, originalName = '') {
  const file = await open(tempPath, 'r');
  const header = Buffer.alloc(12);
  const bytesRead = await file.read(header, 0, header.length, 0)
    .then((result) => result.bytesRead).finally(() => file.close());
  const { size } = await stat(tempPath);
  return persistGalleryVideo(header.subarray(0, bytesRead), originalName, size,
    async (outPath) => {
      const staging = `${outPath}.tmp`;
      try {
        await copyFileGuarded(tempPath, staging);
        await rename(staging, outPath);
      } finally {
        await unlinkGuarded(staging).catch(() => {});
      }
    });
}

async function persistGalleryVideo(header, originalName, size, write) {
  const ext = detectVideoContainer(header);
  if (!ext) {
    throw new ServerError('Unsupported video format (expected MP4, MOV/M4V, or WebM)', { status: 400, code: 'UNSUPPORTED_VIDEO' });
  }
  const id = `upload-${randomUUID().slice(0, 8)}`;
  const filename = `${id}.${ext}`;
  await ensureDir(PATHS.videos);
  const outPath = join(PATHS.videos, filename);
  try {
    await write(outPath);
    // Both best-effort: a missing ffmpeg/ffprobe degrades to a thumbnail-less
    // entry (normalizeVideo renders a no-preview tile), never a failed upload.
    const [thumbnail, durationSec] = await Promise.all([
      generateThumbnail(outPath, id).catch(() => null),
      probeVideoDuration(outPath).catch(() => null),
    ]);
    const title = typeof originalName === 'string' && originalName.trim()
      ? originalName.trim().slice(0, 200)
      : '';
    const entry = buildUploadHistoryEntry({ id, filename, thumbnail, durationSec, title });
    await mutateVideoHistory((history) => { history.unshift(entry); return history; });
    // Let the live media-asset index hook index this immediately (same event
    // the generation and download paths emit). Reconcile is the backstop.
    videoGenEvents.emit('completed', { generationId: id, filename, path: `/data/videos/${filename}`, thumbnail });
    console.log(`📥 Saved uploaded gallery video: ${filename} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    return entry;
  } catch (err) {
    // A throw between the byte write and the history write would orphan a
    // large file in data/videos with nothing pointing at it — mirror
    // downloadVideoIntoLibrary's cleanup-then-rethrow.
    await unlinkGuarded(outPath).catch(() => {});
    throw err;
  }
}

export async function saveUploadedGalleryVideo(base64Data, originalName = '') {
  return saveUploadedGalleryVideoBuffer(Buffer.from(base64Data, 'base64'), originalName);
}
