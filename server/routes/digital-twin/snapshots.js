/**
 * Time capsule snapshots — list, create, fetch, delete, and compare snapshots
 * of the digital twin over time.
 */

import { Router } from 'express';
import * as timeCapsuleService from '../../services/timeCapsule.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  createSnapshotInputSchema,
  compareSnapshotsInputSchema,
} from '../../lib/digitalTwinValidation.js';
import { UUID_RE } from '../../lib/fileUtils.js';

const router = Router();

/**
 * GET /api/digital-twin/snapshots
 * List all time capsule snapshots (metadata only)
 */
router.get('/snapshots', asyncHandler(async (req, res) => {
  const snapshots = await timeCapsuleService.listSnapshots();
  res.json(snapshots);
}));

/**
 * POST /api/digital-twin/snapshots
 * Create a new time capsule snapshot
 */
router.post('/snapshots', asyncHandler(async (req, res) => {
  const data = validateRequest(createSnapshotInputSchema, req.body);
  const snapshot = await timeCapsuleService.createSnapshot(data.label, data.description);
  res.status(201).json(snapshot);
}));

/**
 * GET /api/digital-twin/snapshots/:id
 * Get a snapshot with full data
 */
router.get('/snapshots/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid snapshot ID', { status: 400 });
  }
  const snapshot = await timeCapsuleService.getSnapshot(id);
  if (!snapshot) {
    throw new ServerError('Snapshot not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(snapshot);
}));

/**
 * DELETE /api/digital-twin/snapshots/:id
 * Delete a snapshot
 */
router.delete('/snapshots/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    throw new ServerError('Invalid snapshot ID', { status: 400 });
  }
  const deleted = await timeCapsuleService.deleteSnapshot(id);
  if (!deleted) {
    throw new ServerError('Snapshot not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true });
}));

/**
 * POST /api/digital-twin/snapshots/compare
 * Compare two snapshots
 */
router.post('/snapshots/compare', asyncHandler(async (req, res) => {
  const data = validateRequest(compareSnapshotsInputSchema, req.body);
  const diff = await timeCapsuleService.compareSnapshots(data.id1, data.id2);
  if (!diff) {
    throw new ServerError('One or both snapshots not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(diff);
}));

export default router;
