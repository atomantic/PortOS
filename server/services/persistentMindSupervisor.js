/**
 * Persistent CoS mind supervisor.
 *
 * This service owns liveness, durable wake admission, restart recovery, and
 * one-turn-at-a-time execution. It deliberately does not own provider/model
 * selection or the mind prompt: the model-profile slice registers an exact
 * provider adapter, and the trajectory slice supplies bounded context. Until
 * that adapter is registered, an explicitly started mind degrades visibly and
 * makes zero provider calls.
 */

import { randomUUID } from 'crypto';
import { getDomainMode } from '../lib/domainAutonomy.js';
import {
  PERSISTENT_MIND_LIMITS,
  createDefaultPersistentMindState,
  nextPersistentMindWakeAt,
  normalizePersistentMindState,
  persistentMindBackoffMs,
  persistentMindTurnIsStale,
  requeuePersistentMindWake,
  takeNextPersistentMindWake,
} from '../lib/persistentMind.js';
import { isDaemonRunning, loadState, saveState, withStateLock } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { schedule, cancel } from './eventScheduler.js';
import { getDomainBudgetStatus, recordDomainUsage } from './domainUsage.js';
import { acquireLocalEndpointProviderSlot } from './cosLocalEndpointSlots.js';
import { acquireCosActionReservation, acquireCosGlobalSlot } from './cosAdmissionReservations.js';
import { appendMindEvent } from './agentRunEventLog.js';
import { preparePersistentMindContext } from './persistentMindContext.js';

export const PERSISTENT_MIND_WAKE_EVENT_ID = 'cos-persistent-mind-wake';
export const PERSISTENT_MIND_WATCHDOG_EVENT_ID = 'cos-persistent-mind-watchdog';
export const PERSISTENT_MIND_WATCHDOG_INTERVAL_MS = 30_000;

let turnAdapter = null;
let activeRun = null;
let activeAbortController = null;
let runtimeGeneration = 0;
let supervisorStopping = false;

const nowIso = () => new Date().toISOString();
const errorMessage = (error) => String(error?.message || error || 'Persistent mind turn failed')
  .slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS);

async function mutateMindState(mutator) {
  return withStateLock(async () => {
    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    const result = await mutator(mind, root);
    root.persistentMind = normalizePersistentMindState(result?.mind || mind);
    await saveState(root);
    return { state: root.persistentMind, value: result?.value };
  });
}

function emitMindStatus(state) {
  cosEvents.emit('persistent-mind:status', {
    enabled: state.enabled,
    started: state.started,
    status: state.status,
    pauseReason: state.pauseReason,
    queuedMessages: state.queuedMessages.length,
    activeTurnId: state.activeTurn?.id || null,
    lastCompletedTurnId: state.lastCompletedTurnId,
    nextEligibleWakeAt: state.nextEligibleWakeAt,
  });
}

function armWatchdog() {
  if (supervisorStopping || !isDaemonRunning()) return;
  schedule({
    id: PERSISTENT_MIND_WATCHDOG_EVENT_ID,
    type: 'interval',
    intervalMs: PERSISTENT_MIND_WATCHDOG_INTERVAL_MS,
    handler: () => checkPersistentMindWatchdog(),
    metadata: { description: 'Persistent CoS mind stale-turn watchdog' },
  });
}

async function scheduleNextWake() {
  const root = await loadState();
  const state = normalizePersistentMindState(root.persistentMind);
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  if (supervisorStopping || !isDaemonRunning() || root.paused || getDomainMode(root.config, 'cos') !== 'execute') return;
  const dueAt = nextPersistentMindWakeAt(state);
  if (dueAt == null || activeRun) return;
  schedule({
    id: PERSISTENT_MIND_WAKE_EVENT_ID,
    type: 'once',
    delayMs: Math.max(1, dueAt - Date.now()),
    handler: async () => {
      await drainPersistentMind({ rearm: false });
      // eventScheduler removes a one-shot's timer handle after its handler
      // resolves. Replacing the same id inside the handler would make the new
      // timer live but uncancellable, so defer the replacement one event-loop
      // turn until that cleanup is complete.
      setImmediate(() => {
        scheduleNextWake().catch((error) => {
          console.error(`❌ Failed to re-arm persistent mind wake: ${error.message}`);
        });
      });
    },
    metadata: { description: 'Persistent CoS mind next eligible wake' },
  });
}

