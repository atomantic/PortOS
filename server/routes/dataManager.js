import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, dataPurgeSchema } from '../lib/validation.js';
import {
  getDataOverview,
  getCategoryDetail,
  archiveCategory,
  purgeCategory,
  getBackups,
  deleteBackup
} from '../services/dataManager.js';

const router = Router();

// GET /api/data — overview of all data categories
router.get('/', asyncHandler(async (req, res) => {
  const overview = await getDataOverview();
  res.json(overview);
}));

// GET /api/data/backups — list all backup archives
router.get('/backups', asyncHandler(async (req, res) => {
  const backups = await getBackups();
  res.json(backups);
}));

// GET /api/data/:category — detailed breakdown of a category
router.get('/:category', asyncHandler(async (req, res) => {
  const detail = await getCategoryDetail(req.params.category);
  if (!detail) throw new ServerError('Category not found', { status: 404, code: 'NOT_FOUND' });
  res.json(detail);
}));

// POST /api/data/:category/archive — archive a category to backup
router.post('/:category/archive', asyncHandler(async (req, res) => {
  const rawDays = req.body?.daysToKeep;
  const daysToKeep = rawDays != null ? Number(rawDays) : undefined;
  if (daysToKeep != null && (!Number.isFinite(daysToKeep) || daysToKeep < 0)) {
    throw new ServerError('daysToKeep must be a non-negative number', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const result = await archiveCategory(req.params.category, { daysToKeep });
  res.json(result);
}));

// DELETE /api/data/backups/:filename — delete a backup file (must precede /:category)
router.delete('/backups/:filename', asyncHandler(async (req, res) => {
  const result = await deleteBackup(req.params.filename);
  res.json(result);
}));

// DELETE /api/data/:category — purge a category's contents, or a single entry
// when `subPath` is given. Categories flagged `purgeScope: 'items'` reject the
// bodiless (whole-directory) form in `purgeCategory` — hiding the button in the
// UI is not enough, the endpoint has to refuse it too (#3327).
router.delete('/:category', asyncHandler(async (req, res) => {
  const { subPath } = validateRequest(dataPurgeSchema, req.body || {});
  const result = await purgeCategory(req.params.category, { subPath });
  res.json(result);
}));

export default router;
