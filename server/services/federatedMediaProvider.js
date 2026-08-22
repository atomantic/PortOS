/**
 * Provider-side federated media contract (wire v1).
 *
 * This first slice exposes queued audio generation without introducing a
 * second runner or persistence layer: accepted work is tagged and submitted to
 * mediaJobQueue. Provider settings and queue records stay machine-local. Only
 * allowlisted capability/job/result projections cross the peer boundary.
 */

import { stat } from 'node:fs/promises';
import { ServerError } from '../lib/errorHandler.js';
import { createMutex } from '../lib/asyncMutex.js';
import { canonicalStringify } from '../lib/objects.js';
import {
  PATHS, makePathResolver, resolveGalleryImage, sha256File, sha256Text,
} from '../lib/fileUtils.js';
import { findCachedRepoFiles, inspectModelCache } from '../lib/hfCache.js';
import { getImageModels, getVideoModels, isEditOnly, isFlux2, repoForModel } from '../lib/mediaModels.js';
import { isMiniMaxH3Runtime, usesDiffusersRunner } from '../lib/runners.js';
import {
  FEDERATED_MEDIA_ASSET_MAX_BYTES,
  FEDERATED_MEDIA_ASSET_MAX_COUNT,
  FEDERATED_MEDIA_ASSET_MIME_TYPES,
  FEDERATED_MEDIA_RESULT_EXTENSION,
  FEDERATED_MEDIA_STALE_AFTER_MS,
  FEDERATED_MEDIA_WIRE_VERSION,
  KNOWN_MEDIA_KINDS,
} from '../lib/federatedMediaWire.js';
import { findFederatedMediaAsset, sweepFederatedMediaAssets } from './federatedMedia/assetStore.js';
import { getSettings } from './settings.js';
import {
  cancelJob,
  enqueueJob,
  getJob,
  isRemoteMediaJob,
  laneConcurrencyFor,
  listJobs,
} from './mediaJobQueue/index.js';
import { listMusicEngineCapabilities } from './musicEngineCapabilities.js';
import { BYOV_VIDEO_RUNTIMES, isByovRuntimeReady } from './videoGen/runtimes.js';
import { minimaxH3ControlError } from './videoGen/minimaxH3Controls.js';
import { readCallerInstanceId } from './sharing/peerPullAuthorization.js';
import { findPeerById } from './sharing/peerSyncShared.js';

export { FEDERATED_MEDIA_STALE_AFTER_MS, FEDERATED_MEDIA_WIRE_VERSION };
export const DEFAULT_FEDERATED_MEDIA_PROVIDER = Object.freeze({
  enabled: false,
  maxQueuedJobs: 2,
  audioModels: Object.freeze([]),
  imageModels: Object.freeze([]),
  videoModels: Object.freeze([]),
});

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const OWNER_PREFIX = 'federated-media:';
const MUSIC_RESULT_RE = /^music-gen-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/i;
const RESULT_HASH_CACHE_MAX = 100;
const resolveMusicResult = makePathResolver(() => PATHS.music, { extensions: ['wav'] });
const resultHashCache = new Map();
const withAdmissionLock = createMutex();

const unavailable = (message, code, status = 503, context) => {
  throw new ServerError(message, { status, code, ...(context ? { context } : {}) });
};

const sanitizeModelList = (models) => (Array.isArray(models)
  ? models
    .filter((model) => model && typeof model === 'object' && !Array.isArray(model))
    .map(({ engine, modelId }) => ({ engine, modelId }))
    .filter(({ engine, modelId }) => typeof engine === 'string' && typeof modelId === 'string')
  : []);

const requiresConfiguredPython = (kind, model) => {
  if (kind === 'image') return !isFlux2(model) && !usesDiffusersRunner(model);
  if (kind === 'video') return !BYOV_VIDEO_RUNTIMES.has(model?.runtime);
  return false;
};

/**
 * Which conditioning slots this model can actually fill, and whether it can
 * render at all without one (ADR
 * docs/decisions/2026-08-22-federated-media-input-assets.md rule 1).
 *
 * Derived from what the LOCAL RUNNER accepts, not from a wish list: only the
 * FLUX.2 branch of imageGen/local.js passes `--reference-image`, and a video
 * model's start/end frame slots follow its declared `supportedModes`. Offering
 * a role the runner would drop is how a render silently comes back
 * unconditioned.
 *
 * @returns {{roles: string[], required: boolean}|null} `null` when this model
 *   takes no conditioning at all.
 */
function federatedInputProfile(kind, model) {
  if (!model) return null;
  if (kind === 'image') {
    return {
      roles: isFlux2(model) ? ['initImage', 'referenceImages'] : ['initImage'],
      // An edit-only model has nothing to edit without one.
      required: isEditOnly(model),
    };
  }
  if (kind === 'video') {
    // No declared modes is the historical text-only assumption, not "all modes".
    const modes = Array.isArray(model.supportedModes) ? model.supportedModes : null;
    if (!modes) return null;
    const roles = [];
    if (modes.includes('image') || modes.includes('fflf')) roles.push('sourceImage');
    if (modes.includes('fflf')) roles.push('lastImage');
    if (!roles.length) return null;
    return { roles, required: !modes.includes('text') };
  }
  return null;
}

