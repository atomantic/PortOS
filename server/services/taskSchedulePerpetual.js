/** Perpetual drain park, dispatch, stall and reset state shared by the scheduler and its callers. */

import { emitLog } from './cos/cosEvents.js';
import { formatSkipCauses } from '../lib/perpetualSkipCauses.js';
import { getUserTimezone } from './userTimezone.js';
import { parseCronToNextRun } from './eventScheduler.js';
import {
  DEFAULT_PERPETUAL_RECHECK_MS,
  INTERVAL_TYPES,
  isCronExpression,
  isUserOriginRequest
} from './taskScheduleConstants.js';
import { ensureExecutionRecord, loadSchedule, resolveExecutionRecord, updateSchedule } from './taskScheduleStore.js';
import { clearTaskTypeFailurePark } from './taskScheduleBackoff.js';

/**
 * Compute when a parked perpetual task should next re-probe its work-detector.
 * A cron-scheduled perpetual task rechecks on its own `cronExpression`;
 * otherwise this prefers `recheckCron` (a 5-field cron string, evaluated in the
 * user's timezone) over `recheckIntervalMs`, falling back to
 * DEFAULT_PERPETUAL_RECHECK_MS.
 * Returns an ISO timestamp string.
 */
export async function computePerpetualRecheckAt(interval, fromMs = Date.now()) {
  // A cron+perpetual task needs no separate recheck cadence: its own schedule
  // both initiates the drain and gates the next attempt after it parks.
  const cron = (interval?.type === INTERVAL_TYPES.CRON && isCronExpression(interval?.cronExpression))
    ? interval.cronExpression
    : interval?.recheckCron;
  if (isCronExpression(cron)) {
    const timezone = await getUserTimezone();
    const next = parseCronToNextRun(cron, new Date(fromMs), timezone);
    if (next) return next.toISOString();
  }
  const ms = Number(interval?.recheckIntervalMs) > 0
    ? Number(interval.recheckIntervalMs)
    : DEFAULT_PERPETUAL_RECHECK_MS;
  return new Date(fromMs + ms).toISOString();
}

/**
 * Shorten a computed park so it cannot sleep past a moment the caller already
 * KNOWS the situation changes on its own.
 *
 * The recheck cadence is a poll interval — the right default when nothing is
 * known about *when* new work appears. But some parks wait on a deadline the
 * detector can name: branch-reconcile holds a merged branch whose claim worktree
 * is still inside its grace window, and that hold lifts at a computable instant.
 * Parking past it compounds two waits (the grace window, then the next cron
 * fire) into a stall several times longer than either — on a weekly recheck a
 * 7-day hold becomes up to 14 days of a task that looks idle.
 *
 * Only ever SHORTENS: a bound that is unparseable, already elapsed, or later
 * than the recheck is ignored, so a bad bound can never extend a park (nor spin
 * one into a hot retry loop).
 *
 * @param {string} recheckAt - ISO timestamp from computePerpetualRecheckAt
 * @param {string|null|undefined} notLaterThan - ISO instant the hold self-lifts
 * @param {number} [nowMs]
 * @returns {string} ISO timestamp
 */
export function boundParkedUntil(recheckAt, notLaterThan, nowMs = Date.now()) {
  const bound = Date.parse(notLaterThan);
  const recheck = Date.parse(recheckAt);
  if (!Number.isFinite(bound) || !Number.isFinite(recheck)) return recheckAt;
  if (bound <= nowMs || bound >= recheck) return recheckAt;
  return new Date(bound).toISOString();
}

/**
 * Numeric ms of a record's perpetual park, or 0 when it carries none (or an
 * unparseable timestamp). The single reader of `parkedUntil` — every park
 * comparison in this file goes through it so "parked" can't mean two things.
 */
