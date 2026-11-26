/** Read and manage Video Gen gallery history and uploads. */

import { withMediaFileSizes } from '../lib/mediaFileInfo.js';
import { historyListQuerySchema, isHistoryListQuery, listVideoHistoryQuery } from '../services/videoGen/historyList.js';
import { Router } from 'express';
import { updateVideoPoster, createSharingCopy } from '../services/videoGen/poster.js';
import { asyncHandler, failValidation } from '../lib/errorHandler.js';
import { createVideoHistoryItemRead, historyRecordIdSchema } from './videoHistoryRead.js';
import { optionalUpload } from '../lib/multipart.js';
import { validateRequest } from '../lib/validateRequest.js';
import { deleteVideoHostedCopy } from '../services/hostedRenderRemoteDelete.js';
import { loadHistory, getHistoryItem, setHistoryItemHidden, updateHistoryItemPrompt, extractLastFrame } from '../services/videoGen/local.js';
import { readHistorySnapshot } from '../services/videoGen/history.js';
import { cleanupMultipartTemp } from '../services/videoGen/prepareParams.js';
import { saveUploadedGalleryVideo, saveUploadedGalleryVideoFile } from '../services/videoUpload.js';
import { deleteMediaAnywhere, cancelPendingDelete } from '../services/mediaRemoteDelete.js';
import { assertMediaDeletable } from '../services/mediaUsage.js';
import { hostedProviderParamSchema, mediaDeleteQuerySchema } from '../lib/mediaGenerationValidation.js';
import { historyIdSchema, posterSchema, updatePromptSchema, uploadVideoSchema, visibilitySchema } from '../lib/videoGenValidation.js';

const router = Router();

router.get('/history', asyncHandler(async (req, res) => {
  // No query keeps the legacy full array; see historyList.js for the opt-in form.
  if (!isHistoryListQuery(req.query)) return res.json(await withMediaFileSizes(await loadHistory(), 'video'));
  const options = validateRequest(historyListQuerySchema, req.query);
  res.json(await listVideoHistoryQuery(options, await readHistorySnapshot()));
}));

// One history entry by id (#4165) — see videoHistoryRead.js.
router.get('/history/:id', createVideoHistoryItemRead(getHistoryItem));

// Upload a video into the shared gallery (#4188) — the video counterpart of
// POST /api/image-gen/upload. Lands the bytes under PATHS.videos with a
// `source: 'upload'` history entry so the file federates via the peer-sync
// asset manifest (unlike POST /api/uploads → data/uploads/, which does not).
router.post('/upload', optionalUpload('file'), asyncHandler(async (req, res) => {
  if (req.file) {
    try {
      return res.json(await saveUploadedGalleryVideoFile(req.file.path, req.file.originalname));
    } finally {
      await cleanupMultipartTemp(req.files);
    }
  }
  const parsed = uploadVideoSchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const { data, filename } = parsed.data;
  res.json(await saveUploadedGalleryVideo(data, filename));
}));

// Deletes on the machine that owns the row (services/mediaRemoteDelete.js):
// `{ ok, status: 'deleted' | 'deleted-remote' | 'pending' | 'owner-unknown' | 'cancelled' }`.
// A refusal or an unusable answer from the owner is an error, never a success.
router.delete('/history/:id', asyncHandler(async (req, res) => {
  const parsed = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const { force } = validateRequest(mediaDeleteQuerySchema, req.query ?? {});
  await assertMediaDeletable(`video:${parsed.data}`, { force: force === '1' });
  res.json({ ok: true, ...(await deleteMediaAnywhere('video', parsed.data)) });
}));

// Runs the provider's delete for a finished render (Runway: the rendered asset; fal.ai: stored payloads and output files);
// the local file and record stay, stamped with when the hosted copy was deleted.
router.delete('/history/:id/hosted/:provider', asyncHandler(async (req, res) => {
  const parsed = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const provider = validateRequest(hostedProviderParamSchema, req.params.provider);
  res.json(await deleteVideoHostedCopy(provider, parsed.data));
}));

router.post('/history/:id/cancel-delete', asyncHandler(async (req, res) => {
  const parsed = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  res.json(await cancelPendingDelete('video', parsed.data));
}));

router.post('/history/:id/visibility', asyncHandler(async (req, res) => {
  const parsedId = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsedId.success) failValidation(parsedId);
  const body = visibilitySchema.safeParse(req.body ?? {});
  if (!body.success) failValidation(body);
  res.json(await setHistoryItemHidden(parsedId.data, body.data.hidden));
}));

router.patch('/history/:id/poster', asyncHandler(async (req, res) => {
  const parsed = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(posterSchema, req.body);
  res.json(await updateVideoPoster(parsed.data, body.atSec));
}));

router.get('/history/:id/sharing-download', asyncHandler(async (req, res) => {
  const parsed = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  const copy = await createSharingCopy(parsed.data, { signal: controller.signal });
  if (res.destroyed) { await copy.cleanup(); return; }
  res.download(copy.path, copy.filename, error => {
    res.off('close', abort);
    copy.cleanup().catch(err => console.error(`❌ Sharing download cleanup failed: ${err.message}`));
    if (error && !res.destroyed) res.destroy(error);
  });
}));

router.patch('/history/:id/prompt', asyncHandler(async (req, res) => {
  const parsedId = historyRecordIdSchema.safeParse(req.params.id);
  if (!parsedId.success) failValidation(parsedId);
  const body = updatePromptSchema.safeParse(req.body ?? {});
  if (!body.success) failValidation(body);
  res.json(await updateHistoryItemPrompt(parsedId.data, body.data.prompt));
}));

router.post('/last-frame/:id', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  res.json(await extractLastFrame(parsed.data));
}));

export default router;