// Do not advertise a catalog model this contract cannot drive; otherwise the
// provider accepts the job, persists it, and only rejects it after a worker
// starts. Since conditioning images cross, "can render text-only" is no longer
// the bar — a model that needs an init image is advertisable, carrying
// `inputAssets.required` so a consumer knows to send one. An older consumer
// blind to that field submits text-only and gets a typed
// MEDIA_PROVIDER_INPUT_REQUIRED at admission rather than a stalled job.
const supportsFederatedInput = (kind, model) => {
  if (kind === 'image') return !isEditOnly(model) || !!federatedInputProfile(kind, model);
  if (kind === 'video') {
    const modes = model?.supportedModes;
    if (!Array.isArray(modes) || modes.includes('text')) return true;
    return !!federatedInputProfile(kind, model);
  }
  return true;
};

// The capability's input-asset block. Limits only — never a filename, digest, or
// anything derived from a prompt (ADR 2026-08-20 rule 3 still governs status).
const federatedInputAssetsBlock = (kind, model) => {
  const profile = federatedInputProfile(kind, model);
  if (!profile) return null;
  return {
    maxBytes: FEDERATED_MEDIA_ASSET_MAX_BYTES,
    maxCount: FEDERATED_MEDIA_ASSET_MAX_COUNT,
    mimeTypes: [...FEDERATED_MEDIA_ASSET_MIME_TYPES],
    roles: profile.roles,
    required: profile.required,
  };
};

// Which submission field feeds which slot, per kind. One table so the
// capability's advertised `roles`, this admission check, and the local-runner
// param names cannot drift into disagreeing about what a role means.
const INPUT_ASSET_FIELDS = Object.freeze({
  image: [
    { role: 'initImage', field: 'initImage', param: 'initImagePath', many: false },
    { role: 'referenceImages', field: 'referenceImages', param: 'referenceImagePaths', many: true },
  ],
  video: [
    { role: 'sourceImage', field: 'sourceImage', param: 'sourceImagePath', many: false },
    { role: 'lastImage', field: 'lastImage', param: 'lastImagePath', many: false },
  ],
});

/**
 * Turn a submission's asset REFERENCES into local paths, refusing anything this
 * capability did not advertise (ADR
 * docs/decisions/2026-08-22-federated-media-input-assets.md rule 1).
 *
 * Resolution happens at admission rather than at render time on purpose: an
 * expired or never-uploaded asset is a re-upload the consumer can act on right
 * now, whereas discovering it when a worker starts leaves a queued job that
 * fails minutes later with the consumer no longer watching.
 *
 * @returns {Promise<object>} local generator params for the resolved assets
 */
async function resolveSubmissionInputAssets({ callerId, input, capability }) {
  const fields = INPUT_ASSET_FIELDS[input.kind] || [];
  const requested = fields
    .map((entry) => ({
      ...entry,
      refs: entry.many
        ? (Array.isArray(input[entry.field]) ? input[entry.field] : [])
        : (input[entry.field] ? [input[entry.field]] : []),
    }))
    .filter((entry) => entry.refs.length > 0);
  const limits = capability.inputAssets;

  if (requested.length === 0) {
    if (limits?.required) {
      unavailable(
        'Requested model renders only from a conditioning image; none was supplied',
        'MEDIA_PROVIDER_INPUT_REQUIRED',
        400,
        { roles: limits.roles },
      );
    }
    return {};
  }
  if (!limits) {
    unavailable(
      'Requested model does not accept conditioning images',
      'MEDIA_PROVIDER_INPUT_UNSUPPORTED',
      400,
    );
  }
  const unsupportedRoles = requested.filter((entry) => !limits.roles.includes(entry.role));
  if (unsupportedRoles.length) {
    unavailable(
      `Requested model does not accept ${unsupportedRoles.map((entry) => entry.role).join(' or ')}`,
      'MEDIA_PROVIDER_INPUT_UNSUPPORTED',
      400,
      { roles: limits.roles },
    );
  }
  const total = requested.reduce((sum, entry) => sum + entry.refs.length, 0);
  if (total > limits.maxCount) {
    unavailable('Too many conditioning images for one job', 'MEDIA_PROVIDER_INPUT_UNSUPPORTED', 400, {
      maxCount: limits.maxCount,
    });
  }

  const params = {};
  for (const entry of requested) {
    const paths = [];
    for (const ref of entry.refs) {
      const found = await findFederatedMediaAsset(callerId, ref.assetId);
      if (!found) {
        // 410, not 404: the id was well-formed and caller-scoped, so "gone"
        // (expired, or swept) is the actionable reading — re-upload and retry.
        // The upload is content-addressed, so the retry keeps the same id.
        unavailable(
          'A referenced conditioning image is no longer staged on the provider',
          'MEDIA_PROVIDER_ASSET_NOT_FOUND',
          410,
          { assetId: ref.assetId },
        );
      }
      paths.push(found.path);
    }
    params[entry.param] = entry.many ? paths : paths[0];
  }
  return params;
}