export function parkedUntilMs(record) {
  if (!record?.parkedUntil) return 0;
  const ms = new Date(record.parkedUntil).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Roll a perpetual task's park records up into ONE aggregate that every
 * per-app-park consumer projects from (getUpcomingTasks eligibility and the
 * getScheduleStatus UI block).
 *
 * GLOBAL-RECORD INCLUSION RULE (documented once, here, so the callers can't
 * diverge): every `perApp` record is a tracked scope; the top-level execution
 * record is a tracked scope ONLY when it carries its OWN `parkedUntil`.
 * Rationale — perpetual parks are recorded PER-APP (parkPerpetual is always
 * called with an appId for the shipped app-scoped drains: claim-issue,
 * claim-work, branch-/issue-reconcile), so for those the top-level record is
 * just a container and must not be mistaken for a scope that is "due now".
 * A future global-park perpetual (none ship today) stamps its own `parkedUntil`
 * and is then folded in like any other scope.
 *
 * Returns:
 *   trackedAppCount  per-app records (the UI's "N app(s)" denominator)
 *   trackedCount     tracked scopes total (per-app + an own-parked global)
 *   parkedAppCount   per-app records still parked in the future
 *   globalParked     the top-level record carries a park that hasn't elapsed
 *   soonestParkAt    ms of the earliest un-elapsed park, or null when none
 *   anyDueNow        some tracked scope is unparked or its park has elapsed
 *   parkReason       first parked app's reason, else the parked global's
 *   parkCounts       first parked app's counts, else the parked global's
 *   parkSkipCauses   first parked app's skip breakdown, else the parked global's
 */
export function aggregatePerpetualParks(execution, now) {
  const appRecords = Object.values(execution?.perApp || {});
  const globalUntil = parkedUntilMs(execution);
  const globalTracked = globalUntil > 0;
  const globalParked = globalUntil > now;

  let parkedAppCount = 0;
  let anyDueNow = false;
  let soonestParkAt = null;
  // The FIRST parked app in iteration order, not the first one that happens to
  // carry a reason — the UI names the app it counted first, so a reasonless park
  // must read as "no reason" rather than borrowing the next app's.
  let firstParkedApp = null;

  for (const rec of appRecords) {
    const until = parkedUntilMs(rec);
    // Unparked (mid-drain) or park already elapsed → this scope is due now.
    if (until <= now) {
      anyDueNow = true;
      continue;
    }
    parkedAppCount++;
    if (firstParkedApp === null) firstParkedApp = rec;
    if (soonestParkAt === null || until < soonestParkAt) soonestParkAt = until;
  }

  if (globalTracked) {
    if (globalParked) {
      if (soonestParkAt === null || globalUntil < soonestParkAt) soonestParkAt = globalUntil;
    } else {
      anyDueNow = true;
    }
  }

  const parkedRecord = firstParkedApp || (globalParked ? execution : null);

  return {
    trackedAppCount: appRecords.length,
    trackedCount: appRecords.length + (globalTracked ? 1 : 0),
    parkedAppCount,
    globalParked,
    soonestParkAt,
    anyDueNow,
    parkReason: firstParkedApp?.parkReason || (globalParked ? execution.parkReason : null) || null,
    parkCounts: parkedRecord?.parkCounts ?? null,
    parkSkipCauses: parkedRecord?.parkSkipCauses ?? null
  };
}

// Every field parkPerpetual stamps for a park. Kept as one list so the clear /
// reset paths can't drift from what park writes (adding a park field here is the
// single edit that keeps all three in sync).
const PARK_FIELDS = ['parkedUntil', 'parkReason', 'parkActionableCount', 'parkCounts', 'parkSkipCauses', 'parkNotLaterThan', 'parkedAt'];

/**
 * Park a perpetual task: its work-detector reported nothing actionable, so stop
 * draining and wait until `parkedUntil` before re-probing. Stamps the park
 * fields on the (per-app or global) execution record.
 *
 * `signature` and `dispatchCount` are the drain's two convergence brakes, both
 * settable HERE rather than by a follow-up call, because every terminal park has
 * to land them in the same write it lands the park. A second await after this one
 * is a step a future park path can forget — and a stale non-zero dispatch count
 * makes the NEXT fresh drain cap out early, which looks exactly like the task
 * silently doing nothing.
 *
 * `notLaterThan` is an optional ISO instant at which the caller knows the hold
 * lifts on its own; the park is shortened to it when that is sooner than the
 * recheck cadence, and ignored otherwise.
 *
 * `dispatchCount` therefore DEFAULTS to 0: a park ends the drain window by
 * definition, so zeroing the budget is the invariant, not an opt-in every caller
 * has to remember. The churn detector's park in agentChurn.js relies on this
 * default so a local signal ends the current drain window cleanly. Note
 * `dispatchCount` is still deliberately NOT in `PARK_FIELDS`:
 * `recordPerpetualDispatch` clears those fields mid-drain on every dispatch, and
 * zeroing the counter there would reset the budget before every dispatch, so the
 * cap could never fire.
 */
export async function parkPerpetual(taskType, appId = null, { reason = null, actionableCount = 0, counts = null, skipCauses = null, signature, dispatchCount = 0, notLaterThan = null, branchAttempts } = {}) {
  const { record, parkedUntil } = await updateSchedule(async (schedule) => {
    const interval = schedule.tasks[taskType] || {};
    // Bound HERE, not at the assignment: `parkedUntil` is also what the log line and
    // the schedule:perpetual-parked event publish, and a change whose whole point is
    // an honest "when will this actually run" must not report the un-shortened time.
    const parkedUntil = boundParkedUntil(await computePerpetualRecheckAt(interval), notLaterThan);
    const record = ensureExecutionRecord(schedule, taskType, appId);
    record.parkedUntil = parkedUntil;
    record.parkReason = reason;
    if (taskType === 'branch-reconcile') {
      const remaining = record.branchReconcileOutcome?.remaining ?? null;
      const drained = reason === 'no-in-flight-branches' && remaining?.length === 0;
      record.branchReconcileOutcome = {
        ...record.branchReconcileOutcome,
        status: drained ? 'drained' : 'incomplete', reason, remaining,
        observedAt: record.branchReconcileOutcome?.observedAt ?? null,
        updatedAt: new Date().toISOString(),
        nextAction: drained ? null : 'Resolve the listed holds or dispatch limit, then run branch reconciliation again.',
      };
    }
    if (branchAttempts === null) delete record.branchReconcileAttempts;
    else if (branchAttempts !== undefined) record.branchReconcileAttempts = branchAttempts;
    record.parkActionableCount = actionableCount;
    // The detector's candidate breakdown ({ open, inFlight, filtered }). Lets the
    // UI explain WHY a non-empty queue yields zero claimable work — "0 of N, M
    // in-flight" — instead of a bare "no work". `null` = the detector reported no
    // breakdown (e.g. the reconcile scans), so the field is left off the record.
    if (counts != null) record.parkCounts = counts;
    else delete record.parkCounts;
    // Per-cause skip attribution ({ 'needs-input': 49, blocked: 17, … }) for the
    // same purpose: "78 filtered" alone can't tell a user their work is waiting
    // on `needs-input` decisions rather than the task being broken. Same null
    // contract as parkCounts — absent when the detector reported no attribution.
    if (skipCauses != null) record.parkSkipCauses = skipCauses;
    else delete record.parkSkipCauses;
    // The self-expiry has to OUTLIVE this call: updateTaskInterval restamps every
    // un-elapsed park from the new cadence, and without a remembered bound it would
    // stretch a correctly-shortened park back out — reintroducing the stacking this
    // option exists to remove, via an unrelated settings edit.
    if (notLaterThan) record.parkNotLaterThan = notLaterThan;
    else delete record.parkNotLaterThan;
    record.parkedAt = new Date().toISOString();
    // A drain that parks because a full cycle made NO progress (branch-reconcile's
    // 'no-progress' park) records the actionable signature it was stuck on, so the
    // next recheck can tell "same stuck set" (park again) from "the set changed"
    // (resume). `null` clears it (an idle park with nothing actionable); `undefined`
    // (the default) leaves any prior signature untouched.
    //
    // `signatureRepeatCount` is the harvested "same finding again" metric the
    // CoS churn detector reports: increment when this park restates the same
    // signature, reset when the set changes, clear when idle.
    if (signature !== undefined) {
      if (signature === null) {
        delete record.lastActionableSignature;
        delete record.signatureRepeatCount;
      } else if (signature === record.lastActionableSignature) {
        record.signatureRepeatCount = (Number(record.signatureRepeatCount) || 1) + 1;
      } else {
        record.lastActionableSignature = signature;
        record.signatureRepeatCount = 1;
      }
    }
    // Same option shape for the consecutive-dispatch budget: `0` (or null) clears it
    // because this park ended the drain window; `undefined` leaves it alone.
    if (dispatchCount !== undefined) {
      if (!dispatchCount) delete record.perpetualDispatchCount;
      else record.perpetualDispatchCount = dispatchCount;
    }

    return { result: { record, parkedUntil }, changed: true };
  });
  // A park on a non-empty queue needs its WHY in the log line itself — the
  // operator reads PM2 output, where a bare `no-actionable-issues` next to "88
  // open issues" reads as the task being broken. Render the top skip causes
  // inline ("49 needs-input, 17 blocked") so the one line they see answers the
  // question the toast exists for.
  const causes = formatSkipCauses(skipCauses);
  const causeSummary = causes ? ` — ${causes}` : '';
  emitLog('info', `Perpetual ${taskType} parked until ${parkedUntil} (${reason || 'idle'}${causeSummary})`, { taskType, appId, parkedUntil }, '📅 TaskSchedule');
  if (taskType === 'branch-reconcile') {
    for (const row of record.branchReconcileOutcome?.remaining || []) {
      emitLog('info', `🔀 branch-reconcile retained ${row.branch || row.path || 'repository scan'}: ${row.reason}${row.nextAction ? ` — ${row.nextAction}` : ''}`, { appId });
    }
  }
  return record;
}

/**
 * Read the current park record for a perpetual task (or null when not parked).
 * Used by the on-demand handler to explain to the user WHY an explicit "Run"
 * produced no task — the park fields are freshly stamped by the same dispatch,
 * so this reflects the just-completed detection, not stale cadence state.
 */
export async function getPerpetualParkInfo(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  if (!record || record.parkedUntil == null) return null;
  return {
    parkedUntil: record.parkedUntil,
    parkReason: record.parkReason ?? null,
    parkActionableCount: record.parkActionableCount ?? null,
    parkCounts: record.parkCounts ?? null,
    parkSkipCauses: record.parkSkipCauses ?? null,
    parkedAt: record.parkedAt ?? null,
    signatureRepeatCount: Number.isFinite(record.signatureRepeatCount) ? record.signatureRepeatCount : null
  };
}

/**
 * Stamp (or clear) the perpetual work gate's escalated probe-failure diagnostic
 * onto the task's schedule record — ALONGSIDE the park fields, never instead of
 * them, because a stall means the gate is skipping WITHOUT parking (the drain
 * keeps ticking; there is no park record to hang the reason on otherwise). This
 * is what lets the Schedule tab render "probe failing — gh: <reason>" instead of
 * an apparently-healthy armed schedule while a broken forge CLI silently skips
 * every evaluation (#7551). Survives a process restart the same way a park does.
 *
 * `stall: null` clears it — a probe that stops being transient (recovers,
 * dispatches, or reaches a definitive park) means whatever was stuck has
 * cleared, so applyPerpetualWorkGate clears this on every non-escalated path.
 */
export async function recordPerpetualStall(taskType, appId = null, stall = null) {
  return updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, taskType, appId);
    if (!stall) {
      if (!('stall' in record)) return { result: null, changed: false };
      delete record.stall;
      return { result: null, changed: true };
    }
    record.stall = {
      cli: stall.cli || null,
      reason: stall.reason || null,
      detail: stall.detail || null,
      consecutive: Number.isFinite(stall.consecutive) ? stall.consecutive : 0,
      at: new Date().toISOString()
    };
    return { result: null, changed: true };
  });
}