function initialSelfWake(reason) {
  const createdAt = nowIso();
  return {
    id: `wake-${randomUUID()}`,
    kind: 'self',
    reason,
    sourceTurnId: reason,
    createdAt,
    notBefore: createdAt,
  };
}

function quietSelfWake(turnId, notBefore = Date.now() + PERSISTENT_MIND_LIMITS.MAX_QUIET_MS) {
  return {
    id: `wake-${randomUUID()}`,
    kind: 'self',
    reason: 'maximum quiet period elapsed',
    sourceTurnId: turnId,
    createdAt: nowIso(),
    notBefore: new Date(notBefore).toISOString(),
  };
}

async function interruptActiveTurn(reason, status, { retry = false, expectedTurnId = null } = {}) {
  const result = await mutateMindState((mind) => {
    if (expectedTurnId && mind.activeTurn?.id !== expectedTurnId) {
      return { mind, value: false };
    }
    const interrupted = Boolean(mind.activeTurn);
    let next = mind;
    if (mind.activeTurn) next = requeuePersistentMindWake(next, mind.activeTurn.wake);
    const failureCount = retry ? next.failureCount + 1 : next.failureCount;
    return {
      mind: {
        ...next,
        activeTurn: null,
        status,
        pauseReason: reason,
        failureCount,
        lastError: reason,
        nextEligibleWakeAt: retry
          ? new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString()
          : null,
      },
      value: { interrupted, turnId: mind.activeTurn?.id || null, mindId: mind.mindId },
    };
  });
  if (result.value?.interrupted) {
    runtimeGeneration += 1;
    activeAbortController?.abort(reason);
    await appendMindEvent({
      kind: status === 'paused' ? 'mind.paused' : 'mind.failed',
      mindId: result.value.mindId,
      turnId: result.value.turnId,
      eventId: `mind-${status}:${result.value.turnId}`,
      data: { status, error: reason },
    });
  }
  emitMindStatus(result.state);
  return { state: result.state, interrupted: result.value?.interrupted === true };
}

async function parkActiveTurn(turnId, reason, status = 'waiting', retryAt = null) {
  const result = await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind };
    const next = requeuePersistentMindWake(mind, mind.activeTurn.wake);
    const failureCount = next.failureCount + 1;
    return {
      mind: {
        ...next,
        activeTurn: null,
        status,
        pauseReason: reason,
        failureCount,
        lastError: reason,
        nextEligibleWakeAt: retryAt || new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString(),
      },
    };
  });
  await appendMindEvent({
    kind: 'mind.failed',
    mindId: result.state.mindId,
    turnId,
    eventId: `mind-failed:${turnId}:${status}`,
    data: { status, error: reason, retryAt },
  });
  emitMindStatus(result.state);
  return result.state;
}

async function claimNextTurn() {
  const result = await mutateMindState((mind, root) => {
    if (supervisorStopping || !isDaemonRunning()) return { mind, value: null };
    if (!mind.enabled || !mind.started || mind.activeTurn || mind.status === 'paused') return { mind, value: null };
    if (root.paused || getDomainMode(root.config, 'cos') !== 'execute') return { mind, value: null };
    const selected = takeNextPersistentMindWake(mind);
    if (!selected.wake) return { mind: selected.state, value: null };
    const id = `mind-turn-${randomUUID()}`;
    const startedAt = nowIso();
    const activeTurn = {
      id,
      wake: selected.wake,
      startedAt,
      heartbeatAt: startedAt,
      providerId: null,
      model: null,
      effort: null,
    };
    return {
      mind: {
        ...selected.state,
        status: 'thinking',
        pauseReason: null,
        activeTurn,
        nextEligibleWakeAt: null,
      },
      value: activeTurn,
    };
  });
  if (result.value) {
    await appendMindEvent({
      kind: 'mind.wake',
      mindId: result.state.mindId,
      turnId: result.value.id,
      eventId: `mind-wake:${result.value.id}`,
      at: result.value.startedAt,
      data: {
        status: result.state.status,
        wakeKind: result.value.wake.kind,
        wakeId: result.value.wake.id || null,
        messageId: result.value.wake.message?.id || null,
        reason: result.value.wake.reason || null,
      },
    });
    emitMindStatus(result.state);
  }
  return result.value;
}