const requiredModelCacheGroups = (model) => {
  const groups = [];
  if (Array.isArray(model?.repoFiles)) {
    groups.push({ repo: model.repo, revision: model.revision, files: model.repoFiles });
  }
  if (Array.isArray(model?.requiredWeights)) groups.push(...model.requiredWeights);
  return groups;
};

const inspectFederatedModelCache = async (model, repo) => {
  const revision = model?.revision ? { revision: model.revision } : undefined;
  const base = repo
    ? await inspectModelCache(repo, revision).catch(() => ({ cached: false }))
    : { cached: requiredModelCacheGroups(model).length === 0 };
  if (base.cached !== true) return false;

  // Some video profiles are deliberately selective: the main snapshot is not
  // sufficient without the exact pinned Wan adapters, H3 checkpoint files, or
  // H3 CUDA repo-file subset that the runner will load.
  for (const group of requiredModelCacheGroups(model)) {
    if (!group || typeof group.repo !== 'string' || !group.repo
      || !Array.isArray(group.files) || group.files.length === 0
      || typeof group.revision !== 'string' || !group.revision) return false;
    if (!await findCachedRepoFiles(group.repo, group.files, { revision: group.revision })) return false;
  }
  return true;
};

const FEDERATED_DEFAULT_VIDEO_FRAMES = 121;

const validateFederatedVideoControls = (input, model) => {
  if (input.kind !== 'video') return;
  const numFrames = input.numFrames ?? model.defaultFrames ?? FEDERATED_DEFAULT_VIDEO_FRAMES;
  const fps = input.fps ?? 24;
  if (isMiniMaxH3Runtime(model.runtime)) {
    const controlError = minimaxH3ControlError({
      model,
      negativePrompt: input.negativePrompt,
      numFrames,
      fps,
    });
    if (controlError) throw controlError;
  }
  if (model.runtime === 'wan22') {
    const frameStride = Number(model.frameStride);
    if (Number.isFinite(frameStride) && frameStride > 0 && (Number(numFrames) - 1) % frameStride !== 0) {
      unavailable(
        `${model.name} requires a ${frameStride}n+1 frame count; got ${numFrames}.`,
        'WAN22_INVALID_FRAME_COUNT',
        400,
      );
    }
  }
};

export function normalizeFederatedMediaProviderConfig(settings) {
  const raw = settings?.federation?.mediaProvider;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_FEDERATED_MEDIA_PROVIDER, audioModels: [], imageModels: [], videoModels: [] };
  }
  return {
    ...raw,
    enabled: raw.enabled === true,
    maxQueuedJobs: Number.isInteger(raw.maxQueuedJobs)
      ? Math.max(1, Math.min(20, raw.maxQueuedJobs))
      : DEFAULT_FEDERATED_MEDIA_PROVIDER.maxQueuedJobs,
    audioModels: sanitizeModelList(raw.audioModels),
    imageModels: sanitizeModelList(raw.imageModels),
    videoModels: sanitizeModelList(raw.videoModels),
  };
}

/**
 * The provider is stricter than ordinary federation reads: it never inherits
 * authGate's auth-off bypass and never accepts a browser session. A verified
 * Basic credential plus a registered, enabled caller is required every time.
 */
export async function authorizeFederatedMediaPeer(req) {
  const config = normalizeFederatedMediaProviderConfig(await getSettings());
  if (!config.enabled) {
    unavailable('Federated media provider is disabled', 'MEDIA_PROVIDER_DISABLED');
  }
  if (req.portosAuthContext?.method !== 'basic' || req.portosAuthContext?.authenticated !== true) {
    unavailable('Verified peer Basic authentication is required', 'MEDIA_PROVIDER_PEER_AUTH_REQUIRED', 403);
  }
  const callerId = readCallerInstanceId(req);
  if (!callerId) {
    unavailable('A peer instance id is required', 'MEDIA_PROVIDER_PEER_ID_REQUIRED', 403);
  }
  const peer = await findPeerById(callerId);
  if (!peer || peer.enabled === false) {
    unavailable('The caller is not an enabled registered peer', 'MEDIA_PROVIDER_PEER_FORBIDDEN', 403);
  }
  return { callerId, config };
}

function readinessReason(engine, modelReady) {
  if (!engine) return 'unknown-engine';
  if (!engine.platformSupported) return 'platform-unsupported';
  if (!engine.runtimeReady) return 'runtime-unavailable';
  if (engine.cudaRequired && engine.cudaState !== 'available') {
    return engine.cudaState === 'unknown' ? 'cuda-unknown' : 'cuda-absent';
  }
  // Mixed-version compatibility: older capability payloads omit vramState and
  // retain the pre-VRAM behavior, while newer local capabilities fail closed
  // for an insufficient or unmeasured CUDA execution profile.
  if (engine.cudaRequired && engine.vramState && engine.vramState !== 'sufficient') {
    return engine.vramState === 'unknown-size' ? 'vram-unknown-size' : 'vram-insufficient';
  }
  if (!modelReady) return 'model-unavailable';
  return null;
}

