/**
 * Mind-callable local provider context (`numCtx`) inspection and adjustment.
 *
 * Only the Persistent Mind's own local API provider may be changed. Requests
 * are RAM/GPU clamped, rate-limited, and persisted through the normal provider
 * update path. Ollama daemons are nudged via ensureContextWindow when needed.
 */

import { join } from 'path';
import { z } from 'zod';
import {
  MIND_LOCAL_CONTEXT_DEFAULT_MODEL_GB,
  MIND_LOCAL_CONTEXT_LIMITS,
  clampMindLocalContextRequest,
  resolveMindLocalContextClamp,
} from '../lib/mindLocalContextClamp.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { detectSystemCapabilities } from '../lib/systemCapabilities.js';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import {
  PATHS,
  atomicWrite,
  readJSONFileStrict,
} from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { appendMindEvent } from './agentRunEventLog.js';
import { loadState, withStateLock } from './cosState.js';
import { getProviderById, updateProvider } from './providers.js';
import * as ollamaManager from './ollamaManager.js';

export const persistentMindLocalContextAdjustSchema = z.object({
  numCtx: z.number().int().min(512).max(131072),
  reason: z.string().trim().min(1).max(MIND_LOCAL_CONTEXT_LIMITS.reasonChars),
}).strict();

const GB = 1024 ** 3;
const STORE_PATH = join(PATHS.cos, 'persistent-mind-local-context.json');
const STORE_SCHEMA_VERSION = 1;
const queueStoreWrite = createFileWriteQueue();

const emptyStore = () => ({ schemaVersion: STORE_SCHEMA_VERSION, history: [] });

async function loadStore() {
  const { ok, value } = await readJSONFileStrict(STORE_PATH, emptyStore());
  if (!ok || !value || typeof value !== 'object' || !Array.isArray(value.history)) {
    return emptyStore();
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, history: value.history.filter((row) => row && typeof row === 'object') };
}

function saveStore(store) {
  return queueStoreWrite(() => atomicWrite(STORE_PATH, {
    schemaVersion: STORE_SCHEMA_VERSION,
    history: Array.isArray(store.history) ? store.history.slice(-40) : [],
  }));
}

function hasUsableGpu(capabilities) {
  const cuda = capabilities?.cuda;
  if (cuda?.status === 'available' && Number(cuda.maxVramGb) > 0) return true;
  // Apple Silicon unified memory counts as a usable accelerator for larger windows.
  return capabilities?.appleSilicon === true;
}

function isLocalApiProvider(provider) {
  if (!provider || provider.type !== 'api') return false;
  if (provider.apiKey || provider.apiKeyEnvVar || provider.gatewayBacked || provider.orcarouterBacked) return false;
  if (Object.keys(provider.envVars || {}).length) return false;
  return Boolean(localRuntimeForProvider(provider));
}

async function hostFacts(modelSizeGb = MIND_LOCAL_CONTEXT_DEFAULT_MODEL_GB) {
  const [capabilities, memory] = await Promise.all([
    detectSystemCapabilities(),
    getMemoryStats(),
  ]);
  const freeMemoryGb = memory?.free != null ? memory.free / GB : null;
  const usableGpu = hasUsableGpu(capabilities);
  const maxVramGb = capabilities?.cuda?.status === 'available'
    ? capabilities?.cuda?.maxVramGb
    : (capabilities?.appleSilicon ? capabilities?.totalMemoryGb : null);
  return {
    totalMemoryGb: capabilities?.totalMemoryGb ?? null,
    freeMemoryGb,
    hasUsableGpu: usableGpu,
    maxVramGb: maxVramGb ?? null,
    modelSizeGb,
  };
}

function publicClamp(clamp, facts) {
  return {
    min: clamp.min,
    max: clamp.max,
    reasons: clamp.reasons,
    host: {
      totalMemoryGb: facts.totalMemoryGb,
      freeMemoryGb: facts.freeMemoryGb == null ? null : Number(Number(facts.freeMemoryGb).toFixed(2)),
      hasUsableGpu: facts.hasUsableGpu,
      maxVramGb: facts.maxVramGb,
    },
  };
}

