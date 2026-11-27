/** Admit, execute and settle a single Persistent Mind turn against its configured provider and budgets. */
import { normalizePersistentMindCapabilities } from '../../lib/persistent/persistentMindCapabilities.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { normalizePersistentMindMaintainer } from '../../lib/persistent/persistentMindMaintainer.js';
import { canonicalStringify as maintainerCanonicalStringify } from '../../lib/objects.js';
import { randomUUID } from 'crypto';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { isPersistentMindCallDenial } from '../../lib/persistent/persistentMindTrajectory.js';
import {
  PERSISTENT_MIND_LIMITS,
  holdPersistentMindWake,
  normalizePersistentMindState,
  persistentMindMessageReceipt,
  persistentMindBackoffMs,
  persistentMindWakeConsumesAttempt,
  requeuePersistentMindWake,
  takeNextPersistentMindWake,
} from '../../lib/persistent/persistentMind.js';
import { isDaemonRunning, loadState } from '../cos/cosState.js';
import { emitLog } from '../cos/cosEvents.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { acquireLocalEndpointProviderSlot, localEndpointOfProvider } from '../cos/cosLocalEndpointSlots.js';
import { acquireCosActionReservation, acquireCosGlobalSlot } from '../cos/cosAdmissionReservations.js';
import {
  createPersistentMindCallBoundary,
  persistentMindCapabilityGrantFingerprint,
} from './persistentMindCallGuard.js';
import { appendMindEvent } from '../agent/agentRunEventLog.js';
import { resolvePersistentMindSelfThinkingRequest } from './persistentMindThinkingRequests.js';
import { resolvePersistentMindProfile, resolvePersistentMindThinkingSession } from './persistentMindProfile.js';
import { persistentMindWakeIntervalMs } from '../../lib/persistent/persistentMindProfile.js';
import { imageCapabilityAllowsAttempt, resolvePersistentMindImageCapability } from './persistentMindImageCapability.js';
import {
  PROVIDER_USAGE_LIMIT_PAUSE_REASON,
  isHardProviderUsageLimitError,
} from '../../lib/persistent/persistentMindUsageLimit.js';
import {
  contextBudgetPauseReasonFrom,
  isContextBudgetFitnessError,
} from '../../lib/persistent/persistentMindContextBudget.js';
import { markProviderUsageLimit } from '../provider/providerStatus.js';
import { scrubSecretTokens } from '../../lib/secretText.js';
import { trackInFlightCall } from './persistentMindRecoveryProbes.js';

const nowIso = () => new Date().toISOString();
const errorMessage = (error) => String(error?.message || error || 'Persistent mind turn failed')
  .slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS);

const QUIET_SELF_WAKE_REASON = 'maximum quiet period elapsed';

export function quietSelfWake(turnId, quietPeriodMs = PERSISTENT_MIND_LIMITS.MAX_QUIET_MS, baseAt = Date.now()) {
  return {
    id: `wake-${randomUUID()}`,
    kind: 'self',
    scheduleKind: 'quiet',
    reason: QUIET_SELF_WAKE_REASON,
    sourceTurnId: turnId,
    createdAt: nowIso(),
    notBefore: new Date(baseAt + quietPeriodMs).toISOString(),
  };
}

/**
 * Hand a claimed wake back to durable state when its turn is abandoned.
 *
 * An interrupted temporary thinking session is an uncertain consumed attempt:
 * the abort races whatever the provider already started, and no durable record
 * can say whether that call was billed. Every such wake is retired rather than
 * requeued, so resuming it stays an explicit user decision; an ordinary message
 * or self-wake keeps its free automatic retry.
 */
export const releaseClaimedWake = (mind, wake) => (
  persistentMindWakeConsumesAttempt(wake)
    ? holdPersistentMindWake(mind, wake)
    : requeuePersistentMindWake(mind, wake)
);

