/**
 * Video Generation Routes — local LTX backend.
 *
 * Mirrors the imageGen route surface where it makes sense (status, models,
 * SSE progress, cancel) and adds video-specific bits (history, last-frame
 * extraction, ffmpeg stitching).
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { uploadSingle } from '../lib/multipart.js';
import { PATHS } from '../lib/fileUtils.js';
import { getSettings } from '../services/settings.js';
import {
  listVideoModels,
  defaultVideoModelId,
  generateVideo,
  attachSseClient,
  cancel,
  loadHistory,
  deleteHistoryItem,
  extractLastFrame,
  stitchVideos,
} from '../services/videoGen/local.js';

const router = Router();

const sourceImageUpload = uploadSingle('sourceImage', {
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

router.get('/status', asyncHandler(async (_req, res) => {
  const s = await getSettings();
  const py = s.imageGen?.local?.pythonPath || null;
  res.json({
    connected: !!py,
    pythonPath: py,
    models: listVideoModels(),
    defaultModel: defaultVideoModelId(),
  });
}));

router.get('/models', (_req, res) => {
  res.json(listVideoModels());
});

router.post('/', sourceImageUpload, asyncHandler(async (req, res) => {
  const s = await getSettings();
  const pythonPath = s.imageGen?.local?.pythonPath || null;

  let sourceImagePath = null;
  if (req.file) {
    sourceImagePath = req.file.path;
  } else if (req.body.sourceImageFile) {
    const localPath = join(PATHS.images, basename(req.body.sourceImageFile));
    if (existsSync(localPath)) sourceImagePath = localPath;
  }

  const result = await generateVideo({
    pythonPath,
    prompt: req.body.prompt,
    negativePrompt: req.body.negativePrompt || '',
    modelId: req.body.modelId,
    width: req.body.width,
    height: req.body.height,
    numFrames: req.body.numFrames,
    fps: req.body.fps,
    steps: req.body.steps,
    guidanceScale: req.body.guidanceScale,
    seed: req.body.seed,
    tiling: req.body.tiling || 'auto',
    disableAudio: req.body.disableAudio === 'true' || req.body.disableAudio === true,
    sourceImagePath,
  });

  res.json(result);
}));

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) res.status(404).json({ error: 'Job not found or expired' });
});

router.post('/cancel', (_req, res) => {
  const cancelled = cancel();
  res.json({ ok: cancelled });
});

router.get('/history', asyncHandler(async (_req, res) => {
  res.json(await loadHistory());
}));

router.delete('/history/:id', asyncHandler(async (req, res) => {
  res.json(await deleteHistoryItem(req.params.id));
}));

router.post('/last-frame/:id', asyncHandler(async (req, res) => {
  res.json(await extractLastFrame(req.params.id));
}));

router.post('/stitch', asyncHandler(async (req, res) => {
  const ids = req.body?.videoIds;
  if (!Array.isArray(ids)) throw new ServerError('videoIds array required', { status: 400, code: 'VALIDATION_ERROR' });
  const stitched = await stitchVideos(ids);
  res.json({ ok: true, video: stitched });
}));

export default router;
