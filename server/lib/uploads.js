/**
 * Upload staging/import, base64/image persistence, and safe local-file serving.
 *
 * `assertFileNotMediaManifest(path)` refuses a media upload whose bytes are a playlist or manifest before ffmpeg can probe it (the base64 and multipart import helpers apply the same check).
 */
import { open, stat, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, resolve as resolvePath } from 'path';
import { MIRRORED_MIME_TYPES } from './beeperAttachmentPaths.js';
import { ServerError } from './errorHandler.js';
import { copyFileGuarded, ensureDir, pathExists, renameGuarded, unlinkGuarded, writeFileGuarded } from './fileCore.js';
import {
  detectImageFormat, detectMediaManifest, getFileExtension, getMimeType, id3v2TagLength,
  MEDIA_MANIFEST_PROBE_BYTES, RISKY_MIME_TYPES, sanitizeFilename,
} from './mimeTypes.js';
import { PATHS } from './paths.js';
import { isPathInsideDir } from './pathSafety.js';

// Uploads under these types may later be probed, thumbnailed or rendered by ffmpeg.
const isFfmpegInputExtension = (ext) => /^(audio|video|image)\//.test(getMimeType(ext));

/**
 * Refuse bytes ffmpeg would open as a playlist or manifest naming other files
 * (see `detectMediaManifest`). Apply before persisting any upload a probe,
 * thumbnail or render may later read.
 */
function assertNotMediaManifest(buffer) {
  const format = detectMediaManifest(buffer);
  if (format) {
    throw new ServerError(`File content is a ${format} playlist or manifest that references other files; upload the media itself`, { status: 400, code: 'INVALID_FILE_TYPE' });
  }
}

/**
 * `assertNotMediaManifest` over a file on disk: its leading window, plus a
 * full window after an ID3v2 tag. A tag ending inside a full leading window
 * leaves only a fragment of the following manifest in it, so the post-tag
 * window is read whenever the leading read filled its buffer.
 */
export async function assertFileNotMediaManifest(path) {
  const handle = await open(path, 'r');
  const readWindow = async (position) => {
    const window = Buffer.alloc(MEDIA_MANIFEST_PROBE_BYTES);
    const { bytesRead } = await handle.read(window, 0, window.length, position);
    return window.subarray(0, bytesRead);
  };
  const windows = await (async () => {
    const head = await readWindow(0);
    const tagLength = id3v2TagLength(head);
    return tagLength > 0 && head.length === MEDIA_MANIFEST_PROBE_BYTES ? [head, await readWindow(tagLength)] : [head];
  })().finally(() => handle.close());
  for (const window of windows) assertNotMediaManifest(window);
}

/**
 * Move a temp file into `destDir` and return `{ filename, sizeBytes }`, using the `/api/uploads` naming (`<uuid8>-<sanitized-name>`) so a server-produced file is served like a user upload.
 * copyFile + unlink, not rename: `os.tmpdir()` may be on another filesystem (EXDEV); the temp unlink is best-effort. With `extensions`, the persisted name must use one of them
 * (the extension determines Content-Type under a static mount, so it never comes from a client filename).
 */