function resolveTurnProfile({ selfThinkingRequest, thinkingPresetId, thinkingSelection, config }) {
  if (selfThinkingRequest) return resolvePersistentMindSelfThinkingRequest({ request: selfThinkingRequest, config });
  if (thinkingPresetId) return resolvePersistentMindThinkingSession({ presetId: thinkingPresetId, selection: thinkingSelection, config });
  return resolvePersistentMindProfile(config?.persistentMindProfile);
}

// The one place a failed turn is classified. `usageLimit`, `contextBudget` and
// a call denial are mutually exclusive causes, and the park message, status,
// retire/retry flags, usage-limit probe and log line all follow from which one
// applies — so they are decided together here and the `catch` only acts on the
// result.
//
// Only the home profile autopauses and probes for quota recovery. A temporary
// profile belongs to its wake, which retires on quota exhaustion even when the
// adapter encounters the limit during preparation.
// Local context-budget / known-window-below-request failures are not
// transient either: retrying the same wake only climbs failureCount, so they
// autopause with an actionable reason until the operator raises the window or
// shrinks mind context. Call denials carry their own status and disposition.
function classifyPersistentMindTurnFailure(error, { signal, runStartedAt, profile }) {
  const denied = isPersistentMindCallDenial(error);
  const aborted = signal.aborted;
  const detail = aborted
    ? String(signal.reason || 'Persistent mind turn interrupted')
    : errorMessage(error);
  const nonDeniedFault = !denied && !aborted;
  const usageLimit = nonDeniedFault && isHardProviderUsageLimitError(error);
  const contextBudget = nonDeniedFault && !usageLimit && isContextBudgetFitnessError(error);
  const held = denied && error.retryDisposition === 'hold' && error.requiresResubmission !== true;
  const base = {
    message: detail,
    status: held ? 'paused' : ((denied && error.deniedStatus) || 'interrupted'),
    consumedAttempt: runStartedAt != null,
    retireWake: (denied && error.requiresResubmission === true) || (usageLimit && profile?.temporary === true),
    retryAt: denied && error.retryDisposition === 'reset-wait' ? error.retryAt : null,
    markUsageLimit: usageLimit,
    logMessage: `Persistent mind turn ${denied ? 'refused a further provider call' : 'interrupted'}: ${detail}`,
  };
  if (usageLimit && profile?.ok && !profile.temporary) {
    return {
      ...base,
      message: PROVIDER_USAGE_LIMIT_PAUSE_REASON,
      status: 'paused',
      logMessage: `Persistent mind autopaused on provider usage limit: ${detail}`,
    };
  }
  if (contextBudget) {
    return {
      ...base,
      message: contextBudgetPauseReasonFrom(error),
      status: 'paused',
      logMessage: `Persistent mind autopaused on local context budget: ${detail}`,
    };
  }
  return base;
}

// A turn phase either continues (`ok: true`) or stops the turn: `park` names
// the reason/status/options to park it under, and `aborted` means the turn was
// superseded (pause, stop, restart) while the phase awaited, so the new owner's
// state is left alone.
const parkTurn = (reason, status, opts) => ({ ok: false, park: { reason, status, opts } });
const TURN_ABORTED = Object.freeze({ ok: false, aborted: true });
const parkRefusedProfile = (profile) => parkTurn(profile.error, 'degraded', { retireWake: profile.requiresResubmission === true });

// A message the user explicitly sent with another model resolves its saved
// preset instead of the home profile. Only that one message carries it: the
// next ordinary message and every scheduled wake read the unchanged default,
// because the selection lives on the message rather than in config.
function turnThinkingSelection(wake) {
  const selfThinkingRequest = wake.thinkingRequest || null;
  return {
    selfThinkingRequest,
    thinkingSelection: selfThinkingRequest?.selection || wake.message?.thinkingPreset || null,
    thinkingPresetId: selfThinkingRequest?.selection.id || (wake.kind === 'message'
      ? wake.message.thinkingPresetId || null
      : null),
  };
}