/** Read-only catalog for the mind: current window + safe clamp. */
export async function getPersistentMindLocalContextCatalog() {
  const root = await loadState();
  const grants = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  const provider = profile.providerId ? await getProviderById(profile.providerId) : null;
  const facts = await hostFacts();
  const clamp = resolveMindLocalContextClamp(facts);
  const local = isLocalApiProvider(provider);
  return {
    enabled: grants.adjustLocalContext === true,
    eligible: local,
    providerId: provider?.id || null,
    model: profile.model || provider?.defaultModel || null,
    numCtx: Number.isFinite(Number(provider?.numCtx)) ? Number(provider.numCtx) : null,
    clamp: publicClamp(clamp, facts),
    limits: MIND_LOCAL_CONTEXT_LIMITS,
    explanation: local
      ? "Adjust only this mind's local API provider numCtx within the RAM/GPU safety ceiling. Reloads the local Ollama daemon when needed."
      : "The mind's configured provider is not a local API runtime, so context adjustment is unavailable.",
  };
}

/**
 * Mind-turn tool: clamp + persist numCtx on the mind's own local provider.
 */
export async function adjustPersistentMindLocalContext(args, { turnId, requestId, signal } = {}) {
  const parsed = persistentMindLocalContextAdjustSchema.parse(args);
  return withStateLock(async () => {
    const root = await loadState();
    const mind = root.persistentMind;
    const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
    if (signal?.aborted || !turnId || !requestId || mind?.activeTurn?.id !== turnId || !mind?.started || !mind?.enabled) {
      return fail('Request requires the active mind turn');
    }
    const grants = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
    if (!grants.adjustLocalContext) return fail('adjustLocalContext is not granted');

    const store = await loadStore();
    const history = store.history;
    const prior = history.find((entry) => entry.requestId === requestId);
    if (prior) {
      return prior.numCtx === parsed.numCtx && prior.reason === parsed.reason
        ? { ok: true, duplicate: true, numCtx: prior.numCtx, providerId: prior.providerId }
        : fail('Request id already used');
    }
    const now = Date.now();
    const recent = history.filter((entry) => Date.parse(entry.at) > now - MIND_LOCAL_CONTEXT_LIMITS.rollingWindowMs);
    if (recent.length >= MIND_LOCAL_CONTEXT_LIMITS.maxAdjustmentsPerRollingDay) {
      return fail('Local context adjustments already used for the rolling 24 hours');
    }
    if (recent.some((entry) => now - Date.parse(entry.at) < MIND_LOCAL_CONTEXT_LIMITS.minGapMs)) {
      return fail('Local context adjustments must be spaced apart');
    }

    const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
    const provider = profile.providerId ? await getProviderById(profile.providerId) : null;
    if (!isLocalApiProvider(provider)) {
      return fail("Only the mind's local API provider can adjust numCtx");
    }

    const facts = await hostFacts();
    const clamped = clampMindLocalContextRequest(parsed.numCtx, facts);
    if (!clamped.ok) {
      return fail(clamped.error, { clamp: publicClamp(clamped.clamp, facts) });
    }

    const previous = Number.isFinite(Number(provider.numCtx)) ? Number(provider.numCtx) : null;
    await updateProvider(provider.id, { numCtx: clamped.numCtx });

    let daemon = null;
    const runtime = localRuntimeForProvider(provider);
    if (runtime?.kind === 'ollama' && typeof ollamaManager.ensureContextWindow === 'function') {
      daemon = await ollamaManager.ensureContextWindow(clamped.numCtx, profile.model || null);
    }

    const entry = {
      requestId,
      turnId,
      at: new Date(now).toISOString(),
      providerId: provider.id,
      previousNumCtx: previous,
      numCtx: clamped.numCtx,
      reason: parsed.reason,
      clampMax: clamped.clamp.max,
    };
    await saveStore({ history: [...history, entry] });

    await appendMindEvent({
      kind: 'mind.local-context.adjusted',
      mindId: mind.mindId,
      turnId,
      eventId: `mind-local-context:${requestId}`,
      data: {
        providerId: provider.id,
        previousNumCtx: previous,
        numCtx: clamped.numCtx,
        reason: parsed.reason,
        clampMax: clamped.clamp.max,
        daemonApplied: daemon?.applied === true,
        displayText: `Adjusted local numCtx ${previous ?? 'default'} → ${clamped.numCtx}: ${parsed.reason}`,
      },
    }).catch(() => {});

    return {
      ok: true,
      providerId: provider.id,
      previousNumCtx: previous,
      numCtx: clamped.numCtx,
      clamp: publicClamp(clamped.clamp, facts),
      daemon,
    };
  });
}
