/**
 * Sprites Routes — REST surface for the Sprite Manager.
 *
 * Phase 1 (#2895): library list/get, source-tree importer, record patch.
 * Phase 2 (#2896): character create + the reference workflow — generate
 * main/anchor candidates through the shared image-gen queue, review, then
 * lock (normalize + dynamic chroma-key selection). Generation is strictly
 * user-triggered per the AI-provider policy; locked artifacts are immutable
 * (409 on regenerate/relock).
 */

import { Router } from 'express';
import { unlink } from 'fs/promises';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  spriteImportRequestSchema,
  spriteRecordUpdateSchema,
  spriteCreateSchema,
  spriteReferenceGenerateSchema,
  spriteReferenceLockSchema,
} from '../lib/validation.js';
import { optionalUploadFields } from '../lib/multipart.js';
import {
  listRecords, getRecordWithAssets, createCharacter, updateRecord, deleteRecord,
} from '../services/sprites/records.js';
import { importFromSource } from '../services/sprites/importer.js';
import { getReferenceSet, startReferenceGeneration, lockReference } from '../services/sprites/reference.js';

const router = Router();

const MAX_REFERENCE_UPLOAD_BYTES = 20 * 1024 * 1024;
const ACCEPTED_REFERENCE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

const referenceUpload = optionalUploadFields(['referenceImage'], {
  limits: { fileSize: MAX_REFERENCE_UPLOAD_BYTES },
  // multer-style (req, file, cb) — streamMultipart requires the callback to
  // be invoked synchronously (see routes/imageGen.js for the sibling).
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_REFERENCE_MIME.has((file.mimetype || '').toLowerCase())),
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listRecords());
}));

// Create a character record — the entry point of the reference workflow.
// Id derivation and the kind live in the service (createCharacter).
router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(spriteCreateSchema, req.body);
  res.status(201).json(await createCharacter(input));
}));

// Import approved production assets from a source tree. A direct user action
// (never boot-triggered) per the AI Provider / cold-start policy — though this
// endpoint itself makes no AI calls, only file copies.
router.post('/import', asyncHandler(async (req, res) => {
  const input = validateRequest(spriteImportRequestSchema, req.body);
  res.json(await importFromSource(input));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await getRecordWithAssets(req.params.id);
  if (!detail) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
  const reference = detail.record.kind === 'character' ? await getReferenceSet(req.params.id) : null;
  res.json({ ...detail, reference });
}));

// Queue one reference candidate render (main or a directional anchor).
// Accepts JSON, or multipart with an optional `referenceImage` file for the
// main target (an uploaded visual design reference → i2i).
router.post('/:id/reference/generate', referenceUpload, asyncHandler(async (req, res) => {
  // Capture + register the temp-file sweep BEFORE validation — a 400 thrown
  // by validateRequest would otherwise leak the already-finalized upload.
  // The service moves the file on success, so the unlink is a harmless
  // ENOENT there.
  const file = req.files?.referenceImage;
  const upload = file ? { tempPath: file.path, originalname: file.originalname } : null;
  if (upload) res.on('close', () => { unlink(upload.tempPath).catch(() => {}); });
  const body = validateRequest(spriteReferenceGenerateSchema, req.body ?? {});
  if (upload && body.target !== 'main') {
    throw new ServerError('Reference image uploads apply to the main target only — anchors always derive from the locked main', { status: 400, code: 'UPLOAD_MAIN_ONLY' });
  }
  res.json(await startReferenceGeneration(req.params.id, body, upload));
}));

// Lock a reviewed candidate: normalize onto the canonical key-color square
// and freeze it in the reference-set manifest. 409 when already locked.
router.post('/:id/reference/lock', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteReferenceLockSchema, req.body);
  res.json(await lockReference(req.params.id, body));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(spriteRecordUpdateSchema, req.body);
  // Once the main reference is locked the manifest key is frozen with the
  // artifacts — a record-level repin would only make the record/UI disagree
  // with the immutable set.
  if ('chromaKey' in patch) {
    const reference = await getReferenceSet(req.params.id);
    if (reference.manifest?.mainReference?.locked) {
      throw new ServerError('Chroma key is frozen with the locked reference set', { status: 409, code: 'CHROMA_KEY_LOCKED' });
    }
  }
  res.json(await updateRecord(req.params.id, patch));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteRecord(req.params.id));
}));

export default router;
