/** Upload staging, validation, persistence, and local-file serving helpers. */
import { copyFile, readFile, stat, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, resolve as resolvePath } from 'path';
import { ServerError } from './errorHandler.js';
import { atomicWrite, ensureDir, pathExists } from './fileCore.js';
import { detectImageFormat, getFileExtension, getMimeType, RISKY_MIME_TYPES, sanitizeFilename } from './mimeTypes.js';
import { PATHS } from './paths.js';
import { assertSafeFilename, isPathInsideDir } from './pathSafety.js';

/**
 * Move a temp file into `destDir` and return the persisted filename, using the
 * `/api/uploads` route's naming (`<uuid8>-<sanitized-name>`) so a
 * server-produced file is served and referenced exactly like a user upload.
 *
 * copyFile + unlink instead of rename — the source usually lives in
 * `os.tmpdir()`, which may sit on a different filesystem (rename across devices
 * throws EXDEV on Linux); copy works regardless. The temp unlink is best-effort
 * cleanup. When `extensions` is supplied, the persisted name must use one of
 * those extensions. A persisted extension determines the Content-Type for
 * files that may live under a static mount, so it must never come from a
 * client-supplied filename. Returns `{ filename, sizeBytes }`.
 */
export async function importFileToDir(tempPath, originalName, destDir, { extensions } = {}) {
  const extension = getFileExtension(originalName);
  if (extensions && !extensions.map((item) => item.toLowerCase()).includes(extension)) {
    throw new ServerError('Invalid file type', { status: 400, code: 'INVALID_FILE_TYPE' });
  }
  await ensureDir(destDir);
  const filename = `${randomUUID().slice(0, 8)}-${sanitizeFilename(originalName)}`;
  const dest = join(destDir, filename);
  await copyFile(tempPath, dest);
  await unlink(tempPath).catch(() => {});
  const s = await stat(dest).catch(() => null);
  return { filename, sizeBytes: s?.size ?? 0 };
}

/**
 * `importFileToDir` pinned to the uploads dir (`PATHS.uploads`) — the common
 * case (e.g. a yt-dlp audio extraction, #2120).
 */
export async function importFileToUploads(tempPath, originalName) {
  return importFileToDir(tempPath, originalName, PATHS.uploads);
}

// Widest supported image signature (WebP needs 12 bytes: `RIFF….WEBP`). A payload
// shorter than this can't hold a complete header for any format we accept.
const MIN_IMAGE_BYTES = 12;

// POSIX NAME_MAX — the per-component filename limit on ext4/APFS/HFS+. A longer
// component makes the write fail with ENAMETOOLONG.
const MAX_FILENAME_BYTES = 255;

/**
 * Persist a base64-encoded IMAGE into `dir`, deriving the format from the bytes
 * rather than trusting the client: decode → size cap → magic-byte sniff → force
 * the extension to the detected format → sanitize + containment guard → write.
 *
 * This is the sibling of `saveBase64Upload` for the paths that must be certain
 * they wrote an image (they hand the file to an image-gen backend or to an agent
 * that will read it), so an extension allowlist isn't enough. Naming is the
 * CALLER's call — pass a name that is already unique if later uploads must not
 * overwrite this one, since `dir` is a shared bucket.
 *
 * Throws ServerError with the status/code/message contract `routes/screenshots.js`
 * established (`FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `INVALID_FILENAME` — all
 * 400) so callers keep their pinned responses.
 *
 * @param {string} dir - Destination directory (created if missing).
 * @param {{ filename: string, data: string }} upload - Desired base name (the
 *   extension is replaced with the detected one) + base64 payload.
 * @param {{ maxBytes: number }} opts
 * @returns {Promise<{ filename: string, filePath: string, size: number,
 *   format: string, mime: string }>}
 */
