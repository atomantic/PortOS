/**
 * Sprites Routes — REST surface for the Sprite Manager (issue #2895, phase 1).
 *
 * Phase 1 is the read-only library + importer: list/get sprite records (with
 * their on-disk asset listing), import approved production assets from a
 * source pipeline tree, and patch the few user-managed record fields. The
 * generation workflow (reference/anchors/animation/publish) lands in later
 * phases.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  spriteImportRequestSchema,
  spriteRecordUpdateSchema,
} from '../lib/validation.js';
import { listRecords, getRecord, updateRecord, deleteRecord } from '../services/sprites/records.js';
import { listSpriteAssets } from '../services/sprites/paths.js';
import { importFromSource } from '../services/sprites/importer.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listRecords());
}));

// Import approved production assets from a source tree. A direct user action
// (never boot-triggered) per the AI Provider / cold-start policy — though this
// endpoint itself makes no AI calls, only file copies.
router.post('/import', asyncHandler(async (req, res) => {
  const input = validateRequest(spriteImportRequestSchema, req.body);
  res.json(await importFromSource(input));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const record = await getRecord(req.params.id);
  if (!record) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
  const assets = await listSpriteAssets(record.id);
  res.json({ record, assets });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(spriteRecordUpdateSchema, req.body);
  res.json(await updateRecord(req.params.id, patch));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteRecord(req.params.id));
}));

export default router;
