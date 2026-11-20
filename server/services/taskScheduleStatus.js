/** Schedule status and upcoming run previews for the UI and daemon. */

import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { getActiveApps, getAppTaskTypeOverrides } from './apps.js';
import { loadState, isImprovementEnabled } from './cos/cosState.js';
import {
  isAuditTaskType,
  defaultFileIssuesFor,
  auditDoWorkRequiresWorktree,
  getAuditScheduleMetadata,
  AUDIT_RUN_GUIDANCE,
  AUDIT_SUGGESTED_AFTER
} from '../lib/auditCatalog.js';
import { DEFAULT_TASK_PROMPTS } from './taskPromptDefaults.js';
import { INTERVAL_TYPES, isCronExpression, resolveAppOverrideCadence } from './taskScheduleConstants.js';
import {
  DEFAULT_TASK_INTERVALS,
  INSTALL_WIDE_TASK_TYPES,
  MANAGED_AGENT_OPTIONS,
  getTaskTypeDescription,
  getTaskTypeInvocation,
  getTaskTypePromptInfo,
  isProgrammaticScheduledTaskType
} from './taskScheduleRegistry.js';
import { loadSchedule } from './taskScheduleStore.js';
import { getTaskDataInputCatalog } from '../lib/taskDataInputCatalog.js';
import { normalizeSuggestedAfter } from '../lib/scheduleRunOrder.js';
import { aggregatePerpetualParks, aggregatePerpetualStall } from './taskSchedulePerpetual.js';
import { createFeatureGate, shouldRunTask, getAvailableOnDemandRequests } from './taskScheduleEvaluator.js';

/**
 * The apps that run `taskType` on a cron of their OWN — enabled for the task,
 * and stating a cadence rather than inheriting the task's.
 *
 * Both callers that have to reason about an app-level clock start here:
 * `getUpcomingTasks` (which app boundary should wake the daemon) and
 * `resolveHiddenAppSchedules` (which schedules the UI cannot see on the global
 * row). They differ only in what they do with the result, so the override →
 * cadence walk lives here once.
 *
 * `allOverrides[i]` is the override map for `activeApps[i]`, in the caller's
 * own order; entries come back as `{ app, cronExpression }` in that order.
 */
function appsWithOwnCron(taskType, interval, activeApps, allOverrides) {
  const matched = [];
  for (let i = 0; i < activeApps.length; i++) {
    const override = allOverrides[i]?.[taskType];
    if (override?.enabled !== true) continue;
    const cadence = resolveAppOverrideCadence(override, interval);
    // An inheriting app rides the task's own cadence; only an app stating its
    // own cron adds a clock the global row does not already carry.
    if (cadence.inherited || cadence.type !== INTERVAL_TYPES.CRON) continue;
    if (!isCronExpression(cadence.cronExpression)) continue;
    matched.push({ app: activeApps[i], cronExpression: cadence.cronExpression.trim() });
  }
  return matched;
}

/**
 * The per-app cron cadences a task's GLOBAL row cannot express.
 *
 * Returns one entry per enabled app whose own override resolves to a valid cron
 * expression that differs from whatever the task runs on globally — the state
 * where a task left on-demand globally carries an app-level cron and therefore
 * read as "manual only" on every surface. Apps that inherit the global cadence, or that
 * restate the same expression, are omitted: they already sit on the global
 * track, and listing them would make "3 apps scheduled" mean two different
 * things depending on the task.
 *
 * `shouldRunTask` supplies each entry's next slot rather than a local cron
 * parse, so the time shown is the one dispatch would actually honor (per-app
 * last run, failure backoff, dependency gates and all).
 */
async function resolveHiddenAppSchedules(taskType, interval, activeApps, allOverrides, featureEnabled, schedule) {
  const globalCron = interval.type === INTERVAL_TYPES.CRON && isCronExpression(interval.cronExpression)
    ? interval.cronExpression.trim()
    : null;
  // An app restating the task's own expression sits on the global track
  // already; counting it would make "N apps scheduled" mean something
  // different per task.
  const candidates = appsWithOwnCron(taskType, interval, activeApps, allOverrides)
    .filter(candidate => candidate.cronExpression !== globalCron);
  if (candidates.length === 0) return [];

  const checks = await mapWithConcurrency(candidates, 8, ({ app }) =>
    shouldRunTask(taskType, app.id, { featureEnabled, schedule }));
  return candidates.map(({ app, cronExpression }, i) => ({
    appId: app.id,
    appName: app.name || app.id,
    cronExpression,
    nextRunAt: checks[i]?.nextRunAt || null,
    shouldRun: checks[i]?.shouldRun === true,
    reason: checks[i]?.reason || null,
    missedSlot: checks[i]?.missedSlot || null
  }));
}