async function configuredAudioCapabilities(config) {
  const { engines } = await listMusicEngineCapabilities();
  const enginesById = new Map(engines.map((engine) => [engine.id, engine]));
  return config.audioModels.map((selected) => {
    const engine = enginesById.get(selected.engine);
    const model = engine?.models.find((candidate) => candidate.id === selected.modelId);
    const modelReady = !!model && (!engine.fixedModelInstall || engine.modelReadyById?.[model.id] === true);
    const reason = model ? readinessReason(engine, modelReady) : (engine ? 'unknown-model' : 'unknown-engine');
    return {
      kind: 'audio',
      engine: selected.engine,
      engineName: engine?.name ?? selected.engine,
      modelId: selected.modelId,
      modelName: model?.name ?? selected.modelId,
      ready: reason === null,
      unavailableReason: reason,
      runtimeReady: engine?.runtimeReady === true,
      platformSupported: engine?.platformSupported === true,
      cudaRequired: engine?.cudaRequired === true,
      cudaState: engine?.cudaRequired ? engine.cudaState : 'available',
      minDurationSec: engine?.minDurationSec ?? null,
      maxDurationSec: engine?.maxDurationSec ?? null,
      defaultDurationSec: engine?.defaultDurationSec ?? null,
      lyrics: engine?.lyrics === true,
      acceptsLyrics: engine?.lyrics === true,
      inputAssets: null,
      autoDuration: engine?.autoDuration === true,
      frameStride: null,
      maxNumFrames: null,
      frameOptions: null,
      fpsOptions: null,
      resolutionOptions: null,
      _engine: engine,
      _model: model,
    };
  });
}

// Local image/video generation (mflux on Apple Silicon, diffusers elsewhere)
// has no per-engine CUDA/platform registry like music's ENGINES map — it's one
// shared runtime gated on a single configured pythonPath, with per-model
// readiness coming from the same HF-cache check music capabilities use.
// Reported as platformSupported/cudaRequired: false rather than omitting
// those fields, so this stays a single capability shape the wire schema
// already validates instead of forking a second one per kind.
//
// `runtimeReady` here means "a local pythonPath is configured," not
// "verified importable" — music's isEngineHealthy() and image regen's
// resolveRegenBackend() (server/services/imageGen/regen.js) both go further
// and probe the actual mflux binary / FLUX.2 venv per model family. Matching
// that depth for every image/video model family (mflux vs FLUX.2 vs the
// diffusers runners, plus per-runtime BYOV video probes) is real scope, not a
// cleanup — left as follow-up work; a submission that clears this coarser
// admission check still fails safely if the runtime turns out missing, since
// the local generator itself errors and fails the queued job.
async function localGeneratorCapabilities(kind, pythonPath, { models, configuredList }) {
  const modelsById = new Map(models.map((model) => [model.id, model]));
  return Promise.all(configuredList.map(async (selected) => {
    const isLocal = selected.engine === 'local';
    const model = isLocal ? modelsById.get(selected.modelId) : null;
    const repo = model ? repoForModel(model) : null;
    const modelSupportsInput = supportsFederatedInput(kind, model);
    const needsPython = requiresConfiguredPython(kind, model);
    const modelReady = !model ? false : await inspectFederatedModelCache(model, repo);
    const runtimeReady = !isLocal ? false
      : needsPython ? !!pythonPath
        : kind === 'video' ? await isByovRuntimeReady(model?.runtime)
          : true;
    const reason = !isLocal ? 'unknown-engine'
      : !model ? 'unknown-model'
        : !modelSupportsInput ? 'unsupported-input'
          : !runtimeReady ? 'runtime-unavailable'
            : !modelReady ? 'model-unavailable'
              : null;
    const frameStride = Number.isInteger(Number(model?.frameStride)) && Number(model.frameStride) >= 1 && Number(model.frameStride) <= 64
      ? Number(model.frameStride)
      : null;
    const validFrameOptions = Array.isArray(model?.frameOptions)
      ? model.frameOptions.filter((f) => Number.isInteger(f) && f >= 1 && f <= 600).slice(0, 100)
      : [];
    const validFpsOptions = Array.isArray(model?.fpsOptions)
      ? model.fpsOptions.filter((f) => Number.isInteger(f) && f >= 1 && f <= 60).slice(0, 20)
      : [];
    const rawMaxNumFrames = Number.isInteger(Number(model?.maxNumFrames)) && Number(model.maxNumFrames) >= 1 && Number(model.maxNumFrames) <= 600
      ? Number(model.maxNumFrames)
      : (validFrameOptions.length > 0 ? Math.max(...validFrameOptions) : null);
    const maxNumFrames = rawMaxNumFrames && rawMaxNumFrames <= 600 ? rawMaxNumFrames : null;
    const validResolutions = Array.isArray(model?.resolutionOptions)
      ? model.resolutionOptions
        .filter((opt) => Number.isInteger(Number(opt?.w)) && Number.isInteger(Number(opt?.h))
          && Number(opt.w) >= 64 && Number(opt.w) <= 2048
          && Number(opt.h) >= 64 && Number(opt.h) <= 2048)
        .slice(0, 100)
        .map(({ label, w, h }) => ({
          w: Number(w),
          h: Number(h),
          ...(label ? { label: String(label).slice(0, 120) } : {}),
        }))
      : [];
    return {
      kind,
      engine: selected.engine,
      engineName: isLocal ? 'Local' : selected.engine,
      modelId: selected.modelId,
      modelName: model?.name ?? selected.modelId,
      ready: reason === null,
      unavailableReason: reason,
      runtimeReady,
      platformSupported: isLocal,
      cudaRequired: false,
      cudaState: 'available',
      minDurationSec: null,
      maxDurationSec: null,
      defaultDurationSec: null,
      lyrics: false,
      acceptsLyrics: false,
      inputAssets: federatedInputAssetsBlock(kind, model),
      autoDuration: false,
      frameStride,
      maxNumFrames: Number.isFinite(maxNumFrames) && maxNumFrames > 0 ? maxNumFrames : null,
      frameOptions: validFrameOptions.length > 0 ? validFrameOptions : null,
      fpsOptions: validFpsOptions.length > 0 ? validFpsOptions : null,
      resolutionOptions: validResolutions.length > 0 ? validResolutions : null,
      _pythonPath: isLocal ? pythonPath : null,
      _model: model,
    };
  }));
}

