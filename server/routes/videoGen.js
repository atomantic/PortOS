import { sanitizeContinuation } from '../lib/videoContinuationProvenance.js';
import { runtimeQuerySchema } from '../lib/queryValidation.js';
/**
 * Video Generation Routes — local LTX backend.
 *
 * Mirrors the imageGen route surface where it makes sense (status, models,
 * SSE progress, cancel) and adds video-specific bits (history, last-frame
 * extraction, ffmpeg stitching).
 */

import { withMediaFileSizes } from '../lib/mediaFileInfo.js';
import { checkHiggsfieldNewModels } from '../services/higgsfieldCatalogCheck.js';
import { historyListQuerySchema, isHistoryListQuery, listVideoHistoryQuery } from '../services/videoGen/historyList.js';
import { Router } from 'express';
import { updateVideoPoster, createSharingCopy } from '../services/videoGen/poster.js';
import { basename } from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { resolveGalleryImage } from '../lib/fileUtils.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { createVideoHistoryItemRead, historyRecordIdSchema } from './videoHistoryRead.js';
import { optionalUpload, optionalUploadFields } from '../lib/multipart.js';
import { validateRequest } from '../lib/validateRequest.js';
import { VIDEO_BACKEND_DISCLOSURES } from '../lib/videoDisclosure.js';
import { getSettings } from '../services/settings.js';
import { deleteVideoHostedCopy } from '../services/hostedRenderRemoteDelete.js';
import { recordUserAction } from '../services/userActions.js';
import { checkPackages, isAllowedPython } from '../lib/pythonSetup.js';
import {
  listVideoModels,
  defaultVideoModelId,
  BYOV_RUNTIME_INFO,
  warmByovLoraCapabilities,
  isByovRuntimeReady,
  resolveRuntimeFingerprint,
  loadHistory,
  getHistoryItem,
  setHistoryItemHidden,
  updateHistoryItemPrompt,
  extractLastFrame,
  upscaleHistoryItem,
  planUpscaleHistoryItem,
  resolveFflfLtx2PixelBudget,
} from '../services/videoGen/local.js';
// The method enum comes from the pure contract module rather than through
// local.js's re-export: it is a constant, and reading it off the mockable
// provider surface would make every suite that mocks local.js responsible for
// re-declaring it just so this file's route schemas can be built.
import { UPSCALE_METHODS, DEFAULT_UPSCALE_METHOD } from '../services/videoGen/upscalePlan.js';
import { enqueueLtxUpscale } from '../services/videoGen/upscaleJob.js';
import { quoteTopaz } from '../services/videoGen/topazQuote.js';
import { assertNoPendingTopaz, enqueueTopazUpscale, reconcileTopazStatus, recoverTopazResult } from '../services/videoGen/topazJob.js';
import { enqueueStitch } from '../services/videoGen/stitchJob.js';
import { trimHistoryItem } from '../services/videoGen/trim.js';
import { handheldHistoryItem } from '../services/videoGen/handheld.js';
import { enqueueVertical } from '../services/videoGen/verticalJob.js';
import { VERTICAL_RATIO_IDS } from '../lib/verticalReframe.js';
import { extendHistoryClip } from '../services/videoGen/extendHosted.js';
import { HANDHELD_SEED_MAX } from '../lib/handheldCamera.js';
import { cleanupMultipartTemp } from '../services/videoGen/prepareParams.js';
import { submitVideoGenJob } from '../services/videoGen/submitJob.js';
import { previewVideoPrompt } from '../services/videoGen/promptPreview.js';
import { resolveReactorApiKey, mintReactorToken } from '../services/videoGen/reactor.js';
import { isVideoModeUsable, VIDEO_GEN_MODE } from '../services/videoGen/modes.js';
import { REFERENCE_AUDIO_FIELDS, VIDEO_REFERENCE_IMAGE_FIELDS } from '../services/videoGen/requestFields.js';
import { attachSseClient, cancelJob, listJobs, laneConcurrencyFor } from '../services/mediaJobQueue/index.js';
import { mediaJobExecutionLane } from '../lib/generationModes.js';
import { getTextEncoderRepo, isHfRepoId, getVideoModels } from '../lib/mediaModels.js';
import {
  icLoraSpecForMode, listIcLoraWeights,
  icLoraWeightCandidates, findCachedIcLoraWeight, icLoraWeightKey, icLoraProbesExactFile,
} from '../lib/icLoraWeights.js';
import { publicTextEncoderOption } from '../lib/videoTextEncoders.js';
import { repairModelCache, repairCachedFile, summarizeVerify } from '../lib/hfCache.js';
import {
  modelDownloadTargets, textEncoderDownloadTarget, textEncoderDownloadTargets,
  verifyDownloadTarget, repairDownloadTarget, reposToVerify,
  repoCacheStatus, modelCacheStatus, icLoraSpecFromParam, textEncoderFromParam,
} from '../services/videoGen/modelCache.js';
import { startHfDownloadStream } from '../services/hfDownloadStream.js';
import { openSseStream } from '../lib/sseDownload.js';
import { saveUploadedGalleryVideo, saveUploadedGalleryVideoFile } from '../services/videoUpload.js';
import { JSON_BODY_LIMIT_BYTES } from '../lib/uploadLimits.js';
import { effectiveJobPrompt } from '../lib/federatedMediaWire.js';
import { isRemoteMediaJob } from '../services/mediaJobQueue/remoteMediaJob.js';
import {
  getVideoRuntimeStatus,
  streamVideoRuntimeInstall,
} from '../services/videoGen/runtimeInstaller.js';
import { detectSystemCapabilities, withHardwareCompatibility } from '../lib/systemCapabilities.js';
import { isDisplaySleepEnabled } from '../services/videoGen/displayPower.js';
import { deleteMediaAnywhere, cancelPendingDelete } from '../services/mediaRemoteDelete.js';
import { assertMediaDeletable } from '../services/mediaUsage.js';
import { getProject } from '../services/musicVideo/projects.js';
import {
  hostedProviderParamSchema, mediaDeleteQuerySchema, modelDownloadQuerySchema, modelDownloadParamsSchema,
  icLoraDownloadParamsSchema, textEncoderDownloadParamsSchema, videoCancelBodySchema, videoExtendBodySchema
} from '../lib/mediaGenerationValidation.js';
import { generateBodySchema, promptPreviewBodySchema } from '../lib/videoGenValidation.js';