export async function getScheduleStatus() {
  // Surface the master Improve toggle so the UI can disable Run Now affordances
  const [schedule, state] = await Promise.all([loadSchedule(), loadState()]);
  const featureEnabled = createFeatureGate();
  const onDemandRequests = (await getAvailableOnDemandRequests(schedule, featureEnabled))
    .filter(request => getTaskTypeInvocation(request.taskType).visibility !== 'hidden');

  const status = {
    lastUpdated: schedule.lastUpdated,
    improvementEnabled: isImprovementEnabled(state),
    tasks: {},
    templates: schedule.templates,
    onDemandRequests,
    dataInputCatalog: getTaskDataInputCatalog()
  };

  // Fetch active apps once for per-app override aggregation
  const activeApps = await getActiveApps();
  const totalAppCount = activeApps.length;

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!(await featureEnabled(interval))) continue;
    const invocation = getTaskTypeInvocation(taskType);
    if (invocation.visibility === 'hidden') continue;
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0, perApp: {} };
    const promptInfo = getTaskTypePromptInfo(taskType);

    // Check global shouldRun status
    const check = await shouldRunTask(taskType, null, { featureEnabled, schedule });

    const isEnabledForApp = (override) => override?.enabled === true;
    const appOverrides = {};
    let enabledAppCount = 0;
    const allOverrides = await mapWithConcurrency(activeApps, 8, (app) => getAppTaskTypeOverrides(app.id));
    for (let i = 0; i < activeApps.length; i++) {
      const override = allOverrides[i][taskType];
      if (override) {
        appOverrides[activeApps[i].id] = {
          enabled: isEnabledForApp(override),
          interval: override.interval || null,
          // Surface the per-app provider/model pin: it OUTRANKS the global pin at
          // spawn for every task type (#4783), so omitting it here made the Schedule
          // page's provider read as authoritative when it wasn't (an app pinned to
          // another provider ran on that one with no hint why).
          ...(override.providerId && { providerId: override.providerId }),
          ...(override.model && { model: override.model }),
          ...(override.taskMetadata && { taskMetadata: override.taskMetadata })
        };
      }
      if (isEnabledForApp(override)) {
        enabledAppCount++;
      }
    }

    // Cadences that are INVISIBLE from the global row: an enabled app pinning a
    // cron expression the task itself does not carry. The reported case is a
    // task left 'on-demand' globally while one app schedules it — the app is
    // genuinely clock-driven, so a Schedule card reading "Manual trigger only"
    // and a Timeline filing it under "no clock time" are both wrong.
    // An app that inherits, or that restates the global expression, adds
    // nothing to show and is left out so the count answers "how many apps run
    // this on a schedule you can't see here".
    const appSchedules = await resolveHiddenAppSchedules(taskType, interval, activeApps, allOverrides, featureEnabled, schedule);

    const auditMeta = getAuditScheduleMetadata(taskType);
    const taskStatus = {
      ...interval,
      ...auditMeta,
      displayName: interval.displayName || (auditMeta.displayName !== taskType ? auditMeta.displayName : (DEFAULT_TASK_INTERVALS[taskType]?.displayName || taskType)),
      labels: interval.labels || [],
      // Advisory ordering: WHICH tasks to run first, named by task type. Never
      // a dispatch gate — that is `runAfter`, spread in from `interval` above.
      //
      // Layered at READ time like every other catalog-derived field here
      // (displayName, defaultLabels, runGuidance): a stored value wins, and an
      // absent one inherits the shipped order — so editing AUDIT_SUGGESTED_AFTER
      // reaches existing installs without a migration. An explicit `[]` is a
      // user's clear and is key-present, so `??` keeps it.
      suggestedAfter: normalizeSuggestedAfter(interval.suggestedAfter ?? AUDIT_SUGGESTED_AFTER[taskType], taskType),
      // WHY this task sits where it does — rationale for the order above, not
      // the order itself.
      runGuidance: AUDIT_RUN_GUIDANCE[taskType] || (isAuditTaskType(taskType) ? 'Run when this area has a concrete need; coordinate overlapping fixes and validate after each merge.' : null),
      lastRun: execution.lastRun,
      runCount: execution.count,
      globalLastRun: execution.lastRun,
      globalRunCount: execution.count,
      // The triage lane's last ranked "Recommended next audits" (#12085).
      recommendedAudits: execution.recommendedAudits || null,
      perAppCount: Object.keys(execution.perApp).length,
      appOverrides,
      enabledAppCount,
      totalAppCount,
      appSchedules,
      status: check,
      description: interval.description || getTaskTypeDescription(taskType),
      promptMode: promptInfo.mode,
      ...(promptInfo.description ? { promptDescription: promptInfo.description } : {}),
      invocation,
      // Whether a "Run Now" with NO app is this type's real run (it sweeps every
      // managed app in one dispatch). Served from the server registry rather than
      // mirrored in client constants, so the UI cannot drift from the set the
      // dispatch engines actually treat as install-wide.
      installWide: INSTALL_WIDE_TASK_TYPES.has(taskType),
      // Whether PortOS executes this type ITSELF (services/scheduledHandlers/)
      // rather than dispatching an agent. Served from the registry rather than
      // mirrored in client constants for the same reason as `installWide`: the
      // UI must not drift from the set the dispatch engines actually treat as
      // programmatic. It drives the Run Now affordance (no app picker — these
      // never target a managed app) and the prompt panel (there is no prompt).
      programmatic: isProgrammaticScheduledTaskType(taskType)
    };

    // Include default stage prompts for pipeline tasks so UI can display them
    if (interval.taskMetadata?.pipeline?.stages?.length > 0) {
      taskStatus.stagePrompts = interval.taskMetadata.pipeline.stages.map(stage =>
        DEFAULT_TASK_PROMPTS[stage.promptKey] || null
      );
    }

    // Surface agent-managed flags so the UI can lock the corresponding toggles
    if (MANAGED_AGENT_OPTIONS[taskType]) {
      taskStatus.managedAgentOptions = MANAGED_AGENT_OPTIONS[taskType];
    }

    if (isAuditTaskType(taskType)) {
      taskStatus.fileIssuesCapable = true;
      taskStatus.defaultFileIssues = defaultFileIssuesFor(taskType);
      if (auditDoWorkRequiresWorktree(taskType)) {
        taskStatus.doWorkRequiresWorktree = true;
      }
    } else if (taskType === 'user-action-review') {
      // Not an audit-catalog type (no mode-contract injection — its
      // alternative to filing issues is queueing CoS tasks, not editing code),
      // but its deliverable posture is the same fileIssues toggle, so the
      // schedule UI surfaces the switch the same way.
      taskStatus.fileIssuesCapable = true;
      taskStatus.defaultFileIssues = true;
    }

    // Perpetual tasks park PER-APP (parkPerpetual is called with the appId), so
    // the global `status` above (shouldRunTask with no appId) always reads
    // 'perpetual-drain' for app-scoped tasks like claim-issue/claim-work even
    // when every app is parked. Aggregate the per-app (and global) park records
    // so the UI can show the true parked/draining state and the soonest recheck.
    // Projects the shared aggregatePerpetualParks rollup (same park semantics as
    // the getUpcomingTasks eligibility derivation below).
    if (interval.perpetual) {
      const parks = aggregatePerpetualParks(execution, Date.now());
      // Named apart from the `perpetual` BOOLEAN this config carries: the flag
      // says the task drains, this says what its drain is doing right now.
      taskStatus.perpetualStatus = {
        globalParked: parks.globalParked,
        parkedAppCount: parks.parkedAppCount,
        trackedAppCount: parks.trackedAppCount,
        nextRecheckAt: parks.soonestParkAt === null ? null : new Date(parks.soonestParkAt).toISOString(),
        parkReason: parks.parkReason,
        ...(parks.parkCounts != null && { parkCounts: parks.parkCounts }),
        ...(parks.parkSkipCauses != null && { parkSkipCauses: parks.parkSkipCauses }),
        // A stall means the probe (e.g. gh/glab) has failed several evaluations
        // in a row WITHOUT parking — the drain keeps ticking, so it can be
        // present at the same time `globalParked`/`parkedAppCount` read "not
        // parked". Null when the probe is healthy.
        stall: aggregatePerpetualStall(execution)
      };
    }

    if (taskType === 'branch-reconcile') {
      const outcomes = [
        ...(execution.branchReconcileOutcome ? [[null, execution.branchReconcileOutcome]] : []),
        ...Object.entries(execution.perApp || {}).filter(([, record]) => record.branchReconcileOutcome)
          .map(([appId, record]) => [appId, record.branchReconcileOutcome]),
      ];
      // Raw persisted outcomes. The HTTP boundary adds the missing-checkout
      // annotations (branchReconcileOutcome.annotateMissingCheckouts) so this
      // module never reaches the receipt ledger.
      taskStatus.reconcileOutcomes = Object.fromEntries(outcomes);
    }
    status.tasks[taskType] = taskStatus;
  }

  return status;
}

