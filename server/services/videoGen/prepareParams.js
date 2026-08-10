/**
 * prepareVideoGenParams — pre-dispatch preparation for POST /video-gen.
 *
 * Mirrors `services/imageGen/prepareParams.js`: everything between Zod
 * validation and the final `enqueueJob` call lives here, so the route stays a
 * thin parse → prepare → enqueue → respond shell.
 *
 * Handles, in this exact order (several checks depend on an earlier one having
 * run — see the inline notes before reordering anything):
 *   - resolve the effective backend through the #3231 pin ladder
 *   - validate modelId + local-python configuration
 *   - a2v / IC-LoRA mode↔upload pairing and reference-count bounds
 *   - stage multipart uploads into PATHS.uploads with rollback bookkeeping
 *   - grok short-circuit (grok reads only prompt/dims/source image/duration)
 *   - keyframe resolution + range checks
 *   - render-history resolution for native extend and IC references
 *   - LoRA-array normalization and chunk-count resolution
 *
 * On failure it unlinks every durable copy staged so far plus every multipart
 * temp file, then throws `ServerError` so the route's asyncHandler middleware
 * translates it into a 4xx/5xx response.
 *
 * `body` is mutated in place for the one field the legacy handler defaulted
 * (`mode` → 'fflf' when keyframes are supplied without an explicit mode); the
 * resolved value is also returned as `mode` so callers never need to re-read it.
 */

import { existsSync } from 'fs';
import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, resolveGalleryImage } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { isVideoModelTermsAccepted, acceptedVideoModelTerms, videoModelTermsError } from '../../lib/videoDisclosure.js';
import { videoLoraFamily } from '../../lib/runners.js';
import {
  IC_LORA_MODE_VALUES, icLoraSpecForMode,
  assertIcReferenceCount, describeIcReferenceRange,
} from '../../lib/icLoraWeights.js';
import { getSettings } from '../settings.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getTrack } from '../tracks/index.js';
import { VIDEO_GEN_MODE, resolveVideoMode } from './modes.js';
import {
  listVideoModels,
  defaultVideoModelId,
  BYOV_VIDEO_RUNTIMES,
  loadHistory,
  DEFAULT_NUM_FRAMES,
} from './local.js';
// Straight from the leaf, not through local.js: the suites that exercise this
// module mock local.js wholesale, and a mocked rule table would assert nothing.
import { videoModeContractError, videoChainUnsupportedError } from './modeContract.js';

/**
 * Best-effort unlink of every multipart temp file the parser wrote before the
 * handler ran. Exported because the route needs it on the Zod-parse failure
 * path, which happens before this service is ever called.
 *
 * @param {object} uploads - `req.files` keyed by fieldname (may be empty)
 */
export const cleanupMultipartTemp = async (uploads) => {
  for (const f of Object.values(uploads || {})) {
    if (f?.path) await unlink(f.path).catch(() => {});
  }
};

/**
 * Run `fn`, releasing everything staged so far if it throws or rejects, then
 * rethrow the original error unchanged (#3326).
 *
 * Per the repo's no-try/catch convention a rejected await bubbles straight to
 * the error middleware — skipping the explicit `cleanupStaged()` calls at each
 * throw site and orphaning every durable copy written so far (the job is never
 * enqueued, so the worker's cleanup never runs either). This wrapper is the
 * sanctioned exception for the same reason the `ensureDir` guard below is: the
 * cleanup is a resource-release obligation, not error handling. One guard
 * covers every rejection point at once and stays correct as new awaits appear.
 *
 * @param {() => Promise<any>|any} fn - work that may leave staged files behind
 * @param {() => Promise<void>} cleanupStaged - rollback hook (idempotent)
 */
export const withStagedRollback = async (cleanupStaged, fn) => {
  try {
    return await fn();
  } catch (err) {
    await cleanupStaged();
    throw err;
  }
};

