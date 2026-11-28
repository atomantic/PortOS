/** Programmatic on-demand request dispatch and empty-result handling, including preflight, parking and escalation. */

import { isManualOnDemandRequest } from '../../lib/quotaBurnOrigin.js';
import { ABUSE_GUARD_PAGE_BREADCRUMB } from '../../lib/navManifest.js';
import { isImprovementEnabled } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { getAppById } from '../apps.js';
import { isProgrammaticScheduledTaskType } from '../taskScheduleRegistry.js';
import { finishPreflightCard, recordPreflightOutcome } from '../preflightTaskCard.js';
import { checkGhHealth } from '../github.js';

/**
 * Drain the on-demand requests for PROGRAMMATIC scheduled task types
 * (`services/scheduledHandlers/`) — the ones PortOS performs ITSELF.
 *
 * They never become a CoS task and never spawn an agent, so they are drained
 * ahead of (and outside) the slot-bounded loops in the two on-demand engines:
 * queueing a describe/render batch behind agent capacity it does not use would
 * leave a user's explicit "Run Now" sitting until an unrelated agent finished.
 *
 * Both engines call this once per cycle and then skip the ids it returns in
 * their own loop, so a request drained here is handled exactly once whichever
 * engine gets there first (the request is cleared before the handler runs).
 * Returning the ids rather than re-testing the task type keeps the engines from
 * importing the handler registry statically — see server/AGENTS.md's import
 * scoping rule — and covers requests the drain cleared WITHOUT running (the
 * type was disabled, or Improve is off), which must not fall through either.
 *
 * `force: true` — a manual Run is explicit consent for THIS work, so the run
 * ignores the shared in-flight cooldown that stops the burn rotation re-picking
 * rows whose render hasn't landed yet. `context` is deliberately omitted: with
 * no probe to reuse, `run` does its own scan, which is the contract's
 * `context: undefined` path.
 *
 * Returns the ids of the requests it took responsibility for. Never throws —
 * `runScheduledHandler` converts a handler throw into a non-dispatch, and this
 * runs outside the request lifecycle.
 */
export async function drainProgrammaticOnDemandRequests({ taskScheduleMod, requests, schedule, state }) {
  const handled = new Set();
  const pending = (requests || []).filter((request) => isProgrammaticScheduledTaskType(request.taskType));
  if (pending.length === 0) return handled;

  const { runScheduledHandler } = await import('../scheduledHandlers/index.js');
  for (const request of pending) {
    const taskConfig = schedule?.tasks?.[request.taskType];
    handled.add(request.id);
    if (request.taskType !== 'development-watchdog' && !isImprovementEnabled(state)) {
      emitLog('warn', `On-demand request dropped — improvement is disabled (Config → Improve)`, { requestId: request.id, taskType: request.taskType });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }
    // Match the agent drain: manual runs bypass cadence, never task removal.
    if (!taskConfig || (!isManualOnDemandRequest(request) && !taskConfig.enabled)) {
      emitLog('info', `On-demand request skipped — task type '${request.taskType}' is disabled`, { requestId: request.id });
      await taskScheduleMod.clearOnDemandRequest(request.id);
      continue;
    }

    // CLAIM the request, and only run if this drain is the one that took it.
    // The two engines are independent and each drains its own snapshot, so both
    // can hold the same request; `clearOnDemandRequest` is a serialized
    // read-modify-write that returns the record only to the caller that removed
    // it, and returns null to the loser. Without this check one "Run Now" would
    // spend two describe/render batches and toast twice. Agent preparation
    // takes the same claim before any preflight work; task-store deduplication
    // alone happens too late to protect either lane's preparation.
    const claimed = await taskScheduleMod.clearOnDemandRequest(request.id);
    if (!claimed) continue;

    await taskScheduleMod.recordExecution(`task:${request.taskType}`);
    const outcome = await runScheduledHandler({
      taskType: request.taskType,
      params: taskConfig.taskMetadata || {},
      job: { model: taskConfig.model || null, effort: taskConfig.effort || null, providerId: taskConfig.providerId || null },
      force: true,
    });

    emitLog(outcome?.dispatched ? 'info' : 'debug',
      `${request.taskType}: ${outcome?.summary || outcome?.reason || 'nothing to do'}`,
      { requestId: request.id });
    // The client toasts this so an explicit Run isn't a silent no-op. Separate
    // from `schedule:on-demand-empty`: that channel means "no agent task was
    // produced", while this one reports work PortOS already finished.
    cosEvents.emit('schedule:on-demand-handled', {
      requestId: request.id,
      taskType: request.taskType,
      dispatched: outcome?.dispatched === true,
      summary: outcome?.summary || null,
      reason: outcome?.reason || null,
    });
  }
  return handled;
}

