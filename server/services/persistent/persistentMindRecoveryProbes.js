/** Probe open provider calls and recover a usage-limit pause when the pinned provider becomes available. */
import { isDaemonRunning, loadState } from '../cos/cosState.js';
import { emitLog } from '../cos/cosEvents.js';
import { schedule, cancel, getEvent } from '../eventScheduler.js';
import { providerBaseUrl } from '../cos/cosLocalEndpointSlots.js';
import { isOllamaBackedProvider } from '../../lib/aiToolkit/index.js';
import { resolvePersistentMindProfile } from './persistentMindProfile.js';
import { isUsageLimitPauseReason, usageLimitProbeDelayMs } from '../../lib/persistent/persistentMindUsageLimit.js';
import { isProviderAvailable } from '../provider/providerStatus.js';

export const PERSISTENT_MIND_USAGE_LIMIT_PROBE_EVENT_ID = 'cos-persistent-mind-usage-limit-probe';

/**
 * Provider calls currently in flight, keyed by turn id. A stale heartbeat only
 * means the turn's pulse stopped; while a call is still open in THIS process
 * the thought may simply be long, so the watchdog consults this before it
 * interrupts. Empty after a process restart, so a turn orphaned by a restart
 * is still interrupted as before.
 */
const inFlightCalls = new Map();
const OLLAMA_LIVENESS_TIMEOUT_MS = 5_000;

async function providerLivenessProbe(provider, model) {
  if (!isOllamaBackedProvider(provider)) return { alive: true, reason: 'request open' };
  const base = String(providerBaseUrl(provider) || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!base) return { alive: true, reason: 'request open' };
  const response = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(OLLAMA_LIVENESS_TIMEOUT_MS) }).catch(() => null);
  if (!response?.ok) return { alive: false, reason: 'Ollama is not responding' };
  const data = await response.json().catch(() => null);
  const models = Array.isArray(data?.models) ? data.models : [];
  const loaded = models.some((m) => !model || m.name === model || m.model === model);
  return loaded ? { alive: true, reason: 'model loaded' } : { alive: false, reason: `Ollama no longer has ${model || 'the model'} loaded` };
}

export function trackInFlightCall(turnId, provider, model, call) {
  return async (meta, run) => {
    const entry = { provider, model, startedAt: Date.now() };
    const calls = inFlightCalls.get(turnId) || new Set();
    calls.add(entry);
    inFlightCalls.set(turnId, calls);
    try {
      return await call(meta, run);
    } finally {
      calls.delete(entry);
      if (calls.size === 0) inFlightCalls.delete(turnId);
    }
  };
}

/**
 * Whether a stale-heartbeat turn still has a live provider call. Only a call
 * that is open in this process AND whose provider still answers counts.
 */
export async function turnHasLiveCall(turnId) {
  const calls = inFlightCalls.get(turnId);
  if (!calls?.size) return { alive: false, reason: 'no provider call in flight' };
  for (const entry of calls) {
    const result = await Promise.resolve(providerLivenessProbe(entry.provider, entry.model))
      .catch((err) => ({ alive: false, reason: err?.message || 'liveness probe failed' }));
    if (result?.alive) return { alive: true, reason: result.reason };
    return { alive: false, reason: result?.reason || 'provider gone' };
  }
  return { alive: false, reason: 'no provider call in flight' };
}

/**
 * Lightweight readiness check for a usage-limit autopause.
 * Uses provider status + pinned profile resolve — never opens a mind turn.
 */
async function probePinnedProviderAfterUsageLimit() {
  const root = await loadState();
  const providerId = root.config?.persistentMindProfile?.providerId;
  if (typeof providerId === 'string' && providerId && !isProviderAvailable(providerId)) {
    return { ok: false, reason: 'pinned-provider-unavailable' };
  }
  const resolved = await resolvePersistentMindProfile(root.config?.persistentMindProfile);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.error || 'pinned-provider-unresolved' };
  }
  return { ok: true, providerId: resolved.provider?.id || providerId || null };
}

/**
 * When the next usage-limit readiness probe will run, or null when none is
 * pending. READ-ONLY — it reports the schedule, it does not set or change it.
 *
 * A usage-limit autopause deliberately clears `nextEligibleWakeAt` (see
 * `parkActiveTurn`: a hard quota gets no backoff gate and no failureCount
 * climb), so recovery is owned by this probe alone. Without this accessor the
 * page can say a quota block is retrying but never when — the one question the
 * user actually has while waiting one out.
 */