/**
 * @param {object} opts
 * @param {object} opts.body    - validated + coerced body from Zod (mutated in place)
 * @param {object} opts.uploads - `req.files` from multer (may be empty)
 * @param {string[]} opts.localOnlyParamKeys - field names only the local runtimes
 *   consume; a request carrying any of them is not grok-deliverable. Passed in
 *   from the route (which owns their Zod schemas) so this module never has to
 *   import back into `routes/`.
 * @returns {Promise<object>} On the grok lane:
 *   `{ backend, grok, sourceImagePath, uploadedTempPath, cleanupStaged }`.
 *   On the local lane, additionally `{ pythonPath, effectiveModelId, mode,
 *   lastImagePath, audioFilePath, icReferencePaths, resolvedKeyframes,
 *   extendFromVideoPath, uploadedTempPaths, loras, effectiveChunks,
 *   effectiveChunkPrompts }`.
 *   `cleanupStaged` is the caller's rollback hook for anything that can still
 *   throw after this resolves (today: `enqueueJob`) — pass it to
 *   `withStagedRollback`.
 */
export async function prepareVideoGenParams({ body, uploads, localOnlyParamKeys }) {
  const settings = await getSettings();
  // #3231 Phase 4 — the video pin ladder. An explicit `body.backend` always
  // wins (the VideoGen page and the MV director board both send one); when
  // absent, consult the music-video target pin (for director-board renders)
  // and the install-wide `settings.videoGen.mode` via resolveVideoMode. A pin
  // is honored only for a grok-DELIVERABLE request shape — the grok lane reads
  // only prompt/dims/source-image/duration, so a request carrying local-only
  // machinery (a semantic mode beyond text/image, keyframes, audio, IC refs,
  // extend, LoRAs, a last frame, chunked renders) stays local rather than
  // silently dropping those inputs. A pin degrades; only an explicit backend
  // request errors.
  const grokDeliverable = (!body.mode || body.mode === 'text' || body.mode === 'image')
    // A named local model is local-only machinery in the same sense as the
    // fields below — grok has no model knob, so honoring a grok pin here
    // would silently discard the model the caller asked for (e.g. a media
    // requeue rebuilding a local render's config without a backend field).
    && !body.modelId
    && !localOnlyParamKeys.some((param) => body[param] !== undefined)
    && !uploads.lastImage && !body.lastImageFile
    && !uploads.audioFile
    && !uploads.icReference && !body.icReferenceVideoIds?.length && !body.icReferenceImageFiles?.length
    && !body.extendFromVideoId
    && !body.keyframes?.length
    && !body.loraFilenames?.length
    && !(body.chunks != null && Number(body.chunks) > 1);
  const backend = body.backend
    || (grokDeliverable
      ? resolveVideoMode(null, settings, { target: body.musicVideo ? RENDER_TARGET.MUSIC_VIDEO : null })
      : VIDEO_GEN_MODE.LOCAL);
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
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
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      `Unknown modelId: ${body.modelId}`,
      { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' },
    );
  }
  // Reject a gated model here so the caller gets a synchronous, actionable 403
  // instead of a doomed queue entry. The render itself re-checks (local.js) —
  // this is the early half of the same gate, authorized by the same recorded
  // acknowledgement (POST /api/video-gen/model-terms).
  if (backend !== VIDEO_GEN_MODE.GROK && effectiveModel
    && !isVideoModelTermsAccepted(effectiveModel, acceptedVideoModelTerms(settings))) {
    await cleanupMultipartTemp(uploads);
    throw videoModelTermsError(effectiveModel);
  }
  // Reject up-front when the local python isn't configured AND the model's
  // runtime needs it. ltx2/wan22/hunyuan bring their own venv (resolved
  // inside buildArgs), so they must NOT be blocked by the legacy mlx_video
  // pythonPath setting. Without this gate, the queue would happily accept
  // a job that's known to fail and only surface it asynchronously on SSE,
  // polluting the persisted queue with a doomed entry. The allowlist is
  // shared with services/videoGen/local.js so the route and worker stay
  // in sync.
  const runtimeBringsOwnVenv = effectiveModel && BYOV_VIDEO_RUNTIMES.has(effectiveModel.runtime);
  if (!pythonPath && !runtimeBringsOwnVenv && backend !== 'grok') {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }

  // Track every durable file we've already copied into PATHS.uploads so a
  // *later* staging failure can roll them back. Without this, staging
  // sourceImage successfully then failing on lastImage would leave the
  // sourceImage durable copy orphaned (the job is never enqueued, so the
  // worker's cleanup never runs).
  const stagedDurablePaths = [];
  const cleanupStaged = async () => {
    for (const p of stagedDurablePaths) await unlink(p).catch(() => {});
    await cleanupMultipartTemp(uploads);
  };

  // #3326 — every *explicit* throw below already calls cleanupStaged(), but a
  // plain rejected await (getMusicVideoProject / getTrack / loadHistory) would
  // bubble straight past them and orphan up to the full multipart size cap
  // under data/uploads. One guard around the whole staging region covers every
  // rejection point at once, and stays correct as new awaits are added.
  return withStagedRollback(cleanupStaged, () => resolvePreparedParams({
    body, uploads, settings, backend, pythonPath,
    effectiveModel, effectiveModelId, stagedDurablePaths, cleanupStaged,
  }));
}

