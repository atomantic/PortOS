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
import { spawn } from 'child_process';
import os from 'os';
import { z } from 'zod';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { uploadFields } from '../lib/multipart.js';
import { PATHS } from '../lib/fileUtils.js';
import { videoModelTermsSchema } from '../lib/validation.js';
import { grokVideoDurationSchema } from '../lib/sharedSchemas.js';
import { MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES } from '../lib/videoContinuity.js';
import {
  VIDEO_BACKEND_DISCLOSURES, isVideoModelTermsAccepted, acceptedVideoModelTerms,
  videoModelTermsGateId, videoModelTermsError,
} from '../lib/videoDisclosure.js';
import { IMAGE_GEN_MODE } from '../services/imageGen/modes.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { checkPackages, isAllowedPython } from '../lib/pythonSetup.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { createLineReader } from '../lib/streamLines.js';
import {
  listVideoModels,
  defaultVideoModelId,
  BYOV_RUNTIME_INFO,
  isByovRuntimeInstalled,
  isByovRuntimeReady,
  isByovRuntimeCurrent,
  invalidateByovReadyCache,
  invalidateByovLoraCapabilityCache,
  invalidateRuntimeFingerprintCache,
  resolveRuntimeFingerprint,
  loadHistory,
  deleteHistoryItem,
  setHistoryItemHidden,
  extractLastFrame,
  stitchVideos,
  upscaleHistoryItem,
  resolveFflfLtx2PixelBudget,
} from '../services/videoGen/local.js';
import { prepareVideoGenParams, cleanupMultipartTemp, withStagedRollback } from '../services/videoGen/prepareParams.js';
import { enqueueJob, attachSseClient, cancelJob, listJobs } from '../services/mediaJobQueue/index.js';
import { repoForModel, getTextEncoderRepo, isHfRepoId } from '../lib/mediaModels.js';
import {
  IC_LORA_MODE_VALUES, icLoraSpecForMode, icLoraRepos, listIcLoraWeights,
  icLoraWeightCandidates, findCachedIcLoraWeight,
} from '../lib/icLoraWeights.js';
import {
  downloadableVideoTextEncoders, downloadableVideoTextEncoder, publicTextEncoderOption,
  isStockTextEncoder,
} from '../lib/videoTextEncoders.js';
import {
  inspectModelCache, verifyModelCache, repairModelCache, repairCachedFile,
  verifyCachedRepoFiles, repairCachedRepoFiles, summarizeVerify, aggregateVerifies,
  isSafeHfRepoRelativePath,
} from '../lib/hfCache.js';
import { startHfDownloadStream, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';

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
// one audio upload (audioFile); the IC-LoRA remix modes take one reference
// video upload (icReference). 100MB covers audio cases too (LTX-2's a2v
// expects only seconds of audio in practice). Per-fieldname mime filter
// rejects mismatched parts up-front so a stray .mp4 drag-drop can't get
// staged under any of these fields.
const frameImageUpload = uploadFields(['sourceImage', 'lastImage', 'audioFile', 'icReference'], {
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isImageField = file.fieldname === 'sourceImage' || file.fieldname === 'lastImage';
    const isAudioField = file.fieldname === 'audioFile';
    const isVideoField = file.fieldname === 'icReference';
    const okImage = isImageField && file.mimetype.startsWith('image/');
    const okAudio = isAudioField && isAudioMime(file.mimetype, file.originalname);
    // IC-LoRA references are clips — the control weight reads structure/motion
    // out of a depth/pose/edge video, so only video/* is meaningful here.
    const okVideo = isVideoField && file.mimetype.startsWith('video/');
    cb(null, okImage || okAudio || okVideo);
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
// Coarse upper bound for any IC reference array, derived from the registry so a
// weight raising its own maxReferences doesn't get rejected by a stale literal in
// the schema before the per-mode assertion below can speak. Per-weight bounds are
// still enforced against the mode's own spec (assertIcReferenceCount).
const MAX_IC_REFERENCES = Math.max(...listIcLoraWeights().map((s) => s.maxReferences));

// Chain ceiling — 8 × ~5min ≈ 40min on an M3 Max keeps the worst-case wall time
// bounded. Shared by `chunks` and the per-chunk prompt list so the two can never
// drift apart.
const MAX_VIDEO_CHUNKS = 8;

// Coerce a multipart/JSON list field to an array. Multipart sends a SINGLE value
// as a bare string and repeated keys as an array; a JSON client may send an
// encoded list, and a client that must preserve blank entries' POSITIONS (see
// `chunkPrompts`) has to. Shared by every list field below so the coercion rule
// can't drift between them.
const listPreprocess = (v) => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') return v;
  if (v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { return [v]; } }
  return [v];
};

// Render controls that only the local runtimes understand. Keep their schemas
// together so Grok eligibility and request validation cannot drift when a new
// local-only knob is added.
export const LOCAL_ONLY_VIDEO_PARAMS = Object.freeze({
  numFrames: optionalInt(1, 1024, 'numFrames'),
  fps: optionalNum(1, 60, 'fps'),
  steps: optionalNum(1, 200, 'steps'),
  guidanceScale: optionalNum(0, 30, 'guidanceScale'),
  seed: optionalNum(0, Number.MAX_SAFE_INTEGER, 'seed'),
  imageStrength: optionalNum(0, 1, 'imageStrength'),
  tiling: z.enum(['auto', 'none', 'spatial', 'temporal']).optional(),
  // Which prompt conditioner reads the prompt (lib/videoTextEncoders.js).
  // Validated loosely here and resolved against the MODEL's own option list in
  // the service — the set is per-runtime, so a route-level enum would either
  // have to enumerate every runtime's options or reject a legitimate one.
  textEncoderId: z.string().min(1).max(64).optional(),
});

const generateBodySchema = z.object({
  // Render backend: the local runtimes (default) or the Grok Build CLI's
  // image-first image_to_video flow (#2859 phase 2). Grok ignores the
  // local-only knobs below; it reads prompt/negativePrompt, width/height
  // (mapped to an aspect ratio), sourceImageFile/sourceImage, and
  // grokDuration.
  backend: z.enum(['local', 'grok']).optional(),
  // Grok image_to_video clip length in seconds — the shared schema (see
  // lib/grokVideoClip.js for which lengths grok actually delivers). Multipart
  // bodies arrive as strings, so coerce first.
  grokDuration: z.preprocess(
    (v) => (v == null || v === '' ? undefined : Number(v)),
    grokVideoDurationSchema.optional(),
  ),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(8000).optional(),
  modelId: z.string().max(64).optional(),
  width: optionalNum(64, 2048, 'width'),
  height: optionalNum(64, 2048, 'height'),
  ...LOCAL_ONLY_VIDEO_PARAMS,
  audioStartSec: optionalNum(0, 36000, 'audioStartSec'),
  disableAudio: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  sourceImageFile: z.string().max(512).optional(),
  // Gallery-pick filename for the FFLF end-frame. The end-frame can also
  // arrive as a multipart `lastImage` upload (handled below) — when both
  // are present the upload wins, mirroring the sourceImage/sourceImageFile
  // precedence on the start-frame side.
  lastImageFile: z.string().max(512).optional(),
  // UI mode hint — backend only uses it for logging/branching; absence
  // falls back to inferring (sourceImage→i2v, no source→t2v).
  // IC-LoRA remix modes (`ic-control`, …) come from the weight registry so the
  // enum can never drift from what's actually installable.
  mode: z.enum(['text', 'image', 'fflf', 'extend', 'a2v', ...IC_LORA_MODE_VALUES]).optional(),
  // Chain N renders end-to-end: each chunk's last frame becomes the next
  // chunk's start frame, then ffmpeg concats them into one clip. 1..8 to
  // keep the worst-case wall time bounded (8 × ~5min ≈ 40min on M3 Max).
  chunks: optionalInt(1, MAX_VIDEO_CHUNKS, 'chunks'),
  // Optional per-chunk prompt beats for a chained render (#3695). Entry i
  // steers chunk i, so a longer shot can progress through an action instead of
  // replaying the same prompt at every seam. A blank entry is an explicit
  // fallback to the main `prompt` — that's why empty strings are accepted
  // rather than filtered here; prepareVideoGenParams normalizes them to null.
  // Rides as a JSON-encoded array (like `keyframes`) so blank middle entries
  // keep their position and a one-element list can't collapse to the bare
  // string multipart sends for a single repeated key — a bare string is still
  // accepted as a one-entry list for hand-rolled/JSON clients.
  chunkPrompts: z.preprocess(listPreprocess, z.array(z.string().max(8000)).max(MAX_VIDEO_CHUNKS).optional()),
  // How many of the prior chunk's frames each subsequent chunk conditions on.
  // A window carries motion across the seam where a single still can't; `0`
  // opts back into last-frame chaining, and absence takes the default. Only
  // meaningful on a runtime with an extend pipeline — elsewhere it's ignored,
  // not rejected. See lib/videoContinuity.js.
  contextFrames: optionalInt(MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES, 'contextFrames'),
  // History id of a prior render to extend natively (ltx2 runtime only —
  // routes through ExtendPipeline.extend_from_video which conditions on
  // the entire source video's latent rather than a single last frame).
  // The legacy chained-i2v path keeps using sourceImageFile.
  extendFromVideoId: z.string().guid().optional(),
  // IC-LoRA remix reference clip picked from render history instead of uploaded
  // (the `icReference` multipart upload wins when both are present, mirroring
  // the sourceImage/sourceImageFile precedence). Control/Colorize take exactly
  // one reference; Ingredients (a later phase) will take 2-8, hence the array.
  icReferenceVideoIds: z.preprocess(listPreprocess, z.array(z.string().guid()).min(1).max(MAX_IC_REFERENCES).optional()),
  // Ingredients-style IC references: 2-8 gallery STILLS, not clips. A separate
  // field from icReference / icReferenceVideoIds on purpose — those are
  // `video/*` and resolve against render history, and overloading them would
  // let a video ride into an image-kind weight (or vice versa) and produce
  // plausible-looking garbage. Gallery-only, exactly like `keyframes`: the
  // route resolves each basename under PATHS.images.
  icReferenceImageFiles: z.preprocess(
    listPreprocess,
    // Ceiling derived from the registry (the largest maxReferences any weight
    // declares), NOT a hardcoded 8 — a second literal here would silently
    // pre-empt the per-mode registry check with a 422 the moment a weight raised
    // its own maximum. This is only a coarse sanity bound; the real per-weight
    // rule is asserted below against the mode's own spec.
    z.array(z.string().min(1).max(512)).min(1).max(MAX_IC_REFERENCES).optional(),
  ),
  // Reference-video conditioning strength for the IC-LoRA channel. Distinct
  // from the IC-LoRA's own fusion strength (fixed at 1.0 server-side) and from
  // `icAttentionStrength`, which scales the conditioning ATTENTION.
  icStrength: optionalNum(0, 2, 'icStrength'),
  icAttentionStrength: optionalNum(0, 1, 'icAttentionStrength'),
  // Skip the IC pipeline's 2x upscale + refine — half-resolution output at
  // roughly half the wall time, useful for previewing a control clip's fit.
  icSkipStage2: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
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
  // Video LoRAs to fuse for this render (ltx2 runtime only). Sent as the SAME
  // universal contract image renders use — parallel `loraFilenames` +
  // `loraScales` arrays — NOT a bespoke shape. This is what lets a history
  // requeue via getRenderConfigForItem() (which emits exactly these fields)
  // round-trip with no per-page translation. Multipart sends each array as
  // repeated keys; a SINGLE entry arrives as a bare string and scales arrive as
  // strings, so wrap+coerce in preprocess (mirrors server/routes/imageGen.js).
  // `filename` rejects path separators here; the service re-validates with
  // assertSafeLoraFilename before touching disk.
  loraFilenames: z.preprocess(
    (v) => (v == null || v === '') ? undefined : (Array.isArray(v) ? v : [v]),
    z.array(z.string().min(1).max(255).regex(/^[^/\\]+\.safetensors$/i, 'filename must be a bare .safetensors basename')).max(8).optional(),
  ),
  loraScales: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      const raw = Array.isArray(v) ? v : [v];
      return raw.map((x) => (typeof x === 'string' && x !== '' ? Number(x) : x));
    },
    z.array(z.number().min(0).max(2)).max(8).optional(),
  ),
  // Music Video director-board i2v render (#1760 Phase 1). When present, the
  // mediaJobQueue completion hook (`musicVideoSceneVideoHook`) files the finished
  // clip's history id onto the project scene's `videoHistoryId` — durably, even
  // if the director board unmounted mid-render (the i2v counterpart to the
  // Phase 1b reference-frame `musicVideo` tag on the image route). The shot
  // prompt rides in `prompt` and the reference frame in `sourceImageFile`, so
  // the tag carries only the destination identity. The video route always sends
  // multipart, so the object arrives as a JSON string — preprocess-parse it
  // before the schema sees it (mirrors `keyframes` above).
  musicVideo: z.preprocess(
    (v) => {
      if (v == null || v === '') return undefined;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    },
    z.object({
      projectId: z.string().min(1).max(200),
      sceneId: z.string().min(1).max(200),
    }).optional(),
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
    // Each entry carries its optional `disclosure` block (provenance, weights/
    // runtime licenses, pinned-snapshot download size) straight off the
    // registry — absent for custom models, which the UI renders as Unknown.
    models: listVideoModels(),
    defaultModel: defaultVideoModelId(),
    // Server-owned execution + policy scope per render backend (#3674). The
    // client renders these strings verbatim so the wording can't drift between
    // the two surfaces.
    backendDisclosures: VIDEO_BACKEND_DISCLOSURES,
    // Authoritative list of bring-your-own-venv runtimes — lets the client
    // gate the install-banner probe without hardcoding the same Set.
    byovRuntimes: Object.keys(BYOV_RUNTIME_INFO),
    // Total system memory in GB — the client uses this to auto-select the
    // highest-memory mode-compatible model that fits on this machine.
    // Rounded to nearest GB; sub-GB precision isn't useful for the
    // model-size comparison and reads more cleanly in the UI.
    systemMemoryGb: Math.round(os.totalmem() / 1024 ** 3),
    // Effective FFLF/ltx2 stage-2 pixel-frame budget (honors
    // FFLF_LTX2_PIXEL_BUDGET). The multi-keyframe picker mirrors the
    // back-solve so it can reject out-of-budget keyframe indices before
    // submit instead of letting the worker 400 mid-render.
    fflfLtx2PixelBudget: resolveFflfLtx2PixelBudget(),
    // Runtime fingerprint — host chip/os + resolved ltx/mlx/torch versions per
    // installed BYOV runtime — so the UI can show the exact numerical stack and
    // bug reports for garbled/"mosaic" output carry the version info that makes
    // them actionable (#1325). Best-effort: a venv that fails to probe reports
    // `{ error }` and never blocks the rest of the status payload. The resolver
    // is already non-throwing (each probe resolves to `{ error }`), but guard
    // with a catch as defense-in-depth so a runtime-block failure can never
    // reject the whole /status response.
    runtime: await resolveRuntimeFingerprint().catch(() => null),
  });
}));