const router = Router();

const hardwareAwareVideoModels = async () => {
  // Warm BEFORE decorating: listVideoModels() stamps each entry's
  // `runtimeLoraCapable` from a sync accessor that reads an unprobed runtime as
  // "not capable", and shipping that default is a bug the client cannot recover
  // from — see warmByovLoraCapabilities in services/videoGen/runtimes.js.
  // Joined to the hardware probe this function already awaits for the same
  // reason; both cache for the process, so only the first call pays.
  const [capabilities] = await Promise.all([detectSystemCapabilities(), warmByovLoraCapabilities()]);
  return {
    capabilities,
    models: listVideoModels().map((model) => withHardwareCompatibility(
      model,
      capabilities,
      model.hardwareRequirements,
    )),
  };
};

// The model list plus the three numbers that decide which entry the picker
// auto-selects. Deliberately free of any PER-CALL python probe: /status shells
// out to the interpreter on every call (~1-2s) and the Model field used to wait
// on it, so `/model-context` serves the same fields off the registry, the cached
// hardware probe and the once-per-process LoRA-capability warm above (a bare
// MLX import, no model load, cached both ways). /status keeps returning them
// for its other readers — this is the single builder both routes share, so the
// two can't drift.
const videoModelContext = async (loadedSettings = null) => {
  const { capabilities, models } = await hardwareAwareVideoModels();
  const settings = loadedSettings || await getSettings();
  return {
    // Each entry carries its optional `disclosure` block (provenance, weights/
    // runtime licenses, pinned-snapshot download size) straight off the
    // registry — absent for custom models, which the UI renders as Unknown.
    models,
    defaultModel: defaultVideoModelId(capabilities, settings?.videoGen?.defaultModelId),
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
    // Backend usability for the two metered-API video providers (#6213/#6214).
    // Computed server-side through the SAME resolver `isVideoModeUsable` uses
    // to gate an actual render, so a key set only via FAL_KEY/REACTOR_API_KEY
    // env var (no Settings-form entry) still surfaces the backend switcher —
    // the client can't see env vars, and re-deriving "has a key" from the
    // settings object alone missed that case entirely.
    falEnabled: isVideoModeUsable(settings, VIDEO_GEN_MODE.FAL),
    reactorEnabled: isVideoModeUsable(settings, VIDEO_GEN_MODE.REACTOR),
    runwayEnabled: isVideoModeUsable(settings, VIDEO_GEN_MODE.RUNWAY),
    geminiEnabled: isVideoModeUsable(settings, VIDEO_GEN_MODE.GEMINI),
    higgsfieldEnabled: isVideoModeUsable(settings, VIDEO_GEN_MODE.HIGGSFIELD),
    googleEnabled: isVideoModeUsable(settings, VIDEO_GEN_MODE.GOOGLE),
  };
};

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

// FFLF accepts up to two image uploads (start and end frame); a2v takes one
// audio upload (audioFile); the IC-LoRA remix modes take one reference video
// upload (icReference); FastH3 Omni takes up to three voice clips in indexed
// slots (REFERENCE_AUDIO_FIELDS). Files stream to disk without a file-size cap.
// Per-fieldname mime filtering rejects mismatched parts
// up-front so a stray .mp4 drag-drop can't get staged under these fields.
const frameImageUpload = optionalUploadFields(['sourceImage', 'lastImage', 'audioFile', ...REFERENCE_AUDIO_FIELDS, ...VIDEO_REFERENCE_IMAGE_FIELDS, 'icReference', 'runwayVideo', 'runwayCharacterVideo'], {
  fileFilter: (_req, file, cb) => {
    const isImageField = file.fieldname === 'sourceImage' || file.fieldname === 'lastImage' || VIDEO_REFERENCE_IMAGE_FIELDS.includes(file.fieldname);
    const isAudioField = file.fieldname === 'audioFile' || REFERENCE_AUDIO_FIELDS.includes(file.fieldname);
    const isVideoField = ['icReference', 'runwayVideo', 'runwayCharacterVideo'].includes(file.fieldname);
    const okImage = isImageField && file.mimetype.startsWith('image/');
    const okAudio = isAudioField && isAudioMime(file.mimetype, file.originalname);
    // IC-LoRA references are clips — the control weight reads structure/motion
    // out of a depth/pose/edge video, so only video/* is meaningful here.
    const okVideo = isVideoField && file.mimetype.startsWith('video/');
    cb(null, okImage || okAudio || okVideo);
  },
});