/**
 * Aggregate a perpetual task's park records into a single upcoming-eligibility
 * verdict for getUpcomingTasks.
 *
 * Perpetual parks are recorded PER-APP (parkPerpetual is always called with an
 * appId — see applyPerpetualWorkGate / the reconcile blocks in cosTaskGenerator),
 * so the top-level execution record is only a container and never carries its own
 * `parkedUntil` for the app-scoped drains (claim-issue, claim-work, branch-/
 * issue-reconcile). The GLOBAL `shouldRunTask` therefore always reads
 * 'perpetual-drain' (shouldRun:true) even when every app is parked on its recheck
 * cadence — which made getUpcomingTasks report the task 'ready' forever and hid
 * its real next-recheck boundary (e.g. a `recheckCron: '0 9 * * *'`) from
 * scheduleNextImprovementCheck. The daemon then never woke AT 9am; the parked
 * drain only resumed on the ≤1h fallback poll, so a task configured for 9am ran
 * up to an hour late (or read as "didn't run").
 *
 * Derive eligibility from the shared aggregatePerpetualParks rollup instead (see
 * its GLOBAL-RECORD INCLUSION RULE for which scopes count). Returns:
 *   - null                                    → no tracked scope yet (caller keeps its global 'ready' default)
 *   - { status:'ready', eligibleAt:now }      → some tracked scope is due now (unparked or park elapsed)
 *   - { status:'scheduled', eligibleAt:<ms> } → every tracked scope parked; soonest recheck
 */