// Restricted-model license acknowledgement (#3674 follow-up). Acceptance is a
// fact about the operator of this install, not about one browser or one
// request, so it lives in settings and every render surface reads it: the
// Video Gen page, the music video director board, and producers with no UI to
// prompt through (queued jobs, pipeline stages, agent runs).
router.get('/model-terms', asyncHandler(async (_req, res) => {
  res.json({ accepted: acceptedVideoModelTerms(await getSettings()) });
}));

router.post('/model-terms', asyncHandler(async (req, res) => {
  const parsed = videoModelTermsSchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const { termsId, accepted } = parsed.data;
  // Only ids a shipped model actually declares are storable — otherwise a
  // typo'd or stale id accumulates in settings and silently authorizes
  // nothing, which reads to the user as "I accepted and it still fails".
  const known = listVideoModels().some((model) => videoModelTermsGateId(model) === termsId);
  if (!known) {
    throw new ServerError(
      `Unknown model terms id: ${termsId}`,
      { status: 400, code: 'VIDEO_MODEL_TERMS_UNKNOWN_ID' },
    );
  }
  const next = await updateSettingsWith((current) => {
    const existing = acceptedVideoModelTerms(current);
    const updated = accepted
      ? [...new Set([...existing, termsId])]
      : existing.filter((id) => id !== termsId);
    return { ...current, videoGen: { ...(current.videoGen || {}), acceptedModelTerms: updated } };
  });
  res.json({ accepted: acceptedVideoModelTerms(next) });
}));

