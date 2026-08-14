/**
 * Brain SongBook Routes
 *
 * Repertoire tracker (guitar tabs / chord sheets / sheet music) stored as the
 * Brain entity type `songs` — all writes go through brainStorage's generic API
 * so records ride the sync-log / LWW / tombstone federation pipeline.
 *
 * Mounted from the brain barrel at /songbook → /api/brain/songbook/...
 *
 * Practice: `POST /:id/practice` logs a graded run and moves the song's SM-2
 * schedule (`practice`) plus its learning `stage`. Both `practice` and
 * `attachments` are server-managed — the write schemas have no key for them, so
 * Zod's unknown-key stripping drops a client-supplied value.
 *
 * Attachments: METADATA lives in the synced record (identical on all peers);
 * BYTES are machine-local under data/brain/songbook/ (<uuid8>-<sanitized-name>).
 * The list endpoint reports `present: boolean` per attachment so peers lacking
 * the file can render "not on this machine".
 */

import { Router } from 'express';
import { unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  songInputSchema,
  songUpdateSchema,
  songImportUrlSchema,
  songPracticeInputSchema,
  songAttachmentUploadSchema,
} from '../lib/brainValidation.js';
import { applySongPractice } from '../lib/songPractice.js';
import * as brainStorage from '../services/brainStorage.js';
import { importSongFromUrl } from '../services/brainSongbookImport.js';
import { MAX_BASE64_UPLOAD_BYTES } from '../lib/uploadLimits.js';
import {
  pathExists, PATHS, sanitizeFilename, isPathInsideDir,
  SONGBOOK_ATTACHMENT_EXTENSIONS, saveBase64Upload, serveLocalFile,
} from '../lib/fileUtils.js';

const router = Router();

// Bounded by the JSON body limit, not by any songbook-specific rule — see
// lib/uploadLimits.js.
const MAX_ATTACHMENT_SIZE = MAX_BASE64_UPLOAD_BYTES;

// Read lazily (not captured at module load) so test PATHS mocks with
// per-suite temp roots resolve correctly.
const songbookDir = () => PATHS.brainSongbook;

// 404 unless the storage layer returned a record (or a truthy delete result).
function requireSong(song) {
  if (!song) {
    throw new ServerError('Song not found', { status: 404, code: 'NOT_FOUND' });
  }
  return song;
}