const configuredImageCapabilities = (pythonPath, config) => localGeneratorCapabilities('image', pythonPath, {
  models: getImageModels(), configuredList: config.imageModels,
});

const configuredVideoCapabilities = (pythonPath, config) => localGeneratorCapabilities('video', pythonPath, {
  models: getVideoModels(), configuredList: config.videoModels,
});

// Local image/video readiness shares one settings field
// (imageGen.local.pythonPath — video local generation reuses the same
// Python venv). Resolve it once per top-level call rather than once per
// requested kind, so asking for both image and video status in one request
// doesn't fetch+clone the full settings object twice.
async function resolveLocalRuntimePythonPath(kinds) {
  if (!kinds.some((kind) => kind === 'image' || kind === 'video')) return null;
  const settings = await getSettings();
  return settings?.imageGen?.local?.pythonPath || null;
}

async function capabilitiesForKind(kind, config, { pythonPath = null } = {}) {
  if (kind === 'audio') return configuredAudioCapabilities(config);
  if (kind === 'image') return configuredImageCapabilities(pythonPath, config);
  if (kind === 'video') return configuredVideoCapabilities(pythonPath, config);
  return [];
}

// Every job this provider accepts is a local-engine render — buildQueueParams
// deliberately omits `mode`, and the cloud-CLI backends are not federatable —
// so the lane a submission lands on is decided by its kind alone. The queue
// answers how wide that lane is; the minimum across the negotiated kinds is the
// fail-closed reading if two kinds ever route differently.
// Serialized is the fail-closed answer for an empty kind list: Math.min() over
// nothing is Infinity, which serializes to null and reads as "unknown".
const federatedLaneConcurrency = (kinds) => (kinds.length === 0 ? 1 : Math.min(
  ...kinds.map((kind) => laneConcurrencyFor({ kind, params: {} })),
));

/**
 * Jobs occupying this machine's own generation lanes, and whether another fits.
 *
 * Outgoing proxy jobs consume a remote peer's capacity, not this provider's, so
 * they are excluded — counting them can deadlock two otherwise-idle peers into
 * both reporting busy while each waits on the other.
 */
function activeQueueSnapshot(config, kinds) {
  const active = listJobs().filter((job) =>
    ACTIVE_STATUSES.has(job.status) && !isRemoteMediaJob(job),
  );
  let providerActive = 0;
  let queued = 0;
  let running = 0;
  // Only the kinds the caller negotiated, and only those actually holding a
  // lane: with the block present, an absent kind is idle. Derived from the same
  // filtered list as the slot count rather than from getQueueCapacity().byKind,
  // which also counts the outgoing proxy jobs excluded above.
  const byKind = {};
  for (const job of active) {
    if (job.owner?.startsWith(OWNER_PREFIX)) {
      providerActive += 1;
      if (job.status === 'running') running += 1; else queued += 1;
    }
    // Local work of a kind this contract does not federate (LoRA training) still
    // holds a lane, so it counts toward `totalActive` while having no bucket —
    // which is why the two need not sum.
    //
    // This filter is a WIRE-COMPATIBILITY requirement, not just scoping: the
    // consumer validates `byKind` with a partialRecord over its own kind enum,
    // which rejects an unknown key outright. A kind the caller did not
    // negotiate would therefore invalidate the whole status payload on an older
    // consumer, not just drop that one bucket.
    if (!kinds.includes(job.kind)) continue;
    const bucket = byKind[job.kind] ?? (byKind[job.kind] = { running: 0, queued: 0 });
    bucket[job.status === 'running' ? 'running' : 'queued'] += 1;
  }
  return {
    totalActive: active.length,
    providerActive,
    queued,
    running,
    maxQueuedJobs: config.maxQueuedJobs,
    accepting: active.length < config.maxQueuedJobs,
    concurrency: federatedLaneConcurrency(kinds),
    byKind,
  };
}