// Probes required-package imports on each call so a half-installed Python
// can't masquerade as connected. /status isn't polled (mount + manual
// refresh only), so the ~1-2s subprocess cost is acceptable.
router.get('/status', asyncHandler(async (_req, res) => {
  const s = await getSettings();
  const py = s.imageGen?.local?.pythonPath || null;
  const { connected, reason, missing, pythonVersion } = await resolveLocalPythonHealth(py);
  res.json({
    connected,
    pythonPath: py,
    pythonVersion: pythonVersion || null,
    reason,
    missingPackages: missing,
    // `models` / `defaultModel` / `systemMemoryGb` / `fflfLtx2PixelBudget` —
    // kept here for the callers that already read them off /status. The Video
    // Gen page takes them from GET /model-context instead, so its Model picker
    // never waits on the python probe above.
    ...(await videoModelContext(s)),
    // Server-owned execution + policy scope per render backend (#3674). The
    // client renders these strings verbatim so the wording can't drift between
    // the two surfaces.
    backendDisclosures: VIDEO_BACKEND_DISCLOSURES,
    // Authoritative list of bring-your-own-venv runtimes — lets the client
    // gate the install-banner probe without hardcoding the same Set.
    byovRuntimes: Object.keys(BYOV_RUNTIME_INFO),
    // Runtime fingerprint — host chip/os + resolved ltx/mlx/torch versions per
    // installed BYOV runtime — so the UI can show the exact numerical stack and
    // bug reports for garbled/"mosaic" output carry the version info that makes
    // them actionable (#1325). Best-effort: a venv that fails to probe reports
    // `{ error }` and never blocks the rest of the status payload. The resolver
    // is already non-throwing (each probe resolves to `{ error }`), but guard
    // with a catch as defense-in-depth so a runtime-block failure can never
    // reject the whole /status response.
    runtime: await resolveRuntimeFingerprint().catch(() => null),
    // Will a render on this install actually sleep the display? macOS-only, and
    // OFF unless the user opted in (settings.videoGen.displaySleep). Paired with each
    // model's `sleepsDisplayDuringRender`, this is what lets the UI warn BEFORE
    // the screen goes dark — a user who is not warned reads it as a crash and
    // wakes the display, re-introducing the exact GPU-watchdog contention the
    // sleep is there to avoid.
    displaySleepOnRender: isDisplaySleepEnabled(s.videoGen),
  });
}));

// Mints a short-lived reactor.inc session JWT scoped to `reactor/fast-h3`
// (#6214) — the raw REACTOR_API_KEY never reaches the client. Load-bearing
// security pattern: never cached, and the scope/session bound is set by
// reactor.js#mintReactorToken, not by the caller.
router.get('/reactor/token', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const settings = await getSettings();
  const apiKey = resolveReactorApiKey(settings);
  const { jwt, expiresAt } = await mintReactorToken(apiKey);
  res.json({ jwt, expires_at: expiresAt });
}));

// `installed` here means "fully ready to render" — both the venv binary
// exists AND its python packages are importable. The sync existsSync gate
// alone is too permissive: a partial install (clone done, `uv pip install`
// aborted) leaves a venv directory present but no torch, which would
// hide the banner and make every render fail with a deep ImportError.
const sendRuntimeStatus = async (req, res) => {
  const runtime = String(validateRequest(runtimeQuerySchema, req.query).runtime || '');
  res.json(await getVideoRuntimeStatus(runtime));
};

router.get('/setup/runtime-status', asyncHandler(sendRuntimeStatus));

// Backward-compatible read surface for stale clients or status pollers. GET
// never installs; host mutation is restricted to the POST route below.
router.get('/setup/runtime-install', asyncHandler(sendRuntimeStatus));

router.post('/setup/runtime-install', asyncHandler(async (req, res) => {
  const runtime = String(validateRequest(runtimeQuerySchema, req.query).runtime || '');
  const { send, safeEnd } = openSseStream(res);
  await streamVideoRuntimeInstall({
    runtime,
    send,
    safeEnd,
    onDisconnect: (handler) => res.on('close', handler),
    isResponseEnded: () => res.writableEnded,
  });
}));

async function resolveLocalPythonHealth(py) {
  if (!py) return { connected: false, reason: 'Local Python not configured', missing: [], pythonVersion: null };
  if (!isAllowedPython(py)) return { connected: false, reason: 'Saved pythonPath is not a python interpreter', missing: [], pythonVersion: null };
  try {
    const { missing, pythonVersion } = await checkPackages(py);
    if (missing.length === 0) return { connected: true, reason: null, missing, pythonVersion };
    return {
      connected: false,
      reason: `${missing.length} python package${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}`,
      missing,
      pythonVersion,
    };
  } catch (err) {
    return { connected: false, reason: `Python probe failed: ${err.message || err}`, missing: [], pythonVersion: null };
  }
}

// Higgsfield video families the curated picker lacks, read from their public catalog.
router.get('/higgsfield-models/unsupported', asyncHandler(async (_req, res) => {
  res.json(await checkHiggsfieldNewModels());
}));

router.get('/models', asyncHandler(async (_req, res) => {
  const { models } = await hardwareAwareVideoModels();
  res.json(models);
}));

// Everything the Model picker needs to render AND auto-select, with no
// per-request python probe in the way. A sibling route rather than a wrapper
// around /models so the bare-array shape that route has always returned stays
// intact for its existing callers (and for an older client talking to a newer
// server).
router.get('/model-context', asyncHandler(async (_req, res) => {
  res.json(await videoModelContext());
}));

const sharedTextEncoderCacheStatus = async () => {
  const repo = getTextEncoderRepo();
  if (!isHfRepoId(repo)) return { repo, cached: true, sizeBytes: 0, integrity: null };
  return { repo, ...await repoCacheStatus(repo) };
};

const textEncoderCacheStatus = async (entry, target = textEncoderDownloadTarget(entry)) => {
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
};

