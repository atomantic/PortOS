/** Perpetual improvement drain policy: compare work signatures, record admitted dispatches and bound transient probes. */

import { emitLog } from './cosEvents.js';
import { isReconcileDrainTaskType } from '../taskScheduleConstants.js';
import { detectActionableWork } from '../perpetualWork.js';

/**
 * A claim/plan perpetual drain must stop when a completed agent leaves the
 * complete actionable set unchanged. A null signature means the detector has
 * no progress identity and keeps the legacy behavior; an empty signature is a
 * valid idle result but never reaches this predicate because `actionable` is
 * false.
 */
export function shouldParkUnchangedPerpetualWork(detection, lastSignature, dispatchCount = 0) {
  return detection?.actionable === true
    && detection.signature != null
    && lastSignature != null
    && detection.signature === lastSignature
    // A same-issue continuation is allowed one unchanged recheck: the prior
    // claim may have shipped a partial slice while leaving the issue actionable.
    // A second unchanged observation is a genuine no-progress loop.
    && dispatchCount > 1;
}

// The generator can be called before either spawn engine admits its result, so
// the drain signature travels as a plain data record returned alongside the
// task (`pendingPerpetualDispatch`, see `prepareManagedAppImprovementTask`)
// instead of being parked in a WeakMap keyed on the task object. The object-
// identity version required every admission site to keep re-finding the EXACT
// object the generator returned; `cosTaskStore.addTask` hands back a DIFFERENT
// object whenever the description is multi-line, which is the normal case, so
// a caller that naturally kept using the store's returned object instead of
// the generator's recorded nothing, silently (#6871).
export async function recordDeferredPerpetualDispatch(pendingPerpetualDispatch, taskSchedule) {
  // Sentinel on the field the record can't exist without, not mere truthiness
  // of the object — a malformed record must never reach recordPerpetualDispatch
  // as `undefined`, which would write a bogus schedule entry instead of no-oping.
  if (!pendingPerpetualDispatch?.taskType) return false;
  const { taskType, appId, signature } = pendingPerpetualDispatch;
  await taskSchedule.recordPerpetualDispatch(taskType, appId, signature);
  return true;
}

// How many CONSECUTIVE transient skips (across evaluations) applyPerpetualWorkGate
// tolerates at `debug` before escalating to `warn` — see noteTransientProbe's
// return value.
export const PERPETUAL_TRANSIENT_ESCALATION_THRESHOLD = 3;

// Consecutive-transient-skip counters, keyed `taskType:appId`. This is the ONLY
// state that has to outlive a single evaluation (it counts how many evaluations
// IN A ROW came back transient); the skip's REASON travels back explicitly on
// prepareManagedAppImprovementTask's `skip` result instead of through a side
// channel.
const transientStreaks = new Map();

const transientStreakKey = (taskType, appId) => `${taskType}:${appId || 'global'}`;

/**
 * Count one more consecutive transient (non-parking) probe failure for
 * `taskType` + `appId`.
 *
 * @returns {number} the new consecutive-transient count.
 */
function noteTransientProbe(taskType, appId) {
  const key = transientStreakKey(taskType, appId);
  const count = (transientStreaks.get(key) || 0) + 1;
  transientStreaks.set(key, count);
  return count;
}

/** Reset the consecutive-transient streak — the probe stopped being transient. */
function clearTransientProbeStreak(taskType, appId) {
  transientStreaks.delete(transientStreakKey(taskType, appId));
}

/**
 * Perpetual (drain-until-done) work-detector gate. For a task type running on
 * the 'perpetual' interval — excluding branch-/issue-reconcile, whose own scan
 * IS the detector — a programmatic detector decides whether there's anything to
 * claim BEFORE building the (expensive) prompt or burning an agent:
 *   - actionable → stamp metadata.perpetual (skip cooldown), proceed;
 *   - unchanged actionable set → PARK after a successful no-progress run;
 *   - idle (definitive) → PARK on the recheck cadence, skip;
 *   - transient probe failure → skip WITHOUT parking so the next tick retries.
 * The detector keys on the RESOLVED promptTaskType. Returns `{ skip, verdict,
 * spendDispatch, signature }` — `verdict` (`{ cli, reason, remedy, detail }`) is
 * set only on the transient skip, so the caller can hand the reason to the
 * user-facing "Run" toast — and mutates `metadata.perpetual` on the actionable path.
 *
 * `spendDispatch` is the caller's cue to call `recordPerpetualDispatch` (which
 * clears the park and spends one unit of the type's `drainDispatchCap` budget in a
 * single write) — deliberately NOT done here. Gates that run AFTER this one can
 * still return null with no agent ever spawned (`applyPlanIdMetadata` skips
 * plan-task when every unchecked item is in-flight or blocked), and charging the
 * budget for a task that was never created would exhaust a capped drain on
 * evaluations alone, parking it for `drain-cap` without a single dispatch.
 */