/**
 * Surface WHY a user-initiated on-demand "Run" produced no task, so the trigger
 * isn't a silent no-op the user only discovers in the pm2 logs. Emits
 * `schedule:on-demand-empty` (which the client toasts) with an `outcome`:
 *   - 'parked'    → a detector-driven task re-checked and found no actionable work;
 *                   carries the reason + open/in-flight/filtered breakdown.
 *   - 'transient' → a detector-driven task that did NOT park — a gh/glab probe
 *                   failure — so the check didn't actually complete. Carries a
 *                   `forge` block naming the real fault when the CLI is broken
 *                   in a way that will NOT clear on its own.
 *   - 'idle'      → a non-perpetual task produced no task: a genuine "nothing to
 *                   do", NOT a failure (e.g. pr-watcher with no new PRs).
 *
 * Called from the shared on-demand drain (onDemandDrain.js), which both
 * Priority-0 engines delegate to, so a user Run gets the same feedback no matter
 * which one drains the request. `taskConfig` is the already-loaded interval for the task,
 * passed in to avoid re-reading the schedule. The event fires ONLY on the
 * user-initiated on-demand path, so the client can toast it without
 * background-park noise.
 *
 * `skip` is the `skip` field of the prepareManagedAppImprovementTask result
 * that produced no task (null when the caller had none, e.g. a global task): it
 * carries pr-reviewer's preflight reason and the transient detector verdict
 * (`cli` / `remedy`) that the outcome classification below explains.
 */