function perpetualUpcomingEligibility(execution, now) {
  const parks = aggregatePerpetualParks(execution, now);
  if (parks.trackedCount === 0) return null;
  return parks.anyDueNow
    ? { status: 'ready', eligibleAt: now }
    : { status: 'scheduled', eligibleAt: parks.soonestParkAt };
}

export async function getUpcomingTasks(limit = 10) {
  const schedule = await loadSchedule();
  const now = Date.now();
  const upcoming = [];
  const featureEnabled = createFeatureGate();
  // The improvement daemon queues per-app work, so its wake-up preview must
  // include app-scoped cadence overrides. In particular, an app can opt into a
  // cron expression while the global task remains on-demand; omitting that
  // boundary leaves the hourly fallback as the only chance to notice the slot.
  //
  // Strict on purpose (#7527): a rejected inventory/override read used to be
  // swallowed into [] / {}, which looked like "no apps configured" rather than
  // "the calculation is unavailable" — cosJobScheduler.scheduleNextImprovementCheck
  // would then arm its 1h fallback and could sleep through a cron minute a
  // healthy read would have caught. Let the rejection propagate; the caller
  // owns the retry.
  const activeApps = await getActiveApps();
  const activeAppOverrides = activeApps.length > 0
    ? await mapWithConcurrency(activeApps, 8, (app) => getAppTaskTypeOverrides(app.id))
    : [];

  for (const [taskType, interval] of Object.entries(schedule.tasks)) {
    if (!interval.enabled) continue;
    if (!(await featureEnabled(interval))) continue;
    if (getTaskTypeInvocation(taskType).visibility === 'hidden') continue;

    const check = await shouldRunTask(taskType, null, { featureEnabled, schedule });
    const execution = schedule.executions[`task:${taskType}`] || { lastRun: null, count: 0 };

    // `shouldRunTask(taskType, appId)` resolves the same effective cadence used
    // by the queue path, including an app's raw cron override and its own last
    // run. A due app makes the task ready; otherwise the soonest app boundary
    // is the wake-up deadline. This also handles a globally on-demand task that
    // has no global candidate but is cron-scheduled for one managed app.
    // An inheriting app rides the global `check` above; only an app stating its
    // OWN cron adds a boundary the global cadence cannot see.
    const scheduledApps = appsWithOwnCron(taskType, interval, activeApps, activeAppOverrides)
      .map(candidate => candidate.app);
    const appChecks = scheduledApps.length > 0
      ? await mapWithConcurrency(scheduledApps, 8, (app) =>
        shouldRunTask(taskType, app.id, { featureEnabled, schedule }))
      : [];
    const appReady = appChecks.some(appCheck => appCheck?.shouldRun);
    const futureAppTimes = appChecks.map(appCheck => Date.parse(appCheck?.nextRunAt))
      .filter(time => Number.isFinite(time) && time > now);
    const nextAppAt = futureAppTimes.length ? Math.min(...futureAppTimes) : null;
    const appUpcoming = appReady
      ? { status: 'ready', eligibleAt: now }
      : nextAppAt !== null ? { status: 'scheduled', eligibleAt: nextAppAt } : null;
    const futureTimes = [Date.parse(check.nextRunAt), nextAppAt]
      .filter(time => Number.isFinite(time) && time > now);
    const nextScheduledAt = futureTimes.length ? Math.min(...futureTimes) : null;

    // On-demand tasks have no wall-clock position — unless they are perpetual,
    // whose park/recheck boundary IS the schedule the daemon must wake on, or
    // an enabled managed app supplies a scheduled override.
    if (interval.type === INTERVAL_TYPES.ON_DEMAND && (!interval.perpetual || interval.autoStart === false) && !appUpcoming) continue;

    let eligibleAt = null;
    let taskStatus = null;

    if (check.shouldRun) {
      eligibleAt = now;
      taskStatus = 'ready';
    } else if (check.nextRunAt) {
      eligibleAt = new Date(check.nextRunAt).getTime();
      taskStatus = 'scheduled';
    }

    if (appUpcoming) {
      if (appUpcoming.status === 'ready') {
        taskStatus = 'ready';
        eligibleAt = now;
      } else if (taskStatus !== 'ready' && (eligibleAt === null || appUpcoming.eligibleAt < eligibleAt)) {
        taskStatus = 'scheduled';
        eligibleAt = appUpcoming.eligibleAt;
      }
    }

    // No global or per-app wall-clock candidate (for example a plain
    // on-demand task, or a task blocked by a weekday/dependency gate) has no
    // place in an upcoming schedule preview.
    if (!taskStatus) continue;

    // Perpetual tasks park per-app, so the global `check` above can't see the
    // recheck boundary — re-derive status/eligibility from the park records so
    // scheduleNextImprovementCheck wakes the daemon AT the next recheck (e.g. 9am)
    // instead of only on the ≤1h fallback poll. See perpetualUpcomingEligibility.
    if (interval.perpetual) {
      const perpetual = perpetualUpcomingEligibility(execution, now);
      if (perpetual) {
        taskStatus = perpetual.status;
        eligibleAt = perpetual.eligibleAt;
      }
    }

    upcoming.push({
      taskType,
      intervalType: interval.type,
      nextScheduledAt,
      status: taskStatus,
      eligibleAt,
      eligibleIn: eligibleAt - now,
      eligibleInFormatted: formatTimeRemaining(eligibleAt - now),
      lastRun: execution.lastRun,
      lastRunFormatted: execution.lastRun ? formatRelativeTime(new Date(execution.lastRun).getTime()) : 'never',
      runCount: execution.count,
      successRate: check.successRate ?? null,
      description: interval.description || getTaskTypeDescription(taskType)
    });
  }

  upcoming.sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (b.status === 'ready' && a.status !== 'ready') return 1;
    return a.eligibleAt - b.eligibleAt;
  });

  return upcoming.slice(0, limit);
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