export async function importFileToDir(tempPath, originalName, destDir, { extensions } = {}) {
  const extension = getFileExtension(originalName);
  if (extensions && !extensions.map((item) => item.toLowerCase()).includes(extension)) {
    throw new ServerError('Invalid file type', { status: 400, code: 'INVALID_FILE_TYPE' });
  }
  if (extension && isFfmpegInputExtension(extension)) await assertFileNotMediaManifest(tempPath);
  await ensureDir(destDir);
  const id = randomUUID();
  const filename = `${id.slice(0, 8)}-${sanitizeFilename(originalName)}`;
  const dest = join(destDir, filename);
  await copyFileGuarded(tempPath, dest);
  await unlink(tempPath).catch(() => {});
  const s = await stat(dest).catch(() => null);
  return { id, filename, sizeBytes: s?.size ?? 0 };
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
 * Persist a base64-encoded IMAGE into `dir`, deriving the format from the bytes, not the client: decode → size cap → magic-byte sniff → force the detected extension → sanitize + containment guard → write.
 * Sibling of `saveBase64Upload` for paths that must be certain they wrote an image (they hand it to an image-gen backend or agent). Naming is the CALLER's call: pass a unique name if later uploads must not
 * overwrite (`dir` is a shared bucket). Bytes are staged in a short-named sibling and renamed into place so a failed write (ENOSPC, …) never truncates an existing image; `stagePrefix` keeps an owner's
 * recovery prefix on the stage name (the Persistent Mind sweeps `mind-<attachmentId>-*`).
 * Throws ServerError with the `routes/screenshots.js` contract (`FILE_TOO_LARGE`, `INVALID_FILE_TYPE`, `INVALID_FILENAME`, all 400).
 *
 * @param {string} dir - Destination directory (created if missing).
 * @param {{ filename: string, data: string }} upload - Desired base name (extension replaced with the detected one) + base64 payload.
 * @param {{ maxBytes: number, stagePrefix?: string }} opts
 * @returns {Promise<{ filename: string, filePath: string, size: number,
 *   format: string, mime: string }>}
 */
export async function saveImageUpload(dir, { filename, data }, { maxBytes, stagePrefix = '' }) {
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > maxBytes) {
    throw new ServerError(`File exceeds maximum size of ${maxBytes / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  // Floor before the sniff: per-format signatures are short (JPEG 3 bytes, GIF 6) and would "detect" a truncated payload and save it as a success. 12 bytes is the widest (WebP's RIFF….WEBP).
  if (buffer.length < MIN_IMAGE_BYTES) {
    throw new ServerError('Invalid image file - only PNG, JPEG, GIF, and WebP are supported', { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  const detected = detectImageFormat(buffer);
  if (!detected) {
    throw new ServerError('Invalid image file - only PNG, JPEG, GIF, and WebP are supported', { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  // The DETECTED extension always wins so the file can't advertise a type its bytes contradict. Strip a matching extension off the base, then clamp it so `base + ext` fits NAME_MAX
  // (a caller prefixing the name, see services/shellImageDrop.js, could otherwise push a long client filename into ENAMETOOLONG).
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
  // Stage + rename rather than atomicWrite: its `.<pid>.<ts>.<uuid>.tmp` suffix would push the temp file past NAME_MAX (#6176); the stage name is short and fixed-size, and both paths are in `dir` so rename is atomic.
  const stagePath = join(dir, `${stagePrefix}.stage-${randomUUID().slice(0, 8)}${detected.ext}`);
  if (!isPathInsideDir(dir, stagePath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }
  const published = await writeFileGuarded(stagePath, buffer)
    .then(() => renameGuarded(stagePath, filePath))
    .then(() => null, (error) => error);
  if (published) {
    // Best-effort: a stage that survives keeps its owner prefix for sweeps.
    await unlinkGuarded(stagePath).catch(() => {});
    throw published;
  }

  return { filename: fname, filePath, size: buffer.length, format: detected.format, mime: detected.mime };
}

/**
 * Persist a base64-encoded upload into `dir` via the shared attachment pipeline: extension allowlist → decode → size cap → ensureDir → `<uuid8>-<sanitized-name>` naming → containment guard → write.
 * Throws ServerError with the attachment routes' contract (`INVALID_FILE_TYPE`, `FILE_TOO_LARGE`, `INVALID_FILENAME`, all 400); `routes/uploads.js` keeps its own richer response shape around these fields.
 *
 * @param {string} dir - Destination directory (created if missing).
 * @param {{ filename: string, data: string }} upload - Original filename + base64 payload.
 * @param {{ allowedExtensions: Set<string>, maxBytes: number }} opts
 * @returns {Promise<{ id: string, filename: string, filePath: string,
 *   buffer: Buffer, size: number, mime: string }>} `id` is the full UUID whose first 8 chars prefix `filename`.
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
  if (isFfmpegInputExtension(ext)) assertNotMediaManifest(buffer);

  await ensureDir(dir);

  // Unique uuid prefix avoids collisions; sanitize kills traversal characters.
  const id = randomUUID();
  const fname = `${id.slice(0, 8)}-${sanitizeFilename(filename)}`;
  const filePath = join(dir, fname);
  // Double-check the path is within the destination dir (defense in depth).
  if (!isPathInsideDir(dir, filePath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFileGuarded(filePath, buffer);

  return { id, filename: fname, filePath, buffer, size: buffer.length, mime: getMimeType(getFileExtension(fname)) };
}

/** A declared media type reduced to a bare `type/subtype`: parameters dropped, whitespace trimmed on BOTH sides of the split, case folded; `''` for anything not a non-empty string. */
function normalizeDeclaredMimeType(value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
}

/**
 * Serve a machine-local file from `dir` by user-supplied filename (mirrors `routes/attachments.js`): sanitize → containment guard (400 `INVALID_FILENAME`) → existence check (404, message/code via `missingError`)
 * → `X-Content-Type-Options: nosniff` → attachment disposition for RISKY_MIME_TYPES → `res.sendFile`.
 *
 * `contentType` overrides the extension-derived type for a store whose filenames carry no meaning (the Beeper attachment mirror, #37: content-addressed `<sha256>.<ext>`, source sends no `Content-Type`).
 * That type is written by a REMOTE SENDER on the authenticated dashboard origin, so it is normalized (parameters dropped, trimmed, lowercased: `RISKY_MIME_TYPES` is lowercase and `text/HTML`
 * once executed inline) then bounded (only `MIRRORED_MIME_TYPES` is echoed; else `application/octet-stream`). The disposition decision uses the declared type too, so downgrading `text/html` keeps its attachment header.
 *
 * @param {import('express').Response} res
 * @param {string} dir - The containing directory.
 * @param {string} filename - Raw user-supplied filename.
 * @param {{ missingError?: { message: string, code: string }, contentType?: string }} [opts]
 */
export async function serveLocalFile(res, dir, filename, { missingError, contentType } = {}) {
  const safeFilename = sanitizeFilename(filename);
  const filePath = resolvePath(dir, safeFilename);

  if (!isPathInsideDir(dir, filePath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  if (!(await pathExists(filePath))) {
    const { message = 'Attachment not found', code = 'NOT_FOUND' } = missingError || {};
    throw new ServerError(message, { status: 404, code });
  }

  const declared = normalizeDeclaredMimeType(contentType);
  const mimeType = declared
    ? (MIRRORED_MIME_TYPES.has(declared) ? declared : 'application/octet-stream')
    : getMimeType(getFileExtension(safeFilename));
  res.set('X-Content-Type-Options', 'nosniff');
  if (RISKY_MIME_TYPES.has(mimeType) || RISKY_MIME_TYPES.has(declared)) {
    res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
  }
  res.type(mimeType).sendFile(filePath);
}