export async function saveImageUpload(dir, { filename, data }, { maxBytes }) {
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > maxBytes) {
    throw new ServerError(`File exceeds maximum size of ${maxBytes / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  // Floor before the sniff, because the per-format signatures are short (a JPEG is
  // 3 bytes, a GIF header 6) and would happily "detect" a truncated payload — which
  // then saves as a success and hands a consumer a path to an unreadable file. 12
  // bytes is the widest signature (WebP's RIFF….WEBP), so anything under it cannot
  // be a complete header for ANY supported format, let alone a complete image.
  if (buffer.length < MIN_IMAGE_BYTES) {
    throw new ServerError('Invalid image file - only PNG, JPEG, GIF, and WebP are supported', { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  const detected = detectImageFormat(buffer);
  if (!detected) {
    throw new ServerError('Invalid image file - only PNG, JPEG, GIF, and WebP are supported', { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  // The DETECTED extension always wins over whatever the client claimed, so the
  // file on disk can't advertise a type its bytes contradict. Strip a matching
  // extension off the base rather than appending a second one, then clamp the base
  // so `base + ext` fits NAME_MAX — a caller that prefixes the name (see
  // services/shellImageDrop.js) can otherwise push a legitimately-long client
  // filename past the limit and turn the write into an ENAMETOOLONG 500.
  const safeName = sanitizeFilename(filename);
  const base = safeName.toLowerCase().endsWith(detected.ext)
    ? safeName.slice(0, -detected.ext.length)
    : safeName;
  // sanitizeFilename leaves only ASCII, so slicing chars is slicing bytes.
  const fname = `${base.slice(0, MAX_FILENAME_BYTES - detected.ext.length)}${detected.ext}`;
  const filePath = join(dir, fname);
  if (!isPathInsideDir(dir, filePath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await ensureDir(dir);
  await writeFile(filePath, buffer);

  return { filename: fname, filePath, size: buffer.length, format: detected.format, mime: detected.mime };
}

/**
 * Persist a base64-encoded upload into `dir` with the shared attachment
 * pipeline: extension allowlist → base64 decode → size cap → ensureDir →
 * `<uuid8>-<sanitized-name>` naming → containment guard → write.
 *
 * Throws ServerError with the exact status/code/message contract the
 * attachment routes established (`INVALID_FILE_TYPE`, `FILE_TOO_LARGE`,
 * `INVALID_FILENAME` — all 400), so refactored routes keep their pinned
 * responses. Consolidates `routes/attachments.js`, `routes/brainSongbook.js`,
 * and `routes/uploads.js` — the last keeps its own richer response shape
 * (`originalName` / `sizeFormatted` / `createdAt`) around these fields.
 *
 * @param {string} dir - Destination directory (created if missing).
 * @param {{ filename: string, data: string }} upload - Original filename +
 *   base64 payload (validated as present by the calling route).
 * @param {{ allowedExtensions: Set<string>, maxBytes: number }} opts
 * @returns {Promise<{ id: string, filename: string, filePath: string,
 *   buffer: Buffer, size: number, mime: string }>} `id` is the full UUID whose
 *   first 8 chars prefix `filename`.
 */
export async function saveBase64Upload(dir, { filename, data }, { allowedExtensions, maxBytes }) {
  const ext = getFileExtension(filename);
  if (!ext || !allowedExtensions.has(ext)) {
    const allowedList = [...allowedExtensions].join(', ');
    throw new ServerError(`File type not allowed. Supported: ${allowedList}`, { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > maxBytes) {
    throw new ServerError(`File exceeds maximum size of ${maxBytes / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  await ensureDir(dir);

  // Unique uuid prefix avoids collisions; sanitize kills traversal characters.
  const id = randomUUID();
  const fname = `${id.slice(0, 8)}-${sanitizeFilename(filename)}`;
  const filePath = join(dir, fname);
  // Double-check the path is within the destination dir (defense in depth).
  if (!isPathInsideDir(dir, filePath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFile(filePath, buffer);

  return { id, filename: fname, filePath, buffer, size: buffer.length, mime: getMimeType(getFileExtension(fname)) };
}

/**
 * Serve a machine-local file from `dir` by user-supplied filename with the
 * shared safety pipeline: sanitize → containment guard (400
 * `INVALID_FILENAME`) → existence check (404, message/code parametrized via
 * `missingError` so routes keep their contracts) → `X-Content-Type-Options:
 * nosniff` → attachment disposition for RISKY_MIME_TYPES → `res.sendFile`.
 *
 * Mirrors the exact serving behavior of `routes/attachments.js`.
 *
 * @param {import('express').Response} res
 * @param {string} dir - The containing directory.
 * @param {string} filename - Raw user-supplied filename.
 * @param {{ missingError?: { message: string, code: string } }} [opts]
 */
export async function serveLocalFile(res, dir, filename, { missingError } = {}) {
  const safeFilename = sanitizeFilename(filename);
  const filePath = resolvePath(dir, safeFilename);

  if (!isPathInsideDir(dir, filePath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!(await pathExists(filePath))) {
    const { message = 'Attachment not found', code = 'NOT_FOUND' } = missingError || {};
    throw new ServerError(message, { status: 404, code });
  }

  const mimeType = getMimeType(getFileExtension(safeFilename));
  res.set('X-Content-Type-Options', 'nosniff');
  if (RISKY_MIME_TYPES.has(mimeType)) {
    res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
  }
  res.type(mimeType).sendFile(filePath);
}
