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
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { reconcileDeadOwnerReservations } from '../deadOwnerReservations.js';
import { randomUUID } from 'crypto';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import {
  PERSISTENT_MIND_LIMITS,
  nextPersistentMindWakeAt,
  normalizePersistentMindState,
  persistentMindBackoffMs,
  persistentMindTurnIsStale,
} from '../../lib/persistent/persistentMind.js';
import { isDaemonRunning, loadState, saveState, withStateLock } from '../cos/cosState.js';
import { cleanupPersistentMindAttachments } from './persistentMindAttachments.js';
import { cosEvents } from '../cos/cosEvents.js';
import { schedule, cancel } from '../eventScheduler.js';
import { appendMindEvent } from '../agent/agentRunEventLog.js';
import { publicPersistentMindState } from '../../lib/persistent/persistentMindPublic.js';
import { persistentMindWakeIntervalMs } from '../../lib/persistent/persistentMindProfile.js';
import { isUsageLimitPauseReason } from '../../lib/persistent/persistentMindUsageLimit.js';
import { admitPersistentMindMessage } from './persistentMindMessageIntake.js';
import { createUsageLimitRecovery, turnHasLiveCall } from './persistentMindRecoveryProbes.js';
import { createPersistentMindTurnRunner, quietSelfWake, releaseClaimedWake } from './persistentMindTurnRunner.js';

export { createPersistentMindAttachment, deletePersistentMindAttachment } from './persistentMindAttachments.js';
export { PERSISTENT_MIND_USAGE_LIMIT_PROBE_EVENT_ID, persistentMindUsageLimitRetryAt } from './persistentMindRecoveryProbes.js';
export const PERSISTENT_MIND_WAKE_EVENT_ID = 'cos-persistent-mind-wake';
export const PERSISTENT_MIND_WATCHDOG_EVENT_ID = 'cos-persistent-mind-watchdog';
export const PERSISTENT_MIND_WATCHDOG_INTERVAL_MS = 30_000;
// A watchdog tick that arrives this long after the previous one means this
// process itself did not run in between (host sleep, VM suspend/snapshot, or a
// frozen event loop). The turn's heartbeat timer was frozen for the same span,
// so the heartbeat's age measures the pause rather than a dead turn.
export const PERSISTENT_MIND_WATCHDOG_SUSPEND_GAP_MS = PERSISTENT_MIND_LIMITS.HEARTBEAT_STALE_WARNING_MS;

const runtime = { adapter: null, controller: null, generation: 0, stopping: false };
let activeRun = null;
export const isPersistentMindTurnRunning = () => runtime.controller !== null;

/** Wall time of the previous watchdog tick, to detect host suspend gaps. */
let lastWatchdogCheckAt = null;
/** Wall time this process was last seen resuming from such a gap. */
let watchdogResumedAt = null;

const { resetUsageLimitProbe, scheduleUsageLimitProbe, checkPersistentMindUsageLimitRecovery } = createUsageLimitRecovery({
  isStopping: () => runtime.stopping,
  getPersistentMindState, mutateMindState, initialSelfWake, armWatchdog, scheduleNextWake, emitMindStatus,
});
export { checkPersistentMindUsageLimitRecovery };

const { interruptActiveTurn, runOnePersistentMindTurn } = createPersistentMindTurnRunner({
  runtime, getPersistentMindState, mutateMindState, emitMindStatus, scheduleUsageLimitProbe,
  cancelWake: () => cancel(PERSISTENT_MIND_WAKE_EVENT_ID),
});

export function enqueuePersistentMindMessage(message) {
  return admitPersistentMindMessage(message, {
    mutateMindState, armWatchdog, scheduleNextWake, emitMindStatus, resetUsageLimitProbe,
  });
}

async function mutateMindState(mutator) {
  return withStateLock(async () => {
    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    const result = await mutator(mind, root);
    const next = result?.mind || mind;
    const request = mind.activeTurn?.wake?.thinkingRequest;
    if (request && !next.activeTurn) {
      next.thinkingRequests.history = next.thinkingRequests.history.map((entry) => entry.requestId === request.requestId
        ? { ...entry, outcome: next.lastCompletedTurnId === mind.activeTurn.id ? 'completed' : 'failed' } : entry);
    }
    root.persistentMind = normalizePersistentMindState(next);
    await saveState(root);
    return { state: root.persistentMind, value: result?.value };
  });
}

function emitMindStatus(state) {
  cosEvents.emit('persistent-mind:status', publicPersistentMindState(state));
}

function armWatchdog() {
  if (runtime.stopping || !isDaemonRunning()) return;
  // A fresh interval has no prior tick; a gap spent disarmed is not a suspend.
  lastWatchdogCheckAt = null;
  schedule({
    id: PERSISTENT_MIND_WATCHDOG_EVENT_ID,
    type: 'interval',
    intervalMs: PERSISTENT_MIND_WATCHDOG_INTERVAL_MS,
    handler: () => checkPersistentMindWatchdog(),
    metadata: { description: 'Persistent CoS mind stale-turn watchdog' },
  });
}