async function turnCanContinue(turnId, generation, signal) {
  if (supervisorStopping || !isDaemonRunning() || generation !== runtimeGeneration || signal.aborted) return false;
  const state = await getPersistentMindState();
  return !supervisorStopping
    && isDaemonRunning()
    && generation === runtimeGeneration
    && !signal.aborted
    && state.activeTurn?.id === turnId;
}

async function recordTurnProfile(turnId, prepared) {
  await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind };
    return {
      mind: {
        ...mind,
        activeTurn: {
          ...mind.activeTurn,
          providerId: prepared.provider?.id || null,
          model: prepared.model || null,
          effort: prepared.effort || null,
        },
      },
    };
  });
}

async function heartbeat(turnId, generation) {
  if (generation !== runtimeGeneration) return false;
  const result = await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind, value: false };
    return {
      mind: {
        ...mind,
        activeTurn: { ...mind.activeTurn, heartbeatAt: nowIso() },
      },
      value: true,
    };
  });
  return result.value === true;
}

async function completeTurn(turnId, result, generation) {
  if (generation !== runtimeGeneration) return;
  const completedAt = nowIso();
  const updated = await mutateMindState((mind) => {
    if (mind.activeTurn?.id !== turnId) return { mind, value: false };
    const messageId = mind.activeTurn.wake.kind === 'message'
      ? mind.activeTurn.wake.message.id
      : null;
    const recentMessageIds = messageId
      ? [...mind.recentMessageIds.filter((id) => id !== messageId), messageId]
        .slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS)
      : mind.recentMessageIds;
    const requestedWake = result?.selfWake && typeof result.selfWake === 'object'
      ? {
          id: `wake-${randomUUID()}`,
          kind: 'self',
          reason: String(result.selfWake.reason || 'turn requested follow-up')
            .slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS),
          sourceTurnId: turnId,
          createdAt: completedAt,
          notBefore: result.selfWake.notBefore || completedAt,
        }
      : quietSelfWake(turnId);
    const hasQueuedMessages = mind.queuedMessages.length > 0;
    return {
      mind: {
        ...mind,
        activeTurn: null,
        recentMessageIds,
        selfWake: requestedWake,
        lastCompletedTurnId: turnId,
        lastCompletedAt: completedAt,
        nextEligibleWakeAt: null,
        failureCount: 0,
        lastError: null,
        status: hasQueuedMessages ? 'waiting' : 'idle',
        pauseReason: null,
      },
      value: true,
    };
  });
  if (!updated.value) return;
  await appendMindEvent({
    kind: 'mind.turn.completed',
    mindId: updated.state.mindId,
    turnId,
    eventId: `mind-turn-completed:${turnId}`,
    at: completedAt,
    data: {
      status: updated.state.status,
      providerId: result?.providerId || null,
      model: result?.model || null,
      effort: result?.effort || null,
      summaryText: typeof result?.summary === 'string' ? result.summary : null,
    },
  });
  emitMindStatus(updated.state);
  cosEvents.emit('persistent-mind:turn-completed', {
    turnId,
    providerId: updated.state.lastCompletedTurnId === turnId ? result?.providerId || null : null,
  });
}