const icLoraCacheStatus = async (spec) => {
  // A spec that must be located by its exact file can't use the repo-wide
  // verdict. Two reasons, both fatal to it: a mirrored spec (Ingredients)
  // has a 708 GB aggregate mirror that reports `cached` off any unrelated
  // weight, and a revision-pinned spec would accept a DIFFERENT commit's
  // snapshot. Probe the ONE file across the candidates instead, and skip the
  // integrity walk (which would stat/hash every sibling weight in a mirror).
  if (icLoraProbesExactFile(spec)) {
    const found = await findCachedIcLoraWeight(spec);
    return {
      id: icLoraWeightKey(spec), repo: spec.repo, label: spec.label,
      baseModel: spec.baseModel, revision: spec.revision || null,
      requiresPreDownload: !!spec.requiresPreDownload,
      estimatedBytes: spec.sizeBytes,
      gated: !!spec.gated, mirrorRepo: spec.mirrorRepo || null,
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
    id: icLoraWeightKey(spec), repo: spec.repo, label: spec.label,
    baseModel: spec.baseModel, revision: spec.revision || null,
    requiresPreDownload: !!spec.requiresPreDownload,
    estimatedBytes: spec.sizeBytes,
    gated: !!spec.gated,
    ...await repoCacheStatus(spec.repo),
  };
};

router.get('/models/status', asyncHandler(async (_req, res) => {
  // Text encoder is shared across all video renders. A registry entry with
  // `localPath` (e.g. an LM Studio install) trumps the HF cache check, so
  // surface both the repo-cache status and the resolved local path so the UI
  // can distinguish "not downloaded" from "served from LM Studio".
  const verifyCache = new Map();
  const [models, textEncoder, textEncoderOptions, icLoras] = await Promise.all([
    Promise.all(listVideoModels().map(async (m) => {
      return { id: m.id, ...await modelCacheStatus(m, verifyCache) };
    })),
    sharedTextEncoderCacheStatus(),
    // Substitutable prompt conditioners (lib/videoTextEncoders.js) — the same
    // `{ id, repo, cached, sizeBytes, integrity }` badge shape as the models and
    // the IC weights, so the video form renders their Download button and
    // Repair banner with the existing components. Scoped to the ONE pinned file
    // (never the repo) for the reason in textEncoderDownloadTargets.
    Promise.all(textEncoderDownloadTargets().map(({ entry, target }) => textEncoderCacheStatus(entry, target))),
    // IC-LoRA weights (issue #3100). Each is a separate several-hundred-MB pull,
    // so they get the same cached/size/integrity shape as the models — that's
    // what lets the mode panel render a Download badge and a Repair banner with
    // the existing components. This is the PROVISIONING list, so it spans weights
    // that are not remix modes (the LTX-2.5 upscale adapter, #6502) and reports
    // each by its `icLoraWeightKey` rather than assuming a `mode` value exists.
    Promise.all(listIcLoraWeights().map(icLoraCacheStatus)),
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
  validateRequest(modelDownloadQuerySchema, req.query);
  const { modelId } = validateRequest(modelDownloadParamsSchema, req.params);
  const model = listVideoModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  res.json({ id: model.id, ...await modelCacheStatus(model) });
}));

const speedProfileDownloadQuerySchema = modelDownloadQuerySchema.extend({ speedProfileId: z.string().min(1).max(64).optional() });
router.post('/models/:modelId/download', asyncHandler(async (req, res) => {
  const { force, speedProfileId } = validateRequest(speedProfileDownloadQuerySchema, req.query);
  const { modelId } = validateRequest(modelDownloadParamsSchema, req.params);
  const model = listVideoModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  const repos = modelDownloadTargets(model, { speedProfileId });
  if (repos.length === 0) throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file.`, { status: 400, code: 'NO_REPO_FOR_MODEL' });
  const runtimeInfo = BYOV_RUNTIME_INFO[model.runtime];
  const pythonPath = runtimeInfo?.hfDownloadPython !== false
    && await isByovRuntimeReady(model.runtime)
    ? runtimeInfo.venvPython
    : null;
  await startHfDownloadStream({ req, res, repos, pythonPath, force });
}));

// IC-LoRA remix weights (issue #3100) get their own download/repair pair for
// the same reason the text encoder does: they're required by the render path
// but are NOT listVideoModels() entries, so the model-id-keyed routes above
// can't reach them. Keyed by the PortOS remix mode ('ic-control', …) so the
// client uses the same identifier it puts in the render payload.
// Download one IC weight. An exact-file spec is fetched SINGLE-FILE and only ever
// single-file. For Ingredients that is because the official repo is gated (an
// anonymous pull 401s) and its un-gated mirror is the ~708 GB `DeepBeepMeep/LTX-2`
// aggregate, so a snapshot of either would either fail or fill the user's disk;
// for a revision-pinned spec it is because the pinned commit and filename are the
// whole point of the pin. Candidates are tried in order (official → mirror) so a
// user WITH an HF token gets the first-party weight and a user without one still
// succeeds via the mirror — no token, no extra button. The exact filename is
// pinned so a mirror can't hand back a sibling weight.
//
// A spec with NO mirror (the LTX-2.5 upscaler) therefore has exactly one
// candidate: a gated failure surfaces with its actionable "accept the license"
// message rather than being downgraded on the way to a fallback that isn't there.
router.get('/ic-loras/:mode/download', asyncHandler(async (req, res) => {
  validateRequest(modelDownloadQuerySchema, req.query);
  const { mode } = validateRequest(icLoraDownloadParamsSchema, req.params);
  res.json(await icLoraCacheStatus(icLoraSpecFromParam(mode)));
}));

router.post('/ic-loras/:mode/download', asyncHandler(async (req, res) => {
  const { force } = validateRequest(modelDownloadQuerySchema, req.query);
  const { mode } = validateRequest(icLoraDownloadParamsSchema, req.params);
  const spec = icLoraSpecFromParam(mode);
  if (!icLoraProbesExactFile(spec)) {
    await startHfDownloadStream({ req, res, repo: spec.repo, force });
    return;
  }
  await startHfDownloadStream({
    req,
    res,
    fallbacks: icLoraWeightCandidates(spec)
      .map((c) => ({ repo: c.repo, only: [c.filename], revision: c.revision })),
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
  if (icLoraProbesExactFile(spec)) {
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
// Always the entry's pinned file list, never a snapshot: these repos publish
// more than the loader can read — INT8 ConvRot / NVFP4 quantizations and 50-63
// generation tails in a repack, the language layers past the conditioning depth
// in an upstream checkpoint — so a repo-wide pull would cost ~130 GB for ~48 GB
// of usable weights.
router.get('/text-encoders/:id/download', asyncHandler(async (req, res) => {
  validateRequest(modelDownloadQuerySchema, req.query);
  const { id } = validateRequest(textEncoderDownloadParamsSchema, req.params);
  res.json(await textEncoderCacheStatus(textEncoderFromParam(id)));
}));

router.post('/text-encoders/:id/download', asyncHandler(async (req, res) => {
  const { force } = validateRequest(modelDownloadQuerySchema, req.query);
  const { id } = validateRequest(textEncoderDownloadParamsSchema, req.params);
  const entry = textEncoderFromParam(id);
  await startHfDownloadStream({
    req,
    res,
    repos: [textEncoderDownloadTarget(entry)],
    force,
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
  validateRequest(modelDownloadQuerySchema, req.query);
  res.json(await sharedTextEncoderCacheStatus());
}));

router.post('/text-encoder/download', asyncHandler(async (req, res) => {
  const { force } = validateRequest(modelDownloadQuerySchema, req.query);
  const repo = getTextEncoderRepo();
  // Local-path encoders (LM Studio) are not downloadable — they're served
  // off disk and the status endpoint already reports cached: true for them.
  if (!isHfRepoId(repo)) {
    throw new ServerError('Active text encoder is a local-path entry, not an HF repo.', { status: 400, code: 'NOT_DOWNLOADABLE' });
  }
  // `?force=1` (sent by the repair-initiated re-download) re-fetches even when
  // the repo still looks cached — a deleted shard from a multi-file encoder
  // would otherwise be skipped.
  await startHfDownloadStream({ req, res, repo, force });
}));

// What Generate would send to the model, built by the render's own code (#11317).
router.post('/prompt-preview', optionalUploadFields([]), asyncHandler(async (req, res) => {
  res.json(await previewVideoPrompt(validateRequest(promptPreviewBodySchema, req.body ?? {})));
}));

router.post('/', frameImageUpload, asyncHandler(async (req, res) => {
  // The route owns cleanup before validation succeeds; the submit service owns
  // every failure after it receives parsed data.
  const uploads = req.files || {};
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await cleanupMultipartTemp(uploads);
    failValidation(parsed);
  }
  const queued = await submitVideoGenJob(parsed.data, uploads);
  try {
    const happenedAt = new Date().toISOString();
    await recordUserAction({
      type: 'media.video.enqueue',
      actor: 'user',
      target: queued.jobId,
      summary: 'enqueued video job',
      payload: { jobId: queued.jobId },
      source: { route: `${req.baseUrl}${req.route?.path ?? ''}`, method: req.method },
      happenedAt,
      dedupeKey: `media.video.enqueue:${queued.jobId}`,
    });
  } catch (error) {
    console.error(`❌ Failed to record media.video.enqueue: ${error.message}`);
  }
  res.json(queued);
}));

// Overnight local clip batches (#15498): queue each shot × local reference model
// as its Shot card Render, held until `startAt`; anything still waiting at `stopBy` is dropped.
const overnightBodySchema = z.object({
  projectId: z.string().min(1).max(200),
  sceneIds: z.array(z.string().min(1).max(200)).min(1).max(200),
  modelIds: z.array(z.string().min(1).max(256)).min(1).max(4),
  startAt: z.string().datetime().optional(),
  stopBy: z.string().datetime().optional(),
}).refine((b) => !b.startAt || !b.stopBy || Date.parse(b.stopBy) > Date.parse(b.startAt),
  { message: 'The stop-by time must be after the start time', path: ['stopBy'] });

router.post('/overnight', asyncHandler(async (req, res) => {
  const { projectId, sceneIds, modelIds, startAt, stopBy } = validateRequest(overnightBodySchema, req.body ?? {});
  const [{ musicVideoClipReferences }, { overnightModelKind, overnightRenderBodies }] = await Promise.all([
    import('../services/musicVideo/clipCastReferences.js'), import('../services/musicVideo/overnightRenders.js'),
  ]);
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  const catalog = getVideoModels();
  const models = modelIds.map((id) => catalog.find((model) => model.id === id));
  const unusable = modelIds.filter((id, i) => !overnightModelKind(models[i]));
  if (unusable.length) {
    throw new ServerError(`Overnight renders use LTX 2.5 or FastH3 Omni; ${unusable.join(', ')} takes no clip references.`, { status: 400, code: 'OVERNIGHT_MODEL_UNSUPPORTED' });
  }
  const batchId = randomUUID();
  const schedule = startAt || stopBy ? { ...(startAt ? { startAt } : {}), ...(stopBy ? { stopBy } : {}) } : undefined;
  const { bodies, skipped } = await overnightRenderBodies({ project, sceneIds: [...new Set(sceneIds)], models, schedule, batchId, clipReferences: musicVideoClipReferences });
  const queued = [];
  for (const { sceneId, modelId, body } of bodies) {
    const parsed = generateBodySchema.safeParse(body);
    if (!parsed.success) { skipped.push({ sceneId, modelId, reason: parsed.error.issues[0]?.message || 'Invalid request' }); continue; }
    try {
      const job = await submitVideoGenJob(parsed.data, {});
      queued.push({ sceneId, modelId, jobId: job.jobId });
    } catch (err) {
      skipped.push({ sceneId, modelId, reason: err.message });
    }
  }
  console.log(`🌙 Overnight batch ${batchId.slice(0, 8)}: ${queued.length} queued, ${skipped.length} skipped`);
  res.json({ batchId, queued, skipped });
}));

router.get('/overnight', asyncHandler(async (req, res) => {
  const { projectId } = validateRequest(z.object({ projectId: z.string().min(1).max(200) }), req.query);
  const { overnightBatches } = await import('../services/musicVideo/overnightRenders.js');
  res.json({ batches: overnightBatches(listJobs({ kind: 'video' }), projectId) });
}));

// Cancel a batch's remaining jobs; a running render is stopped too, finished takes stay.
router.delete('/overnight/:batchId', asyncHandler(async (req, res) => {
  const { batchId } = validateRequest(z.object({ batchId: z.string().uuid() }), req.params);
  const live = listJobs({ kind: 'video' }).filter((job) => job.params?.musicVideo?.batchId === batchId
    && (job.status === 'queued' || job.status === 'running'));
  let canceled = 0;
  for (const job of live) {
    const result = await cancelJob(job.id);
    if (result?.ok) canceled += 1;
  }
  res.json({ canceled });
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
  'tiling', 'disableAudio', 'displaySleep', 'mode', 'chunks', 'chunkPrompts', 'contextFrames', 'imageStrength',
  // Plain enum, no path — safe to echo so a reloading page restores the promise the
  // in-flight render is actually keeping.
  'i2vReferenceMode',
  // A registry id, not a path — safe to echo so a reloading page restores the
  // conditioner the in-flight render is actually using.
  'textEncoderId',
  // Likewise a registry id — the sampler schedule the in-flight render picked,
  // so a reloading page restores the picker instead of snapping back to Quality.
  'speedProfileId',
  // Likewise a closed enum with no path — the decode the in-flight render
  // picked, so a reloading page restores the control instead of snapping back
  // to Full.
  'draftDecode',
  // Block-streaming request (#6499) — a closed enum with no path, safe to
  // echo so a reloading page restores the picker instead of snapping back to
  // Auto.
  'streamingMode', 'a2vLoraStageStrengths',
  'audioStartSec',
  // Grok jobs (#2859 phase 2): the semantic t2v/i2v mode ('mode' holds the
  // 'grok' discriminator for them) and the clip duration — both plain
  // values, safe to echo for the reloading page's form restore.
  'videoMode', 'duration',
  'targetAspectRatio', 'ratio', 'bodyControl', 'expressionIntensity',
  // reactor.inc jobs (#6214): the clip to chain from, the clip length, and the
  // fast-h3 session canvas — all plain scalars (no filesystem path), safe to
  // echo for the reloading page's form restore. `seed` above already covers
  // reactor's seed field.
  'continueFromClipId', 'seconds', 'aspect',
  // loras are { filename, scale } basenames (no server filesystem paths), so
  // they're safe to echo back for the resuming picker to repopulate.
  'loras',
  // IC-LoRA remix dials — plain scalars, safe to echo. The reference clip
  // itself rides a separate basename mapping below (its param is an absolute
  // path, which the whitelist exists to keep off this surface).
  'icStrength', 'icAttentionStrength', 'icSkipStage2',
];
const pickJobParams = (job) => {
  const params = job?.params;
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const k of ACTIVE_JOB_PARAM_FIELDS) {
    if (params[k] !== undefined) out[k] = params[k];
  }
  if (['frame', 'window'].includes(params.continuityStrategy)) out.continuityStrategy = params.continuityStrategy;
  const continuation = sanitizeContinuation(params.continuation);
  if (continuation) out.continuation = continuation;
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
    const references = params.icReferencePaths
      .filter((p) => typeof p === 'string' && p)
      .map((path) => ({ path, name: basename(path) }));
    const names = references.map((ref) => ref.name);
    if (names.length) out.icReferenceNames = names;
    // A Music Video cast guide can live outside the gallery. Only restore the
    // whole set when every basename resolves to the SAME gallery path; a partial
    // restore could submit a different identity or silently omit one.
    if (names.length && icLoraSpecForMode(params.mode)?.referenceKind === 'image'
      && references.every(({ path, name }) => resolveGalleryImage(name, { mustExist: false }) === path)) {
      out.icReferenceImageFiles = names;
    }
  }
  if (params.mode === 'ic-ingredients-25' && typeof params.sourceImagePath === 'string' && params.sourceImagePath) {
    const name = basename(params.sourceImagePath);
    if (resolveGalleryImage(name, { mustExist: false }) === params.sourceImagePath) out.sourceImageFile = name;
    else out.unavailableSourceImageName = name;
  }
  // Same display-only echo as the IC references above: basenames only. They ARE
  // the gallery filenames, so the resuming form can repopulate its picker.
  if (Array.isArray(params.referenceAudioPaths) && params.referenceAudioPaths.length) {
    out.referenceAudioNames = params.referenceAudioPaths.filter((p) => typeof p === 'string' && p).map((p) => basename(p));
  }
  if (Array.isArray(params.referenceVideoPaths) && params.referenceVideoPaths.length) {
    out.referenceVideoNames = params.referenceVideoPaths.filter((p) => typeof p === 'string' && p).map((p) => basename(p));
  }
  if (Array.isArray(params.referenceImagePaths) && params.referenceImagePaths.length) {
    // Only gallery-backed paths can be submitted again by filename. Internal
    // cast guides may live in another image-input root with the same basename.
    const references = params.referenceImagePaths.filter((p) => typeof p === 'string' && p)
      .map((path) => ({ path, name: basename(path) }))
      .map(({ path, name }) => ({ name, gallery: resolveGalleryImage(name, { mustExist: false }) === path }));
    const files = references.filter((ref) => ref.gallery).map((ref) => ref.name);
    const unavailable = references.filter((ref) => !ref.gallery).map((ref) => ref.name);
    if (files.length) out.referenceImageFiles = files;
    if (unavailable.length) out.unavailableReferenceImageNames = unavailable;
  }
  // A federated render's prompt and model live only inside the versioned marker
  // — the top-level copies are blanked so a downgraded build fails closed
  // (#4683). Read through to the wire request, as the queue's own projection
  // does, or a page reload mid-render resumes the form with an empty prompt and
  // the LOCAL default model instead of the peer's.
  if (isRemoteMediaJob(job)) {
    const prompt = effectiveJobPrompt(job);
    if (typeof prompt === 'string') out.prompt = prompt;
    const { modelId } = params.remoteMedia.request ?? {};
    if (typeof modelId === 'string' && modelId) out.modelId = modelId;
  }
  return out;
};

router.get('/active', (_req, res) => {
  const runningList = listJobs({ kind: 'video', status: 'running' });
  const queuedList = runningList.length === 0 ? listJobs({ kind: 'video', status: 'queued' }) : [];
  const queued = queuedList.length ? queuedList[queuedList.length - 1] : null;
  const primaryJob = runningList[0] || queued;

  const formatJob = (job) => ({
    jobId: job.id,
    generationId: job.id,
    status: job.status,
    position: job.position,
    startedAt: job.startedAt || null,
    params: pickJobParams(job),
  });

  const activeJobs = runningList.map(formatJob);
  const activeJob = primaryJob ? formatJob(primaryJob) : null;
  const sampleJob = primaryJob || runningList[0];
  const lane = sampleJob ? mediaJobExecutionLane({ kind: sampleJob.kind, mode: sampleJob.params?.mode }) : 'gpu';
  const isLocal = lane === 'gpu';
  const limit = (typeof laneConcurrencyFor === 'function' && sampleJob) ? laneConcurrencyFor(sampleJob) : 1;

  if (!primaryJob && runningList.length === 0) {
    return res.json({ activeJob: null });
  }

  res.json({
    activeJob,
    activeJobs,
    limit,
    ...(isLocal ? { memoryGoverned: true, limitReason: 'memory-governed' } : {}),
  });
});

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

// The queue reports a refused cancel as { ok: false, code }; surface it as an
// error status so the caller never mistakes a refusal for a cancelled render.
const cancelOrRefuse = async (jobId) => {
  const result = await cancelJob(jobId);
  if (!result?.ok && result?.code) {
    throw new ServerError(result.error || 'Cancel failed', { status: result.code === 'ALREADY_TERMINAL' ? 409 : 404, code: result.code });
  }
  return result;
};

router.post('/cancel', asyncHandler(async (req, res) => {
  // Cancel selection rules, in priority order:
  //   1. Explicit body.jobId — cancel exactly that job (queued or running).
  //      Required for users with multiple in-flight renders.
  //   2. No jobId — cancel the currently-running video job (legacy behavior).
  //   3. No running job — cancel the newest queued video job so the user can
  //      take back a submission they regret while it's still in line.
  // A supplied-but-malformed jobId is a 400, not "absent": absent selects the
  // running job, which would cancel a different render than the one named (#9932).
  const { jobId: requestedJobId } = validateRequest(videoCancelBodySchema, req.body ?? {});
  if (requestedJobId) {
    // Validate that the jobId is a video job before cancelling, so a stray
    // image jobId from another tab doesn't accidentally cancel here.
    const job = listJobs({ kind: 'video' }).find((j) => j.id === requestedJobId);
    if (!job) throw new ServerError('Video job not found', { status: 404, code: 'NOT_FOUND' });
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new ServerError(`Job already ${job.status}`, { status: 409, code: 'ALREADY_TERMINAL' });
    }
    return res.json(await cancelOrRefuse(job.id));
  }
  const running = listJobs({ kind: 'video', status: 'running' });
  if (running.length) return res.json(await cancelOrRefuse(running[0].id));
  // No running render — cancel the newest queued video instead so the user
  // can pull back a submission before it starts.
  const queued = listJobs({ kind: 'video', status: 'queued' });
  if (queued.length) return res.json(await cancelOrRefuse(queued[queued.length - 1].id));
  res.json({ ok: false, reason: 'no active or queued video render' });
}));

const updatePromptSchema = z.object({ prompt: z.string().max(8000) });
// `hidden` is required: reading an absent body as `false` turned a malformed
// request into a silent unhide.
const visibilitySchema = z.object({ hidden: z.boolean() });

router.get('/history', asyncHandler(async (req, res) => {
  // No query keeps the legacy full array; see historyList.js for the opt-in form.
  if (!isHistoryListQuery(req.query)) return res.json(await withMediaFileSizes(await loadHistory(), 'video'));
  const options = validateRequest(historyListQuerySchema, req.query);
  res.json(await listVideoHistoryQuery(options, await loadHistory()));
}));

// One history entry by id (#4165) — see videoHistoryRead.js.
router.get('/history/:id', createVideoHistoryItemRead(getHistoryItem));

// Upload a video into the shared gallery (#4188) — the video counterpart of
// POST /api/image-gen/upload. Lands the bytes under PATHS.videos with a
// `source: 'upload'` history entry so the file federates via the peer-sync
// asset manifest (unlike POST /api/uploads → data/uploads/, which does not).
// Legacy base64 callers retain the JSON transport bounds; multipart files bypass them.
const uploadVideoSchema = z.object({
  data: z.string().min(1).max(JSON_BODY_LIMIT_BYTES),
  filename: z.string().max(255).optional(),
});

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

const posterSchema = z.object({ atSec: z.number().finite().nullable() });
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

// Render jobs use UUID history ids, while shared-gallery uploads use an
// `upload-<uuid8>` id. These operations derive a NEW artifact path from the
// resolved record (an anchor frame, an upscale, a stitch output) rather than
// merely reading or mutating the row, so they hold the tighter of the two
// contracts and accept only the two id forms this install can mint.
const historyIdSchema = z.string().regex(
  /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|upload-[a-f0-9]{8})$/i,
  'invalid history id',
);

router.post('/last-frame/:id', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  res.json(await extractLastFrame(parsed.data));
}));

// The method choice, shared by the action's body and the plan endpoint's query
// so the two can never disagree on what is accepted or what an omission means.
// An absent method is exactly Lanczos, so every pre-#6509 client keeps its
// current behavior without sending anything new.
const upscaleMethodSchema = z.object({
  method: z.enum(UPSCALE_METHODS).default(DEFAULT_UPSCALE_METHOD),
});

router.post('/upscale/:id/topaz/quote', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(z.object({ model: z.enum(['proteus', 'starlight']).default('proteus') }), req.body ?? {});
  assertNoPendingTopaz(parsed.data);
  res.json({ ok: true, quote: await quoteTopaz(parsed.data, body.model) });
}));

router.get('/upscale/topaz/jobs/:jobId/status', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(z.object({ jobId: z.string().uuid() }), req.params);
  res.json({ ok: true, ...await reconcileTopazStatus(jobId) });
}));

router.post('/upscale/topaz/jobs/:jobId/cancel', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(z.object({ jobId: z.string().uuid() }), req.params);
  res.json({ ok: true, ...await reconcileTopazStatus(jobId, { cancelRemote: true }) });
}));

router.post('/upscale/topaz/jobs/:jobId/recover', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(z.object({ jobId: z.string().uuid() }), req.params);
  res.json({ ok: true, job: await recoverTopazResult(jobId) });
}));

router.post('/upscale/:id/topaz', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(z.object({ token: z.string().uuid() }), req.body ?? {});
  res.json({ ok: true, job: await enqueueTopazUpscale(parsed.data, body.token) });
}));

// What the user must see BEFORE submitting (#6509): source geometry, the target
// the method would produce, the padding the model grid needs, and whether this
// machine can actually run the method. Read-only — it queues no job and pulls
// no weight.
router.get('/upscale/:id/plan', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const query = upscaleMethodSchema.safeParse(req.query ?? {});
  if (!query.success) failValidation(query);
  res.json({ ok: true, plan: await planUpscaleHistoryItem(parsed.data, query.data) });
}));

// The two methods answer with materially different things, so they answer with
// different KEYS rather than one overloaded field. Lanczos is an inline ffmpeg
// pass that returns the finished row; the generative method is a multi-minute
// GPU render, so it returns the queued job to watch and the row appears in
// history when it lands (#6511). Every pre-#6511 client omits `method`, gets
// Lanczos, and still reads `video` exactly as before.
router.post('/upscale/:id', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = upscaleMethodSchema.safeParse(req.body ?? {});
  if (!body.success) failValidation(body);
  if (body.data.method === 'ltx') {
    res.json({ ok: true, job: await enqueueLtxUpscale(parsed.data) });
    return;
  }
  const entry = await upscaleHistoryItem(parsed.data, body.data);
  res.json({ ok: true, video: entry });
}));

// Keep a frame range of a clip: `startSec` drops the frames before it, `endSec`
// the frames from it on. Like an upscale, it writes a NEW gallery row and
// leaves the source clip untouched.
const trimBodySchema = z.object({
  startSec: z.number().finite().positive().max(3600).optional(),
  endSec: z.number().finite().positive().max(3600).optional(),
}).refine((b) => b.startSec !== undefined || b.endSec !== undefined, { message: 'startSec or endSec is required' })
  .refine((b) => b.startSec === undefined || b.endSec === undefined || b.endSec > b.startSec, { message: 'endSec must be after startSec', path: ['endSec'] });
router.post('/history/:id/trim', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(trimBodySchema, req.body ?? {});
  res.json({ ok: true, video: await trimHistoryItem(parsed.data, body) });
}));

// Re-shoot a clip as if handheld (lib/handheldCamera.js): zoomed in a little,
// with the margin swaying, rolling and bobbing with footsteps. Like a trim, it
// writes a NEW gallery row and leaves the source clip untouched.
const handheldBodySchema = z.object({
  shake: z.number().finite().min(0).max(1),
  steps: z.number().finite().min(0).max(1),
  seed: z.number().int().min(1).max(HANDHELD_SEED_MAX).optional(),
}).strict();
router.post('/history/:id/handheld', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(handheldBodySchema, req.body ?? {});
  res.json({ ok: true, video: await handheldHistoryItem(parsed.data, body) });
}));

// "Make it vertical" (lib/verticalReframe.js): the clip centred over a blurred copy of itself on
// a 9:16, 4:5 or 1:1 canvas. Queued as a media job; a repeat request returns the live job.
const verticalBodySchema = z.object({ ratio: z.enum(VERTICAL_RATIO_IDS) }).strict();
router.post('/history/:id/vertical', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(verticalBodySchema, req.body ?? {});
  res.json({ ok: true, job: await enqueueVertical(parsed.data, body.ratio) });
}));

// Continue a hosted clip on its model's extend endpoint (#16150); `dryRun` returns the exact body and price.
router.post('/history/:id/extend', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(videoExtendBodySchema, req.body ?? {});
  res.json(await extendHistoryClip(parsed.data, body));
}));

const stitchBodySchema = z.object({
  videoIds: z.array(historyIdSchema).min(2).max(20),
});

router.post('/stitch', asyncHandler(async (req, res) => {
  const parsed = stitchBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  // The concat runs as a media job (#13000); the row lands in history when it
  // finishes. A repeat POST of the same ordered ids returns the live job.
  res.json({ ok: true, job: await enqueueStitch(parsed.data.videoIds) });
}));

export default router;