/**
 * The staging + resolution region, split out so `prepareVideoGenParams` can
 * wrap it in a single rollback guard (#3326) without indenting 400 lines.
 * Every explicit throw here still calls `cleanupStaged()` itself so the
 * unwind order stays identical to the pre-extraction handler; `unlink` is
 * best-effort and idempotent, so the outer guard's second call is harmless.
 */
async function resolvePreparedParams({
  body, uploads, settings, backend, pythonPath,
  effectiveModel, effectiveModelId, stagedDurablePaths, cleanupStaged,
}) {
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
      await cleanupStaged();
      throw new ServerError(
        `Failed to stage upload to durable location: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOAD_STAGE_FAILED' },
      );
    }
    await unlink(file.path).catch(() => {});
    stagedDurablePaths.push(durablePath);
    return durablePath;
  };

  // Music-video a2v jobs reuse an existing library track rather than uploading
  // the same song for every cut. Copy it into the queue-owned uploads area so
  // the worker may safely delete its input on completion without ever touching
  // the source track under data/music.
  const stageExistingAudioDurable = async (sourcePath) => {
    const ext = extname(sourcePath) || '.bin';
    const durablePath = join(PATHS.uploads, `video-audio-${randomUUID()}${ext}`);
    await copyFile(sourcePath, durablePath).catch(async (err) => {
      await unlink(durablePath).catch(() => {});
      await cleanupStaged();
      throw new ServerError(
        `Failed to stage project audio: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_AUDIO_STAGE_FAILED' },
      );
    });
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
  if (body.mode === 'a2v' && !uploads.audioFile && !body.musicVideo) {
    await cleanupStaged();
    throw new ServerError(
      'a2v mode requires an audioFile upload or a music-video project audio source.',
      { status: 400, code: 'VIDEO_GEN_AUDIO_REQUIRED' },
    );
  }
  if (uploads.audioFile && body.mode !== 'a2v') {
    await cleanupStaged();
    throw new ServerError(
      `audioFile upload is only valid with mode='a2v' (got mode='${body.mode || 'unset'}').`,
      { status: 400, code: 'VIDEO_GEN_AUDIO_MODE_MISMATCH' },
    );
  }
  // IC-LoRA remix (mode='ic-control', …). Mirrors the a2v pairing checks: the
  // reference channel is what makes the mode meaningful, and an IC upload
  // outside an IC mode would be silently dropped by the worker.
  const icSpec = icLoraSpecForMode(body.mode);
  if (icSpec) {
    // The grok backend short-circuits below this point (it only reads
    // prompt/dims/source-image), so an IC request routed there would enqueue a
    // plain grok render with the reference clip silently dropped. The client's
    // mode bar snaps grok back to text/image, but reject explicitly so a direct
    // caller gets an error instead of a wrong-looking clip.
    if (body.backend === 'grok') {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode runs on the local ltx2 runtime — it isn't available on the Grok backend.`,
        { status: 400, code: 'IC_LORA_REQUIRES_LOCAL_BACKEND' },
      );
    }
    // Each weight takes exactly ONE kind of reference. An image-kind weight fed a
    // clip (or vice versa) doesn't error inside the pipeline — it produces
    // plausible-looking garbage — so reject the cross-kind fields explicitly
    // rather than silently dropping them.
    const wantsImages = icSpec.referenceKind === 'image';
    const videoShapePresent = !!uploads.icReference || !!body.icReferenceVideoIds?.length;
    if (wantsImages && videoShapePresent) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode conditions on still images — pass gallery filenames as icReferenceImageFiles, not icReference / icReferenceVideoIds.`,
        { status: 400, code: 'IC_LORA_REFERENCE_KIND_MISMATCH' },
      );
    }
    if (!wantsImages && body.icReferenceImageFiles?.length) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode conditions on a reference clip — pass icReference / icReferenceVideoIds, not icReferenceImageFiles.`,
        { status: 400, code: 'IC_LORA_REFERENCE_KIND_MISMATCH' },
      );
    }
    // The upload wins over gallery picks, so a request carrying both would
    // silently drop the picks. Force one shape per request instead. Checked
    // BEFORE the count bounds below, which would otherwise report a misleading
    // "needs exactly 1, got 2" for what is really a mixed-shape request.
    if (uploads.icReference && body.icReferenceVideoIds?.length) {
      await cleanupStaged();
      throw new ServerError(
        'icReference upload cannot be combined with icReferenceVideoIds — pass one reference shape per request.',
        { status: 400, code: 'IC_LORA_REFERENCE_CONFLICT' },
      );
    }
    // Reference count is the weight's contract, asserted once here against the
    // registry that owns the bounds. Checked before staging so a bad request only
    // unlinks the cheap OS temp file, and resolution below can't change the
    // count: an upload is exactly 1, every history id resolves 1:1 or throws, and
    // every gallery filename resolves 1:1 or throws.
    const refCount = wantsImages
      ? (body.icReferenceImageFiles?.length || 0)
      : (uploads.icReference ? 1 : 0) + (body.icReferenceVideoIds?.length || 0);
    if (refCount === 0) {
      // Special-cased ahead of the bounds assertion purely for actionability —
      // "needs exactly 1; got 0" doesn't tell the caller HOW to supply one.
      await cleanupStaged();
      throw new ServerError(
        wantsImages
          ? `${icSpec.label} mode requires ${describeIcReferenceRange(icSpec)} reference images — pick them from your gallery (icReferenceImageFiles).`
          : `${icSpec.label} mode requires a reference ${icSpec.referenceKind} — upload one (multipart field: icReference) or pick a prior render (icReferenceVideoIds).`,
        { status: 400, code: 'IC_LORA_REFERENCE_REQUIRED' },
      );
    }
    if (refCount < icSpec.minReferences || refCount > icSpec.maxReferences) {
      await cleanupStaged();
      assertIcReferenceCount(icSpec, refCount, (msg) => new ServerError(msg, {
        status: 400, code: 'IC_LORA_REFERENCE_COUNT',
      }));
    }
    // IC-LoRA remix is an LTX-2 primitive (ICLoraPipeline). Fail before enqueue
    // so a bad modelId can't pollute the persisted queue with a doomed job.
    if (effectiveModel && effectiveModel.runtime !== 'ltx2') {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
        { status: 400, code: 'IC_LORA_REQUIRES_LTX2' },
      );
    }
    // Chained renders re-seed each chunk from the previous chunk's last frame;
    // an IC render is conditioned on a whole reference clip instead, so there's
    // no defined semantic for chunk 2+ and it would silently ignore the mode.
    if (body.chunks != null && Number(body.chunks) > 1) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode cannot be combined with chunks > 1 — the reference clip anchors a single render.`,
        { status: 400, code: 'IC_LORA_CHUNKS_CONFLICT' },
      );
    }
  } else if (uploads.icReference || body.icReferenceVideoIds?.length || body.icReferenceImageFiles?.length) {
    await cleanupStaged();
    throw new ServerError(
      `IC-LoRA reference inputs are only valid with an IC remix mode (${IC_LORA_MODE_VALUES.join(', ')}); got mode='${body.mode || 'unset'}'.`,
      { status: 400, code: 'IC_LORA_MODE_MISMATCH' },
    );
  }
  // a2v needs the dgrauet runtime — the legacy mlx_video pipeline has no
  // audio-conditioned mode. The worker also catches this in buildArgs (with
  // A2V_REQUIRES_LTX2), but checking here keeps the route's "fail fast
  // before enqueue" contract so a bad modelId can't pollute the persisted
  // queue with a doomed entry.
  if (body.mode === 'a2v' && effectiveModel && effectiveModel.runtime !== 'ltx2') {
    await cleanupStaged();
    throw new ServerError(
      `a2v mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
      { status: 400, code: 'A2V_REQUIRES_LTX2' },
    );
  }
  // Chunk chaining needs image-to-video on any runtime — the same rule
  // generateChainedVideo enforces at dispatch, applied once here so a doomed
  // chain never reaches the persisted queue.
  if (body.chunks != null && Number(body.chunks) > 1) {
    const chainError = videoChainUnsupportedError(effectiveModel);
    if (chainError) {
      await cleanupStaged();
      throw chainError;
    }
  }
  // Mode ↔ source pairing for every gated runtime, resolved through the one
  // contract the render boundary also throws from (#3736), so the two entry
  // points can't disagree about which shapes are legal or which code they
  // return. Runs before durable upload staging, keeping rejection cleanup cheap.
  const hasDeclaredFirstImage = Boolean(uploads.sourceImage || body.sourceImageFile);
  const hasDeclaredLastImage = Boolean(uploads.lastImage || body.lastImageFile);
  // Pinned here rather than re-derived at the resolved pass below: once a
  // declared gallery pick fails to resolve, "was this an i2v request?" can only
  // be answered from what the caller declared.
  const declaredMode = body.mode || (hasDeclaredFirstImage ? 'image' : 'text');
  const modeContractError = videoModeContractError({
    model: effectiveModel,
    mode: declaredMode,
    hasFirstImage: hasDeclaredFirstImage,
    hasLastImage: hasDeclaredLastImage,
    keyframes: body.keyframes,
    extendFromVideo: body.extendFromVideoId,
  });
  if (modeContractError) {
    await cleanupStaged();
    throw modeContractError;
  }
  // MiniMax H3's released MLX path is fixed-24fps, joint A/V and CFG-distilled.
  // These are the runtime's non-mode controls; the mode gate above already ran.
  // Fail before queue persistence so a direct API caller cannot enqueue a
  // request whose controls the runtime would silently ignore.
  if (effectiveModel?.runtime === 'minimax_h3') {
    if (body.negativePrompt?.trim()) {
      await cleanupStaged();
      throw new ServerError(
        'MiniMax H3 is CFG-distilled and does not accept a negative prompt.',
        { status: 400, code: 'MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED' },
      );
    }
    if (body.disableAudio === true || body.disableAudio === 'true') {
      await cleanupStaged();
      throw new ServerError(
        'MiniMax H3 jointly generates video and audio; its audio track cannot be disabled.',
        { status: 400, code: 'MINIMAX_H3_AUDIO_REQUIRED' },
      );
    }
    if (body.tiling && body.tiling !== 'auto') {
      await cleanupStaged();
      throw new ServerError(
        'MiniMax H3 does not expose a tiling mode.',
        { status: 400, code: 'MINIMAX_H3_TILING_UNSUPPORTED' },
      );
    }
    const frames = Number(body.numFrames ?? effectiveModel.defaultFrames);
    if (!Array.isArray(effectiveModel.frameOptions) || !effectiveModel.frameOptions.includes(frames)) {
      await cleanupStaged();
      throw new ServerError(
        `MiniMax H3 requires a 17n+5 frame count between 124 and 362; got ${frames}.`,
        { status: 400, code: 'MINIMAX_H3_INVALID_FRAME_COUNT' },
      );
    }
    const fps = Number(body.fps ?? 24);
    if (fps !== 24) {
      await cleanupStaged();
      throw new ServerError(
        `MiniMax H3 runs at a fixed 24 fps; got ${fps}.`,
        { status: 400, code: 'MINIMAX_H3_INVALID_FPS' },
      );
    }
  }
  // Wan profiles have a narrower temporal-shape contract than the shared
  // request schema can express (the mode side is the shared gate above). Mirror
  // the worker's frame-grid guard here so a direct API caller cannot persist a
  // job that is already known to fail.
  if (effectiveModel?.runtime === 'wan22') {
    const numFrames = body.numFrames != null ? Number(body.numFrames) : DEFAULT_NUM_FRAMES;
    const frameStride = Number(effectiveModel.frameStride);
    if (Number.isFinite(frameStride) && frameStride > 0 && (numFrames - 1) % frameStride !== 0) {
      await cleanupStaged();
      throw new ServerError(
        `${effectiveModel.name} requires a ${frameStride}n+1 frame count; got ${numFrames}.`,
        { status: 400, code: 'WAN22_INVALID_FRAME_COUNT' },
      );
    }
  }

  let sourceImagePath = null;
  let lastImagePath = null;
  let audioFilePath = null;
  let icReferenceUploadPath = null;
  let uploadedTempPath = null;
  const extraUploadedTempPaths = [];
  if (uploads.sourceImage || uploads.lastImage || uploads.audioFile || uploads.icReference) {
    // Ensure the durable uploads dir exists before staging. Wrapped in
    // try/catch so a permission/disk failure here still cleans up the
    // multipart temp uploads instead of leaking them in the OS temp dir.
    try {
      await ensureDir(PATHS.uploads);
    } catch (err) {
      await cleanupStaged();
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
  // Re-run the same contract now that the gallery pick has been resolved to a
  // real path: the pre-staging pass only saw that a filename was *declared*, so
  // a stale/missing gallery entry would otherwise fall through to a text render.
  const resolvedModeError = videoModeContractError({
    model: effectiveModel,
    mode: declaredMode,
    hasFirstImage: Boolean(sourceImagePath),
    hasLastImage: hasDeclaredLastImage,
    sourceResolved: true,
    keyframes: body.keyframes,
    extendFromVideo: body.extendFromVideoId,
  });
  if (resolvedModeError) {
    await cleanupStaged();
    throw resolvedModeError;
  }
  // Music Video director-board renders are always i2v FROM the scene's reference
  // frame (#1760 Phase 1). resolveGalleryImage returns null for a missing/invalid
  // gallery file (mustExist defaults true), and an unresolved source would
  // otherwise fall through to a text-to-video render — silently attaching a clip
  // that ignores the frame the director chose. Reject instead, so a stale/deleted
  // reference frame surfaces as a clear error rather than a wrong-looking clip.
  if (body.musicVideo && !sourceImagePath) {
    await cleanupStaged();
    throw new ServerError(
      'Music Video scene render needs a resolvable reference frame (sourceImageFile) — the scene\'s frame is missing or could not be resolved.',
      { status: 400, code: 'MUSIC_VIDEO_SOURCE_REQUIRED' },
    );
  }
  // Grok backend short-circuit (#2859 phase 2): everything past this point —
  // last-frame/keyframe staging, extend resolution, LoRA gating — is
  // local-runtime machinery grok doesn't use. sourceImagePath (upload or
  // gallery pick) is already resolved above, so an i2v render animates that
  // frame and a plain prompt runs the image-first image_gen → image_to_video
  // flow inside the provider. `backend` (not `body.backend`) so the #3231
  // pin ladder routes an unpinned-request grok default through here too.
  if (backend === 'grok') {
    const grok = settings.imageGen?.grok || {};
    if (!grok.enabled) {
      await cleanupStaged();
      throw new ServerError(
        'Grok Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'GROK_IMAGEGEN_DISABLED' },
      );
    }
    return { backend, grok, sourceImagePath, uploadedTempPath, cleanupStaged };
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
  } else if (body.mode === 'a2v' && body.musicVideo) {
    const project = await getMusicVideoProject(body.musicVideo.projectId);
    const sceneExists = project?.scenes?.some((scene) => scene.sceneId === body.musicVideo.sceneId);
    if (!project || !sceneExists) {
      await cleanupStaged();
      throw new ServerError('Music-video project or scene not found', { status: 404, code: 'NOT_FOUND' });
    }
    const track = project.trackId ? await getTrack(project.trackId) : null;
    const filename = track?.audioFilename || project.uploadedAudioFilename;
    const sourceAudioPath = filename ? safeUnder(PATHS.music, filename) : null;
    if (!sourceAudioPath || !existsSync(sourceAudioPath)) {
      await cleanupStaged();
      throw new ServerError('Music-video project audio is unavailable', { status: 400, code: 'VIDEO_GEN_PROJECT_AUDIO_MISSING' });
    }
    audioFilePath = await stageExistingAudioDurable(sourceAudioPath);
    extraUploadedTempPaths.push(audioFilePath);
  }
  if (uploads.icReference) {
    // IC-LoRA reference clip — same durable staging + cleanup tracking as the
    // audio upload above. A history-picked reference needs neither (it already
    // lives under data/videos/ and must survive the render).
    icReferenceUploadPath = await stageUploadDurable(uploads.icReference, 'ic-ref');
    extraUploadedTempPaths.push(icReferenceUploadPath);
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
      await cleanupStaged();
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
      await cleanupStaged();
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
      await cleanupStaged();
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
      await cleanupStaged();
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
        await cleanupStaged();
        throw new ServerError(
          `keyframes[${i}].file not found in gallery: ${kf.file}`,
          { status: 400, code: 'KEYFRAME_GALLERY_MISS' },
        );
      }
      if (kf.index <= prevIndex) {
        await cleanupStaged();
        throw new ServerError(
          `keyframes indices must be strictly ascending; got ${prevIndex} then ${kf.index}`,
          { status: 400, code: 'KEYFRAME_INDICES_NOT_ASCENDING' },
        );
      }
      if (kf.index > effectiveNumFrames - 1) {
        await cleanupStaged();
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

  // Resolve a render-history id to its on-disk video under data/videos/.
  // Shared by native extend and the IC-LoRA reference channel: both let the
  // user point at a prior render, and both must reject a missing/tampered id
  // rather than silently degrading to a text render (which would produce
  // wrong-looking content with no error). `label` names the field in the error
  // so the two callers stay distinguishable.
  const resolveHistoryVideoPath = async (id, { history, label, notFoundCode, missingFileCode }) => {
    const videoEntry = history.find((h) => h.id === id);
    if (!videoEntry) {
      // cleanupStaged covers durable copies that may have been written
      // before this validation point — these modes and image uploads are
      // mutually exclusive in the UI but the route doesn't enforce that,
      // so be defensive.
      await cleanupStaged();
      throw new ServerError(`${label} not found in history: ${id}`, { status: 404, code: notFoundCode });
    }
    const candidate = safeUnder(PATHS.videos, videoEntry.filename);
    if (!candidate || !existsSync(candidate)) {
      await cleanupStaged();
      throw new ServerError(
        `${label} resolved to a missing file: ${videoEntry.filename}`,
        { status: 404, code: missingFileCode },
      );
    }
    return candidate;
  };

  // Render history is read by both the extend and IC reference paths. Load it
  // lazily and at most once — the file grows with every render, so a request
  // carrying both would otherwise re-read and re-parse megabytes.
  let historyCache = null;
  const getHistory = async () => (historyCache ??= await loadHistory());

  // Native extend (ltx2 runtime): forward the resolved path as
  // extendFromVideoPath.
  let extendFromVideoPath = null;
  if (body.extendFromVideoId) {
    extendFromVideoPath = await resolveHistoryVideoPath(body.extendFromVideoId, {
      history: await getHistory(),
      label: 'extendFromVideoId',
      notFoundCode: 'EXTEND_SOURCE_NOT_FOUND',
      missingFileCode: 'EXTEND_SOURCE_FILE_MISSING',
    });
  }

  // IC-LoRA reference channel: gallery stills for an image-kind weight, else the
  // staged upload or the picked prior render(s). The route already rejected the
  // cross-kind and both-present cases (and asserted the count against the weight's
  // bounds) above, so exactly one branch contributes and each entry resolves 1:1
  // or throws.
  let icReferencePaths = null;
  if (icSpec) {
    if (icSpec.referenceKind === 'image') {
      // Gallery-only, exactly like `keyframes` — same path-traversal guard, same
      // "reject up-front so the queue never accepts a doomed job" contract. The
      // service materializes each still into a VAE-compatible clip at render
      // resolution (the IC reference channel is a video encoder end-to-end).
      icReferencePaths = [];
      for (let i = 0; i < body.icReferenceImageFiles.length; i++) {
        const file = body.icReferenceImageFiles[i];
        const path = resolveGalleryImage(file);
        if (!path) {
          await cleanupStaged();
          throw new ServerError(
            `icReferenceImageFiles[${i}] not found in gallery: ${file}`,
            { status: 400, code: 'IC_LORA_REFERENCE_GALLERY_MISS' },
          );
        }
        icReferencePaths.push(path);
      }
    } else if (icReferenceUploadPath) {
      icReferencePaths = [icReferenceUploadPath];
    } else {
      const history = await getHistory();
      icReferencePaths = [];
      for (const id of body.icReferenceVideoIds || []) {
        icReferencePaths.push(await resolveHistoryVideoPath(id, {
          history,
          label: 'icReferenceVideoIds entry',
          notFoundCode: 'IC_LORA_REFERENCE_NOT_FOUND',
          missingFileCode: 'IC_LORA_REFERENCE_FILE_MISSING',
        }));
      }
    }
  }

  // Collapse the parallel loraFilenames/loraScales arrays into the internal
  // `[{ filename, scale }]` shape the service (resolveVideoLoras) and the
  // resume param echo consume. A defaulted scale keeps the worker contract
  // simple. Empty (picker cleared) → undefined.
  const loras = Array.isArray(body.loraFilenames) && body.loraFilenames.length
    ? body.loraFilenames.map((filename, i) => ({
        filename,
        scale: typeof body.loraScales?.[i] === 'number' ? body.loraScales[i] : 1.0,
      }))
    : undefined;

  // Video LoRAs fuse on two runtimes: dgrauet's `ltx2` (via the pipeline's
  // _pending_loras hook, see scripts/generate_ltx2.py) and non-quantized
  // LTX-2.x `mlx_video` models (merged offline by scripts/generate_av_lora.py).
  // videoLoraFamily() returns null for everything else (wan22 / hunyuan /
  // quantized mlx_video) — reject up-front so a bad modelId can't enqueue a
  // doomed job that only fails in the worker.
  if (loras && effectiveModel && !videoLoraFamily(effectiveModel)) {
    await cleanupStaged();
    throw new ServerError(
      `LoRAs aren't supported on this model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}" — use an LTX-2.x model (dgrauet ltx2, or the bf16 Unified Beta).`,
      { status: 400, code: 'LORAS_REQUIRE_LTX2' },
    );
  }

  // a2v and the IC remix modes both anchor a single render (audio track /
  // reference clip), so chaining is meaningless — pin to 1 chunk. The IC path
  // also hard-rejects an explicit chunks>1 above; this covers the default.
  const effectiveChunks = (body.mode === 'a2v' || icSpec) ? 1 : (body.chunks ?? 1);

  // Per-chunk prompt beats (#3695) — only meaningful once the RESOLVED request
  // really chains, so a single-chunk render (or an a2v/IC one pinned to 1 above)
  // drops the list entirely rather than persisting a stale array into job params
  // that a resume would replay into the form.
  //
  // Sizing is forgiving in both directions: a stale overlong list (the user
  // typed beats, then lowered the chunk count) is truncated to the resolved
  // count, and a short list is left short — generateChainedVideo falls back to
  // the main prompt for any index the list doesn't cover. Blank entries become
  // an explicit null (absent beat → main prompt) rather than an empty string the
  // runner would render as an empty prompt. An all-blank list collapses to
  // undefined so "the user cleared every beat" and "no beats were sent" persist
  // identically instead of storing a useless array of nulls.
  const normalizedChunkPrompts = effectiveChunks > 1 && Array.isArray(body.chunkPrompts)
    ? body.chunkPrompts.slice(0, effectiveChunks)
      .map((p) => (typeof p === 'string' && p.trim() !== '' ? p.trim() : null))
    : undefined;
  const effectiveChunkPrompts = normalizedChunkPrompts?.some(Boolean)
    ? normalizedChunkPrompts
    : undefined;

  return {
    backend,
    pythonPath,
    effectiveModelId,
    mode: body.mode,
    sourceImagePath,
    lastImagePath,
    audioFilePath,
    icReferencePaths,
    resolvedKeyframes,
    extendFromVideoPath,
    uploadedTempPath,
    uploadedTempPaths: extraUploadedTempPaths,
    loras,
    effectiveChunks,
    effectiveChunkPrompts,
    cleanupStaged,
  };
}