// The turn keeps the ONE global slot, action reservation and endpoint slot it
// was admitted with; the boundary acquires nothing further. What it does is
// re-check — before the summary call, before the turn call, and before every
// tool round — that the route, authorization, lifecycle, grants and remaining
// budget still permit one more provider call, and account each attempt
// (failures included) against the domain ledger.
function openTurnCallBoundary({ mindId, turnId, route, config, signal }) {
  const { prepared, profile, target, thinking } = route;
  return createPersistentMindCallBoundary({
    mindId,
    turnId,
    route: {
      providerId: target.providerId,
      providerType: prepared.provider.type || null,
      model: target.model,
      effort: target.effort,
      thinkingPresetId: thinking.thinkingPresetId,
      thinkingPresetLabel: profile.presetLabel || null,
      temporary: profile.temporary === true,
    },
    thinkingPresetId: thinking.thinkingPresetId,
    // The ACCEPTED preset snapshot the message carries (#6283) — never the
    // mutable preset id, which the user can repoint mid-turn.
    thinkingSelection: thinking.thinkingSelection,
    selfThinkingRequest: thinking.selfThinkingRequest,
    capabilityFingerprint: persistentMindCapabilityGrantFingerprint(config?.persistentMindCapabilities),
    maintainerFingerprint: maintainerCanonicalStringify(normalizePersistentMindMaintainer(config?.persistentMindMaintainer)),
    signal,
  });
}