export async function emitOnDemandEmpty({ taskScheduleMod, request, targetApp, taskConfig, preflightCardId = null, skip = null }) {
  const appId = targetApp?.id || null;
  const parkInfo = await taskScheduleMod.getPerpetualParkInfo(request.taskType, appId).catch(() => null);
  const isDetectorDriven = taskConfig?.perpetual === true || request.taskType === 'branch-reconcile';
  const outcome = skip?.gate === 'reviewer-identity'
    ? 'transient'
    : parkInfo ? 'parked' : (isDetectorDriven ? 'transient' : 'idle');

  // Layered Intelligence skips (e.g. a provider that can't drive an agent) record
  // an actionable last-run reason. Surface it so a manual "Run" toasts WHY it
  // produced nothing (e.g. "pick a CLI/TUI provider") instead of a misleading
  // generic "nothing to do". Read the freshest record — the skip's recordRun
  // landed after `targetApp` was loaded. Best-effort; a read failure just omits it.
  let reason = null;
  if (skip?.gate === 'reviewer-identity') reason = skip.reason;
  if (outcome === 'idle' && appId && request.taskType === 'layered-intelligence') {
    const app = await getAppById(appId).catch(() => null);
    reason = app?.layeredIntelligence?.lastRunReason || null;
  }
  if (outcome === 'idle' && request.taskType === 'pr-reviewer') {
    reason = skip?.gate === 'security-preflight' ? skip.reason : null;
  }
  // error-log-triage never produces an agent task of its own — its pass IS the
  // run — so toast what that pass did instead of "nothing to do".
  if (outcome === 'idle' && request.taskType === 'error-log-triage') {
    const { readLastTriageSummary } = await import('../errorLogTriage.js');
    reason = await readLastTriageSummary().catch(() => null);
  }

  // 'transient' says "the forge probe failed, try again shortly" — only true when
  // the forge is momentarily flaky. A gh that is missing, unauthenticated, or
  // blocked by an outbound firewall fails EVERY tick forever, so that advice sends
  // the user in circles. Ask the CLI the detector actually ran (recorded by the
  // work gate on `skip` — the task-type NAME can't answer this: `claim-work`
  // resolves its forge internally, and branch-reconcile goes transient over
  // git/provider faults with no forge involved) whether it is broken in a
  // way that won't self-clear, and pass the remedy through. No verdict, an
  // unprobeable CLI, or a healthy one all leave `forge` null and keep the
  // generic copy — the failure really was a blip, or at least not one we can name.
  let forge = skip?.gate === 'reviewer-identity'
    ? { cli: 'reviewer identity', remedy: skip.reason }
    : null;
  const verdict = outcome === 'transient' && skip?.gate === 'perpetual-work' ? skip : null;
  if (verdict?.remedy) {
    // The detector already knew the fault AND the way out — a per-repo permission
    // the token lacks (e.g. the collaborators/members list behind the "Me +
    // collaborators" author gate). checkGhHealth can't see that: it probes global
    // auth, which such a token passes, so asking it here would drop the remedy and
    // fall back to "try again shortly" — the exact dead end this channel exists to
    // avoid.
    forge = { cli: verdict.cli, remedy: verdict.remedy };
  } else if (verdict?.cli === 'gh') {
    const health = await checkGhHealth().catch(() => null);
    if (health && !health.ok && health.remedy) forge = { cli: 'gh', remedy: health.remedy };
  }

  // Close the run's card — or, for an automated run that never opened one, mint
  // it in its terminal state. A preflight has no agent lifecycle, but an
  // explicit failure still needs a durable record: terminal status prevents
  // either spawn engine from running this diagnostic as a task, and a retry has
  // to enter through the security scan again. The PR row paints from the
  // `preflightFailure` + `note` this stamps.
  const securityFailure = request.taskType === 'pr-reviewer' && appId
    && reason?.startsWith('security-') && reason !== 'security-scan-report-pending';
  if (securityFailure) {
    // Minted when absent: an automated cadence run reaches the same failure with
    // no card to close, and it needs the record just as much.
    await recordPreflightOutcome({
      requestId: request.id,
      taskType: request.taskType,
      appId,
      appName: targetApp?.name || null,
      targetPullRequest: request.targetPullRequest ?? null,
      outcome: 'failed',
      reason,
      note: `PR review stopped before an agent started (${reason}). No PR actions were taken. `
        + (reason.startsWith('security-guard-')
          ? `Open ${ABUSE_GUARD_PAGE_BREADCRUMB}, check its setup and repair it if needed, then retry PR review. The classifier did not return a usable safety verdict; this is not a finding against the PR.`
          : 'Check the repository connection and security scan configuration, then retry PR review.'),
    });
  } else {
    // An ordinary empty outcome — parked, transient, plain nothing to do. Only
    // ever closes a card that already exists: minting one for an automated run
    // nobody is watching would fill the Tasks page with cadence noise.
    await finishPreflightCard(preflightCardId, {
      outcome: 'nothing-to-do',
      reason: reason || parkInfo?.parkReason || outcome,
    });
  }

  // A park is a drain brake, not a promise of another automatic run. Read the
  // actual eligibility, including per-app cadence/enablement and manual-only
  // drains, rather than interpreting the stored park deadline as a schedule.
  const readiness = parkInfo
    ? await taskScheduleMod.shouldRunTask(request.taskType, appId).catch(() => null)
    : null;
  const nextAutoRecheckAt = readiness?.nextRunAt || (readiness?.shouldRun ? new Date().toISOString() : null);

  cosEvents.emit('schedule:on-demand-empty', {
    requestId: request.id,
    taskType: request.taskType,
    appId,
    appName: targetApp?.name || null,
    outcome,
    reason,
    forge,
    parkReason: parkInfo?.parkReason || null,
    parkedUntil: parkInfo?.parkedUntil || null,
    nextAutoRecheckAt,
    actionableCount: parkInfo?.parkActionableCount ?? null,
    counts: parkInfo?.parkCounts || null,
    skipCauses: parkInfo?.parkSkipCauses || null
  });
}
