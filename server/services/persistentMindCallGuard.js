/**
 * The per-call boundary every persistent-mind provider call passes through.
 *
 * The supervisor admits a TURN: one global slot, one action reservation, one
 * local-endpoint slot, one budget check. But a turn is not one provider call —
 * the optional context summary is one, the turn itself is another, and each
 * tool round after it is another again. Checking admission once and accounting
 * one action for that whole span meant a mind could keep spending after the
 * budget was exhausted, after its preset was revoked, or after the user stopped
 * it, and the ledger only ever heard about it once.
 *
 * So this module re-checks the things that can change WHILE a turn runs — the
 * live exact route, provider availability/authorization, mind lifecycle,
 * capability grants, remaining budget — immediately before each call, and
 * accounts every attempt that actually started, failures included.
 *
 * It deliberately acquires NOTHING. The turn already holds the global slot, the
 * action reservation, and the endpoint slot; taking nested ones here would
 * deadlock a turn against its own admission. This boundary only ever refuses.
 */

import { getDomainMode } from '../lib/domainAutonomy.js';
import { canonicalStringify } from '../lib/objects.js';
import { normalizePersistentMindState } from '../lib/persistentMind.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { buildPersistentMindCallDenial, buildPersistentMindCallReceipt } from '../lib/persistentMindTrajectory.js';
import { loadState } from './cosState.js';
import { appendMindEvent } from './agentRunEventLog.js';
import { getDomainBudgetStatus, recordDomainUsage } from './domainUsage.js';
import { resolvePersistentMindProfile, resolvePersistentMindThinkingSession } from './persistentMindProfile.js';

/** Mind status a denial should park the turn under, by cause. */
const DENIAL_STATUS = Object.freeze({
  interrupted: 'interrupted',
  budget: 'waiting',
  authorization: 'degraded',
});

const denial = (reason, status, extra = {}) => ({ ok: false, reason, status, ...extra });

/**
 * The comparable fingerprint of the mind's capability grants.
 *
 * Any change — widening or narrowing — ends the turn's remaining calls. The
 * turn's prompt, its tool catalog, and its already-executed rounds were all
 * built against the snapshot, so continuing on a different grant set would run
 * the second half of a turn under authority the first half never described.
 */
export function persistentMindCapabilityGrantFingerprint(rawCapabilities) {
  return canonicalStringify(normalizePersistentMindCapabilities(rawCapabilities)) ?? '';
}

/**
 * Decide whether one more provider call may start on this turn.
 *
 * Ordered cheapest-and-most-decisive first: an aborted turn or a stopped mind
 * short-circuits before any provider registry or budget read.
 *
 * @param {object} input
 * @param {string} input.turnId - the turn that must still be the active one
 * @param {object} input.route - { providerId, model, effort } pinned at admission
 * @param {string} [input.thinkingPresetId] - set for a temporary thinking session
 * @param {object} [input.thinkingSelection] - the ACCEPTED preset snapshot (#6283);
 *   never re-derived from the mutable preset id
 * @param {string} [input.capabilityFingerprint] - snapshot from turn admission
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ok: boolean, reason?: string, status?: string, requiresResubmission?: boolean}>}
 */
