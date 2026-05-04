/**
 * Video Generation Routes — local LTX backend.
 *
 * Mirrors the imageGen route surface where it makes sense (status, models,
 * SSE progress, cancel) and adds video-specific bits (history, last-frame
 * extraction, ffmpeg stitching).
 */

import { Router } from 'express';
import { existsSync, statSync } from 'fs';
import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, basename, resolve as resolvePath, sep as PATH_SEP, extname } from 'path';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { uploadSingle } from '../lib/multipart.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { getSettings } from '../services/settings.js';
import {
  listVideoModels,
  defaultVideoModelId,
  loadHistory,
  deleteHistoryItem,
  setHistoryItemHidden,
  extractLastFrame,
  stitchVideos,
  upscaleHistoryItem,
} from '../services/videoGen/local.js';
import { enqueueJob, attachSseClient, cancelJob, listJobs } from '../services/mediaJobQueue/index.js';

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
  imageStrength: optionalNum(0, 1, 'imageStrength'),
  tiling: z.enum(['auto', 'none', 'spatial', 'temporal']).optional(),
  disableAudio: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  sourceImageFile: z.string().max(512).optional(),
  // FFLF mode end-frame target. Gallery-pick only (no upload field) so the
  // multipart parser stays single-file. Users wanting a fresh end-frame
  // image can generate or upload it via Image Gen first, then reference
  // its basename here.
  lastImageFile: z.string().max(512).optional(),
  // UI mode hint — backend only uses it for logging/branching; absence
  // falls back to inferring (sourceImage→i2v, no source→t2v).
  mode: z.enum(['text', 'image', 'fflf', 'extend']).optional(),
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

// Path-traversal guard: basename() strips dirs, then resolve+prefix-check
// against PATHS.images so a unicode trick can't escape data/images. Also
// reject `.`/`..`/empty basenames and require the resolved entry to be a
// regular file — otherwise the images-root directory itself would resolve
// (existsSync is true for dirs) and flow into ffmpeg as an "image path"
// where it'd fail in confusing ways.
//
// Wrap statSync in try/catch (one of the few "strictly necessary" uses):
// throwIfNoEntry: false silences ENOENT but not EACCES/permissions or
// transient I/O errors — those should be treated as "not a valid gallery
// reference" and produce a clean validation null, not bubble up as a 500.
const resolveGalleryImage = (name) => {
  const safe = basename(name);
  if (!safe || safe === '.' || safe === '..') return null;
  const imagesRoot = resolvePath(PATHS.images) + PATH_SEP;
  const localPath = resolvePath(join(PATHS.images, safe));
  if (!localPath.startsWith(imagesRoot) || !existsSync(localPath)) return null;
  try {
    const stat = statSync(localPath, { throwIfNoEntry: false });
    return stat?.isFile() ? localPath : null;
  } catch {
    return null;
  }
};

