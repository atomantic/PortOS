/** Live, machine-local telemetry for the persistent Chief-of-Staff mind. */

import os from 'os';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { PERSISTENT_MIND_LIMITS } from '../lib/persistentMind.js';
import { PERSISTENT_MIND_TRAJECTORY_LIMITS } from '../lib/persistentMindTrajectory.js';
import { getLoadedModelsAt as getLoadedOllamaModelsAt } from './ollamaManager.js';
import {
  getLoadedModelsAt as getLoadedLmStudioModelsAt,
  modelIdsReferToSameRepo,
} from './lmStudioManager.js';
import { preparePersistentMindContext, readPersistentMindMemories } from './persistentMindContext.js';

const normalizeOllamaModel = (value) => String(value || '').trim().toLowerCase().replace(/:latest$/, '');

export function persistentMindLocalBackend(provider) {
  return localRuntimeForProvider(provider)?.kind || null;
}

export function persistentMindModelMatches(backend, configuredModel, residentModel) {
  const residentId = residentModel?.id || residentModel?.name;
  if (!configuredModel || !residentId) return false;
  if (backend === 'ollama') return normalizeOllamaModel(configuredModel) === normalizeOllamaModel(residentId);
  if (backend === 'lmstudio') return modelIdsReferToSameRepo(configuredModel, residentId);
  return String(configuredModel).trim() === String(residentId).trim();
}

async function inspectModelResidency(provider, model) {
  if (!provider || !model) {
    return { status: 'unconfigured', backend: null, loaded: null, memoryBytes: null, expiresAt: null };
  }
  const runtime = localRuntimeForProvider(provider);
  if (!runtime) {
    return { status: 'provider-managed', backend: null, loaded: null, memoryBytes: null, expiresAt: null };
  }
  const backend = runtime.kind;
  let models;
  let error;
  if (backend === 'ollama') {
    ({ models, error } = await getLoadedOllamaModelsAt(runtime.endpoint));
  } else if (backend === 'lmstudio') {
    ({ models, error } = await getLoadedLmStudioModelsAt(runtime.endpoint));
  } else {
    const probe = await probeOpenAiModels(runtime.endpoint, { apiKey: provider.apiKey || '' });
    models = Array.isArray(probe.models) ? probe.models.map((id) => ({ id })) : [];
    error = Array.isArray(probe.models) ? null : probe.error || 'Local model residency could not be read';
  }
  if (error) {
    return { status: 'unknown', backend, loaded: null, memoryBytes: null, expiresAt: null };
  }
  const resident = models.find((candidate) => persistentMindModelMatches(backend, model, candidate));
  return {
    status: resident ? 'loaded' : 'not-loaded',
    backend,
    loaded: Boolean(resident),
    memoryBytes: resident && Number.isFinite(resident.sizeVram ?? resident.size)
      ? resident.sizeVram ?? resident.size
      : null,
    expiresAt: resident?.expiresAt || null,
  };
}

// Turn freshness measured against the SERVER clock at `observedAt`, so the page
// never subtracts a browser clock from a server timestamp. A missing or
// unparseable stamp stays `null` — "not reported" and "zero elapsed" are
// different answers, and a UI that collapses them reads a fresh turn as stalled.
function turnFreshness(activeTurn, observedAtMs) {
  const since = (value) => {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return null;
    return Math.max(0, observedAtMs - at);
  };
  if (!activeTurn) return { elapsedMs: null, heartbeatAgeMs: null, heartbeatStale: false };
  const heartbeatAgeMs = since(activeTurn.heartbeatAt);
  return {
    elapsedMs: since(activeTurn.startedAt),
    heartbeatAgeMs,
    heartbeatStale: heartbeatAgeMs !== null
      && heartbeatAgeMs >= PERSISTENT_MIND_LIMITS.HEARTBEAT_STALE_WARNING_MS,
  };
}

export async function inspectPersistentMindRuntime({ state, profile, prompt, provider, usageLimitRetryAt = null } = {}) {
  const activeTurn = state?.activeTurn || null;
  const activeModel = activeTurn?.model || profile?.model;
  const [memories, memory, residency] = await Promise.all([
    readPersistentMindMemories(),
    getMemoryStats(),
    inspectModelResidency(provider, activeModel),
  ]);
  const context = await preparePersistentMindContext({
    identity: prompt?.identity || '',
    instructions: prompt?.instructions || '',
    memories,
  });
  const processMemory = process.memoryUsage();
  const observedAt = new Date();
  const freshness = turnFreshness(activeTurn, observedAt.getTime());
  const totalMemory = Number(memory.total) || 0;
  const usedMemory = Number(memory.used) || 0;

  return {
    observedAt: observedAt.toISOString(),
    // When a blocked mind clears itself. A usage-limit autopause clears
    // `nextEligibleWakeAt`, so its schedule lives only in the readiness probe;
    // callers pass it in rather than this module reaching for the scheduler.
    usageLimitRetryAt: typeof usageLimitRetryAt === 'string' ? usageLimitRetryAt : null,
    inference: {
      active: Boolean(activeTurn),
      turnId: activeTurn?.id || null,
      startedAt: activeTurn?.startedAt || null,
      heartbeatAt: activeTurn?.heartbeatAt || null,
      ...freshness,
      providerId: activeTurn?.providerId || profile?.providerId || null,
      model: activeTurn?.model || profile?.model || null,
      residency,
    },
    context: {
      chars: context.chars,
      maxChars: PERSISTENT_MIND_TRAJECTORY_LIMITS.maxContextChars,
      approximateTokens: context.approximateTokens,
      summaryState: context.summaryState,
      memoryCount: memories.length,
    },
    system: {
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: Number(memory.free) || 0,
        usagePercent: totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 100) : null,
      },
      process: {
        rss: processMemory.rss,
        heapUsed: processMemory.heapUsed,
        heapTotal: processMemory.heapTotal,
      },
      cpu: {
        cores: os.cpus().length,
        loadAvg1m: os.loadavg()[0],
      },
    },
  };
}