export async function evaluatePersistentMindCallAdmission({
  turnId,
  route,
  thinkingPresetId = null,
  thinkingSelection = null,
  capabilityFingerprint = null,
  signal,
} = {}) {
  if (signal?.aborted) {
    return denial(String(signal.reason || 'Persistent mind turn interrupted'), DENIAL_STATUS.interrupted);
  }

  const root = await loadState();
  if (root?.paused) return denial('PortOS autonomy was paused during the turn', DENIAL_STATUS.interrupted);
  if (getDomainMode(root?.config, 'cos') !== 'execute') {
    return denial('CoS autonomy left execute mode during the turn', DENIAL_STATUS.interrupted);
  }

  const mind = normalizePersistentMindState(root?.persistentMind);
  if (!mind.enabled || !mind.started) return denial('Persistent mind was stopped during the turn', DENIAL_STATUS.interrupted);
  if (mind.status === 'paused') return denial('Persistent mind was paused during the turn', DENIAL_STATUS.interrupted);
  if (mind.activeTurn?.id !== turnId) return denial('Persistent mind turn is no longer the active turn', DENIAL_STATUS.interrupted);

  if (capabilityFingerprint !== null
      && persistentMindCapabilityGrantFingerprint(root?.config?.persistentMindCapabilities) !== capabilityFingerprint) {
    return denial('Persistent mind capability grants changed during the turn', DENIAL_STATUS.authorization);
  }

  // Provider availability/authorization and preset lifecycle both resolve here:
  // the same exact-or-refuse resolvers the supervisor admitted the turn with.
  const resolved = thinkingPresetId
    ? await resolvePersistentMindThinkingSession({ presetId: thinkingPresetId, selection: thinkingSelection, config: root?.config })
    : await resolvePersistentMindProfile(root?.config?.persistentMindProfile);
  if (!resolved.ok) {
    return denial(resolved.error, DENIAL_STATUS.authorization, { requiresResubmission: resolved.requiresResubmission === true });
  }
  if ((resolved.provider?.id || null) !== (route?.providerId || null)
      || (resolved.model || null) !== (route?.model || null)
      || (resolved.effort || null) !== (route?.effort || null)) {
    return denial('Persistent mind route changed during the turn', DENIAL_STATUS.authorization);
  }

  // Fail closed: an unreadable ledger must not read as unlimited budget.
  let budget;
  try {
    budget = await getDomainBudgetStatus('cos');
  } catch (error) {
    return denial(`Persistent mind budget check failed: ${error?.message || 'unknown error'}`, DENIAL_STATUS.budget);
  }
  if (!budget.withinBudget) {
    return denial(`CoS ${budget.exceeded || 'daily'} budget exhausted`, DENIAL_STATUS.budget);
  }

  return { ok: true };
}

/**
 * Build the per-turn boundary the supervisor hands to the adapter.
 *
 * `call({ purpose, round }, run)` re-checks admission, runs `run`, times it,
 * accounts it against the domain ledger, and writes one bounded receipt to the
 * trajectory — for completed, failed, interrupted AND denied attempts. `run`
 * receives `{ reportRunId }` so the receipt names the concrete provider run id
 * even when the call throws before returning one.
 *
 * @returns {{call: Function, accountedCalls: () => number}}
 */
export function createPersistentMindCallBoundary({
  mindId,
  turnId,
  route,
  thinkingPresetId = null,
  thinkingSelection = null,
  capabilityFingerprint = null,
  signal,
  now = () => Date.now(),
  evaluate = evaluatePersistentMindCallAdmission,
  appendEvent = appendMindEvent,
  recordUsage = recordDomainUsage,
} = {}) {
  let receiptIndex = 0;
  let accountedCalls = 0;

  const writeReceipt = async (fields) => {
    const index = receiptIndex;
    receiptIndex += 1;
    const receipt = buildPersistentMindCallReceipt({ turnId, route, ...fields });
    await appendEvent({
      kind: 'mind.model.call',
      mindId,
      turnId,
      eventId: `mind-model-call:${turnId}:${index}`,
      data: receipt,
    });
    return receipt;
  };

  const account = async (elapsedMs) => {
    accountedCalls += 1;
    await recordUsage('cos', { actions: 1, ms: elapsedMs }).catch((error) => {
      console.error(`❌ Failed to record persistent mind call usage: ${error.message}`);
    });
  };

  const call = async ({ purpose, round = null } = {}, run) => {
    const admission = await evaluate({ turnId, route, thinkingPresetId, thinkingSelection, capabilityFingerprint, signal });
    if (!admission.ok) {
      await writeReceipt({ purpose, round, outcome: 'denied', reason: admission.reason });
      throw buildPersistentMindCallDenial(admission);
    }
    let runId = null;
    const reportRunId = (id) => { if (typeof id === 'string' && id) runId = id; };
    const startedAt = now();
    try {
      const result = await run({ reportRunId });
      const elapsedMs = Math.max(0, now() - startedAt);
      reportRunId(result?.runId);
      await account(elapsedMs);
      await writeReceipt({ purpose, round, runId, elapsedMs, outcome: 'completed', usage: result?.usage });
      return result;
    } catch (error) {
      const elapsedMs = Math.max(0, now() - startedAt);
      // The attempt reached the provider, so it is accounted even though it
      // produced nothing — an uncertain spend is still a spend, and never a
      // reason to silently retry.
      await account(elapsedMs);
      await writeReceipt({
        purpose,
        round,
        runId,
        elapsedMs,
        outcome: signal?.aborted ? 'interrupted' : 'failed',
        reason: error?.message,
      });
      throw error;
    }
  };

  return { call, accountedCalls: () => accountedCalls };
}