async function runOnePersistentMindTurn() {
  if (supervisorStopping || !isDaemonRunning()) return;
  if (!turnAdapter) {
    const updated = await mutateMindState((mind) => ({
      mind: mind.enabled && mind.started
        ? {
            ...mind,
            status: 'degraded',
            pauseReason: 'Persistent mind provider is not configured',
            lastError: 'Persistent mind provider is not configured',
            nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS).toISOString(),
          }
        : mind,
    }));
    emitMindStatus(updated.state);
    return;
  }

  const root = await loadState();
  const mind = normalizePersistentMindState(root.persistentMind);
  if (supervisorStopping || !isDaemonRunning()) return;
  if (!mind.enabled || !mind.started || mind.status === 'paused') return;
  if (root.paused || getDomainMode(root.config, 'cos') !== 'execute') return;

  const runningAgentEntries = Object.values(root.agents || {}).filter((agent) => agent.status === 'running');
  const maxConcurrentAgents = Number(root.config?.maxConcurrentAgents);
  const admissionId = `persistent-mind:${randomUUID()}`;
  const globalSlot = acquireCosGlobalSlot({
    agents: root.agents,
    limit: maxConcurrentAgents,
    reservationId: admissionId,
  });
  if (!globalSlot.ok) {
    const updated = await mutateMindState((current) => ({
      mind: {
        ...current,
        status: 'waiting',
        pauseReason: globalSlot.reason,
        nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_BASE_MS).toISOString(),
      },
    }));
    emitMindStatus(updated.state);
    return;
  }

  let actionReservation = null;
  try {
    let budget;
    try {
      budget = await getDomainBudgetStatus('cos');
    } catch (error) {
      const message = `Persistent mind budget check failed: ${errorMessage(error)}`;
      const updated = await mutateMindState((current) => ({
        mind: {
          ...current,
          status: 'degraded',
          pauseReason: message,
          lastError: message,
          nextEligibleWakeAt: new Date(Date.now() + persistentMindBackoffMs(current.failureCount + 1)).toISOString(),
          failureCount: current.failureCount + 1,
        },
      }));
      emitMindStatus(updated.state);
      return;
    }
    if (!budget.withinBudget) {
      const updated = await mutateMindState((current) => ({
        mind: {
          ...current,
          status: 'waiting',
          pauseReason: `CoS ${budget.exceeded || 'daily'} budget exhausted`,
          nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS).toISOString(),
        },
      }));
      emitMindStatus(updated.state);
      return;
    }

    const runningAutonomous = runningAgentEntries.filter(
      (agent) => agent.metadata?.taskType && agent.metadata.taskType !== 'user'
    ).length;
    actionReservation = acquireCosActionReservation({
      budget: budget.budget,
      usage: budget.usage,
      inFlight: runningAutonomous,
      reservationId: admissionId,
    });
    if (!actionReservation.ok) {
      const updated = await mutateMindState((current) => ({
        mind: {
          ...current,
          status: 'waiting',
          pauseReason: actionReservation.reason,
          nextEligibleWakeAt: new Date(Date.now() + PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS).toISOString(),
        },
      }));
      emitMindStatus(updated.state);
      return;
    }

    const turn = await claimNextTurn();
    if (!turn) return;

    const generation = runtimeGeneration;
    const controller = new AbortController();
    activeAbortController = controller;
    let release = () => {};
    let runStartedAt = null;
    try {
      // `prepare` must resolve the exact configured provider. The supervisor never
      // follows a fallback chain: an unavailable pin is a visible degraded state.
      const prepared = await turnAdapter.prepare({ wake: turn.wake, signal: controller.signal });
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;
      if (!prepared?.ok || !prepared.provider) {
        await parkActiveTurn(turn.id, prepared?.error || 'Persistent mind provider is unavailable', 'degraded', prepared?.retryAt || null);
        return;
      }
      await recordTurnProfile(turn.id, prepared);
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;

      const context = await preparePersistentMindContext({
        mindId: mind.mindId,
        identity: turnAdapter.identity || 'One supervised persistent Chief of Staff mind.',
        providerId: prepared.provider.id,
        model: prepared.model || null,
        summarize: typeof turnAdapter.summarize === 'function'
          ? (input) => turnAdapter.summarize({
              ...input,
              provider: prepared.provider,
              model: prepared.model || null,
              effort: prepared.effort || null,
              signal: controller.signal,
            })
          : null,
      });
      await appendMindEvent({
        kind: 'mind.model.request',
        mindId: mind.mindId,
        turnId: turn.id,
        eventId: `mind-model-request:${turn.id}`,
        data: {
          providerId: prepared.provider.id,
          model: prepared.model || null,
          effort: prepared.effort || null,
          contextChars: context.chars,
          contextSummaryState: context.summaryState,
        },
      });

      const latestRoot = await loadState();
      const slot = await acquireLocalEndpointProviderSlot(prepared.provider, latestRoot.agents, turn.id);
      if (!slot.ok) {
        await parkActiveTurn(turn.id, slot.reason, 'waiting');
        return;
      }
      release = slot.release;
      if (!await turnCanContinue(turn.id, generation, controller.signal)) return;
      runStartedAt = Date.now();
      const result = await turnAdapter.run({
        turnId: turn.id,
        wake: turn.wake,
        provider: prepared.provider,
        model: prepared.model || null,
        effort: prepared.effort || null,
        signal: controller.signal,
        heartbeat: () => heartbeat(turn.id, generation),
        context,
        recordCapabilityEvent: ({ kind, id, data } = {}) => {
          const eventKind = kind === 'result' ? 'mind.capability.result' : 'mind.capability.request';
          const capabilityId = typeof id === 'string' && id ? id : randomUUID();
          return appendMindEvent({
            kind: eventKind,
            mindId: mind.mindId,
            turnId: turn.id,
            eventId: `mind-capability:${turn.id}:${capabilityId}:${kind === 'result' ? 'result' : 'request'}`,
            data: { capabilityId, ...(data && typeof data === 'object' ? data : {}) },
          });
        },
      });
      await appendMindEvent({
        kind: 'mind.model.result',
        mindId: mind.mindId,
        turnId: turn.id,
        eventId: `mind-model-result:${turn.id}`,
        data: {
          providerId: prepared.provider.id,
          model: prepared.model || null,
          effort: prepared.effort || null,
          summaryText: typeof result?.summary === 'string' ? result.summary : null,
          responseChars: typeof result?.output === 'string' ? result.output.length : null,
          success: true,
        },
      });
      await completeTurn(turn.id, {
        ...result,
        providerId: prepared.provider.id,
        model: prepared.model || null,
        effort: prepared.effort || null,
      }, generation);
    } catch (error) {
      if (generation === runtimeGeneration) {
        const message = controller.signal.aborted
          ? String(controller.signal.reason || 'Persistent mind turn interrupted')
          : errorMessage(error);
        await parkActiveTurn(turn.id, message, 'interrupted');
        emitLog('warn', `Persistent mind turn interrupted: ${message}`, { turnId: turn.id });
      }
    } finally {
      release();
      if (runStartedAt != null) {
        await recordDomainUsage('cos', { actions: 1, ms: Date.now() - runStartedAt }).catch((error) => {
          console.error(`❌ Failed to record persistent mind usage: ${error.message}`);
        });
      }
    }
  } finally {
    actionReservation?.release?.();
    globalSlot.release();
  }
}