/**
 * First still-relevant stall diagnostic across a perpetual task's per-app (and
 * global) execution records. Unlike a park, a stall can coexist with a
 * currently-draining task (the gate skips without parking), so the UI needs its
 * own signal independent of aggregatePerpetualParks — mirrors that function's
 * per-app-then-global scan order.
 */
export function aggregatePerpetualStall(execution) {
  const appRecords = Object.values(execution?.perApp || {});
  const stalledApp = appRecords.find((rec) => rec?.stall);
  return stalledApp?.stall || execution?.stall || null;
}

/**
 * Is this type+app parked with an UNEXPIRED `parkedUntil`?
 *
 * `getPerpetualParkInfo` reports the park record whether or not it has elapsed —
 * an elapsed park is deliberately left on disk (it reads as "due right now"), so
 * its mere presence is not a stop signal. This is the elapse-aware question, and
 * it is what the completion refill asks before re-issuing a drain: a park means
 * "stop draining until the recheck cadence", and until #3848 the refill lane
 * never asked, so a park could not stop a refill hop.
 */
export async function isPerpetualParkActive(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  return parkedUntilMs(record) > Date.now();
}


/**
 * A perpetual drain's convergence state, read in ONE pass: the actionable
 * signature its last dispatch was handed, and how many times it has dispatched
 * since it last went idle. Read together because they are decided together — two
 * separate getters also left a read-skew window between the two fields.
 * @returns {Promise<{ signature:string|null, dispatchCount:number }>}
 */
