import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, restoreRequestSchema, restoreDbRequestSchema } from '../lib/validation.js';
import * as backup from '../services/backup.js';
import { getSettings } from '../services/settings.js';

const router = Router();

// GET /api/backup/status
router.get('/status', asyncHandler(async (req, res) => {
  const state = await backup.getState();
  const settings = await getSettings();
  const nextRun = backup.getNextRunTime();
  res.json({
    ...state,
    destPath: settings.backup?.destPath ?? null,
    nextRun,
    defaultExcludes: backup.DEFAULT_EXCLUDES
  });
}));

// POST /api/backup/run
router.post('/run', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const destPath = settings.backup?.destPath;
  if (!destPath) {
    throw new ServerError('No backup destination configured in settings', { status: 400, code: 'BACKUP_NOT_CONFIGURED' });
  }
  const excludePaths = settings.backup?.excludePaths || [];
  const disabledDefaultExcludes = settings.backup?.disabledDefaultExcludes || [];
  const io = req.app.get('io');
  const result = await backup.runBackup(destPath, io, { excludePaths, disabledDefaultExcludes });
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

// POST /api/backup/restore-db
router.post('/restore-db', asyncHandler(async (req, res) => {
  const { snapshotId, dryRun } = validateRequest(restoreDbRequestSchema, req.body);
  const settings = await getSettings();
  const destPath = settings.backup?.destPath;
  if (!destPath) {
    throw new ServerError('No backup destination configured in settings', { status: 400, code: 'BACKUP_NOT_CONFIGURED' });
  }
  const result = await backup.restorePostgres(destPath, snapshotId, { dryRun });
  res.json(result);
}));

export default router;
