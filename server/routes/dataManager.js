import {
  recordingLocator,
  recordingOffsetQuerySchema,
  recordingPurgeSchema,
  recordingPinSchema,
  storageMeasureQuerySchema,
} from '../lib/dataManagerValidation.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  getDataOverview,
  getCategoryDetail,
  archiveCategory,
  purgeCategory,
  getBackups,
  deleteBackup
} from '../services/dataManager.js';
import { dataPurgeSchema, dataArchiveBodySchema } from '../lib/databaseValidation.js';

const router = Router();

// Lazy service import keeps ordinary storage overview reads out of the CoS graph.
router.get('/cos/storage', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  res.json(await service.getAgentStorageStatus());
}));
router.put('/cos/storage/policy', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  res.json(await service.updateAgentStoragePolicy(validateRequest(service.agentStoragePolicySchema, req.body)));
}));
router.post('/cos/storage/preview', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  const { offset } = validateRequest(recordingOffsetQuerySchema, req.query);
  res.json(await service.previewAgentStorage(validateRequest(service.agentStorageFilterSchema, req.body), { offset }));
}));
router.post('/cos/storage/run', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  const input = validateRequest(recordingPurgeSchema, req.body);
  res.json(await service.startAgentStorage(input));
}));
router.post('/cos/storage/cancel', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  res.json(await service.cancelAgentStorage());
}));
router.put('/cos/storage/pin', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  res.json(await service.pinAgentRecording(validateRequest(recordingPinSchema, req.body)));
}));
router.get('/cos/storage/recording/:date/:id', asyncHandler(async (req, res) => {
  const service = await import('../services/cos/cosAgentStorage.js');
  const { date, id } = validateRequest(recordingLocator, req.params);
  const artifact = await service.getAgentRecordingDownload(date, id);
  res.download(artifact.path, artifact.name);
}));

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
  const { measure } = validateRequest(storageMeasureQuerySchema, req.query);
  const detail = await getCategoryDetail(req.params.category, { measure: measure === '1' });
  if (!detail) throw new ServerError('Category not found', { status: 404, code: 'NOT_FOUND' });
  res.json(detail);
}));

// POST /api/data/:category/archive — archive a category to backup
router.post('/:category/archive', asyncHandler(async (req, res) => {
  const { daysToKeep } = validateRequest(dataArchiveBodySchema, req.body ?? {});
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