async function scheduleNextWake() {
  if (maintenance.held()) return;
  const root = await loadState();
  const state = normalizePersistentMindState(root.persistentMind);
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  if (runtime.stopping || !isDaemonRunning() || root.paused || getDomainMode(root.config, 'cos') !== 'execute') return;
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
  const createdAt = new Date().toISOString();
  return {
    id: `wake-${randomUUID()}`,
    kind: 'self',
    scheduleKind: 'requested',
    reason,
    sourceTurnId: reason,
    createdAt,
    notBefore: createdAt,
  };
}

export async function registerPersistentMindTurnAdapter(adapter) {
  if (!adapter || typeof adapter.prepare !== 'function' || typeof adapter.run !== 'function') {
    throw new Error('Persistent mind adapter requires prepare() and run()');
  }
  runtime.adapter = adapter;
  await mutateMindState((mind) => ({
    mind: mind.lastError === 'Persistent mind provider is not configured'
      ? { ...mind, status: mind.started ? 'waiting' : mind.status, pauseReason: null, lastError: null, nextEligibleWakeAt: null }
      : mind,
  }));
  await scheduleNextWake();
}

export function unregisterPersistentMindTurnAdapter() {
  runtime.adapter = null;
}

export async function getPersistentMindState() {
  const state = await loadState();
  return normalizePersistentMindState(state.persistentMind);
}

/** Apply a saved cadence to the currently scheduled self-wake and timer. */
export async function refreshPersistentMindWakeCadence() {
  const result = await mutateMindState((mind, root) => {
    if (!mind.started || mind.activeTurn) return { mind };
    const quietPeriodMs = persistentMindWakeIntervalMs(root.config?.persistentMindProfile);
    const baseAt = Number.isFinite(Date.parse(mind.lastCompletedAt))
      ? Date.parse(mind.lastCompletedAt)
      : Date.now();
    const quietDeadline = baseAt + quietPeriodMs;
    let selfWake = mind.selfWake;
    if (!selfWake && mind.queuedMessages.length === 0) {
      selfWake = quietSelfWake(mind.lastCompletedTurnId || 'cadence-change', quietPeriodMs, baseAt);
    } else if (selfWake?.scheduleKind === 'quiet') {
      selfWake = quietSelfWake(selfWake.sourceTurnId || mind.lastCompletedTurnId || 'cadence-change', quietPeriodMs, baseAt);
    } else if (selfWake && (!Number.isFinite(Date.parse(selfWake.notBefore)) || Date.parse(selfWake.notBefore) > quietDeadline)) {
      selfWake = { ...selfWake, notBefore: new Date(quietDeadline).toISOString() };
    }
    return { mind: { ...mind, selfWake } };
  });
  if (result.state.started) await scheduleNextWake();
  emitMindStatus(result.state);
  return result.state;
}

/** Clear failure/backoff residue without changing lifecycle or queued work. */
export async function resetPersistentMindRuntimeResidue() {
  const result = await mutateMindState((mind) => ({
    mind: {
      ...mind,
      failureCount: 0,
      lastError: null,
      nextEligibleWakeAt: null,
      pauseReason: mind.status === 'paused' ? mind.pauseReason : null,
    },
  }));
  emitMindStatus(result.state);
  return result.state;
}