export async function applyPerpetualWorkGate(app, taskType, promptTaskType, metadata, interval, taskSchedule, { ignoreTaskId = null } = {}) {
  // The reconcile drains run their own scan-driven gate (the blocks in
  // cosTaskPreStepBlocks), so they opt out of the generic work detector.
  if (interval.perpetual !== true || isReconcileDrainTaskType(taskType)) {
    return { skip: false };
  }
  const detection = await detectActionableWork(promptTaskType, app, {
    issueAuthorFilter: metadata.issueAuthorFilter || 'self',
    issueExcludeLabels: metadata.issueExcludeLabels || [],
    issueMinAgeMinutes: metadata.issueMinAgeMinutes,
    // A detector that counts in-flight work must skip the task whose completion
    // triggered this refill — it is already recorded, just not yet marked done.
    ignoreTaskId
  });
  if (detection.actionable) {
    // A probe that reports actionable work is, by definition, not stuck — clear
    // both the transient streak and any persisted stall diagnostic before
    // deciding whether THIS evaluation dispatches or parks on no-progress.
    clearTransientProbeStreak(taskType, app.id);
    await taskSchedule.recordPerpetualStall(taskType, app.id, null);
    // A successful claim/plan agent can still return without changing forge or
    // PLAN state (for example, it decides not to pick the advertised item). The
    // completion refill would otherwise dispatch the same candidate forever.
    // The detector's signature covers the complete set; `items` is capped for
    // the picker and is not sufficient for convergence.
    const drainSignature = detection.signature == null
      ? null
      : JSON.stringify({ taskType: promptTaskType, candidates: detection.signature });
    if (drainSignature != null) {
      const { signature: lastSignature, dispatchCount } = await taskSchedule.getPerpetualDrainState(taskType, app.id);
      if (shouldParkUnchangedPerpetualWork({ ...detection, signature: drainSignature }, lastSignature, dispatchCount)) {
        const counts = detection.total != null
          ? { open: detection.total, inFlight: detection.inFlightCount ?? 0, filtered: detection.filteredCount ?? 0 }
          : null;
        await taskSchedule.parkPerpetual(taskType, app.id, {
          reason: 'no-progress',
          actionableCount: detection.count,
          counts,
          signature: null
        });
        emitLog('info', `Perpetual ${taskType} parked for ${app.name}: actionable work unchanged after the last run`, { appId: app.id });
        return { skip: true };
      }
    }
    metadata.perpetual = true;
    // The dispatch is SPENT BY THE CALLER, once a task is certain — see the note
    // on `spendDispatch` in the JSDoc above.
    return { skip: false, spendDispatch: true, signature: drainSignature };
  }
  if (detection.transient) {
    // Record BEFORE logging, so the log line (and the escalation decision) can
    // report which consecutive occurrence this is. A single blip stays at
    // `debug` (suppressed on a default install); once the SAME probe has failed
    // PERPETUAL_TRANSIENT_ESCALATION_THRESHOLD evaluations in a row, escalate to
    // `warn` (reaches the console and the cos:log stream) and persist the
    // stalled verdict — otherwise a perpetual drain whose forge CLI is broken
    // produces zero console output, zero persisted state, and zero UI signal,
    // indefinitely (#7551).
    const verdict = {
      cli: detection.cli || null, reason: detection.reason, remedy: detection.remedy || null, detail: detection.detail || null
    };
    const consecutive = noteTransientProbe(taskType, app.id);
    const detailSuffix = detection.detail ? ` — ${detection.detail}` : '';
    const escalated = consecutive >= PERPETUAL_TRANSIENT_ESCALATION_THRESHOLD;
    emitLog(escalated ? 'warn' : 'debug',
      `Perpetual ${taskType} skip for ${app.name} (transient: ${detection.reason}${detailSuffix}, ${consecutive} consecutive)`,
      { appId: app.id, consecutive });
    // The skip is silent by design at low counts (the next tick retries), but an
    // explicit user "Run" ends here too — return which CLI failed (`verdict`) so
    // emitOnDemandEmpty can tell the difference between a blip and a forge that
    // is broken for good, plus any remedy the detector already named (a
    // permission the token lacks, which no amount of retrying fixes).
    if (escalated) {
      await taskSchedule.recordPerpetualStall(taskType, app.id, {
        cli: detection.cli || null, reason: detection.reason, detail: detection.detail || null, consecutive
      });
    }
    return { skip: true, verdict };
  }
  clearTransientProbeStreak(taskType, app.id);
  await taskSchedule.recordPerpetualStall(taskType, app.id, null);
  // Carry the detector's open/in-flight/filtered breakdown into the park so an
  // explicit "Run" can explain WHY a non-empty queue yielded no work.
  const counts = detection.total != null
    ? { open: detection.total, inFlight: detection.inFlightCount ?? 0, filtered: detection.filteredCount ?? 0 }
    : null;
  // Per-cause skip attribution for the same question at one level deeper: not
  // just "78 filtered" but "49 needs-input, 17 blocked, …". Only the claim
  // detectors report it; every other park shape keeps the field absent.
  // parkPerpetual's own log line renders the summary (it is the single choke
  // point every park flows through), so this one stays bare.
  const skipCauses = detection.skipCauses ?? null;
  // Terminal park — parkPerpetual zeroes the dispatch budget in the same write, so
  // the next drain window starts fresh instead of capping early on this one's spend.
  await taskSchedule.parkPerpetual(taskType, app.id, { reason: detection.reason, actionableCount: detection.count, counts, skipCauses, signature: null });
  emitLog('info', `Perpetual ${taskType} parked for ${app.name}: ${detection.reason}`, { appId: app.id });
  return { skip: true };
}