export async function registerPersistentMindTurnAdapter(adapter) {
  if (!adapter || typeof adapter.prepare !== 'function' || typeof adapter.run !== 'function') {
    throw new Error('Persistent mind adapter requires prepare() and run()');
  }
  turnAdapter = adapter;
  await mutateMindState((mind) => ({
    mind: mind.lastError === 'Persistent mind provider is not configured'
      ? { ...mind, status: mind.started ? 'waiting' : mind.status, pauseReason: null, lastError: null, nextEligibleWakeAt: null }
      : mind,
  }));
  await scheduleNextWake();
}

export function unregisterPersistentMindTurnAdapter() {
  turnAdapter = null;
}

export async function getPersistentMindState() {
  const state = await loadState();
  return normalizePersistentMindState(state.persistentMind);
}

export async function setPersistentMindEnabled(enabled) {
  if (!enabled) {
    runtimeGeneration += 1;
    activeAbortController?.abort('Persistent mind disabled');
    cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
    cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  }
  const result = await mutateMindState((mind) => {
    const changedToDisabled = !enabled && (mind.enabled || Boolean(mind.activeTurn));
    const interruptedTurnId = !enabled ? mind.activeTurn?.id || null : null;
    let next = mind;
    if (!enabled && mind.activeTurn) next = requeuePersistentMindWake(next, mind.activeTurn.wake);
    return {
      mind: {
        ...next,
        enabled: Boolean(enabled),
        started: enabled ? next.started : false,
        status: enabled ? (next.started ? 'waiting' : 'idle') : 'disabled',
        activeTurn: enabled ? next.activeTurn : null,
        pauseReason: null,
        nextEligibleWakeAt: enabled ? next.nextEligibleWakeAt : null,
      },
      value: { changedToDisabled, interruptedTurnId, mindId: mind.mindId },
    };
  });
  if (result.value.changedToDisabled) {
    await appendMindEvent({
      kind: 'mind.paused',
      mindId: result.value.mindId,
      turnId: result.value.interruptedTurnId,
      eventId: `mind-disabled:${result.value.interruptedTurnId || randomUUID()}`,
      data: { status: 'disabled', error: 'Persistent mind disabled' },
    });
  }
  emitMindStatus(result.state);
  return result.state;
}

