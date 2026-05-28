/**
 * Video Generation Routes — local LTX backend.
 *
 * Mirrors the imageGen route surface where it makes sense (status, models,
 * SSE progress, cancel) and adds video-specific bits (history, last-frame
 * extraction, ffmpeg stitching).
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { z } from 'zod';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { uploadFields } from '../lib/multipart.js';
import { PATHS, ensureDir, resolveGalleryImage } from '../lib/fileUtils.js';
import { safeUnder } from '../lib/ffmpeg.js';
import { getSettings } from '../services/settings.js';
import { checkPackages, isAllowedPython } from '../lib/pythonSetup.js';
import {
  listVideoModels,
  defaultVideoModelId,
  loadHistory,
  deleteHistoryItem,
  setHistoryItemHidden,
  extractLastFrame,
  stitchVideos,
  upscaleHistoryItem,
  DEFAULT_NUM_FRAMES,
} from '../services/videoGen/local.js';
import { enqueueJob, attachSseClient, cancelJob, listJobs } from '../services/mediaJobQueue/index.js';
import { repoForModel, getTextEncoderRepo, isHfRepoId } from '../lib/mediaModels.js';
import { inspectModelCache } from '../lib/hfCache.js';
import { startHfDownloadStream } from '../lib/sseDownload.js';

const router = Router();

// M4A files are stored in an MP4 container. Browsers and OS file pickers
// label them inconsistently: Safari uses `video/mp4`, Chrome/Firefox use
// `audio/mp4`, and some platforms emit `audio/x-m4a` or `audio/aac`.
// `audio/*` catches the obvious cases (WAV, MP3, OGG, FLAC…) but misses
// the MP4-container variants. The extension check is a defense-in-depth
// fallback so a `.m4a` always passes regardless of what the HTTP client
// decided to put in Content-Type.
export const isAudioMime = (mime, filename) => {
  if (!mime) return false;
  if (mime.startsWith('audio/')) return true;
  if (mime === 'video/mp4') {
    // Only allow video/mp4 when the extension confirms it's audio, not a
    // genuine video file drag-dropped onto the audio upload field.
    const ext = (filename || '').match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    return ext === 'm4a' || ext === 'aac';
  }
  return false;
};

// FFLF accepts up to two image uploads (start and end frame); a2v takes
// one audio upload (audioFile). 100MB covers audio cases too (LTX-2's a2v
// expects only seconds of audio in practice). Per-fieldname mime filter
// rejects mismatched parts up-front so a stray .mp4 drag-drop can't get
// staged under any of these fields.
const frameImageUpload = uploadFields(['sourceImage', 'lastImage', 'audioFile'], {
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isImageField = file.fieldname === 'sourceImage' || file.fieldname === 'lastImage';
    const isAudioField = file.fieldname === 'audioFile';
    const okImage = isImageField && file.mimetype.startsWith('image/');
    const okAudio = isAudioField && isAudioMime(file.mimetype, file.originalname);
    cb(null, okImage || okAudio);
  },
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
// numFrames and chunks must be integers. Multipart bodies send `'121'` as
// a string and `'121.5'` would silently coerce to 121.5 — feed that into
// keyframe-index range checks and the maximum becomes a fractional bound,
// not an integer one. Reject up front.
const optionalInt = (min, max, label) => z.preprocess(
  (v) => v == null || v === '' ? undefined : Number(v),
  z.number().int().refine((n) => n >= min && n <= max, `${label} ${min}..${max}`).optional(),
);
const generateBodySchema = z.object({
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(8000).optional(),
  modelId: z.string().max(64).optional(),
  width: optionalNum(64, 2048, 'width'),
  height: optionalNum(64, 2048, 'height'),
  numFrames: optionalInt(1, 1024, 'numFrames'),
  fps: optionalNum(1, 60, 'fps'),
  steps: optionalNum(1, 200, 'steps'),
  guidanceScale: optionalNum(0, 30, 'guidanceScale'),
  seed: optionalNum(0, Number.MAX_SAFE_INTEGER, 'seed'),
  imageStrength: optionalNum(0, 1, 'imageStrength'),
  tiling: z.enum(['auto', 'none', 'spatial', 'temporal']).optional(),
  disableAudio: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  sourceImageFile: z.string().max(512).optional(),
  // Gallery-pick filename for the FFLF end-frame. The end-frame can also
  // arrive as a multipart `lastImage` upload (handled below) — when both
  // are present the upload wins, mirroring the sourceImage/sourceImageFile
  // precedence on the start-frame side.
  lastImageFile: z.string().max(512).optional(),
  // UI mode hint — backend only uses it for logging/branching; absence
  // falls back to inferring (sourceImage→i2v, no source→t2v).
  mode: z.enum(['text', 'image', 'fflf', 'extend', 'a2v']).optional(),
  // Chain N renders end-to-end: each chunk's last frame becomes the next
  // chunk's start frame, then ffmpeg concats them into one clip. 1..8 to
  // keep the worst-case wall time bounded (8 × ~5min ≈ 40min on M3 Max).
  chunks: optionalInt(1, 8, 'chunks'),
  // History id of a prior render to extend natively (ltx2 runtime only —
  // routes through ExtendPipeline.extend_from_video which conditions on
  // the entire source video's latent rather than a single last frame).
  // The legacy chained-i2v path keeps using sourceImageFile.
  extendFromVideoId: z.string().uuid().optional(),
  // Multi-keyframe interpolation (ltx2 + mode='fflf'). Each entry pins one
  // gallery image at a specific pixel-frame index. Indices must be strictly
  // ascending and within [0, numFrames-1]. When set, overrides the legacy
  // sourceImageFile/lastImageFile pair. Multipart bodies arrive as a string,
  // so the preprocess parses JSON before zod sees it.
  keyframes: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    },
    z.array(z.object({
      file: z.string().min(1).max(512),
      index: z.number().int().min(0).max(1023),
    })).min(2).max(8).optional(),
  ),
});

// Probes required-package imports on each call so a half-installed Python
// can't masquerade as connected. /status isn't polled (mount + manual
// refresh only), so the ~1-2s subprocess cost is acceptable.
router.get('/status', asyncHandler(async (_req, res) => {
  const s = await getSettings();
  const py = s.imageGen?.local?.pythonPath || null;
  const { connected, reason, missing } = await resolveLocalPythonHealth(py);
  res.json({
    connected,
    pythonPath: py,
    reason,
    missingPackages: missing,
    models: listVideoModels(),
    defaultModel: defaultVideoModelId(),
  });
}));

async function resolveLocalPythonHealth(py) {
  if (!py) return { connected: false, reason: 'Local Python not configured', missing: [] };
  if (!isAllowedPython(py)) return { connected: false, reason: 'Saved pythonPath is not a python interpreter', missing: [] };
  try {
    const { missing } = await checkPackages(py);
    if (missing.length === 0) return { connected: true, reason: null, missing };
    return {
      connected: false,
      reason: `${missing.length} python package${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}`,
      missing,
    };
  } catch (err) {
    return { connected: false, reason: `Python probe failed: ${err.message || err}`, missing: [] };
  }
}

router.get('/models', (_req, res) => {
  res.json(listVideoModels());
});

// Per-model download status — see /api/image-gen/models/status for the
// shape contract. We also surface the active text-encoder repo so the
// video form can warn when the Gemma encoder isn't downloaded yet (a
// surprise multi-GB pull on top of the model itself).
router.get('/models/status', asyncHandler(async (_req, res) => {
  // Text encoder is shared across all video renders. A registry entry with
  // `localPath` (e.g. an LM Studio install) trumps the HF cache check, so
  // surface both the repo-cache status and the resolved local path so the UI
  // can distinguish "not downloaded" from "served from LM Studio".
  const encoderRepo = getTextEncoderRepo();
  const [models, encoderInspection] = await Promise.all([
    Promise.all(listVideoModels().map(async (m) => {
      const repo = repoForModel(m);
      if (!repo) return { id: m.id, repo: null, cached: null, sizeBytes: 0 };
      const { cached, sizeBytes } = await inspectModelCache(repo);
      return { id: m.id, repo, cached, sizeBytes };
    })),
    isHfRepoId(encoderRepo) ? inspectModelCache(encoderRepo) : Promise.resolve(null),
  ]);
  const textEncoder = encoderInspection
    ? { repo: encoderRepo, ...encoderInspection }
    : { repo: encoderRepo, cached: true, sizeBytes: 0 };
  res.json({ models, textEncoder });
}));

router.get('/models/:modelId/download', asyncHandler(async (req, res) => {
  const model = listVideoModels().find((m) => m.id === req.params.modelId);
  if (!model) return res.status(404).json({ error: `Unknown video model: ${req.params.modelId}` });
  const repo = repoForModel(model);
  if (!repo) return res.status(400).json({ error: `Model "${model.id}" has no HuggingFace repo on file.`, code: 'NO_REPO_FOR_MODEL' });
  await startHfDownloadStream({ req, res, repo });
}));

// Text encoder pre-fetch. The Gemma encoder is a separate ~7-25 GB pull from
// the video model itself, so it gets its own button on the video form.
router.get('/text-encoder/download', asyncHandler(async (req, res) => {
  const repo = getTextEncoderRepo();
  // Local-path encoders (LM Studio) are not downloadable — they're served
  // off disk and the status endpoint already reports cached: true for them.
  if (!isHfRepoId(repo)) {
    return res.status(400).json({ error: 'Active text encoder is a local-path entry, not an HF repo.', code: 'NOT_DOWNLOADABLE' });
  }
  await startHfDownloadStream({ req, res, repo });
}));

router.post('/', frameImageUpload, asyncHandler(async (req, res) => {
  // Pre-enqueue cleanup hook: every throw path below MUST drop ALL multipart
  // temp uploads (the parser wrote them before this handler ran). Without
  // this a configuration/validation error leaks files in the OS temp dir.
  const uploads = req.files || {};
  const cleanupTempUploads = async () => {
    for (const f of Object.values(uploads)) {
      if (f?.path) await unlink(f.path).catch(() => {});
    }
  };
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await cleanupTempUploads();
    failValidation(parsed);
  }
  const body = parsed.data;
  const s = await getSettings();
  const pythonPath = s.imageGen?.local?.pythonPath || null;
  // Reject up-front when the local python isn't configured. Without this,
  // the queue would happily accept the job, return 200/queued, and only
  // surface the failure asynchronously on SSE — which then pollutes the
  // persisted queue with a doomed entry.
  if (!pythonPath) {
    await cleanupTempUploads();
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }
  // Resolve the effective model up front — both the modelId-exists check
  // below AND the a2v runtime guard further down need the model entry,
  // and listVideoModels() is the kind of thing test mocks easily get out
  // of sync if called twice.
  const knownModels = listVideoModels();
  const effectiveModelId = body.modelId || defaultVideoModelId();
  const effectiveModel = knownModels.find((m) => m.id === effectiveModelId);
  // Validate modelId synchronously (when supplied). Without this the queue
  // would happily accept a typo'd modelId and fail asynchronously inside
  // the worker — leaving a persisted, doomed queue entry.
  if (body.modelId && !effectiveModel) {
    await cleanupTempUploads();
    throw new ServerError(
      `Unknown modelId: ${body.modelId}`,
      { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' },
    );
  }

  // Track every durable file we've already copied into PATHS.uploads so a
  // *later* staging failure can roll them back. Without this, staging
  // sourceImage successfully then failing on lastImage would leave the
  // sourceImage durable copy orphaned (the job is never enqueued, so the
  // worker's cleanup never runs).
  const stagedDurablePaths = [];
  const cleanupAllStaged = async () => {
    for (const p of stagedDurablePaths) await unlink(p).catch(() => {});
    await cleanupTempUploads();
  };

  // Stage a multipart upload into data/uploads so the queue worker can find
  // it after a server restart — the OS temp dir gets reaped on reboot, and a
  // persisted `queued` job may replay long after the original POST. Worker
  // unlinks the durable file when the job completes or cancels. Throws
  // ServerError on copy failure (and cleans up every staged file + multipart
  // temp upload so a mid-flight failure doesn't leak under /tmp + data/uploads).
  const stageUploadDurable = async (file, kind) => {
    const ext = extname(file.originalname || file.path) || '.bin';
    const durablePath = join(PATHS.uploads, `video-${kind}-${randomUUID()}${ext}`);
    try {
      await copyFile(file.path, durablePath);
    } catch (err) {
      await unlink(durablePath).catch(() => {});
      await cleanupAllStaged();
      throw new ServerError(
        `Failed to stage upload to durable location: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOAD_STAGE_FAILED' },
      );
    }
    await unlink(file.path).catch(() => {});
    stagedDurablePaths.push(durablePath);
    return durablePath;
  };

  // Resolution precedence on each frame side: a fresh upload always wins over
  // a gallery filename so users can override a stale gallery pick by dropping
  // in a new file without first clearing the picker.
  //
  // Cleanup plumbing: `uploadedTempPath` (single, legacy) is RESERVED for the
  // start-frame upload — that field shape is what already-persisted jobs from
  // before this route change carry, so keeping its semantics stable means
  // those replays still clean up correctly. Every additional upload (today:
  // just `lastImage`) flows through `uploadedTempPaths` as an array. The
  // worker walks both fields when unlinking on terminal events.
  // Mode/upload pairing checks BEFORE staging so a rejected request only
  // unlinks the OS temp file (cheap) instead of also unlinking a freshly-
  // copied 100MB durable file under data/uploads (wasted disk I/O on every
  // bad request).
  if (body.mode === 'a2v' && !uploads.audioFile) {
    await cleanupAllStaged();
    throw new ServerError(
      'a2v mode requires an audioFile upload (multipart field name: audioFile).',
      { status: 400, code: 'VIDEO_GEN_AUDIO_REQUIRED' },
    );
  }
  if (uploads.audioFile && body.mode !== 'a2v') {
    await cleanupAllStaged();
    throw new ServerError(
      `audioFile upload is only valid with mode='a2v' (got mode='${body.mode || 'unset'}').`,
      { status: 400, code: 'VIDEO_GEN_AUDIO_MODE_MISMATCH' },
    );
  }
  // a2v needs the dgrauet runtime — the legacy mlx_video pipeline has no
  // audio-conditioned mode. The worker also catches this in buildArgs (with
  // A2V_REQUIRES_LTX2), but checking here keeps the route's "fail fast
  // before enqueue" contract so a bad modelId can't pollute the persisted
  // queue with a doomed entry.
  if (body.mode === 'a2v' && effectiveModel && effectiveModel.runtime !== 'ltx2') {
    await cleanupAllStaged();
    throw new ServerError(
      `a2v mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
      { status: 400, code: 'A2V_REQUIRES_LTX2' },
    );
  }

  let sourceImagePath = null;
  let lastImagePath = null;
  let audioFilePath = null;
  let uploadedTempPath = null;
  const extraUploadedTempPaths = [];
  if (uploads.sourceImage || uploads.lastImage || uploads.audioFile) {
    // Ensure the durable uploads dir exists before staging. Wrapped in
    // try/catch so a permission/disk failure here still cleans up the
    // multipart temp uploads instead of leaking them in the OS temp dir.
    try {
      await ensureDir(PATHS.uploads);
    } catch (err) {
      await cleanupAllStaged();
      throw new ServerError(
        `Failed to prepare uploads directory: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOADS_DIR_FAILED' },
      );
    }
  }
  if (uploads.sourceImage) {
    sourceImagePath = await stageUploadDurable(uploads.sourceImage, 'source');
    uploadedTempPath = sourceImagePath;
  } else if (body.sourceImageFile) {
    sourceImagePath = resolveGalleryImage(body.sourceImageFile);
  }
  if (uploads.lastImage) {
    lastImagePath = await stageUploadDurable(uploads.lastImage, 'last');
    extraUploadedTempPaths.push(lastImagePath);
  } else if (body.lastImageFile) {
    // Same path-traversal guard as the start frame.
    lastImagePath = resolveGalleryImage(body.lastImageFile);
  }
  if (uploads.audioFile) {
    // a2v: audio file rides through the same durable-staging path as the
    // image uploads. Cleanup tracking via extraUploadedTempPaths so the
    // worker drops it on terminal events the same way it drops lastImage.
    audioFilePath = await stageUploadDurable(uploads.audioFile, 'audio');
    extraUploadedTempPaths.push(audioFilePath);
  }

  // Multi-keyframe interpolation: resolve each gallery filename to an
  // absolute path under PATHS.images via the same path-traversal guard as
  // sourceImageFile. Reject up-front when any reference can't be resolved
  // so the queue doesn't accept a doomed job. Only valid for fflf mode +
  // single-chunk renders (the chain orchestrator pins keyframes only on
  // chunk 0; chaining ≥2 chunks with N keyframes has no defined semantic).
  let resolvedKeyframes = null;
  if (body.keyframes && body.keyframes.length >= 2) {
    if (body.mode && body.mode !== 'fflf') {
      await cleanupAllStaged();
      throw new ServerError(
        `keyframes is only valid with mode='fflf' (got mode='${body.mode}').`,
        { status: 400, code: 'KEYFRAMES_MODE_MISMATCH' },
      );
    }
    // Reject mixing keyframes with the legacy 2-keyframe inputs — the
    // worker would silently ignore sourceImage/lastImage when keyframes is
    // present, but staging/resizing them anyway is wasted work and the
    // ambiguity (which one wins?) bites callers later. Force the user to
    // pick one shape per request. Covers both upload paths and the
    // gallery-resolved file fields.
    if (sourceImagePath || lastImagePath || body.sourceImageFile || body.lastImageFile) {
      await cleanupAllStaged();
      throw new ServerError(
        'keyframes cannot be combined with sourceImage / lastImage inputs — pass each anchor frame as a keyframes[] entry instead.',
        { status: 400, code: 'KEYFRAMES_LEGACY_INPUTS_CONFLICT' },
      );
    }
    // Multi-keyframe FFLF is an LTX-2 primitive — the legacy mlx_video
    // pipeline has no equivalent. Mirror the a2v guard above so a bad
    // modelId can't enqueue a doomed job that will only fail in the
    // worker (with KEYFRAMES_REQUIRE_LTX2).
    if (effectiveModel && effectiveModel.runtime !== 'ltx2') {
      await cleanupAllStaged();
      throw new ServerError(
        `keyframes mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
        { status: 400, code: 'KEYFRAMES_REQUIRE_LTX2' },
      );
    }
    // Default mode to 'fflf' when keyframes is set without an explicit mode —
    // otherwise local.js#buildLtx2Args resolves helperMode to 'text' and the
    // keyframes silently disappear.
    if (!body.mode) body.mode = 'fflf';
    if (body.chunks != null && Number(body.chunks) > 1) {
      await cleanupAllStaged();
      throw new ServerError(
        'keyframes cannot be combined with chunks > 1 — keyframes anchor a single clip.',
        { status: 400, code: 'KEYFRAMES_CHUNKS_CONFLICT' },
      );
    }
    // Validate keyframe indices against the *effective* numFrames so a
    // request with no explicit `numFrames` (which falls back to the
    // generateVideo default of 121) still rejects out-of-range indices
    // up-front instead of failing late inside the worker / Python helper.
    // Keep this in sync with the default in services/videoGen/local.js.
    const effectiveNumFrames = body.numFrames != null ? Number(body.numFrames) : DEFAULT_NUM_FRAMES;
    resolvedKeyframes = [];
    let prevIndex = -1;
    for (let i = 0; i < body.keyframes.length; i++) {
      const kf = body.keyframes[i];
      const path = resolveGalleryImage(kf.file);
      if (!path) {
        await cleanupAllStaged();
        throw new ServerError(
          `keyframes[${i}].file not found in gallery: ${kf.file}`,
          { status: 400, code: 'KEYFRAME_GALLERY_MISS' },
        );
      }
      if (kf.index <= prevIndex) {
        await cleanupAllStaged();
        throw new ServerError(
          `keyframes indices must be strictly ascending; got ${prevIndex} then ${kf.index}`,
          { status: 400, code: 'KEYFRAME_INDICES_NOT_ASCENDING' },
        );
      }
      if (kf.index > effectiveNumFrames - 1) {
        await cleanupAllStaged();
        const numFramesLabel = body.numFrames != null
          ? `numFrames ${body.numFrames}`
          : `default numFrames ${DEFAULT_NUM_FRAMES}`;
        throw new ServerError(
          `keyframes[${i}].index ${kf.index} >= ${numFramesLabel}`,
          { status: 400, code: 'KEYFRAME_INDEX_OUT_OF_RANGE' },
        );
      }
      resolvedKeyframes.push({ path, index: kf.index });
      prevIndex = kf.index;
    }
  }

  // Native extend (ltx2 runtime): resolve the history id to a video file
  // path under data/videos/ and forward it as extendFromVideoPath. Reject
  // a missing/tampered id rather than silently falling back to t2v —
  // surfaces a clear error to the user instead of producing wrong content.
  let extendFromVideoPath = null;
  if (body.extendFromVideoId) {
    const history = await loadHistory();
    const videoEntry = history.find((h) => h.id === body.extendFromVideoId);
    if (!videoEntry) {
      // cleanupAllStaged covers durable copies that may have been written
      // before this validation point — extend mode and image uploads are
      // mutually exclusive in the UI but the route doesn't enforce that,
      // so be defensive.
      await cleanupAllStaged();
      throw new ServerError(
        `extendFromVideoId not found in history: ${body.extendFromVideoId}`,
        { status: 404, code: 'EXTEND_SOURCE_NOT_FOUND' },
      );
    }
    const candidate = safeUnder(PATHS.videos, videoEntry.filename);
    if (!candidate || !existsSync(candidate)) {
      await cleanupAllStaged();
      throw new ServerError(
        `extendFromVideoId resolved to a missing file: ${videoEntry.filename}`,
        { status: 404, code: 'EXTEND_SOURCE_FILE_MISSING' },
      );
    }
    extendFromVideoPath = candidate;
  }

  const effectiveChunks = body.mode === 'a2v' ? 1 : (body.chunks ?? 1);

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
      audioFilePath,
      uploadedTempPath,
      uploadedTempPaths: extraUploadedTempPaths,
      lastImagePath,
      keyframes: resolvedKeyframes,
      extendFromVideoPath,
      mode: body.mode,
      imageStrength: body.imageStrength,
      chunks: effectiveChunks,
    },
  });
  // Match the legacy response shape (jobId, generationId, filename, model,
  // mode) so existing client code keeps working; add status+position for
  // the queue. effectiveModelId was resolved at the top of the handler.
  res.json({ jobId, generationId: jobId, filename: `${jobId}.mp4`, model: effectiveModelId, mode: 'local', status, position });
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

// History ids are produced by crypto.randomUUID(), so validate them as
// proper UUIDs rather than the looser /^[a-f0-9-]{36}$/ pattern (which
// happily accepts e.g. 36 hyphens). Matches the .uuid() usage in the
// other route schemas.
const historyIdSchema = z.string().uuid('invalid history id');

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