export async function getPerpetualDrainState(taskType, appId = null) {
  const schedule = await loadSchedule();
  const record = resolveExecutionRecord(schedule, taskType, appId);
  return {
    signature: record?.lastActionableSignature ?? null,
    dispatchCount: record?.perpetualDispatchCount || 0,
    ...(record?.branchReconcileAttempts && { branchAttempts: record.branchReconcileAttempts })
  };
}

/**
 * Record that a perpetual drain is dispatching against `signature`: resume the
 * drain (drop any park), remember the signature so a later cycle can recognize
 * "same set ⇒ no progress", and spend one dispatch from the cap's budget — all in
 * a single read-modify-write, so the three facts can never land apart.
 * @returns {Promise<number>} the new consecutive-dispatch count
 */
export async function recordPerpetualDispatch(taskType, appId = null, signature, { branchAttempts } = {}) {
  return updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, taskType, appId);
    for (const field of PARK_FIELDS) delete record[field];
    if (branchAttempts !== undefined) record.branchReconcileAttempts = branchAttempts;
    // Mirrors parkPerpetual's signature handling, including the churn detector's
    // `signatureRepeatCount`. A dispatch only happens when the set CHANGED (an
    // unchanged one parks instead), so this is always the "new signature ⇒ first
    // sighting" case — leaving the previous count in place would let the NEXT park
    // increment a stale value, over-reporting "same finding again" to a detector
    // that parks the coordinator and files a tracker issue off that number.
    if (signature == null) {
      delete record.lastActionableSignature;
      delete record.signatureRepeatCount;
    } else {
      record.lastActionableSignature = signature;
      record.signatureRepeatCount = 1;
    }
    const count = (record.perpetualDispatchCount || 0) + 1;
    record.perpetualDispatchCount = count;
    return { result: count, changed: true };
  });
}