export function persistentMindUsageLimitRetryAt() {
  const event = getEvent(PERSISTENT_MIND_USAGE_LIMIT_PROBE_EVENT_ID);
  // A fired one-shot nulls its own nextRunAt, but a PAUSED event keeps a future
  // one it will never honour, and a probe scheduled before a clock jump can sit
  // in the past. Both would advertise a retry that is not coming, which is worse
  // than saying nothing: the whole point is to stop the user guessing.
  if (!event?.active || !Number.isFinite(event.nextRunAt) || event.nextRunAt <= Date.now()) return null;
  return new Date(event.nextRunAt).toISOString();
}

export function createUsageLimitRecovery({
  isStopping, getPersistentMindState, mutateMindState, initialSelfWake, armWatchdog, scheduleNextWake, emitMindStatus,
}) {
  /** Zero-based attempt count for the in-flight usage-limit readiness probe. */
  let usageLimitProbeAttempt = 0;

  function resetUsageLimitProbe() {
    cancel(PERSISTENT_MIND_USAGE_LIMIT_PROBE_EVENT_ID);
    usageLimitProbeAttempt = 0;
  }

  function scheduleUsageLimitProbe(attempt = 0) {
    if (isStopping() || !isDaemonRunning()) return;
    usageLimitProbeAttempt = Math.max(0, Number.isFinite(attempt) ? Math.floor(attempt) : 0);
    cancel(PERSISTENT_MIND_USAGE_LIMIT_PROBE_EVENT_ID);
    const delayMs = usageLimitProbeDelayMs(usageLimitProbeAttempt);
    schedule({
      id: PERSISTENT_MIND_USAGE_LIMIT_PROBE_EVENT_ID,
      type: 'once',
      delayMs: Math.max(1, delayMs),
      handler: async () => {
        try {
          await checkPersistentMindUsageLimitRecovery();
        } catch (error) {
          console.error(`❌ Persistent mind usage-limit probe failed: ${error.message}`);
          const mind = await getPersistentMindState().catch(() => null);
          if (mind && mind.status === 'paused' && isUsageLimitPauseReason(mind.pauseReason)) {
            scheduleUsageLimitProbe(usageLimitProbeAttempt + 1);
          }
        }
      },
      metadata: {
        description: 'Persistent CoS mind usage-limit readiness probe',
        attempt: usageLimitProbeAttempt,
      },
    });
  }

  /**
   * If paused solely for a provider usage limit, probe readiness and auto-resume
   * when the pinned provider is usable again. Other pause reasons are ignored.
   */
  async function checkPersistentMindUsageLimitRecovery() {
    const mind = await getPersistentMindState();
    if (mind.status !== 'paused' || !isUsageLimitPauseReason(mind.pauseReason)) {
      resetUsageLimitProbe();
      return { recovered: false, ignored: true };
    }
    if (isStopping() || !isDaemonRunning() || !mind.enabled || !mind.started) {
      return { recovered: false, ignored: false, reason: 'supervisor-inactive' };
    }

    const probe = await probePinnedProviderAfterUsageLimit();
    if (!probe.ok) {
      scheduleUsageLimitProbe(usageLimitProbeAttempt + 1);
      return { recovered: false, ignored: false, reason: probe.reason || 'still-limited' };
    }

    const result = await mutateMindState((current) => {
      if (current.status !== 'paused' || !isUsageLimitPauseReason(current.pauseReason)) {
        return { mind: current, value: { recovered: false } };
      }
      return {
        mind: {
          ...current,
          status: 'waiting',
          pauseReason: null,
          lastError: null,
          nextEligibleWakeAt: null,
          selfWake: current.queuedMessages.length > 0 || current.selfWake
            ? current.selfWake
            : initialSelfWake('usage-limit-recovered'),
        },
        value: { recovered: true, mindId: current.mindId },
      };
    });

    if (!result.value?.recovered) {
      resetUsageLimitProbe();
      return { recovered: false, ignored: true };
    }

    resetUsageLimitProbe();
    armWatchdog();
    await scheduleNextWake();
    // Match resumePersistentMind: status emit + log only (no new trajectory kind).
    emitMindStatus(result.state);
    emitLog('info', 'Persistent mind auto-resumed after provider usage limit cleared', {
      providerId: probe.providerId || null,
    });
    return { recovered: true, ignored: false };
  }

  return { resetUsageLimitProbe, scheduleUsageLimitProbe, checkPersistentMindUsageLimitRecovery };
}