export async function startPersistentMind() {
  maintenance.assertOpen();
  const result = await mutateMindState((mind) => {
    if (mind.started) return { mind, value: { success: true, alreadyStarted: true } };
    return {
      mind: {
        ...mind,
        enabled: true,
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

/** A deliberate user wake retries now through the normal admission gates. */
export async function wakePersistentMind() {
  maintenance.assertOpen();
  const result = await mutateMindState((mind) => {
    // A running turn already satisfies this request; never interrupt or queue
    // an extra billable turn for repeated clicks while it is thinking.
    if (mind.activeTurn) return { mind, value: { success: true, alreadyRunning: true } };
    return {
      mind: {
        ...mind,
        enabled: true,
        started: true,
        status: 'waiting',
        pauseReason: null,
        nextEligibleWakeAt: null,
        selfWake: mind.queuedMessages.length > 0 ? mind.selfWake : initialSelfWake('explicit-wake'),
      },
      value: { success: true, alreadyRunning: false },
    };
  });
  resetUsageLimitProbe();
  armWatchdog();
  await scheduleNextWake();
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
  // Explicit / non-usage pauses must never auto-resume via the usage-limit probe.
  resetUsageLimitProbe();
  return { success: true, state };
}

export async function resumePersistentMind() {
  maintenance.assertOpen();
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
    resetUsageLimitProbe();
    armWatchdog();
    await scheduleNextWake();
  }
  emitMindStatus(result.state);
  return result.value;
}

export async function stopPersistentMind({ waitForTurn = false } = {}) {
  runtime.generation += 1;
  runtime.controller?.abort('Persistent mind stopped');
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  resetUsageLimitProbe();
  const result = await mutateMindState((mind) => {
    const wasStarted = mind.started;
    const interruptedTurnId = mind.activeTurn?.id || null;
    let next = mind;
    if (mind.activeTurn) next = releaseClaimedWake(next, mind.activeTurn.wake);
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
  if (waitForTurn && activeRun) {
    await activeRun.catch((error) => {
      console.error(`❌ Failed while settling stopped persistent mind turn: ${error.message}`);
    });
  }
  return { success: true };
}

export async function drainPersistentMind({ rearm = true } = {}) {
  if (activeRun) return activeRun;
  const run = runOnePersistentMindTurn();
  activeRun = run.finally(async () => {
    activeRun = null;
    runtime.controller = null;
    if (rearm) await scheduleNextWake();
  });
  return activeRun;
}

/**
 * Track the watchdog's own cadence. When a tick lands long after the previous
 * one, the whole process (and with it the turn's heartbeat pulse and, on a
 * suspended host, the local model server) was paused, so the stale window is
 * restarted from the resume instead of killing an in-flight call that will
 * continue as soon as the host runs again.
 */
function noteWatchdogTick(now) {
  const previous = lastWatchdogCheckAt;
  lastWatchdogCheckAt = now;
  if (previous != null && now - previous >= PERSISTENT_MIND_WATCHDOG_SUSPEND_GAP_MS) {
    watchdogResumedAt = now;
    console.log(`⏸️ Persistent mind watchdog resumed after a ${Math.round((now - previous) / 1000)}s pause; restarting the heartbeat window`);
  }
}

export async function checkPersistentMindWatchdog(now = Date.now()) {
  noteWatchdogTick(now);
  const state = await getPersistentMindState();
  if (!persistentMindTurnIsStale(state, now)) return { interrupted: false };
  if (watchdogResumedAt != null && now - watchdogResumedAt < PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS) {
    return { interrupted: false, resumeGrace: true };
  }
  // A long thought is not a dead one: while the provider call is still open
  // and its provider still answers, keep waiting with no fixed cap.
  const liveness = await turnHasLiveCall(state.activeTurn.id);
  if (liveness.alive) return { interrupted: false, inFlight: true };
  const result = await interruptActiveTurn('Persistent mind turn heartbeat expired', 'interrupted', {
    retry: true,
    expectedTurnId: state.activeTurn.id,
  });
  if (result.interrupted) await scheduleNextWake();
  return { interrupted: result.interrupted };
}

export async function initializePersistentMindSupervisor() {
  runtime.stopping = false;
  await cleanupPersistentMindAttachments();
  const recovered = await mutateMindState((mind, root) => {
    if (!mind.enabled || !mind.started) return { mind };
    let next = mind;
    const orphanedTurnId = mind.activeTurn?.id || null;
    if (mind.activeTurn) {
      next = releaseClaimedWake(next, mind.activeTurn.wake);
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
      next = {
        ...next,
        selfWake: quietSelfWake(
          next.lastCompletedTurnId || 'restart',
          persistentMindWakeIntervalMs(root.config?.persistentMindProfile),
          base,
        ),
      };
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
  // The turn record is durable now. A dead mind-turn reservation is releasable
  // only once this recovery has cleared an orphaned active turn.
  reconcileDeadOwnerReservations({
    mindTurnIdle: () => recovered.state != null && recovered.state.activeTurn == null,
  });
  if (recovered.state.enabled && recovered.state.started) {
    armWatchdog();
    await scheduleNextWake();
    if (recovered.state.status === 'paused' && isUsageLimitPauseReason(recovered.state.pauseReason)) {
      scheduleUsageLimitProbe(0);
    }
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
  runtime.stopping = true;
  runtime.generation += 1;
  runtime.controller?.abort('Chief of Staff daemon stopped');
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  resetUsageLimitProbe();
  const state = await getPersistentMindState();
  if (!state.activeTurn) return state;
  return (await interruptActiveTurn('Chief of Staff daemon stopped', 'interrupted', { retry: true })).state;
}

export function __resetPersistentMindSupervisorForTests() {
  runtime.adapter = null;
  activeRun = null;
  runtime.controller = null;
  runtime.generation = 0;
  runtime.stopping = false;
  lastWatchdogCheckAt = null;
  watchdogResumedAt = null;
  cancel(PERSISTENT_MIND_WAKE_EVENT_ID);
  cancel(PERSISTENT_MIND_WATCHDOG_EVENT_ID);
  resetUsageLimitProbe();
}

export const recheckPersistentMindSchedule = () => scheduleNextWake();