export async function startPersistentMind() {
  const result = await mutateMindState((mind) => {
    if (!mind.enabled) return { mind, value: { success: false, error: 'Persistent mind is disabled' } };
    if (mind.started) return { mind, value: { success: true, alreadyStarted: true } };
    return {
      mind: {
        ...mind,
        started: true,
        status: 'waiting',
        pauseReason: null,
        selfWake: mind.queuedMessages.length > 0 ? mind.selfWake : initialSelfWake('explicit-start'),
        nextEligibleWakeAt: null,
      },
      value: { success: true, alreadyStarted: false },
    };
  });
  if (result.value.success) {
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(result.state);
  return result.value;
}

export async function pausePersistentMind(reason = 'Paused by user') {
  const { state, interrupted } = await interruptActiveTurn(reason, 'paused');
  if (!interrupted) {
    await appendMindEvent({
      kind: 'mind.paused',
      mindId: state.mindId,
      eventId: `mind-paused:${randomUUID()}`,
      data: { status: 'paused', error: reason },
    });
  }
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  return { success: true, state };
}

export async function resumePersistentMind() {
  const result = await mutateMindState((mind) => {
    if (!mind.enabled || !mind.started) return { mind, value: { success: false, error: 'Persistent mind is not started' } };
    if (mind.status !== 'paused') return { mind, value: { success: true, alreadyRunning: true } };
    return {
      mind: {
        ...mind,
        status: 'waiting',
        pauseReason: null,
        selfWake: mind.queuedMessages.length > 0 || mind.selfWake
          ? mind.selfWake
          : initialSelfWake('explicit-resume'),
      },
      value: { success: true, alreadyRunning: false },
    };
  });
  if (result.value.success) {
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(result.state);
  return result.value;
}

export async function stopPersistentMind() {
  runtimeGeneration += 1;
  activeAbortController?.abort('Persistent mind stopped');
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  const result = await mutateMindState((mind) => {
    const wasStarted = mind.started;
    const interruptedTurnId = mind.activeTurn?.id || null;
    let next = mind;
    if (mind.activeTurn) next = requeuePersistentMindWake(next, mind.activeTurn.wake);
    return {
      mind: {
        ...next,
        started: false,
        status: mind.enabled ? 'idle' : 'disabled',
        activeTurn: null,
        pauseReason: null,
        nextEligibleWakeAt: null,
      },
      value: { wasStarted, interruptedTurnId, mindId: mind.mindId },
    };
  });
  if (result.value.wasStarted || result.value.interruptedTurnId) {
    await appendMindEvent({
      kind: 'mind.paused',
      mindId: result.value.mindId,
      turnId: result.value.interruptedTurnId,
      eventId: `mind-stopped:${result.value.interruptedTurnId || randomUUID()}`,
      data: { status: result.state.status, error: 'Persistent mind stopped' },
    });
  }
  emitMindStatus(result.state);
  return { success: true };
}

export async function enqueuePersistentMindMessage({ id = randomUUID(), text, createdAt = nowIso() } = {}) {
  const message = normalizePersistentMindState({ queuedMessages: [{ id, text, createdAt }] }).queuedMessages[0];
  if (!message) return { success: false, error: 'Message id and text are required' };
  const result = await mutateMindState((mind) => {
    const duplicate = mind.recentMessageIds.includes(message.id)
      || mind.queuedMessages.some((queued) => queued.id === message.id)
      || (mind.activeTurn?.wake.kind === 'message' && mind.activeTurn.wake.message.id === message.id);
    if (duplicate) return { mind, value: { success: true, duplicate: true, messageId: message.id } };
    const acceptedMessageCount = mind.queuedMessages.length
      + (mind.activeTurn?.wake.kind === 'message' ? 1 : 0);
    if (acceptedMessageCount >= PERSISTENT_MIND_LIMITS.MAX_QUEUED_MESSAGES) {
      return { mind, value: { success: false, error: 'Persistent mind message queue is full' } };
    }
    return {
      mind: {
        ...mind,
        queuedMessages: [...mind.queuedMessages, message],
        status: mind.started && mind.status !== 'paused' ? 'waiting' : mind.status,
      },
      value: { success: true, duplicate: false, messageId: message.id },
    };
  });
  if (result.value.success) {
    // Retry the stable event id even when the mutable queue already saw this
    // message. The ledger deduplicates a healthy first append; if the first
    // append was dropped, the caller's idempotent retry repairs the trajectory.
    await appendMindEvent({
      kind: 'mind.message.accepted',
      mindId: result.state.mindId,
      eventId: `mind-message:${message.id}`,
      at: message.createdAt,
      data: {
        messageId: message.id,
        displayText: message.text,
        textChars: message.text.length,
      },
    });
  }
  if (result.value.success && result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  return result.value;
}

export async function requestPersistentMindWake({ sourceTurnId, reason, notBefore = nowIso() } = {}) {
  const result = await mutateMindState((mind) => {
    if (!sourceTurnId || sourceTurnId !== mind.lastCompletedTurnId) {
      return { mind, value: { success: false, error: 'Self-wake must reference the last completed turn' } };
    }
    const selfWake = {
      id: `wake-${randomUUID()}`,
      kind: 'self',
      reason: String(reason || 'self-wake').slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS),
      sourceTurnId,
      createdAt: nowIso(),
      notBefore,
    };
    return {
      mind: { ...mind, selfWake, status: mind.started && mind.status !== 'paused' ? 'waiting' : mind.status },
      value: { success: true, wakeId: selfWake.id },
    };
  });
  if (result.value.success && result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  return result.value;
}

export async function drainPersistentMind({ rearm = true } = {}) {
  if (activeRun) return activeRun;
  const run = runOnePersistentMindTurn();
  activeRun = run.finally(async () => {
    activeRun = null;
    activeAbortController = null;
    if (rearm) await scheduleNextWake();
  });
  return activeRun;
}

export async function checkPersistentMindWatchdog() {
  const state = await getPersistentMindState();
  if (!persistentMindTurnIsStale(state)) return { interrupted: false };
  const result = await interruptActiveTurn('Persistent mind turn heartbeat expired', 'interrupted', {
    retry: true,
    expectedTurnId: state.activeTurn.id,
  });
  if (result.interrupted) await scheduleNextWake();
  return { interrupted: result.interrupted };
}

export async function initializePersistentMindSupervisor() {
  supervisorStopping = false;
  const recovered = await mutateMindState((mind) => {
    if (!mind.enabled || !mind.started) return { mind };
    let next = mind;
    const orphanedTurnId = mind.activeTurn?.id || null;
    if (mind.activeTurn) {
      next = requeuePersistentMindWake(next, mind.activeTurn.wake);
      const failureCount = next.failureCount + 1;
      next = {
        ...next,
        activeTurn: null,
        status: 'interrupted',
        pauseReason: 'Recovered an orphaned persistent mind turn after restart',
        failureCount,
        lastError: 'Recovered an orphaned persistent mind turn after restart',
        nextEligibleWakeAt: new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString(),
      };
    } else if (next.queuedMessages.length === 0 && !next.selfWake) {
      const base = next.lastCompletedAt ? Date.parse(next.lastCompletedAt) : Date.now();
      next = { ...next, selfWake: quietSelfWake(next.lastCompletedTurnId || 'restart', base + PERSISTENT_MIND_LIMITS.MAX_QUIET_MS) };
    }
    return { mind: next, value: { orphanedTurnId, mindId: mind.mindId } };
  });
  if (recovered.value?.orphanedTurnId) {
    await appendMindEvent({
      kind: 'mind.failed',
      mindId: recovered.value.mindId,
      turnId: recovered.value.orphanedTurnId,
      eventId: `mind-restart-recovered:${recovered.value.orphanedTurnId}`,
      data: {
        status: 'interrupted',
        error: 'Recovered an orphaned persistent mind turn after restart',
      },
    });
  }
  if (recovered.state.enabled && recovered.state.started) {
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(recovered.state);
  return recovered.state;
}

export async function handlePersistentMindGlobalPause(reason = 'Chief of Staff paused') {
  const state = await getPersistentMindState();
  if (!state.activeTurn) {
    cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
    return state;
  }
  return (await interruptActiveTurn(reason, 'waiting')).state;
}

export async function handlePersistentMindGlobalResume() {
  await scheduleNextWake();
}

export async function shutdownPersistentMindSupervisor() {
  supervisorStopping = true;
  runtimeGeneration += 1;
  activeAbortController?.abort('Chief of Staff daemon stopped');
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  const state = await getPersistentMindState();
  if (!state.activeTurn) return state;
  return (await interruptActiveTurn('Chief of Staff daemon stopped', 'interrupted', { retry: true })).state;
}

export function __resetPersistentMindSupervisorForTests() {
  turnAdapter = null;
  activeRun = null;
  activeAbortController = null;
  runtimeGeneration = 0;
  supervisorStopping = false;
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
}
