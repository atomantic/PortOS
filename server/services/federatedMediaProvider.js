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
  FEDERATED_MEDIA_RESULT_EXTENSION,
  FEDERATED_MEDIA_STALE_AFTER_MS,
  FEDERATED_MEDIA_WIRE_VERSION,
  KNOWN_MEDIA_KINDS,
} from '../lib/federatedMediaWire.js';
import { getSettings } from './settings.js';
import {
  cancelJob,
  enqueueJob,
  getJob,
  isRemoteMediaJob,
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

// The federated wire intentionally carries no source image, keyframes, or
// semantic video mode. Do not advertise a catalog model that cannot render a
// text-only request through this contract; otherwise the provider accepts the
// job, persists it, and only rejects it after a worker starts.
const supportsFederatedInput = (kind, model) => {
  if (kind === 'image') return !isEditOnly(model);
  if (kind === 'video') {
    return !Array.isArray(model?.supportedModes) || model.supportedModes.includes('text');
  }
  return true;
};

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
      autoDuration: engine?.autoDuration === true,
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
      autoDuration: false,
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

function activeQueueSnapshot(config) {
  // Outgoing proxy jobs consume a remote peer's capacity, not this provider's
  // local generation resources. Counting them here can create a federation
  // deadlock where two otherwise-idle peers both report busy while waiting on
  // each other.
  const active = listJobs().filter((job) =>
    ACTIVE_STATUSES.has(job.status) && !isRemoteMediaJob(job),
  );
  const providerActive = active.filter((job) => job.owner?.startsWith(OWNER_PREFIX));
  return {
    totalActive: active.length,
    providerActive: providerActive.length,
    queued: providerActive.filter((job) => job.status === 'queued').length,
    running: providerActive.filter((job) => job.status === 'running').length,
    maxQueuedJobs: config.maxQueuedJobs,
    accepting: active.length < config.maxQueuedJobs,
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
  const queue = activeQueueSnapshot(config);
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

    const queue = activeQueueSnapshot(config);
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

    const federatedMedia = {
      wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
      callerInstanceId: callerId,
      idempotencyKey,
      requestHash,
    };
    const queued = enqueueJob({
      kind: input.kind,
      owner: jobOwner(callerId),
      params: buildQueueParams(input, capability, federatedMedia),
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
function buildQueueParams(input, capability, federatedMedia) {
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
    return { ...shared, ...(input.guidance !== undefined ? { guidance: input.guidance } : {}) };
  }
  // video — videoGen/local.js's generateVideo takes `guidanceScale`, not
  // `guidance` (image's field name).
  return {
    ...shared,
    ...(input.numFrames !== undefined ? { numFrames: input.numFrames } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {}),
    ...(input.guidance !== undefined ? { guidanceScale: input.guidance } : {}),
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
