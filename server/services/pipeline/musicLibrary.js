/**
 * Background-music library for the pipeline audio stage.
 *
 * Storage model: a single shared directory at `PATHS.music`. Every track —
 * uploaded today, locally generated tomorrow — lives here under a deterministic
 * basename. The library list is just `readdir + stat` filtered to known audio
 * extensions. No JSON index — the filesystem is the source of truth, which
 * keeps the library robust across server restarts and direct file drops.
 *
 * Provider strategy mirrors `audio.js`: **local-first**. User-upload is the
 * always-available path (zero infra). Local MusicGen via a Python sidecar
 * (4c.2 follow-up) and a 3rd-party Suno stub (4c.3) plug in as sibling
 * sources behind the same library list — the AudioStage picker doesn't
 * care which one wrote the bytes.
 */

import { stat, copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, assertSafeFilename, listDirectoryByExtension } from '../../lib/fileUtils.js';

// Mirror of the sanitizer's MUSIC_SOURCES set in `services/pipeline/issues.js`.
// Exported so routes don't sprinkle bare strings; `'gen'` is reserved for the
// next sub-phase (local MusicGen sidecar / 3rd-party Suno stub).
export const MUSIC_SOURCE = Object.freeze({
  UPLOAD: 'upload',
  LIBRARY: 'library',
  GEN: 'gen',
});

export const SUPPORTED_AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);

export const SUPPORTED_AUDIO_MIME = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
});

export const MUSIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Returns true if the MIME or filename extension marks this as one of our
// supported audio formats. Used by the multipart fileFilter — matching either
// signal handles browsers that report `application/octet-stream` for drag-
// drop uploads while still requiring a known extension.
export function isSupportedMusicUpload(file) {
  if (!file) return false;
  const ext = (extname(file.originalname || '') || '').toLowerCase();
  if (!SUPPORTED_AUDIO_EXTENSIONS.includes(ext)) return false;
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  if (mime === 'application/octet-stream') return true;
  if (mime === 'video/mp4' && ext === '.m4a') return true; // some browsers
  return false;
}

/**
 * Validate a stored music filename — same pattern as the rest of the codebase.
 * Rejects path traversal, separators, and disallowed extensions.
 */
export function assertSafeMusicFilename(filename) {
  assertSafeFilename(filename, {
    extensions: [...SUPPORTED_AUDIO_EXTENSIONS],
    subject: 'music filename',
  });
}

/**
 * Generate a fresh deterministic basename for a newly-uploaded track. Keeps
 * the original extension so the static handler picks the right Content-Type.
 */
export function buildStoredFilename(originalName) {
  const ext = (extname(originalName || '') || '.mp3').toLowerCase();
  const safeExt = SUPPORTED_AUDIO_EXTENSIONS.includes(ext) ? ext : '.mp3';
  return `music-${randomUUID()}${safeExt}`;
}

/**
 * Strip the extension off a stored filename to produce a default label for
 * the library picker when the caller didn't pass one explicitly.
 */
export function deriveDefaultLabel(originalName) {
  const name = basename(originalName || '');
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/**
 * List every track currently sitting in the library. Each entry carries the
 * stored filename (what the audio stage persists on `music.trackFilename`),
 * file size, and last-modified timestamp so the picker can show "added X
 * minutes ago" without a separate metadata store.
 *
 * Missing directory → empty list (no surprise 500 on a fresh install).
 */
export async function listMusicLibrary() {
  await ensureDir(PATHS.music);
  // listDirectoryByExtension covers readdir + ENOENT → [] + extension filter
  // + stat + isFile drop. ensureDir runs first, so ENOENT shouldn't trip
  // anyway — but the helper preserves the original safety net.
  const entries = await listDirectoryByExtension(PATHS.music, {
    extensions: [...SUPPORTED_AUDIO_EXTENSIONS],
    mapEntry: (name, _full, s) => ({
      filename: name,
      label: deriveDefaultLabel(name),
      sizeBytes: s.size,
      updatedAt: s.mtime.toISOString(),
    }),
  });
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Move an uploaded temp file into the library and return the persisted
 * filename. Caller (the route) reads `req.file.path` from the multipart
 * helper. Returns `{ filename, sizeBytes }`.
 */
export async function importUploadedTrack(tempPath, originalName) {
  await ensureDir(PATHS.music);
  const filename = buildStoredFilename(originalName);
  const dest = join(PATHS.music, filename);
  // copyFile + unlink instead of rename — the multipart helper writes to
  // os.tmpdir(), which may sit on a different filesystem (rename across
  // devices throws EXDEV on Linux). Copy works regardless; the temp file
  // unlink is best-effort cleanup.
  await copyFile(tempPath, dest);
  await unlink(tempPath).catch(() => {});
  const s = await stat(dest).catch(() => null);
  return { filename, sizeBytes: s?.size ?? 0 };
}

/**
 * Confirm a track exists in the library. Returns the same shape as a list
 * entry (`{ filename, label, sizeBytes }`) or `null` if missing. Validates
 * the filename to prevent path-traversal.
 */
export async function statMusicTrack(filename) {
  assertSafeMusicFilename(filename);
  const full = join(PATHS.music, filename);
  if (!existsSync(full)) return null;
  const s = await stat(full).catch(() => null);
  if (!s || !s.isFile()) return null;
  return {
    filename,
    label: deriveDefaultLabel(filename),
    sizeBytes: s.size,
  };
}

/**
 * Delete a track from the library by stored filename. Returns true if the
 * file existed and was removed; false if it was already gone. Validates the
 * filename so a path-traversal attempt can't escape `PATHS.music`.
 */
export async function deleteMusicTrack(filename) {
  assertSafeMusicFilename(filename);
  const full = join(PATHS.music, filename);
  try {
    await unlink(full);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