router.post('/', sourceImageUpload, asyncHandler(async (req, res) => {
  // Pre-enqueue cleanup hook: every throw path below MUST drop the multipart
  // temp upload (Multer wrote it before this handler ran). Without this a
  // configuration/validation error leaks the upload in the OS temp dir.
  const cleanupTempUpload = async () => {
    if (req.file?.path) await unlink(req.file.path).catch(() => {});
  };
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await cleanupTempUpload();
    throw new ServerError(`Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const body = parsed.data;
  const s = await getSettings();
  const pythonPath = s.imageGen?.local?.pythonPath || null;
  // Reject up-front when the local python isn't configured. Without this,
  // the queue would happily accept the job, return 200/queued, and only
  // surface the failure asynchronously on SSE — which then pollutes the
  // persisted queue with a doomed entry.
  if (!pythonPath) {
    await cleanupTempUpload();
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }
  // Validate modelId synchronously (when supplied). Without this the queue
  // would happily accept a typo'd modelId and fail asynchronously inside
  // the worker — leaving a persisted, doomed queue entry.
  if (body.modelId) {
    const known = listVideoModels();
    if (!known.some((m) => m.id === body.modelId)) {
      await cleanupTempUpload();
      throw new ServerError(
        `Unknown modelId: ${body.modelId}`,
        { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' },
      );
    }
  }

  let sourceImagePath = null;
  let uploadedTempPath = null;
  if (req.file) {
    // Copy the multipart upload into a durable location under data/uploads
    // before enqueueing. The Multer temp file lives in the OS temp dir —
    // which gets reaped by macOS on reboot, and might be missing entirely
    // when the queue replays a persisted `queued` job after a server
    // restart. Copying here gives the worker a stable path that survives
    // restarts; the worker unlinks it on completion or cancel.
    await ensureDir(PATHS.uploads);
    const ext = extname(req.file.originalname || req.file.path) || '.bin';
    const durablePath = join(PATHS.uploads, `video-source-${randomUUID()}${ext}`);
    // copyFile can throw on disk-full / permission errors. If it does we
    // need to clean up: drop the multipart temp upload AND the half-written
    // durablePath (copyFile may have created a zero-byte sentinel before
    // bailing). Without this, a failed POST leaks files in /tmp + data/uploads.
    try {
      await copyFile(req.file.path, durablePath);
    } catch (err) {
      await unlink(durablePath).catch(() => {});
      await cleanupTempUpload();
      throw new ServerError(
        `Failed to stage upload to durable location: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOAD_STAGE_FAILED' },
      );
    }
    await unlink(req.file.path).catch(() => {});
    sourceImagePath = durablePath;
    uploadedTempPath = durablePath;
  } else if (body.sourceImageFile) {
    sourceImagePath = resolveGalleryImage(body.sourceImageFile);
  }

  // FFLF end-frame: gallery-pick only. Same path-traversal guard.
  const lastImagePath = body.lastImageFile ? resolveGalleryImage(body.lastImageFile) : null;

  // Enqueue rather than spawn synchronously — the mediaJobQueue worker will
  // run this when no other render is in flight. Caller never sees BUSY.
  const { jobId, position, status } = enqueueJob({
    kind: 'video',
    params: {
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
      lastImagePath,
      mode: body.mode,
      imageStrength: body.imageStrength,
    },
  });
  // Match the legacy response shape (jobId, generationId, filename, model,
  // mode) so existing client code keeps working; add status+position for
  // the queue. Resolve the effective model NOW — when modelId is omitted
  // the worker will default it inside generateVideo, but the response
  // needs to surface what the gallery / history will record.
  const effectiveModel = body.modelId || defaultVideoModelId();
  res.json({ jobId, generationId: jobId, filename: `${jobId}.mp4`, model: effectiveModel, mode: 'local', status, position });
}));

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) res.status(404).json({ error: 'Job not found or expired' });
});

router.post('/cancel', asyncHandler(async (req, res) => {
  // Cancel selection rules, in priority order:
  //   1. Explicit body.jobId — cancel exactly that job (queued or running).
  //      Required for users with multiple in-flight renders.
  //   2. No jobId — cancel the currently-running video job (legacy behavior).
  //   3. No running job — cancel the newest queued video job so the user can
  //      take back a submission they regret while it's still in line.
  const requestedJobId = typeof req.body?.jobId === 'string' && req.body.jobId.trim()
    ? req.body.jobId.trim()
    : undefined;
  if (requestedJobId) {
    // Validate that the jobId is a video job before cancelling, so a stray
    // image jobId from another tab doesn't accidentally cancel here.
    const job = listJobs({ kind: 'video' }).find((j) => j.id === requestedJobId);
    if (!job) return res.json({ ok: false, reason: 'video job not found' });
    if (job.status !== 'queued' && job.status !== 'running') {
      return res.json({ ok: false, reason: `job already ${job.status}` });
    }
    return res.json(await cancelJob(job.id));
  }
  const running = listJobs({ kind: 'video', status: 'running' });
  if (running.length) return res.json(await cancelJob(running[0].id));
  // No running render — cancel the newest queued video instead so the user
  // can pull back a submission before it starts.
  const queued = listJobs({ kind: 'video', status: 'queued' });
  if (queued.length) return res.json(await cancelJob(queued[queued.length - 1].id));
  res.json({ ok: false, reason: 'no active or queued video render' });
}));

router.get('/history', asyncHandler(async (_req, res) => {
  res.json(await loadHistory());
}));

router.delete('/history/:id', asyncHandler(async (req, res) => {
  res.json(await deleteHistoryItem(req.params.id));
}));

router.post('/history/:id/visibility', asyncHandler(async (req, res) => {
  res.json(await setHistoryItemHidden(req.params.id, !!req.body?.hidden));
}));

router.post('/last-frame/:id', asyncHandler(async (req, res) => {
  res.json(await extractLastFrame(req.params.id));
}));

const historyIdSchema = z.string().regex(/^[a-f0-9-]{36}$/i, 'invalid history id');

const failValidation = (parsed) => {
  throw new ServerError(`Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
};

router.post('/upscale/:id', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const entry = await upscaleHistoryItem(parsed.data);
  res.json({ ok: true, video: entry });
}));

const stitchBodySchema = z.object({
  videoIds: z.array(historyIdSchema).min(2).max(20),
});

router.post('/stitch', asyncHandler(async (req, res) => {
  const parsed = stitchBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const stitched = await stitchVideos(parsed.data.videoIds);
  res.json({ ok: true, video: stitched });
}));

export default router;
