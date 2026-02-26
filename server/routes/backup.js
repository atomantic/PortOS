import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, restoreRequestSchema } from '../lib/validation.js';
import * as backup from '../services/backup.js';
import { getSettings } from '../services/settings.js';

const router = Router();

// GET /api/backup/status
router.get('/status', asyncHandler(async (req, res) => {
  const state = await backup.getState();
  const settings = await getSettings();
  const nextRun = backup.getNextRunTime();
  res.json({ ...state, destPath: settings.backup?.destPath ?? null, nextRun });
}));

// POST /api/backup/run
router.post('/run', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const io = req.app.get('io');
  const result = await backup.runBackup(settings.backup?.destPath, io);
  res.json(result);
}));

// GET /api/backup/snapshots
router.get('/snapshots', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const snapshots = await backup.listSnapshots(settings.backup?.destPath);
  res.json(snapshots);
}));

// POST /api/backup/restore
router.post('/restore', asyncHandler(async (req, res) => {
  const { snapshotId, subdirFilter, dryRun } = validateRequest(restoreRequestSchema, req.body);
  const settings = await getSettings();
  const result = await backup.restoreSnapshot(settings.backup?.destPath, snapshotId, { dryRun, subdirFilter });
  res.json(result);
}));

export default router;