// Strip every private (`_`-prefixed) helper field before a capability crosses
// the wire — `_engine`/`_model` (audio) and `_pythonPath`/`_model` (image/
// video) all carry local runtime state, never public capability data.
const publicCapability = (capability) => Object.fromEntries(
  Object.entries(capability).filter(([key]) => !key.startsWith('_')),
);

// `kinds` defaults to audio-only so a caller that never opts in (every
// already-shipped consumer) gets back the exact status shape it has always
// understood — see normalizeRequestedMediaKinds in federatedMediaWire.js.
export async function getFederatedMediaProviderStatus(config, { kinds = ['audio'] } = {}) {
  const requestedKinds = kinds.filter((kind) => KNOWN_MEDIA_KINDS.includes(kind));
  const pythonPath = await resolveLocalRuntimePythonPath(requestedKinds);
  const capabilities = (await Promise.all(
    requestedKinds.map((kind) => capabilitiesForKind(kind, config, { pythonPath })),
  )).flat();
  const queue = activeQueueSnapshot(config, requestedKinds);
  const anyReady = capabilities.some((capability) => capability.ready);
  return {
    wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
    generatedAt: new Date().toISOString(),
    staleAfterMs: FEDERATED_MEDIA_STALE_AFTER_MS,
    status: !anyReady ? 'unavailable' : (queue.accepting ? 'ready' : 'busy'),
    kinds: requestedKinds,
    queue,
    capabilities: capabilities.map(publicCapability),
  };
}

/**
 * Every LOCAL model this instance could offer to share, per visual kind, with
 * the same readiness projection the wire status uses.
 *
 * This is the provider-side answer to a chicken-and-egg problem: the status
 * endpoint only ever describes models the operator has ALREADY allowlisted, so
 * it can never tell the Sharing UI what there is to allowlist in the first
 * place. Audio doesn't need this — its Sharing UI is driven by the music-engine
 * catalog, which already enumerates candidates.
 *
 * LOCAL ONLY. This is exposed under `/api/` for this instance's own settings
 * screen, never on the peer surface: it enumerates unshared local models, which
 * is exactly the inventory a peer has no business reading.
 *
 * @returns {Promise<{image: object[], video: object[]}>}
 */
export async function listLocalMediaShareCandidates() {
  const pythonPath = await resolveLocalRuntimePythonPath(['image', 'video']);
  const catalogs = { image: getImageModels(), video: getVideoModels() };
  const entries = await Promise.all(
    Object.entries(catalogs).map(async ([kind, models]) => [
      kind,
      (await localGeneratorCapabilities(kind, pythonPath, {
        models,
        // Offer the whole local catalog as candidates rather than the
        // configured subset — that subset is what this call exists to help the
        // operator choose.
        configuredList: models.map((model) => ({ engine: 'local', modelId: model.id })),
      })).map(publicCapability),
    ]),
  );
  return Object.fromEntries(entries);
}

const jobOwner = (callerId) => `${OWNER_PREFIX}${callerId}`;
const jobBelongsToCaller = (job, callerId) =>
  job?.owner === jobOwner(callerId)
  && job.params?.federatedMedia?.callerInstanceId === callerId;

function lookupCallerJob(callerId, jobId) {
  const job = getJob(jobId);
  if (!jobBelongsToCaller(job, callerId)) {
    unavailable('Provider job not found', 'MEDIA_PROVIDER_JOB_NOT_FOUND', 404);
  }
  return job;
}

function findIdempotentJob(callerId, idempotencyKey) {
  return listJobs().find((job) =>
    jobBelongsToCaller(job, callerId)
    && job.params?.federatedMedia?.idempotencyKey === idempotencyKey,
  ) || null;
}

// The audio wire predates the explicit `kind` field. Its old idempotency hash
// was computed from the kind-less parsed body, while the compatibility
// preprocessor now adds `kind: 'audio'` before this service sees it. Keep the
// canonical audio hash kind-less so an ambiguous submission can still replay
// a queued job across this upgrade; image/video hashes retain their kind to
// prevent cross-kind key reuse.
const requestHashInput = (input) => {
  if (input?.kind !== 'audio') return input;
  const { kind: _kind, ...legacyAudioInput } = input;
  return legacyAudioInput;
};

// Image/video results are named `<queue-job-uuid>.<ext>` by the local
// generator itself (jobId: job.id passed straight through, same as audio's
// music-gen-<uuid>.wav). Bind the provider only to that shape, not to
// job.id specifically — mirrors MUSIC_RESULT_RE's leniency. Each kind gets
// its own anchored extension (not one pattern shared across png/mp4) so a
// hand-edited job.kind/result.filename mismatch can't pass the check and
// get served under the wrong Content-Type.
const IMAGE_RESULT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;
const VIDEO_RESULT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/i;
const resolveVideoResult = makePathResolver(() => PATHS.videos, { extensions: ['mp4'] });

const RESULT_BY_KIND = {
  audio: { mimeType: 'audio/wav', pattern: MUSIC_RESULT_RE, resolve: resolveMusicResult },
  image: { mimeType: 'image/png', pattern: IMAGE_RESULT_RE, resolve: resolveGalleryImage },
  video: { mimeType: 'video/mp4', pattern: VIDEO_RESULT_RE, resolve: resolveVideoResult },
};

