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
import { PATHS, makePathResolver, sha256File, sha256Text } from '../lib/fileUtils.js';
import {
  FEDERATED_MEDIA_STALE_AFTER_MS,
  FEDERATED_MEDIA_WIRE_VERSION,
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
import { readCallerInstanceId } from './sharing/peerPullAuthorization.js';
import { findPeerById } from './sharing/peerSyncShared.js';

export { FEDERATED_MEDIA_STALE_AFTER_MS, FEDERATED_MEDIA_WIRE_VERSION };
export const DEFAULT_FEDERATED_MEDIA_PROVIDER = Object.freeze({
  enabled: false,
  maxQueuedJobs: 2,
  audioModels: Object.freeze([]),
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

export function normalizeFederatedMediaProviderConfig(settings) {
  const raw = settings?.federation?.mediaProvider;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_FEDERATED_MEDIA_PROVIDER, audioModels: [] };
  }
  return {
    ...raw,
    enabled: raw.enabled === true,
    maxQueuedJobs: Number.isInteger(raw.maxQueuedJobs)
      ? Math.max(1, Math.min(20, raw.maxQueuedJobs))
      : DEFAULT_FEDERATED_MEDIA_PROVIDER.maxQueuedJobs,
    audioModels: Array.isArray(raw.audioModels)
      ? raw.audioModels
        .filter((model) => model && typeof model === 'object' && !Array.isArray(model))
        .map(({ engine, modelId }) => ({ engine, modelId }))
        .filter(({ engine, modelId }) => typeof engine === 'string' && typeof modelId === 'string')
      : [],
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

const publicCapability = ({ _engine, _model, ...capability }) => capability;

export async function getFederatedMediaProviderStatus(config) {
  const capabilities = await configuredAudioCapabilities(config);
  const queue = activeQueueSnapshot(config);
  const anyReady = capabilities.some((capability) => capability.ready);
  return {
    wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
    generatedAt: new Date().toISOString(),
    staleAfterMs: FEDERATED_MEDIA_STALE_AFTER_MS,
    status: !anyReady ? 'unavailable' : (queue.accepting ? 'ready' : 'busy'),
    kinds: ['audio'],
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

async function describeResult(job) {
  if (job.status !== 'completed') return null;
  const filename = job.result?.filename;
  // The queue record is persisted and therefore could be hand-edited. Bind a
  // provider job only to the filename shape generateMusic itself creates;
  // makePathResolver confines the root, while this prevents cross-job file
  // substitution inside that root.
  if (typeof filename !== 'string' || !MUSIC_RESULT_RE.test(filename)) {
    unavailable('Provider result is unavailable', 'MEDIA_PROVIDER_RESULT_UNAVAILABLE', 410);
  }
  const path = resolveMusicResult(filename);
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
      mimeType: 'audio/wav',
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
    kind: 'audio',
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
    const requestHash = sha256Text(canonicalStringify(input));
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

    const capabilities = await configuredAudioCapabilities(config);
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

    const queued = enqueueJob({
      kind: 'audio',
      owner: jobOwner(callerId),
      params: {
        prompt: input.prompt,
        lyrics: input.lyrics,
        engine: input.engine,
        modelId: input.modelId,
        ...(capability._model?.userAdded ? { repo: capability._model.repo } : {}),
        ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
        ...(input.durationMode ? { durationMode: input.durationMode } : {}),
        federatedMedia: {
          wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
          callerInstanceId: callerId,
          idempotencyKey,
          requestHash,
        },
      },
    });
    return {
      replayed: false,
      job: await describeFederatedMediaJob(callerId, queued.jobId),
    };
  });
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