// `installed` here means "fully ready to render" — both the venv binary
// exists AND its python packages are importable. The sync existsSync gate
// alone is too permissive: a partial install (clone done, `uv pip install`
// aborted) leaves a venv directory present but no torch, which would
// hide the banner and make every render fail with a deep ImportError.
router.get('/setup/runtime-status', asyncHandler(async (req, res) => {
  const runtime = String(req.query?.runtime || '');
  const info = BYOV_RUNTIME_INFO[runtime];
  if (!info) {
    // `failValidation` only accepts a Zod safeParse result — calling it with
    // (res, string) would TypeError on `parsed.error.issues.map(...)` and
    // bubble as a 500 instead of the intended 400.
    throw new ServerError(
      `Unknown runtime: ${runtime}. Expected one of: ${Object.keys(BYOV_RUNTIME_INFO).join(', ')}`,
      { status: 400, code: 'UNKNOWN_BYOV_RUNTIME' },
    );
  }
  const binaryPresent = isByovRuntimeInstalled(info.id);
  // Check the immutable source pin before the import probe. Source-only
  // runtimes execute checkout code while importing, so an outdated or dirty
  // checkout must surface Upgrade / Repair without being loaded first.
  const current = binaryPresent ? await isByovRuntimeCurrent(info.id) : false;
  const packagesReady = current ? await isByovRuntimeReady(info.id) : false;
  res.json({
    runtime: info.id,
    label: info.label,
    installed: binaryPresent && packagesReady && current,
    binaryPresent,
    packagesReady,
    current,
    upgradeAvailable: binaryPresent && !current,
    venvPath: info.venvPython,
    repoDir: info.repoDir,
    repoUrl: info.repoUrl,
    installEnvVar: info.installEnvVar,
  });
}));

// In-flight singleton per runtime. A rapid double-click of the install
// button would otherwise race two `bash setup-image-video.sh` processes
// against the same target dir, both trying to git-clone or pip-install at
// once. Existing existsSync gate doesn't help — the install hasn't created
// the venv yet on the second click.
const runtimeInstallInFlight = new Map();