async function describeResult(job) {
  if (job.status !== 'completed') return null;
  const shape = RESULT_BY_KIND[job.kind];
  if (!shape) {
    unavailable('Provider result is unavailable', 'MEDIA_PROVIDER_RESULT_UNAVAILABLE', 410);
  }
  const filename = job.result?.filename;
  // The queue record is persisted and therefore could be hand-edited. Bind a
  // provider job only to the filename shape its own generator creates;
  // makePathResolver confines the root, while this prevents cross-job file
  // substitution inside that root.
  if (typeof filename !== 'string' || !shape.pattern.test(filename)) {
    unavailable('Provider result is unavailable', 'MEDIA_PROVIDER_RESULT_UNAVAILABLE', 410);
  }
  const path = shape.resolve(filename);
  if (!path) {
    unavailable('Provider result is unavailable', 'MEDIA_PROVIDER_RESULT_UNAVAILABLE', 410);
  }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size <= 0) {
    unavailable('Provider result is unavailable', 'MEDIA_PROVIDER_RESULT_UNAVAILABLE', 410);
  }
  const cacheKey = `${filename}:${info.size}:${info.mtimeMs}`;
  let sha256 = resultHashCache.get(cacheKey);
  if (!sha256) {
    sha256 = await sha256File(path).catch(() => null);
    if (!sha256) {
      unavailable('Provider result is unavailable', 'MEDIA_PROVIDER_RESULT_UNAVAILABLE', 410);
    }
    if (resultHashCache.size >= RESULT_HASH_CACHE_MAX) {
      resultHashCache.delete(resultHashCache.keys().next().value);
    }
    resultHashCache.set(cacheKey, sha256);
  }
  return {
    metadata: {
      available: true,
      mimeType: shape.mimeType,
      sizeBytes: info.size,
      sha256,
      downloadUrl: `/api/federation/media/v1/jobs/${job.id}/result`,
      engine: job.result?.engine ?? job.params?.engine ?? null,
      modelId: job.result?.modelId ?? job.params?.modelId ?? null,
      durationSec: Number.isFinite(job.result?.durationSec) ? job.result.durationSec : null,
    },
    path,
  };
}

export async function describeFederatedMediaJob(callerId, jobOrId) {
  const job = typeof jobOrId === 'string' ? lookupCallerJob(callerId, jobOrId) : jobOrId;
  if (!jobBelongsToCaller(job, callerId)) {
    unavailable('Provider job not found', 'MEDIA_PROVIDER_JOB_NOT_FOUND', 404);
  }
  const result = await describeResult(job);
  return {
    wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
    id: job.id,
    kind: job.kind,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    position: Number.isFinite(job.position) ? job.position : null,
    progress: Number.isFinite(job.progress) ? job.progress : null,
    etaMs: Number.isFinite(job.etaMs) ? job.etaMs : null,
    ...(job.status === 'failed' ? { failure: { code: 'MEDIA_PROVIDER_JOB_FAILED', message: 'Provider job failed' } } : {}),
    ...(result ? { result: result.metadata } : {}),
  };
}

