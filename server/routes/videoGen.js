/**
 * Video Generation Routes — local LTX backend.
 *
 * Mirrors the imageGen route surface where it makes sense (status, models,
 * SSE progress, cancel) and adds video-specific bits (history, last-frame
 * extraction, ffmpeg stitching).
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join, basename, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { z } from 'zod';
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

// Multipart bodies arrive as strings; coerce numerics in the schema. The
// service layer also coerces, but validating at the route boundary catches
// out-of-range / wrong-type input before any work happens.
//
// `optional()` lives INSIDE the preprocess wrapper so that the inner schema
// (`z.number()`) actually receives `undefined` rather than failing with
// "received undefined". With the optional() on the outside the empty-string
// branch was unreachable — preprocess returned undefined and z.number()
// rejected it before optional() ever saw the result.
const optionalNum = (min, max, label) => z.preprocess(
  (v) => v == null || v === '' ? undefined : Number(v),
  z.number().refine((n) => n >= min && n <= max, `${label} ${min}..${max}`).optional(),
);
const generateBodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  modelId: z.string().max(64).optional(),
  width: optionalNum(64, 2048, 'width'),
  height: optionalNum(64, 2048, 'height'),
  numFrames: optionalNum(1, 1024, 'numFrames'),
  fps: optionalNum(1, 60, 'fps'),
  steps: optionalNum(1, 200, 'steps'),
  guidanceScale: optionalNum(0, 30, 'guidanceScale'),
  seed: optionalNum(0, Number.MAX_SAFE_INTEGER, 'seed'),
  tiling: z.enum(['auto', 'none', 'spatial', 'temporal']).optional(),
  disableAudio: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  sourceImageFile: z.string().max(512).optional(),
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
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ServerError(`Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const body = parsed.data;
  const s = await getSettings();
  const pythonPath = s.imageGen?.local?.pythonPath || null;

  let sourceImagePath = null;
  let uploadedTempPath = null;
  if (req.file) {
    sourceImagePath = req.file.path;
    // Hand the multipart upload's temp path to the service so it can unlink
    // it in the proc.on('close') cleanup — covers both the success path
    // (after ffmpeg consumed it for resize) and the no-ffmpeg fallback path
    // (where the python child reads it directly and we can't unlink earlier).
    uploadedTempPath = req.file.path;
  } else if (body.sourceImageFile) {
    // Path-traversal guard: basename() strips dirs, then resolve+prefix-check
    // against PATHS.images so a unicode trick can't escape data/images.
    const imagesRoot = resolvePath(PATHS.images) + PATH_SEP;
    const localPath = resolvePath(join(PATHS.images, basename(body.sourceImageFile)));
    if (localPath.startsWith(imagesRoot) && existsSync(localPath)) sourceImagePath = localPath;
  }

  try {
    const result = await generateVideo({
      pythonPath,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt || '',
      modelId: body.modelId,
      width: body.width,
      height: body.height,
      numFrames: body.numFrames,
      fps: body.fps,
      steps: body.steps,
      guidanceScale: body.guidanceScale,
      seed: body.seed,
      tiling: body.tiling || 'auto',
      disableAudio: body.disableAudio === true || body.disableAudio === 'true',
      sourceImagePath,
      uploadedTempPath,
    });
    res.json(result);
  } catch (err) {
    // generateVideo threw before scheduling the proc.on('close') cleanup
    // (e.g. PYTHON not configured, BUSY, validation) — drop the upload now.
    if (uploadedTempPath) await unlink(uploadedTempPath).catch(() => {});
    throw err;
  }
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