export function createPersistentMindTurnRunner({
  runtime, getPersistentMindState, mutateMindState, emitMindStatus, cancelWake, scheduleUsageLimitProbe,
}) {
  /**
   * Return a claimed turn to the queue with a visible reason.
   *
   * `consumedAttempt` says the provider span had already opened, so a temporary
   * thinking session must not be replayed automatically. Every refusal decided
   * before that point normally requeues. A revoked or unverified selection is
   * retired too: changing a preset back later must not resurrect refused work.
   */
  async function parkActiveTurn(turnId, reason, status = 'waiting', { retryAt = null, consumedAttempt = false, retireWake = false } = {}) {
    const paused = status === 'paused';
    if (status === 'degraded') {
      console.warn(`⚠️ Persistent mind turn degraded: ${scrubSecretTokens(String(reason)).slice(0, 300)}`);
    }
    const result = await mutateMindState((mind) => {
      if (mind.activeTurn?.id !== turnId) return { mind, value: false };
      // Transport/slot waits may retry; a revoked route or uncertain inference
      // requires a fresh user submission.
      const held = (consumedAttempt || retireWake || Boolean(mind.activeTurn.wake.thinkingRequest)) && persistentMindWakeConsumesAttempt(mind.activeTurn.wake);
      const next = held
        ? holdPersistentMindWake(mind, mind.activeTurn.wake)
        : requeuePersistentMindWake(mind, mind.activeTurn.wake);
      // A hard usage-limit autopause mirrors pausePersistentMind: no backoff gate
      // and no failureCount climb. Auto-recovery probes (not ordinary wakes) clear
      // only this pause reason when the pinned provider is usable again.
      const failureCount = paused ? next.failureCount : next.failureCount + 1;
      return {
        mind: {
          ...next,
          activeTurn: null,
          status,
          pauseReason: reason,
          failureCount,
          lastError: reason,
          nextEligibleWakeAt: paused
            ? null
            : (retryAt || new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString()),
        },
        value: held,
      };
    });
    if (paused) cancelWake();
    await appendMindEvent({
      kind: paused ? 'mind.paused' : 'mind.failed',
      mindId: result.state.mindId,
      turnId,
      eventId: `mind-${paused ? 'paused' : 'failed'}:${turnId}:${status}`,
      data: { status, error: reason, retryAt: paused ? null : retryAt, consumedAttempt: consumedAttempt && result.value === true, requiresResubmission: result.value === true },
    });
    emitMindStatus(result.state);
    return result.state;
  }

  async function claimNextTurn() {
    const result = await mutateMindState((mind, root) => {
      if (runtime.stopping || !isDaemonRunning()) return { mind, value: null };
      if (!mind.enabled || !mind.started || mind.activeTurn || mind.status === 'paused') return { mind, value: null };
      if (root.paused || getDomainMode(root.config, 'cos') !== 'execute') return { mind, value: null };
      const selected = takeNextPersistentMindWake(mind);
      if (!selected.wake) return { mind: selected.state, value: null };
      if (selected.wake.kind === 'self' && selected.state.thinkingRequests.pending) {
        selected.wake = { ...selected.wake, thinkingRequest: selected.state.thinkingRequests.pending };
        selected.state.thinkingRequests = {
          pending: null,
          history: selected.state.thinkingRequests.history.map((entry) => entry.requestId === selected.wake.thinkingRequest.requestId
            ? { ...entry, outcome: 'admitted', admittedAt: nowIso() } : entry),
        };
      }
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
          thinkingPresetId: result.value.wake.thinkingRequest?.selection.id || result.value.wake.message?.thinkingPresetId || null,
          reason: result.value.wake.reason || null,
        },
      });
      emitMindStatus(result.state);
    }
    return result.value;
  }

  async function turnCanContinue(turnId, generation, signal) {
    if (runtime.stopping || !isDaemonRunning() || generation !== runtime.generation || signal.aborted) return false;
    const state = await getPersistentMindState();
    return !runtime.stopping
      && isDaemonRunning()
      && generation === runtime.generation
      && !signal.aborted
      && state.activeTurn?.id === turnId;
  }

  async function recordTurnProfile(turnId, prepared) {
    const result = await mutateMindState((mind) => {
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
        value: true,
      };
    });
    if (result.value) emitMindStatus(result.state);
  }

  async function heartbeat(turnId, generation) {
    if (generation !== runtime.generation) return false;
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
    if (generation !== runtime.generation) return;
    const completedAt = nowIso();
    const updated = await mutateMindState((mind, root) => {
      if (mind.activeTurn?.id !== turnId) return { mind, value: false };
      const messageId = mind.activeTurn.wake.kind === 'message'
        ? mind.activeTurn.wake.message.id
        : null;
      const recentMessageIds = messageId
        ? [...mind.recentMessageIds.filter((id) => id !== messageId), messageId]
          .slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS)
        : mind.recentMessageIds;
      const recentMessageFingerprints = messageId
        ? [...mind.recentMessageFingerprints.filter((entry) => entry.id !== messageId),
            persistentMindMessageReceipt(mind.activeTurn.wake.message),
          ].slice(-PERSISTENT_MIND_LIMITS.MAX_RECENT_MESSAGE_IDS)
        : mind.recentMessageFingerprints;
      const quietPeriodMs = persistentMindWakeIntervalMs(root.config?.persistentMindProfile);
      const quietDeadline = Date.parse(completedAt) + quietPeriodMs;
      const requestedAt = Date.parse(result?.selfWake?.notBefore);
      const requestedWake = result?.selfWake && typeof result.selfWake === 'object'
        ? {
            id: `wake-${randomUUID()}`,
            kind: 'self',
            scheduleKind: 'requested',
            reason: String(result.selfWake.reason || 'turn requested follow-up')
              .slice(0, PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS),
            sourceTurnId: turnId,
            createdAt: completedAt,
            // A turn may request an earlier follow-up, but the saved cadence is
            // the operator's maximum quiet period and therefore caps later asks.
            notBefore: new Date(Math.min(
              quietDeadline,
              Number.isFinite(requestedAt) ? Math.max(Date.parse(completedAt), requestedAt) : Date.parse(completedAt),
            )).toISOString(),
          }
        : quietSelfWake(turnId, quietPeriodMs, Date.parse(completedAt));
      const hasQueuedMessages = mind.queuedMessages.length > 0;
      return {
        mind: {
          ...mind,
          activeTurn: null,
          recentMessageIds,
          recentMessageFingerprints,
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
        thinkingPresetId: result?.thinkingPresetId || null,
        summaryText: typeof result?.summary === 'string' ? result.summary : null,
      },
    });
    emitMindStatus(updated.state);
  }

  // Admission refusals have no active turn to park. Waiting preserves the last
  // error; only degraded admission records a new error, and only a failed budget
  // lookup increments the failure count.
  async function deferUnclaimedWake({ status, reason, backoffMs, bumpFailure = false, requireStarted = false }) {
    const updated = await mutateMindState((mind) => {
      if (requireStarted && !(mind.enabled && mind.started)) return { mind };
      const failureCount = mind.failureCount + Number(bumpFailure);
      return {
        mind: {
          ...mind,
          status,
          pauseReason: reason,
          lastError: status === 'degraded' ? reason : mind.lastError,
          failureCount,
          nextEligibleWakeAt: new Date(Date.now() + (backoffMs ?? persistentMindBackoffMs(failureCount))).toISOString(),
        },
      };
    });
    emitMindStatus(updated.state);
  }

  async function runOnePersistentMindTurn() {
    const permit = maintenance.tryAdmit('mind-turn', 'persistent-mind');
    if (!permit) return;
    try { return await permit.run(runAdmittedPersistentMindTurn); }
    catch (err) { permit.markUnsettled(); throw err; }
    finally { await permit.finish(); }
  }

  async function runAdmittedPersistentMindTurn() {
    if (runtime.stopping || !isDaemonRunning()) return;
    if (!runtime.adapter) {
      return deferUnclaimedWake({
        status: 'degraded',
        reason: 'Persistent mind provider is not configured',
        backoffMs: PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS,
        requireStarted: true,
      });
    }

    const root = await loadState();
    const mind = normalizePersistentMindState(root.persistentMind);
    if (runtime.stopping || !isDaemonRunning()) return;
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
      return deferUnclaimedWake({
        status: 'waiting',
        reason: globalSlot.reason,
        backoffMs: PERSISTENT_MIND_LIMITS.BACKOFF_BASE_MS,
      });
    }

    let actionReservation = null;
    try {
      let budget;
      try {
        budget = await getDomainBudgetStatus('cos');
      } catch (error) {
        const message = `Persistent mind budget check failed: ${errorMessage(error)}`;
        return await deferUnclaimedWake({ status: 'degraded', reason: message, bumpFailure: true });
      }
      if (!budget.withinBudget) {
        return await deferUnclaimedWake({
          status: 'waiting',
          reason: `CoS ${budget.exceeded || 'daily'} budget exhausted`,
          backoffMs: PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS,
        });
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
        return await deferUnclaimedWake({
          status: 'waiting',
          reason: actionReservation.reason,
          backoffMs: PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS,
        });
      }

      const turn = await claimNextTurn();
      if (!turn) return;

      await runClaimedPersistentMindTurn(turn, mind, globalSlot);
    } finally {
      actionReservation?.release?.();
      globalSlot.release();
    }
  }

  async function settleStoppedTurn(turnId, outcome) {
    if (outcome.park) await parkActiveTurn(turnId, outcome.park.reason, outcome.park.status, outcome.park.opts);
  }

  // The route is resolved before an adapter can run. This is a read-only
  // catalog/status check: no alternate provider, model pull, or generation is
  // allowed while deciding whether the pinned mind can wake. A preset that has
  // since been removed, retired, or narrowed is a refusal — never a silent
  // return to the default route.
  async function resolveTurnRoute({ turn, thinking, profile, signal, alive }) {
    if (!profile.ok) return parkRefusedProfile(profile);
    // Adapters receive the exact profile. They may prepare their text
    // transport, but cannot substitute a fallback provider/model/effort.
    const adapterPrepared = await runtime.adapter.prepare({ wake: turn.wake, signal, profile });
    if (!await alive()) return TURN_ABORTED;
    if (!adapterPrepared?.ok || !adapterPrepared.provider) {
      const prepareError = adapterPrepared?.error || 'Persistent mind provider is unavailable';
      if (isContextBudgetFitnessError(prepareError)) return parkTurn(contextBudgetPauseReasonFrom(prepareError), 'paused');
      return parkTurn(prepareError, 'degraded', { retryAt: adapterPrepared?.retryAt || null });
    }
    // Existing adapters only named their transport provider; missing model or
    // effort now means "use the supplied profile", while an explicit value
    // still must match exactly and cannot become a fallback route.
    const prepared = {
      ...adapterPrepared,
      model: adapterPrepared.model ?? profile.model,
      effort: adapterPrepared.effort ?? profile.effort,
    };
    if (prepared.provider.id !== profile.provider.id
        || prepared.model !== profile.model
        || prepared.effort !== profile.effort) {
      return parkTurn('Persistent mind adapter did not honor the pinned provider profile', 'degraded');
    }
    return {
      ok: true,
      thinking,
      profile,
      prepared,
      target: { providerId: prepared.provider.id, model: prepared.model || null, effort: prepared.effort || null },
    };
  }

  // Admission owns the global/action reservations until the claimed turn's
  // provider work, error handling, and endpoint cleanup have all settled — with
  // one exception: once a LOCAL-model turn has secured its endpoint-scoped slot,
  // the generic global slot is released early. A local turn can run for
  // minutes, far longer than the spawn-setup window the global cap models, and
  // `acquireLocalEndpointProviderSlot` already serializes the real GPU
  // contention on its own. Holding the global slot for the whole generation
  // would otherwise starve unrelated cloud/CLI/TUI agent spawns (e.g. agy,
  // gemini) that never touch this endpoint but share the same
  // `maxConcurrentAgents` budget.
  //
  // `holdSlot` hands the endpoint slot's release to the driver the moment it is
  // acquired, so a later stop or throw in this phase still frees it.
  async function admitTurn({ turn, route, globalSlot, alive, holdSlot }) {
    const { prepared, thinking } = route;
    const images = turn.wake.message?.images;
    if (turn.wake.kind === 'message' && Array.isArray(images) && images.length > 0) {
      const imageCapability = await resolvePersistentMindImageCapability({
        provider: prepared.provider,
        model: prepared.model,
      });
      if (!imageCapabilityAllowsAttempt(imageCapability, prepared.provider)) return parkTurn(imageCapability.reason, 'degraded');
    }
    await recordTurnProfile(turn.id, prepared);
    if (!await alive()) return TURN_ABORTED;

    const slot = await acquireLocalEndpointProviderSlot(prepared.provider, (await loadState()).agents, turn.id);
    if (!slot.ok) return parkTurn(slot.reason, 'waiting');
    holdSlot(slot.release);
    // Idempotent: the admitting `finally` still releases the global slot once
    // the turn settles.
    if (localEndpointOfProvider(prepared.provider)) globalSlot?.release();
    if (!await alive()) return TURN_ABORTED;
    // Preparation and slot admission may wait. A preset revoked during those
    // waits must be refused before even a context-summary call can begin.
    const config = (await loadState()).config;
    if (thinking.thinkingPresetId) {
      const admissionProfile = await resolveTurnProfile({ ...thinking, config });
      if (!await alive()) return TURN_ABORTED;
      if (!admissionProfile.ok) return parkRefusedProfile(admissionProfile);
    }
    return { ok: true, config };
  }

  async function runAdmittedTurn({ turn, mindId, route, callBoundary, generation, signal, alive }) {
    const { prepared, target } = route;
    const { thinkingPresetId } = route.thinking;
    // Every provider call this turn makes — summary, journal, turn — carries
    // the same pinned route and per-call boundary.
    const providerCall = () => ({
      provider: prepared.provider,
      model: target.model,
      effort: target.effort,
      signal,
      heartbeat: () => heartbeat(turn.id, generation),
      callBoundary: trackInFlightCall(turn.id, prepared.provider, target.model, callBoundary.call),
    });
    // Context/memory orchestration is only needed once admission succeeds.
    const { preparePersistentMindContext, readPersistentMindReflection, recordPersistentMindRecallAccess } = await import('./persistentMindContext.js');
    const reflection = await readPersistentMindReflection({ enabled: normalizePersistentMindCapabilities((await loadState()).config?.persistentMindCapabilities).manageMind });
    const context = await preparePersistentMindContext({
      mindId,
      identity: prepared.identity ?? runtime.adapter.identity ?? 'One supervised persistent Chief of Staff mind.',
      instructions: prepared.instructions || '',
      memories: Array.isArray(prepared.memories) ? prepared.memories : [],
      memoryRecall: prepared.memoryRecall,
      reflection,
      // A local window's adapter bounds the recalled context so the wake
      // prompt leaves room for its tool rounds; absent means the default cap.
      ...(Number.isInteger(prepared.contextMaxChars) && prepared.contextMaxChars > 0 ? { maxChars: prepared.contextMaxChars } : {}),
      providerId: target.providerId,
      model: target.model,
      summarize: typeof runtime.adapter.summarize === 'function'
        ? (input) => runtime.adapter.summarize({ ...input, ...providerCall() })
        : null,
      // The journal introduces no second provider path.
      extractJournal: typeof runtime.adapter.extractJournal === 'function'
        ? (input) => runtime.adapter.extractJournal({ ...input, ...providerCall() })
        : null,
    });
    if (!await alive()) return;
    await appendMindEvent({
      kind: 'mind.model.request',
      mindId,
      turnId: turn.id,
      eventId: `mind-model-request:${turn.id}`,
      data: {
        ...target,
        thinkingPresetId,
        contextChars: context.chars,
        contextSummaryState: context.summaryState,
        memoryReflectionState: context.reflection?.state || 'disabled',
        memoryRecallState: context.memoryRecall?.state || 'none',
        memoryRecallIds: context.memoryRecall?.includedIds || [],
        memoryRecallOmittedIds: context.memoryRecall?.omittedIds || [],
      },
    });
    if (!await alive()) return;

    const result = await runtime.adapter.run({
      turnId: turn.id,
      wake: turn.wake,
      ...providerCall(),
      context,
      recordCapabilityEvent: ({ kind, id, data } = {}) => {
        const eventKind = kind === 'result' ? 'mind.capability.result' : 'mind.capability.request';
        const capabilityId = typeof id === 'string' && id ? id : randomUUID();
        return appendMindEvent({
          kind: eventKind,
          mindId,
          turnId: turn.id,
          eventId: `mind-capability:${turn.id}:${capabilityId}:${kind === 'result' ? 'result' : 'request'}`,
          data: { capabilityId, ...(data && typeof data === 'object' ? data : {}) },
        });
      },
    });
    await recordPersistentMindRecallAccess(context.memoryRecall?.includedIds);
    for (const event of Array.isArray(result?.events) ? result.events : []) {
      await appendMindEvent({
        kind: event.kind,
        mindId,
        turnId: turn.id,
        eventId: `mind-${event.id}`,
        data: event.data,
      });
    }
    await appendMindEvent({
      kind: 'mind.model.result',
      mindId,
      turnId: turn.id,
      eventId: `mind-model-result:${turn.id}`,
      data: {
        ...target,
        thinkingPresetId,
        summaryText: typeof result?.summary === 'string' ? result.summary : null,
        responseChars: typeof result?.output === 'string' ? result.output.length : null,
        success: true,
      },
    });
    await completeTurn(turn.id, { ...result, ...target, thinkingPresetId }, generation);
  }

  // Each phase re-checks `alive()` after every wait that precedes its next step,
  // so a turn paused, stopped or restarted mid-phase never starts that step; the
  // adapter run itself is cancelled through `controller.signal`.
  async function runClaimedPersistentMindTurn(turn, mind, globalSlot) {
    const generation = runtime.generation;
    const controller = new AbortController();
    runtime.controller = controller;
    const alive = () => turnCanContinue(turn.id, generation, controller.signal);
    let release = () => {};
    let runStartedAt = null;
    let callBoundary = null;
    let profile = null;
    try {
      const thinking = turnThinkingSelection(turn.wake);
      profile = await resolveTurnProfile({ ...thinking, config: (await loadState()).config });
      const route = await resolveTurnRoute({ turn, thinking, profile, signal: controller.signal, alive });
      if (!route.ok) return await settleStoppedTurn(turn.id, route);
      const admission = await admitTurn({ turn, route, globalSlot, alive, holdSlot: (fn) => { release = fn; } });
      if (!admission.ok) return await settleStoppedTurn(turn.id, admission);
      // The span opens BEFORE context preparation, so a local adapter cannot
      // bypass endpoint capacity merely because its first inference happens
      // while context is assembled.
      runStartedAt = Date.now();
      callBoundary = openTurnCallBoundary({
        mindId: mind.mindId, turnId: turn.id, route, config: admission.config, signal: controller.signal,
      });
      await runAdmittedTurn({
        turn, mindId: mind.mindId, route, callBoundary, generation, signal: controller.signal, alive,
      });
    } catch (error) {
      if (generation === runtime.generation) {
        const failure = classifyPersistentMindTurnFailure(error, { signal: controller.signal, runStartedAt, profile });
        await parkActiveTurn(turn.id, failure.message, failure.status, {
          consumedAttempt: failure.consumedAttempt,
          retireWake: failure.retireWake,
          retryAt: failure.retryAt,
        });
        if (failure.markUsageLimit) {
          const providerId = profile?.provider?.id;
          if (typeof providerId === 'string' && providerId) {
            await markProviderUsageLimit(providerId, { message: errorMessage(error) }).catch((markError) => {
              console.error(`❌ Failed to mark provider usage limit for mind probe: ${markError.message}`);
            });
          }
          if (failure.status === 'paused') scheduleUsageLimitProbe(0);
        }
        emitLog('warn', failure.logMessage, { turnId: turn.id });
      }
    } finally {
      release();
      // The boundary accounts every provider call it admitted, so the turn adds
      // nothing on top — that would double-count the span it already recorded.
      // A turn that opened the span and never reached a provider still costs one
      // action, or a turn that always aborts just before its first call would
      // retry against the budget for free.
      if (runStartedAt != null && (callBoundary?.accountedCalls() ?? 0) === 0) {
        await recordDomainUsage('cos', { actions: 1, ms: Date.now() - runStartedAt }).catch((error) => {
          console.error(`❌ Failed to record persistent mind usage: ${error.message}`);
        });
      }
    }
  }

  async function interruptActiveTurn(reason, status, { retry = false, expectedTurnId = null } = {}) {
    const result = await mutateMindState((mind) => {
      if (expectedTurnId && mind.activeTurn?.id !== expectedTurnId) {
        return { mind, value: false };
      }
      const interrupted = Boolean(mind.activeTurn);
      let next = mind;
      if (mind.activeTurn) next = releaseClaimedWake(next, mind.activeTurn.wake);
      const failureCount = retry ? next.failureCount + 1 : next.failureCount;
      return {
        mind: {
          ...next,
          activeTurn: null,
          status,
          pauseReason: reason,
          failureCount,
          // A pause or global hold is not a wake failure: keep the real last
          // error (OOM kill, canceled run, ...) visible next to the pause reason.
          lastError: status === 'paused' || status === 'waiting' ? next.lastError : reason,
          nextEligibleWakeAt: retry
            ? new Date(Date.now() + persistentMindBackoffMs(failureCount)).toISOString()
            : null,
        },
        value: { interrupted, turnId: mind.activeTurn?.id || null, mindId: mind.mindId },
      };
    });
    if (result.value?.interrupted) {
      runtime.generation += 1;
      runtime.controller?.abort(reason);
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

  return { interruptActiveTurn, runOnePersistentMindTurn };
}