async function getSongOr404(id) {
  return requireSong(await brainStorage.getById('songs', id));
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
  // Index projection: the list view needs metadata only, and content.text can
  // be 200k chars per song — a large repertoire would ship megabytes nobody
  // reads. The full record (with text) comes from GET /:id.
  const songs = (await brainStorage.getAll('songs')).map(({ content, ...rest }) => ({
    ...rest,
    content: { format: content?.format || 'tab' },
  }));
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

router.patch('/:id', asyncHandler(async (req, res) => {
  // songUpdateSchema is defaults-free down to the nested `content` object, so
  // an omitted field (or omitted content.format/text) is genuinely absent
  // instead of resetting to its default (see brainValidation.js / zodCompat.js).
  // The schema has no `attachments` key, so Zod's unknown-key stripping drops
  // any client-supplied attachments — the record's server-managed list survives.
  // A partial `content` deep-merges over the stored song's content inside the
  // store write lock (updateWith), so `{ content: { text } }` keeps the stored
  // format and `{ content: { format } }` keeps the stored text.
  const data = validateRequest(songUpdateSchema, req.body);
  const song = requireSong(await brainStorage.updateWith('songs', req.params.id, (fresh) => (
    data.content ? { ...data, content: { ...fresh.content, ...data.content } } : data
  )));
  res.json(song);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  // Tombstone delete (brainStorage.remove) so the deletion federates. Local
  // attachment bytes are left in place — peers may still hold the meta, and
  // orphaned bytes are harmless machine-local files.
  requireSong(await brainStorage.remove('songs', req.params.id));
  res.json({ id: req.params.id });
}));

// =============================================================================
// PRACTICE (spaced repetition)
// =============================================================================

// POST /:id/practice — log one practice run, graded 0..5. Advances the song's
// SM-2 schedule and its learning stage (see lib/songPractice.js).
//
// This earns its own endpoint rather than riding the generic PATCH because an
// SM-2 advance is computed FROM the stored schedule: the work happens inside
// `updateWith`'s locked read-modify-write, against the freshest record, so a
// concurrent edit or a peer-sync apply can't be clobbered — and the scheduler
// stays on the server instead of in the browser.
router.post('/:id/practice', asyncHandler(async (req, res) => {
  const { quality } = validateRequest(songPracticeInputSchema, req.body);
  const song = requireSong(await brainStorage.updateWith('songs', req.params.id,
    (fresh) => applySongPractice(fresh, quality)));
  console.log(`🎸 Practice logged: "${song.title}" quality=${quality} → ${song.stage}, next review in ${song.practice.intervalDays}d`);
  res.json(song);
}));

// =============================================================================
// ATTACHMENTS
// =============================================================================

// POST /:id/attachments — base64 upload; writes bytes + appends meta to record
router.post('/:id/attachments', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  const { filename, data, label } = validateRequest(songAttachmentUploadSchema, req.body);

  const saved = await saveBase64Upload(songbookDir(), { filename, data }, {
    allowedExtensions: SONGBOOK_ATTACHMENT_EXTENSIONS,
    maxBytes: MAX_ATTACHMENT_SIZE,
  });

  const attachment = {
    filename: saved.filename,
    label,
    mime: saved.mime,
    size: saved.size,
    sha256: createHash('sha256').update(saved.buffer).digest('hex'),
  };
  // Append against the FRESH record inside the store write lock (updateWith) —
  // a concurrent upload/delete or a peer-sync apply landing between the read
  // above and this write would otherwise be clobbered (and win LWW). requireSong
  // 404s the mid-request tombstone race instead of 201-ing meta never persisted.
  requireSong(await brainStorage.updateWith('songs', song.id, (fresh) => ({
    attachments: [...(Array.isArray(fresh.attachments) ? fresh.attachments : []), attachment],
  })));

  console.log(`🎸 Song attachment saved: ${saved.filename} (${saved.size} bytes)`);
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

// GET /:id/attachments/:filename — serve the local bytes. resolveAttachment
// runs first so a filename not on the record 404s even when a file exists;
// the shared server then handles the meta-synced-but-bytes-absent case.
router.get('/:id/attachments/:filename', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  resolveAttachment(song, req.params.filename);
  await serveLocalFile(res, songbookDir(), req.params.filename, {
    missingError: { message: 'Attachment file is not on this machine', code: 'NOT_ON_THIS_MACHINE' },
  });
}));

// DELETE /:id/attachments/:filename — remove meta from record + local bytes
router.delete('/:id/attachments/:filename', asyncHandler(async (req, res) => {
  const song = await getSongOr404(req.params.id);
  const { safeFilename, filepath } = resolveAttachment(song, req.params.filename);

  // Filter against the FRESH record inside the store write lock (updateWith) so
  // a concurrent upload/peer-sync apply isn't clobbered; requireSong 404s the
  // mid-request tombstone race instead of TypeError-ing on a null record.
  const updated = requireSong(await brainStorage.updateWith('songs', song.id, (fresh) => ({
    attachments: (Array.isArray(fresh.attachments) ? fresh.attachments : [])
      .filter((a) => a.filename !== safeFilename),
  })));

  // Bytes may legitimately be absent on this machine (meta synced from a peer).
  if (await pathExists(filepath)) {
    await unlink(filepath);
  }

  console.log(`🗑️ Song attachment deleted: ${safeFilename}`);
  res.json({ success: true, filename: safeFilename, attachments: updated.attachments });
}));

export default router;
