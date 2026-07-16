/**
 * Brain SongBook Routes
 *
 * Repertoire tracker (guitar tabs / chord sheets / sheet music) stored as the
 * Brain entity type `songs` — all writes go through brainStorage's generic API
 * so records ride the sync-log / LWW / tombstone federation pipeline.
 *
 * Mounted from the brain barrel at /songbook → /api/brain/songbook/...
 *
 * Attachments: METADATA lives in the synced record (identical on all peers);
 * BYTES are machine-local under data/brain/songbook/ (<uuid8>-<sanitized-name>).
 * The list endpoint reports `present: boolean` per attachment so peers lacking
 * the file can render "not on this machine".
 */

import { Router } from 'express';
import { writeFile, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import {
  songInputSchema,
  songStagePatchSchema,
  songImportUrlSchema,
  songAttachmentUploadSchema,
} from '../lib/brainValidation.js';
import * as brainStorage from '../services/brainStorage.js';
import { importSongFromUrl } from '../services/brainSongbookImport.js';
import {
  ensureDir, pathExists, PATHS, RISKY_MIME_TYPES,
  sanitizeFilename, getFileExtension, getMimeType, ATTACHMENT_ALLOWED_EXTENSIONS, isPathInsideDir,
} from '../lib/fileUtils.js';

const router = Router();

// Max attachment size: 50MB (matches routes/attachments.js — sheet-music PDFs)
const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

// The shared attachment allowlist plus MIDI — sheet music commonly ships as
// .mid/.midi, which the CoS attachment set deliberately excludes.
const SONG_ATTACHMENT_EXTENSIONS = new Set([...ATTACHMENT_ALLOWED_EXTENSIONS, '.mid', '.midi']);

// Read lazily (not captured at module load) so test PATHS mocks with
// per-suite temp roots resolve correctly.
const songbookDir = () => PATHS.brainSongbook;

const isAllowedExtension = (filename) => {
  const ext = getFileExtension(filename);
  return !!ext && SONG_ATTACHMENT_EXTENSIONS.has(ext);
};

async function getSongOr404(id) {
  const song = await brainStorage.getById('songs', id);
  if (!song) {
    throw new ServerError('Song not found', { status: 404, code: 'NOT_FOUND' });
  }
  return song;
}

// Locate an attachment's meta on a song + its vetted local filepath. Throws
// 400 on a traversal-shaped filename and 404 when the meta isn't on the record.
function resolveAttachment(song, rawFilename) {
  const safeFilename = sanitizeFilename(rawFilename);
  const filepath = resolve(songbookDir(), safeFilename);
  if (!isPathInsideDir(songbookDir(), filepath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }
  const meta = (Array.isArray(song.attachments) ? song.attachments : [])
    .find((a) => a.filename === safeFilename);
  if (!meta) {
    throw new ServerError('Attachment not found', { status: 404, code: 'NOT_FOUND' });
  }
  return { meta, safeFilename, filepath };
}

// =============================================================================
// IMPORT (before /:id routes so 'import' is never treated as an id)
// =============================================================================

// POST /import/url — fetch + extract a draft; nothing is stored.
router.post('/import/url', asyncHandler(async (req, res) => {
  const { url } = validateRequest(songImportUrlSchema, req.body);
  const draft = await importSongFromUrl(url);
  res.json({ draft });
}));

// =============================================================================
// SONG CRUD
// =============================================================================

router.get('/', asyncHandler(async (req, res) => {
  const songs = await brainStorage.getAll('songs');
  res.json({ songs });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  res.json(song);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(songInputSchema, req.body);
  // `attachments` is server-managed — always born empty, mutated only by the
  // attachment endpoints below.
  const song = await brainStorage.create('songs', { ...data, attachments: [] });
  res.status(201).json(song);
}));

router.put('/:id', asyncHandler(async (req, res) => {
  // partialWithoutDefaults (not .partial()) so an omitted field is genuinely
  // absent instead of resetting to its default (see zodCompat.js). The schema
  // has no `attachments` key, so Zod's unknown-key stripping drops any
  // client-supplied attachments — the record's server-managed list survives.
  const data = validateRequest(partialWithoutDefaults(songInputSchema), req.body);
  const song = await brainStorage.update('songs', req.params.id, data);
  if (!song) {
    throw new ServerError('Song not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(song);
}));

router.patch('/:id/stage', asyncHandler(async (req, res) => {
  const { stage } = validateRequest(songStagePatchSchema, req.body);
  const song = await brainStorage.update('songs', req.params.id, { stage });
  if (!song) {
    throw new ServerError('Song not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(song);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  // Tombstone delete (brainStorage.remove) so the deletion federates. Local
  // attachment bytes are left in place — peers may still hold the meta, and
  // orphaned bytes are harmless machine-local files.
  const deleted = await brainStorage.remove('songs', req.params.id);
  if (!deleted) {
    throw new ServerError('Song not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ id: req.params.id });
}));

// =============================================================================
// ATTACHMENTS
// =============================================================================

// POST /:id/attachments — base64 upload; writes bytes + appends meta to record
router.post('/:id/attachments', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  const { filename, data, label } = validateRequest(songAttachmentUploadSchema, req.body);

  if (!isAllowedExtension(filename)) {
    const allowedList = [...SONG_ATTACHMENT_EXTENSIONS].join(', ');
    throw new ServerError(`File type not allowed. Supported: ${allowedList}`, { status: 400, code: 'INVALID_FILE_TYPE' });
  }

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length > MAX_ATTACHMENT_SIZE) {
    throw new ServerError(`File exceeds maximum size of ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB`, { status: 400, code: 'FILE_TOO_LARGE' });
  }

  await ensureDir(songbookDir());

  // Unique uuid prefix avoids collisions; sanitize kills traversal characters.
  const fname = `${uuidv4().slice(0, 8)}-${sanitizeFilename(filename)}`;
  const filepath = join(songbookDir(), fname);
  if (!isPathInsideDir(songbookDir(), filepath)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }

  await writeFile(filepath, buffer);

  const attachment = {
    filename: fname,
    label,
    mime: getMimeType(getFileExtension(fname)),
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
  await brainStorage.update('songs', song.id, {
    attachments: [...(Array.isArray(song.attachments) ? song.attachments : []), attachment],
  });

  console.log(`🎸 Song attachment saved: ${fname} (${buffer.length} bytes)`);
  res.status(201).json({ attachment });
}));

// GET /:id/attachments — synced meta + machine-local presence
router.get('/:id/attachments', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  const metas = Array.isArray(song.attachments) ? song.attachments : [];
  const attachments = await Promise.all(metas.map(async (meta) => ({
    ...meta,
    present: await pathExists(join(songbookDir(), meta.filename)),
  })));
  res.json(attachments);
}));

// GET /:id/attachments/:filename — serve the local bytes
router.get('/:id/attachments/:filename', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  const { safeFilename, filepath } = resolveAttachment(song, req.params.filename);

  if (!(await pathExists(filepath))) {
    // Meta is synced but the bytes never landed on this machine.
    throw new ServerError('Attachment file is not on this machine', { status: 404, code: 'NOT_ON_THIS_MACHINE' });
  }

  const mimeType = getMimeType(getFileExtension(safeFilename));
  res.set('X-Content-Type-Options', 'nosniff');
  if (RISKY_MIME_TYPES.has(mimeType)) {
    res.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
  }
  res.type(mimeType).sendFile(filepath);
}));

// DELETE /:id/attachments/:filename — remove meta from record + local bytes
router.delete('/:id/attachments/:filename', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  const { safeFilename, filepath } = resolveAttachment(song, req.params.filename);

  const updated = await brainStorage.update('songs', song.id, {
    attachments: song.attachments.filter((a) => a.filename !== safeFilename),
  });

  // Bytes may legitimately be absent on this machine (meta synced from a peer).
  if (await pathExists(filepath)) {
    await unlink(filepath);
  }

  console.log(`🗑️ Song attachment deleted: ${safeFilename}`);
  res.json({ success: true, filename: safeFilename, attachments: updated.attachments });
}));

export default router;