/**
 * Reset a perpetual task's cached drain state for an explicit user-initiated
 * re-run. Drops any park AND the convergence `lastActionableSignature` in a
 * single write, so the next detection dispatches on LIVE state alone — never a
 * stale "no-progress" verdict or a cadence park. This is what makes a manual
 * "Run" honor the user's intent to re-check now: without clearing the signature,
 * branch-reconcile/issue-reconcile would re-park `no-progress` against an
 * unchanged-since-last-run set even though the user explicitly asked to re-drive.
 *
 * Branch-reconcile retains its attempted revisions: a manual retry must reach
 * the remaining branches before starting another sweep of the blocked prefix.
 *
 * ONLY a human asking for a re-run may call this. An automated re-issue that
 * borrows the on-demand lane (the perpetual drain's own completion refill) must
 * NOT: clearing the convergence signature and the dispatch counter is precisely
 * what removes every brake the drain has, and the drain then re-dispatches for as
 * long as one actionable item exists. That is the loop that ran ~40 branch-reconcile
 * coordinators overnight on 2026-08-12. See `origin` on the on-demand request.
 *
 * Returns true when it cleared anything.
 */
export async function resetPerpetualForManualRun(taskType, appId = null) {
  return updateSchedule(async (schedule) => {
    const record = resolveExecutionRecord(schedule, taskType, appId);
    if (!record) return { result: false, changed: false };
    let changed = false;
    for (const field of [...PARK_FIELDS, 'lastActionableSignature', 'signatureRepeatCount', 'perpetualDispatchCount']) {
      if (record[field] !== undefined) { delete record[field]; changed = true; }
    }
    return { result: changed, changed };
  });
}

/**
 * Apply the "a human pressed Run" state resets for one on-demand request — and
 * apply NOTHING when the request is an automated drain refill.
 *
 * This is the single home of that policy. It used to be open-coded in each spawn
 * engine that drains the on-demand queue, which is how the loop this guards against
 * got in: the engines could not tell a human "Run Now" from the perpetual drain
 * re-issuing itself through the same queue, so they cleared the drain's park,
 * convergence signature, and dispatch budget on every automated hop. There are
 * THREE consumers of that queue (cos.dequeueNextTask, cosTaskGenerator's
 * spawnPriority0OnDemand, and the idle-review path), so "remember to check origin
 * at each call site" is not a durable invariant — calling this instead is.
 *
 * @param {{taskType:string, origin?:string}} request - the queued on-demand record
 * @param {string|null} [appId] - the app scope, or null for a global task
 * @returns {Promise<boolean>} true when the request was user-initiated (resets
 *   applied) — callers use it to decide whether user-facing feedback is warranted
 */
export async function applyOnDemandRunResets(request, appId = null) {
  // Every AUTOMATED origin inherits the brakes — the drain's own refill and a
  // quota burn alike. Written as "is this a human?" rather than "is this a
  // refill?" so an origin added later fails CLOSED instead of silently
  // acquiring a human's park/convergence resets (a burn that cleared them would
  // re-run a converged drain every time its window opened).
  if (!isUserOriginRequest(request)) return false;
  // A user-initiated "Run" must re-check live state, never honor a stale park or
  // convergence verdict.
  await resetPerpetualForManualRun(request.taskType, appId);
  // It also unparks a failure-parked type (#2616): a human explicitly re-running is
  // an "I've addressed it" signal. A refill carries no such signal from anybody —
  // gating this too keeps a drain that fails every run from clearing its own
  // failure park forever.
  await clearTaskTypeFailurePark(request.taskType, appId);
  return true;
}