// Shells out to scripts/setup-image-video.sh with the runtime's INSTALL_X
// env pre-set, so the in-app installer and the README's terminal recipe
// invoke the exact same install path — no parallel Node-side implementation
// per runtime to keep in sync.
router.get('/setup/runtime-install', asyncHandler(async (req, res) => {
  const runtime = String(req.query?.runtime || '');
  const info = BYOV_RUNTIME_INFO[runtime];
  const { send, safeEnd } = openSseStream(res);
  let child = null;
  let aborted = false;

  // Register disconnect handling before any readiness/revision await. Those
  // probes can take tens of seconds on a damaged venv; closing the modal during
  // that window must prevent the large installer from starting unattended.
  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    if (info && runtimeInstallInFlight.get(info.id) === null) {
      runtimeInstallInFlight.delete(info.id);
    }
    if (child && !child.killed && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch { child.kill('SIGTERM'); }
    }
  });

  if (!info) {
    send({ type: 'error', message: `Unknown runtime: ${runtime}` });
    return safeEnd();
  }
  // Claim the in-flight slot SYNCHRONOUSLY, before any await. Two near-
  // simultaneous SSE requests would otherwise both reach the readiness await
  // on line below, both observe `!ready`, and both spawn `setup-image-video.sh`
  // against the same target dir — racing two git clones / pip installs.
  // Placeholder (`null`) gets replaced with the real child handle once spawned;
  // every early-return path below releases the slot.
  if (runtimeInstallInFlight.has(info.id)) {
    send({ type: 'error', message: `Another ${info.label} install is already running. Wait for it to finish or restart PortOS.` });
    return safeEnd();
  }
  runtimeInstallInFlight.set(info.id, null);
  // Skip ONLY when the binary, import probe, AND immutable revision all pass.
  // A partial install needs Repair, while a healthy checkout on an older pin
  // needs Upgrade; treating either as "already installed" strands the user
  // behind a button that can never perform the action it advertises.
  const alreadyInstalled = isByovRuntimeInstalled(info.id);
  const alreadyCurrent = alreadyInstalled && await isByovRuntimeCurrent(info.id);
  if (aborted) return safeEnd();
  const alreadyReady = alreadyCurrent && await isByovRuntimeReady(info.id);
  if (aborted) return safeEnd();
  if (alreadyInstalled && alreadyReady && alreadyCurrent) {
    runtimeInstallInFlight.delete(info.id);
    send({ type: 'log', message: `${info.label} already installed at ${info.venvPython}` });
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }
  // The install may add/remove packages; drop any cached "ready" so the
  // post-install /runtime-status response reflects the new state instead of
  // a stale "true" from before a deliberate cleanup. Same for the cached
  // runtime fingerprint — a reinstall can bump ltx/mlx/torch versions.
  invalidateByovReadyCache(info.id);
  invalidateByovLoraCapabilityCache(info.id);
  invalidateRuntimeFingerprintCache(info.id);

  const scriptPath = join(PATHS.root, 'scripts', 'setup-image-video.sh');
  if (!existsSync(scriptPath)) {
    runtimeInstallInFlight.delete(info.id);
    send({ type: 'error', message: `Installer script not found at ${scriptPath}` });
    return safeEnd();
  }

  send({ type: 'log', message: `▸ Starting ${info.label} install via ${info.installEnvVar}=1 bash scripts/setup-image-video.sh` });
  // Server-console visibility for the multi-GB install (start / heartbeat /
  // outcome) — the SSE stream otherwise surfaces progress only in the browser.
  const installLog = createInstallLogger({ installer: info.label, target: info.venvPython });
  const emit = (ev) => { installLog.onEvent(ev); send(ev); };
  installLog.start();
  // `detached: true` puts bash in its own process group so a cancel from the
  // client can take down uv / pip / git children too. Without it, SIGTERM on
  // bash leaves a multi-GB `git clone` (and any subsequent pip downloads)
  // orphaned to init — the user sees the modal close but the bandwidth keeps
  // burning until the network drops or the snapshot completes.
  const installEnv = {
    [info.installEnvVar]: '1',
    ...(info.pinEnvVar && info.expectedRevision ? { [info.pinEnvVar]: info.expectedRevision } : {}),
  };
  child = spawn('bash', [scriptPath], {
    env: safeChildProcessEnv(installEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  runtimeInstallInFlight.set(info.id, child);

  // `splitRe: /[\r\n]+/` so a bash/pip/tqdm progress bar that redraws with a
  // bare `\r` surfaces each redraw as its own log line; the carry buffer
  // stitches a line split across chunk boundaries (flushed on close).
  const onLine = (line) => {
    const t = line.trimEnd();
    if (t) emit({ type: 'log', message: t });
  };
  const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  child.stdout.on('data', stdoutReader.push);
  child.stderr.on('data', stderrReader.push);
  child.on('error', (err) => {
    runtimeInstallInFlight.delete(info.id);
    emit({ type: 'error', message: `Installer failed to spawn: ${err.message}` });
    safeEnd();
  });
  child.on('close', async (code) => {
    stdoutReader.flush();
    stderrReader.flush();
    runtimeInstallInFlight.delete(info.id);
    // Re-probe rather than trusting exit code alone — partial installs
    // (network drop mid-clone, missing requirements file, ctrl-c via
    // SIGTERM) can exit 0 but leave the venv unable to import its core
    // packages. Probe both the binary AND the import surface so the
    // success message can't lie. The banner gate uses the same probe.
    const binaryPresent = isByovRuntimeInstalled(info.id);
    const current = binaryPresent && await isByovRuntimeCurrent(info.id);
    const packagesReady = current && await isByovRuntimeReady(info.id);
    if (code === 0 && binaryPresent && packagesReady && current) {
      emit({ type: 'complete', message: `${info.label} ready: ${info.venvPython}` });
    } else if (code === 0 && !binaryPresent) {
      emit({ type: 'error', message: `Installer exited 0 but the runtime is still missing. Review the log above, then use Repair in this panel.` });
    } else if (code === 0) {
      emit({ type: 'error', message: packagesReady
        ? 'Installer exited 0 but the runtime is still on an outdated revision. Review the source-update log above, then use Repair in this panel.'
        : `Installer exited 0 but the runtime can't import its core packages. Review the package errors above, then use Repair in this panel.` });
    } else {
      emit({ type: 'error', message: `Installer exited with code ${code}.` });
    }
    safeEnd();
  });

  res.on('close', () => { if (!res.writableEnded) installLog.cancel(); });
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

// Resolve the repo set an integrity scan should cover. A specific `modelId`
// scopes to that model's repo; no modelId scans every model repo plus the
// shared text encoder.
const modelDownloadTargets = (model) => {
  const repo = repoForModel(model);
  if (!repo) return [];
  const targets = [{ repo, revision: model?.revision || null, only: [] }];
  for (const dep of Array.isArray(model?.requiredWeights) ? model.requiredWeights : []) {
    if (typeof dep?.repo !== 'string') continue;
    const only = Array.isArray(dep.files) ? dep.files.filter((file) => typeof file === 'string' && file.length > 0) : [];
    if (only.some((file) => !isSafeHfRepoRelativePath(file))) {
      throw new ServerError(
        `Video model "${model.id}" has an unsafe required-weight path. Use repo-relative POSIX filenames only.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    if (only.length > 0) targets.push({ repo: dep.repo, revision: dep.revision || null, only });
  }
  return targets;
};

// One download target per substitutable prompt conditioner. Each is a single
// pinned file inside a repo that also publishes quantizations and generation
// tails PortOS's MLX loader can't read, so these are ALWAYS scoped to `only:
// [file]` — a repo-wide snapshot would pull ~130 GB of unusable variants.
const textEncoderDownloadTarget = (entry) => ({
  repo: entry.repo,
  revision: entry.revision || null,
  only: [entry.file],
});
// Paired with its entry so the status lane can project the registry fields
// (label, advisory, size) alongside the cache verdict without a second lookup.
const textEncoderDownloadTargets = () => downloadableVideoTextEncoders()
  .map((entry) => ({ entry, target: textEncoderDownloadTarget(entry) }));

const targetKey = (target) => `${target.repo}@${target.revision || 'latest'}::${target.only.join(',')}`;
const targetVerifyOptions = (target, deep) => ({
  deep,
  ...(target.revision ? { revision: target.revision } : {}),
});
const verifyDownloadTarget = (target, { deep = false } = {}) => target.only.length > 0
  ? verifyCachedRepoFiles(target.repo, target.only, targetVerifyOptions(target, deep))
  : verifyModelCache(target.repo, targetVerifyOptions(target, deep));
const repairDownloadTarget = (target, { deep = false } = {}) => target.only.length > 0
  ? repairCachedRepoFiles(target.repo, target.only, targetVerifyOptions(target, deep))
  : repairModelCache(target.repo, targetVerifyOptions(target, deep));

const reposToVerify = (modelId) => {
  if (modelId) {
    const m = listVideoModels().find((x) => x.id === modelId);
    return m ? modelDownloadTargets(m) : [];
  }
  const targets = listVideoModels().flatMap(modelDownloadTargets);
  const enc = getTextEncoderRepo();
  if (isHfRepoId(enc)) targets.push({ repo: enc, only: [] });
  // Substitutable prompt conditioners are single pinned files the render path
  // depends on, so an unscoped scan must reach them too — a truncated one
  // otherwise only surfaces as a load failure minutes into a render.
  targets.push(...textEncoderDownloadTargets().map(({ target }) => target));
  // IC-LoRA remix weights are separate HF pulls that the render path depends
  // on, so an unscoped integrity scan must cover them too — otherwise a
  // corrupt IC weight only surfaces as a garbled render.
  targets.push(...icLoraRepos().map((repo) => ({ repo, only: [] })));
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()];
};

// Per-model download status — see /api/image-gen/models/status for the
// shape contract. We also surface the active text-encoder repo so the
// video form can warn when the Gemma encoder isn't downloaded yet (a
// surprise multi-GB pull on top of the model itself).
// Cache + integrity for one HF repo, in the `{ cached, sizeBytes, integrity }`
// shape every download badge consumes. The integrity check only runs for a repo
// that's actually downloaded — a not-yet-cached repo gets the Download badge,
// not a Repair banner. Shared by all three lanes of /models/status below so the
// badge semantics can't drift between models, the encoder, and IC weights.
const repoCacheStatus = async (repo) => {
  const { cached, sizeBytes } = await inspectModelCache(repo);
  return { cached, sizeBytes, integrity: cached ? summarizeVerify(await verifyModelCache(repo)) : null };
};

const modelCacheStatus = async (model, cache = null) => {
  const targets = modelDownloadTargets(model);
  if (targets.length === 0) return { repo: null, cached: null, sizeBytes: 0, integrity: null };
  const readTarget = (target) => {
    if (!cache) return verifyDownloadTarget(target);
    const key = targetKey(target);
    if (!cache.has(key)) cache.set(key, verifyDownloadTarget(target));
    return cache.get(key);
  };
  const verifies = await Promise.all(targets.map(readTarget));
  return {
    repo: targets[0].repo,
    requiredRepos: [...new Set(targets.map((target) => target.repo))],
    cached: verifies.every((verify) => verify.status === 'ok'),
    sizeBytes: verifies.reduce((sum, verify) => sum + (verify.sizeBytes || 0), 0),
    integrity: aggregateVerifies(verifies),
  };
};

router.get('/models/status', asyncHandler(async (_req, res) => {
  // Text encoder is shared across all video renders. A registry entry with
  // `localPath` (e.g. an LM Studio install) trumps the HF cache check, so
  // surface both the repo-cache status and the resolved local path so the UI
  // can distinguish "not downloaded" from "served from LM Studio".
  const encoderRepo = getTextEncoderRepo();
  const verifyCache = new Map();
  const [models, textEncoder, textEncoderOptions, icLoras] = await Promise.all([
    Promise.all(listVideoModels().map(async (m) => {
      return { id: m.id, ...await modelCacheStatus(m, verifyCache) };
    })),
    (async () => {
      if (!isHfRepoId(encoderRepo)) return { repo: encoderRepo, cached: true, sizeBytes: 0, integrity: null };
      return { repo: encoderRepo, ...await repoCacheStatus(encoderRepo) };
    })(),
    // Substitutable prompt conditioners (lib/videoTextEncoders.js) — the same
    // `{ id, repo, cached, sizeBytes, integrity }` badge shape as the models and
    // the IC weights, so the video form renders their Download button and
    // Repair banner with the existing components. Scoped to the ONE pinned file
    // (never the repo) for the reason in textEncoderDownloadTargets.
    Promise.all(textEncoderDownloadTargets().map(async ({ entry, target }) => {
      // Through the shared target verifier, so the badge, the integrity scan
      // and the repair route can't drift on how a pinned single-file target is
      // checked.
      const verify = await verifyDownloadTarget(target);
      const cached = verify.status === 'ok';
      return {
        ...publicTextEncoderOption(entry),
        estimatedBytes: entry.sizeBytes,
        cached,
        sizeBytes: verify.sizeBytes || 0,
        // Same rule as repoCacheStatus: a not-yet-downloaded file gets the
        // Download badge, not a Repair banner.
        integrity: cached ? summarizeVerify(verify) : null,
      };
    })),
    // IC-LoRA remix weights (issue #3100). Each is a separate several-hundred-MB
    // pull the IC render path needs, so they get the same cached/size/integrity
    // shape as the models — that's what lets the mode panel render a Download
    // badge and a Repair banner with the existing components.
    Promise.all(listIcLoraWeights().map(async (spec) => {
      // A mirrored spec (Ingredients) can't use the repo-wide verdict: its
      // official repo is gated and its mirror is a 708 GB aggregate that reports
      // `cached` off any unrelated weight. Probe the ONE file across both
      // candidates instead, and skip the integrity walk (which would stat/hash
      // every sibling weight in that mirror).
      if (spec.mirrorRepo) {
        const found = await findCachedIcLoraWeight(spec);
        return {
          id: spec.mode, repo: spec.repo, label: spec.label,
          estimatedBytes: spec.sizeBytes,
          gated: !!spec.gated, mirrorRepo: spec.mirrorRepo,
          cached: !!found,
          resolvedRepo: found?.repo || null,
          // The badge falls back to `estimatedBytes` when sizeBytes is 0, and the
          // real number would cost a stat on a path we already proved resident —
          // so report 0 and let the estimate speak.
          sizeBytes: 0,
          integrity: null,
        };
      }
      return {
        id: spec.mode, repo: spec.repo, label: spec.label,
        estimatedBytes: spec.sizeBytes,
        gated: !!spec.gated,
        ...await repoCacheStatus(spec.repo),
      };
    })),
  ]);
  res.json({ models, textEncoder, textEncoderOptions, icLoras });
}));

// POST /models/verify — force an integrity re-scan on demand. `deep:true` adds
// the per-file sha256 comparison (slower; reads every weight byte) on top of
// the cheap structural check the status poll already runs. With no `modelId`
// it scans every cached model + the text encoder.
const verifyBodySchema = z.object({
  modelId: z.string().min(1).optional(),
  deep: z.boolean().optional(),
});
router.post('/models/verify', asyncHandler(async (req, res) => {
  const parsed = verifyBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const { modelId, deep = false } = parsed.data;
  const repos = reposToVerify(modelId);
  if (modelId && repos.length === 0) {
    throw new ServerError(`Unknown video model: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  }
  const results = await Promise.all(repos.map((target) => verifyDownloadTarget(target, { deep })));
  res.json({ deep, models: results.map((r) => ({ repo: r.repoId, ...summarizeVerify(r) })) });
}));

// POST /models/:modelId/repair — delete the flagged (corrupt/truncated) weight
// files for the model's repo(s) so the existing resumable HF fetch path
// re-downloads them. Returns the deleted-file list; the client then re-triggers
// the normal `/models/:id/download` SSE stream to pull clean copies with
// progress. `deep:true` uses the sha256 comparison to decide what's corrupt.
router.post('/models/:modelId/repair', asyncHandler(async (req, res) => {
  const model = listVideoModels().find((m) => m.id === req.params.modelId);
  if (!model) throw new ServerError(`Unknown video model: ${req.params.modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  const parsed = z.object({ deep: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const deep = parsed.data.deep || false;
  const repos = reposToVerify(model.id);
  if (repos.length === 0) {
    throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file.`, { status: 400, code: 'NO_REPO_FOR_MODEL' });
  }
  const repaired = await Promise.all(repos.map((target) => repairDownloadTarget(target, { deep })));
  const deleted = repaired.flatMap((r) => r.deleted.map((name) => ({ repo: r.repoId, name })));
  res.json({ deep, deleted, repos: [...new Set(repos.map((target) => target.repo))] });
}));

router.get('/models/:modelId/download', asyncHandler(async (req, res) => {
  const model = listVideoModels().find((m) => m.id === req.params.modelId);
  if (!model) throw new ServerError(`Unknown video model: ${req.params.modelId}`, { status: 404 });
  // Only a gated model needs the recorded acknowledgement list — skip the
  // settings read (and its deep clone) for every ordinary model.
  if (videoModelTermsGateId(model)
    && !isVideoModelTermsAccepted(model, acceptedVideoModelTerms(await getSettings()))) {
    throw videoModelTermsError(model, 'download');
  }
  const repos = modelDownloadTargets(model);
  if (repos.length === 0) throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file.`, { status: 400, code: 'NO_REPO_FOR_MODEL' });
  const runtimeInfo = BYOV_RUNTIME_INFO[model.runtime];
  const pythonPath = runtimeInfo && await isByovRuntimeReady(model.runtime) ? runtimeInfo.venvPython : null;
  await startHfDownloadStream({ req, res, repos, pythonPath, force: req.query.force === '1' });
}));

// IC-LoRA remix weights (issue #3100) get their own download/repair pair for
// the same reason the text encoder does: they're required by the render path
// but are NOT listVideoModels() entries, so the model-id-keyed routes above
// can't reach them. Keyed by the PortOS remix mode ('ic-control', …) so the
// client uses the same identifier it puts in the render payload.
const icLoraSpecFromParam = (mode) => {
  const spec = icLoraSpecForMode(mode);
  if (!spec) {
    throw new ServerError(
      `Unknown IC-LoRA remix mode: ${mode} (expected one of ${IC_LORA_MODE_VALUES.join(', ')})`,
      { status: 404, code: 'IC_LORA_UNKNOWN_MODE' },
    );
  }
  return spec;
};

// Download one IC weight. A spec with a `mirrorRepo` is fetched SINGLE-FILE and
// only ever single-file: the official Ingredients repo is gated (an anonymous
// pull 401s) and its un-gated mirror is the ~708 GB `DeepBeepMeep/LTX-2`
// aggregate, so a snapshot of either would either fail or fill the user's disk.
// Candidates are tried in order (official → mirror) so a user WITH an HF token
// gets the first-party weight and a user without one still succeeds via the
// mirror — no token, no extra button. The exact filename is pinned so the mirror
// can't hand back a sibling weight.
router.get('/ic-loras/:mode/download', asyncHandler(async (req, res) => {
  const spec = icLoraSpecFromParam(req.params.mode);
  const force = req.query.force === '1';
  if (!spec.mirrorRepo) {
    await startHfDownloadStream({ req, res, repo: spec.repo, force });
    return;
  }
  await startHfDownloadStream({
    req,
    res,
    fallbacks: icLoraWeightCandidates(spec).map((c) => ({ repo: c.repo, only: [c.filename] })),
    // The repo-wide `cached` verdict is meaningless for the aggregate mirror (it
    // reports cached as soon as ANY unrelated weight is resident), so gate the
    // already-have short-circuit on this exact weight instead.
    cachedFile: async () => !!(await findCachedIcLoraWeight(spec)),
    force,
  });
}));

router.post('/ic-loras/:mode/repair', asyncHandler(async (req, res) => {
  const spec = icLoraSpecFromParam(req.params.mode);
  const parsed = z.object({ deep: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const deep = parsed.data.deep || false;
  // A mirrored spec is single-file by construction, and repairModelCache walks
  // the WHOLE snapshot — against the 708 GB aggregate mirror that would stat (and
  // under `deep`, hash) every unrelated LTX weight the user has. Delete just this
  // weight and let the single-file download re-fetch it.
  if (spec.mirrorRepo) {
    const found = await findCachedIcLoraWeight(spec);
    if (!found) return res.json({ deep, deleted: [], repos: [spec.repo] });
    await repairCachedFile(found.path);
    return res.json({ deep, deleted: [{ repo: found.repo, name: found.filename }], repos: [found.repo] });
  }
  const result = await repairModelCache(spec.repo, { deep });
  res.json({ deep, deleted: result.deleted.map((name) => ({ repo: result.repoId, name })), repos: [spec.repo] });
}));

// Substitutable prompt conditioners (lib/videoTextEncoders.js) get their own
// download/repair pair for the same reason the IC-LoRA weights do: the render
// path depends on them but they are NOT listVideoModels() entries, so the
// model-id-keyed routes can't reach them. Keyed by the registry id the client
// also puts in the render payload.
//
// Distinct from the /text-encoder/* pair below, which is the SHARED LTX encoder
// (one repo, install-wide, selected in the media-models registry). These are
// per-model alternatives chosen per render.
const textEncoderFromParam = (id) => {
  const entry = downloadableVideoTextEncoder(id);
  if (!entry) {
    const known = downloadableVideoTextEncoders().map((e) => e.id);
    throw new ServerError(
      `Unknown text encoder: ${id}${known.length ? ` (expected one of ${known.join(', ')})` : ''}`,
      { status: 404, code: 'VIDEO_TEXT_ENCODER_UNKNOWN' },
    );
  }
  return entry;
};

// Always single-file, never a snapshot: the upstream repo also publishes INT8
// ConvRot / NVFP4 quantizations and 50-63 generation tails that this MLX loader
// cannot read, so a repo-wide pull would cost ~130 GB for ~48 GB of usable
// weights.
router.get('/text-encoders/:id/download', asyncHandler(async (req, res) => {
  const entry = textEncoderFromParam(req.params.id);
  await startHfDownloadStream({
    req,
    res,
    repos: [textEncoderDownloadTarget(entry)],
    force: req.query.force === '1',
  });
}));

router.post('/text-encoders/:id/repair', asyncHandler(async (req, res) => {
  const entry = textEncoderFromParam(req.params.id);
  const parsed = z.object({ deep: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const deep = parsed.data.deep || false;
  const result = await repairDownloadTarget(textEncoderDownloadTarget(entry), { deep });
  res.json({
    deep,
    deleted: result.deleted.map((name) => ({ repo: entry.repo, name })),
    repos: [entry.repo],
  });
}));

// POST /text-encoder/repair — delete the flagged (corrupt/truncated) weight
// files for the active text encoder repo so the existing /text-encoder/download
// SSE re-fetches clean copies. The encoder is shared across all video renders
// and is NOT a listVideoModels() entry, so the model-id-keyed
// /models/:modelId/repair can't cover it — this scalar route does. A local-path
// encoder (e.g. an LM Studio install) isn't an HF repo and has nothing to
// repair through the cache.
router.post('/text-encoder/repair', asyncHandler(async (req, res) => {
  const repo = getTextEncoderRepo();
  if (!isHfRepoId(repo)) {
    throw new ServerError('Active text encoder is a local-path entry, not an HF repo.', { status: 400, code: 'NOT_DOWNLOADABLE' });
  }
  const parsed = z.object({ deep: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const deep = parsed.data.deep || false;
  const result = await repairModelCache(repo, { deep });
  res.json({ deep, deleted: result.deleted.map((name) => ({ repo: result.repoId, name })), repos: [repo] });
}));

// Text encoder pre-fetch. The Gemma encoder is a separate ~7-25 GB pull from
// the video model itself, so it gets its own button on the video form.
router.get('/text-encoder/download', asyncHandler(async (req, res) => {
  const repo = getTextEncoderRepo();
  // Local-path encoders (LM Studio) are not downloadable — they're served
  // off disk and the status endpoint already reports cached: true for them.
  if (!isHfRepoId(repo)) {
    throw new ServerError('Active text encoder is a local-path entry, not an HF repo.', { status: 400, code: 'NOT_DOWNLOADABLE' });
  }
  // `?force=1` (sent by the repair-initiated re-download) re-fetches even when
  // the repo still looks cached — a deleted shard from a multi-file encoder
  // would otherwise be skipped.
  await startHfDownloadStream({ req, res, repo, force: req.query.force === '1' });
}));

router.post('/', frameImageUpload, asyncHandler(async (req, res) => {
  // The multipart parser already wrote every upload to the OS temp dir before
  // this handler ran, so a rejected body must drop them explicitly or they
  // leak. Past this point the service owns cleanup for both temp and durable
  // copies.
  const uploads = req.files || {};
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await cleanupMultipartTemp(uploads);
    failValidation(parsed);
  }
  const body = parsed.data;
  // Everything between validation and enqueue — backend resolution, upload
  // staging with rollback, mode/reference validation, history lookups — lives
  // in the service (#3288), mirroring imageGen's prepareGenerateParams. It
  // throws ServerError (after unwinding every staged file) on any rejection.
  const prepared = await prepareVideoGenParams({
    body,
    uploads,
    localOnlyParamKeys: Object.keys(LOCAL_ONLY_VIDEO_PARAMS),
  });
  const { backend, cleanupStaged } = prepared;

  // #3326 — `enqueueJob` is the last place a throw can strand the durable
  // copies the service staged (the job never exists, so the worker's cleanup
  // never runs). Release them, then rethrow untouched for the error middleware.
  const enqueue = (params) => withStagedRollback(cleanupStaged, () => enqueueJob({ kind: 'video', params }));

  if (backend === 'grok') {
    const { grok: g, sourceImagePath, uploadedTempPath } = prepared;
    const { jobId, position, status } = await enqueue({
      // `mode: 'grok'` is the queue's discriminator — the cloud lane and
      // getGenModuleForJob route on it. Local video jobs use `mode` for
      // the t2v/i2v semantic (text/image/fflf/…), which never collides
      // with the literal 'grok'.
      mode: IMAGE_GEN_MODE.GROK,
      // Semantic t2v/i2v mode, kept separate from the discriminator so a
      // client restoring form state from /active never feeds 'grok' back
      // into its mode selector.
      videoMode: sourceImagePath ? 'image' : 'text',
      grokPath: g.grokPath,
      aspectRatio: g.aspectRatio,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt || '',
      width: body.width,
      height: body.height,
      duration: body.grokDuration,
      sourceImagePath,
      uploadedTempPath,
      ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
    });
    return res.json({ jobId, generationId: jobId, filename: `${jobId}.mp4`, model: 'grok', mode: 'grok', status, position });
  }

  const {
    pythonPath, effectiveModelId, mode,
    sourceImagePath, lastImagePath, audioFilePath, icReferencePaths,
    resolvedKeyframes, extendFromVideoPath,
    uploadedTempPath, uploadedTempPaths, loras, effectiveChunks, effectiveChunkPrompts, effectiveContextFrames,
  } = prepared;

  // Enqueue rather than spawn synchronously — the mediaJobQueue worker will
  // run this when no other render is in flight. Caller never sees BUSY.
  const { jobId, position, status } = await enqueue({
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
    // Only a SUBSTITUTE is persisted: an explicit `textEncoderId: 'stock'` is
    // semantically identical to omitting the field, so storing it would make a
    // resumed/remixed render carry a knob that never applied — and would differ
    // from what the service records in history for the same render.
    ...(isStockTextEncoder(body.textEncoderId) ? {} : { textEncoderId: body.textEncoderId }),
    disableAudio: body.disableAudio === true || body.disableAudio === 'true',
    sourceImagePath,
    audioFilePath,
    audioStartSec: body.audioStartSec,
    uploadedTempPath,
    uploadedTempPaths,
    lastImagePath,
    keyframes: resolvedKeyframes,
    extendFromVideoPath,
    mode,
    imageStrength: body.imageStrength,
    chunks: effectiveChunks,
    // Undefined when the request doesn't chain (or every beat was blank) — the
    // key is simply absent from job.params then, so a resumed form restores no
    // stale beats. See prepareVideoGenParams for the normalization.
    ...(effectiveChunkPrompts ? { chunkPrompts: effectiveChunkPrompts } : {}),
    // Undefined for a non-chained request, so job.params doesn't carry a knob
    // that couldn't have applied. `0` is a real value here (last-frame
    // chaining) and must survive — see resolveContextFrames.
    ...(effectiveContextFrames != null ? { contextFrames: effectiveContextFrames } : {}),
    loras,
    icReferencePaths,
    icStrength: body.icStrength,
    icAttentionStrength: body.icAttentionStrength,
    icSkipStage2: body.icSkipStage2 === true || body.icSkipStage2 === 'true',
    // Director-board attach tag (#1760 Phase 1). Rides into persisted
    // job.params so the completion hook can file the clip onto the scene even
    // if the board unmounted; absent for ordinary VideoGen-page renders.
    ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
  });
  // Match the legacy response shape (jobId, generationId, filename, model,
  // mode) so existing client code keeps working; add status+position for
  // the queue. effectiveModelId was resolved by the service.
  res.json({ jobId, generationId: jobId, filename: `${jobId}.mp4`, model: effectiveModelId, mode: 'local', status, position });
}));

// Currently-running video job (if any) so the page can re-attach after a
// reload — the SSE replay of `lastPayload` then resumes progress display.
// Mirrors GET /api/image-gen/active. Returns `{ activeJob: null }` when no
// video render is in flight. Queued-but-not-yet-running jobs are returned
// too so the user lands on a "Queued (position N)" state instead of an
// empty form. Selection order MUST match /cancel below: newest queued is
// what cancelVideoGen() targets when nothing is running, so resuming the
// oldest queued would leave the resumed page's Cancel button hitting a
// different job.
//
// Whitelist the params the UI form actually consumes — `job.params`
// carries server-internal absolute file paths (sourceImagePath,
// audioFilePath, uploadedTempPath(s), extendFromVideoPath) and the
// resolved pythonPath, none of which belong on a client surface.
const ACTIVE_JOB_PARAM_FIELDS = [
  'prompt', 'negativePrompt', 'modelId',
  'width', 'height', 'numFrames', 'fps',
  'steps', 'guidanceScale', 'seed',
  'tiling', 'disableAudio', 'mode', 'chunks', 'chunkPrompts', 'contextFrames', 'imageStrength',
  // A registry id, not a path — safe to echo so a reloading page restores the
  // conditioner the in-flight render is actually using.
  'textEncoderId',
  'audioStartSec',
  // Grok jobs (#2859 phase 2): the semantic t2v/i2v mode ('mode' holds the
  // 'grok' discriminator for them) and the clip duration — both plain
  // values, safe to echo for the reloading page's form restore.
  'videoMode', 'duration',
  // loras are { filename, scale } basenames (no server filesystem paths), so
  // they're safe to echo back for the resuming picker to repopulate.
  'loras',
  // IC-LoRA remix dials — plain scalars, safe to echo. The reference clip
  // itself rides a separate basename mapping below (its param is an absolute
  // path, which the whitelist exists to keep off this surface).
  'icStrength', 'icAttentionStrength', 'icSkipStage2',
];
const pickJobParams = (params) => {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const k of ACTIVE_JOB_PARAM_FIELDS) {
    if (params[k] !== undefined) out[k] = params[k];
  }
  // keyframes ride a separate mapping rather than the raw whitelist: they're
  // stored as { path, index } where `path` is an absolute gallery path (the
  // same internal-path-leak the whitelist exists to prevent — see the
  // comment above). Re-derive the gallery basename as `file` so the resuming
  // client's multi-keyframe picker can repopulate { file, index } entries
  // (its submit shape) without ever seeing the server's filesystem layout.
  if (Array.isArray(params.keyframes)) {
    const mapped = params.keyframes
      .filter((kf) => kf && typeof kf.path === 'string' && Number.isInteger(kf.index))
      .map((kf) => ({ file: basename(kf.path), index: kf.index }));
    if (mapped.length) out.keyframes = mapped;
  }
  // IC-LoRA references are absolute paths for the same reason keyframes are —
  // echo only the basename so the resuming form can show WHICH clip is in
  // flight without leaking the staging/data layout. The client can't re-submit
  // from a basename alone (an upload isn't re-derivable), so this is display
  // only; the resumed render is already queued with the real path.
  if (Array.isArray(params.icReferencePaths)) {
    const names = params.icReferencePaths
      .filter((p) => typeof p === 'string' && p)
      .map((p) => basename(p));
    if (names.length) out.icReferenceNames = names;
    // For an IMAGE-kind weight the basename IS the gallery filename (references
    // are gallery-only, never uploads), so unlike the clip case the resuming form
    // CAN repopulate its picker and re-submit. Echo it under the submit field name
    // so the client needs no per-kind translation.
    if (names.length && icLoraSpecForMode(params.mode)?.referenceKind === 'image') {
      out.icReferenceImageFiles = names;
    }
  }
  return out;
};

router.get('/active', (_req, res) => {
  const running = listJobs({ kind: 'video', status: 'running' })[0];
  const queuedList = !running ? listJobs({ kind: 'video', status: 'queued' }) : [];
  const queued = queuedList.length ? queuedList[queuedList.length - 1] : null;
  const job = running || queued;
  if (!job) return res.json({ activeJob: null });
  res.json({
    activeJob: {
      jobId: job.id,
      generationId: job.id,
      status: job.status,
      position: job.position,
      params: pickJobParams(job.params),
    },
  });
});

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
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
// UUIDs rather than the looser /^[a-f0-9-]{36}$/ pattern (which happily
// accepts e.g. 36 hyphens). `.guid()` is Zod 4's name for the 8-4-4-4-12
// hex-group check Zod 3's `.uuid()` performed (version-agnostic); matches
// the .guid() usage in the other route schemas.
const historyIdSchema = z.string().guid('invalid history id');

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