export async function submitFederatedMediaJob({ callerId, config, input, idempotencyKey }) {
  return withAdmissionLock(async () => {
    const requestHash = sha256Text(canonicalStringify(requestHashInput(input)));
    const existing = findIdempotentJob(callerId, idempotencyKey);
    if (existing) {
      if (existing.params?.federatedMedia?.requestHash !== requestHash) {
        unavailable('Idempotency-Key was already used with a different request', 'MEDIA_PROVIDER_IDEMPOTENCY_CONFLICT', 409);
      }
      return { replayed: true, job: await describeFederatedMediaJob(callerId, existing) };
    }

    const queue = activeQueueSnapshot(config, [input.kind]);
    if (!queue.accepting) {
      unavailable('Provider queue is at capacity', 'MEDIA_PROVIDER_BUSY', 429, {
        retryable: true,
        maxQueuedJobs: queue.maxQueuedJobs,
      });
    }

    const pythonPath = await resolveLocalRuntimePythonPath([input.kind]);
    const capabilities = await capabilitiesForKind(input.kind, config, { pythonPath });
    const capability = capabilities.find((candidate) =>
      candidate.engine === input.engine && candidate.modelId === input.modelId,
    );
    if (!capability) {
      unavailable('Requested model is not enabled for federation', 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', 400);
    }
    if (!capability.ready) {
      unavailable('Requested model is not currently available', 'MEDIA_PROVIDER_MODEL_UNAVAILABLE', 503, {
        reason: capability.unavailableReason,
      });
    }
    validateFederatedVideoControls(input, capability._model);
    // Lyrics reach a lyric-aware model only. `input.lyrics` is checked for a
    // non-empty string rather than mere presence: a consumer that renders an
    // instrumental take on a lyrical engine sends `''`, and refusing that would
    // break a submission carrying no conditioning at all. Rejecting here rather
    // than dropping the field is the ADR's own rule — a render that silently
    // discards the words is a plausible render of the wrong thing.
    if (input.lyrics && !capability.lyrics) {
      unavailable('Requested model cannot render lyrics', 'MEDIA_PROVIDER_LYRICS_UNSUPPORTED', 400);
    }
    if (input.durationMode === 'auto' && !capability.autoDuration) {
      unavailable('Requested engine does not support automatic duration', 'MEDIA_PROVIDER_AUTO_DURATION_UNSUPPORTED', 400);
    }
    if (input.durationSec !== undefined
      && (input.durationSec < capability.minDurationSec || input.durationSec > capability.maxDurationSec)) {
      unavailable('Requested duration is outside the engine limits', 'MEDIA_PROVIDER_DURATION_UNSUPPORTED', 400, {
        minDurationSec: capability.minDurationSec,
        maxDurationSec: capability.maxDurationSec,
      });
    }

    const inputAssetParams = await resolveSubmissionInputAssets({ callerId, input, capability });
    // Opportunistic, and only once a submission has actually arrived: a provider
    // nobody sends work to has nothing to sweep, and one that does gets swept on
    // every admission. Never allowed to fail the job it rode in on.
    sweepFederatedMediaAssets().catch((error) => {
      console.error(`❌ Federated media inbox sweep failed: ${error.message}`);
    });

    const federatedMedia = {
      wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
      callerInstanceId: callerId,
      idempotencyKey,
      requestHash,
    };
    const queued = enqueueJob({
      kind: input.kind,
      owner: jobOwner(callerId),
      params: buildQueueParams(input, capability, federatedMedia, inputAssetParams),
    });
    return {
      replayed: false,
      job: await describeFederatedMediaJob(callerId, queued.jobId),
    };
  });
}

// Per-kind mapping from the validated wire submission to the *local*
// mediaJobQueue params the matching runner module expects — audio's shape
// (engine/modelId/prompt/lyrics/duration) already matched generateMusic's
// contract; image/video map onto imageGen/local.js's generateImage and
// videoGen/local.js's generateVideo signatures. Omitting `mode` from the
// image/video params keeps the queue's dispatcher on the local runner (see
// getGenModuleForJob in mediaJobQueue/index.js): only the cloud-CLI modes
// (codex/grok/agy) need an explicit mode, and those aren't federatable here.
function buildQueueParams(input, capability, federatedMedia, inputAssetParams = {}) {
  if (input.kind === 'audio') {
    return {
      prompt: input.prompt,
      lyrics: input.lyrics,
      engine: input.engine,
      modelId: input.modelId,
      ...(capability._model?.userAdded ? { repo: capability._model.repo } : {}),
      ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
      ...(input.durationMode ? { durationMode: input.durationMode } : {}),
      federatedMedia,
    };
  }
  const shared = {
    pythonPath: capability._pythonPath,
    prompt: input.prompt,
    modelId: input.modelId,
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.steps !== undefined ? { steps: input.steps } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    federatedMedia,
  };
  if (input.kind === 'image') {
    return {
      ...shared,
      ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
      ...inputAssetParams,
      ...(input.initImageStrength !== undefined && inputAssetParams.initImagePath
        ? { initImageStrength: input.initImageStrength }
        : {}),
    };
  }
  // video — videoGen/local.js's generateVideo takes `guidanceScale`, not
  // `guidance` (image's field name).
  return {
    ...shared,
    ...(input.numFrames !== undefined ? { numFrames: input.numFrames } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {}),
    ...(input.guidance !== undefined ? { guidanceScale: input.guidance } : {}),
    ...inputAssetParams,
    // `mode` is normally omitted so the queue's dispatcher keeps this on the
    // LOCAL runner (only the cloud-CLI modes need an explicit one). A
    // conditioned render must name its pipeline anyway: generateVideo infers
    // `image` from a bare sourceImagePath, but first-last-frame has to be
    // explicit or the end frame is silently dropped and the clip comes back as
    // a plain image-to-video. 'image'/'fflf' are pipeline semantics, not
    // backend tokens, so neither diverts the dispatcher off the local runner.
    ...(inputAssetParams.lastImagePath
      ? { mode: 'fflf' }
      : inputAssetParams.sourceImagePath ? { mode: 'image' } : {}),
  };
}

export async function cancelFederatedMediaJob(callerId, jobId) {
  lookupCallerJob(callerId, jobId);
  const outcome = await cancelJob(jobId);
  if (!outcome.ok) {
    unavailable(outcome.error || 'Provider job cannot be canceled', outcome.code === 'ALREADY_TERMINAL'
      ? 'MEDIA_PROVIDER_JOB_TERMINAL'
      : 'MEDIA_PROVIDER_JOB_NOT_FOUND', outcome.code === 'ALREADY_TERMINAL' ? 409 : 404);
  }
  return describeFederatedMediaJob(callerId, jobId);
}

export async function getFederatedMediaResult(callerId, jobId) {
  const job = lookupCallerJob(callerId, jobId);
  if (job.status !== 'completed') {
    unavailable('Provider result is not ready', 'MEDIA_PROVIDER_RESULT_NOT_READY', 409);
  }
  return describeResult(job);
}

export function __resetFederatedMediaProviderForTests() {
  resultHashCache.clear();
}
