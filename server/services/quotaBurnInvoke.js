/**
 * The ONE path a quota-burn step takes to run its work.
 *
 * A burn step REFERENCES a scheduled task the user already owns
 * (`lib/quotaBurnTaskRef.js`), so running it means invoking that task the way anything
 * else does, never re-implementing it (which would walk past canonical task generation
 * and its gates). A step still carrying a legacy `jobType` resolves to
 * `LEGACY_UNMIGRATED` and is refused, never executed.
 *
 * Three reference shapes, three canonical invocations:
 *
 *   built-in AGENT task  -> `taskSchedule.triggerOnDemandTask(type, appId,
 *                           { origin: QUOTA_BURN, burn })`. Acceptance is
 *                           ASYNCHRONOUS; burn provenance rides on the request.
 *   built-in PROGRAMMATIC -> `scheduledHandlers.runScheduledHandler` directly with the
 *                           burning `family`, so the render backend stays pinned to the
 *                           subscription being drained (the request queue would drop
 *                           `family` and spend the wrong provider).
 *   CUSTOM app job        -> `autonomousJobs.generateTaskFromJob` + `addTask`, the
 *                           pair the scheduled fire uses.
 *
 * **This is not the manual endpoint.** `POST /jobs/:id/trigger` hands a human three
 * privileges an unattended burn must never inherit: `approvalRequired: false`,
 * `forceSpawnTask` past the scheduling gates, and `reviveBlockedTask`. A burn queues the
 * task and stops, leaves a blocked twin blocked, and REFUSES a job needing human
 * approval (parking it would consume dispatch budget for work that spends nothing).
 *
 * `force` means "the user clicked play": it bypasses the QUOTA gates in
 * `quotaBurn.js#evaluateFamily` and lets a programmatic handler relax its own in-flight
 * cooldown. It never relaxes task eligibility, approval, target scope, enabled state,
 * the master Improve gate or the duplicate checks: those decide whether the work may run
 * at all, and a duplicate is the same work twice.
 */

import {
  QUOTA_BURN_TASK_REF_KIND,
  QUOTA_BURN_UNAVAILABLE,
  enabledAppIdsByTaskType,
  resolveQuotaBurnStepAvailability,
} from '../lib/quotaBurnTaskRef.js';
import { isAuditTaskType } from '../lib/auditCatalog.js';
import { generatedJobTaskFields } from '../lib/autonomousJobTask.js';
import { isProgrammaticScheduledTaskType } from '../lib/taskTargetScope.js';
import { ON_DEMAND_ORIGINS } from './taskScheduleConstants.js';

/** The autonomy level a custom job must carry for an UNATTENDED burn to run it. */
const UNATTENDED_AUTONOMY_LEVEL = 'yolo';

const declined = (reason) => ({ dispatched: false, reason });
/** What a log line calls the thing being spent — a family, or nothing at all. */
const burnLabel = (family) => family?.id || 'no subscription family';
const noWork = (detail) => ({ count: 0, detail });
// `Object.hasOwn` so a reference naming an inherited key like `constructor` resolves to nothing.
const entryOf = (map, key) => (map && Object.hasOwn(map, key) ? map[key] : null);

/**
 * The live task catalog `resolveQuotaBurnStepAvailability` resolves a reference
 * against: `{ builtin: { [taskType]: { enabled, featureEnabled, feature,
 * eligible, appIds } }, custom: { [jobId]: { enabled, eligible, appId } },
 * improvementEnabled }`.
 *
 * The built-in entry is the `entry` shape `evaluateOnDemandEligibility` reads, so the
 * page's verdict comes from the ladder that decides dispatch. The instance-FEATURE gate
 * is its own field so the ladder can say which switch is off. `eligible` excludes a type
 * another automation owns (`userInvokable: false`) and non-agent custom jobs.
 * `appIds` is the ACTIVE apps with the type on, so a removed app resolves as wrong-scope.
 * `improvementEnabled` is the master Improve switch, `null` when unreadable (fails
 * CLOSED).
 *
 * Entries also carry their source record and the catalog the `queued` on-demand set, all
 * from ONE snapshot: `loadSchedule()` is uncached, so per-step reads made the status
 * probe pay its full cost per step. Manual maintenance catalogs bypass built-in cadence
 * switches without changing saved settings.
 */
export async function getQuotaBurnTaskCatalog({ manual = false } = {}) {
  const [{ loadSchedule }, { getTaskTypeInvocation }, { getActiveApps }, { createFeatureGate }, { getAllJobs }, { isImprovementEnabled, loadState }] =
    await Promise.all([
      import('./taskScheduleStore.js'),
      import('./taskScheduleRegistry.js'),
      import('./apps.js'),
      import('./taskSchedule.js'),
      import('./autonomousJobs.js'),
      import('./cosState.js'),
    ]);

  const [schedule, apps, jobs, state] = await Promise.all([
    loadSchedule(),
    getActiveApps().catch(() => []),
    getAllJobs().catch(() => []),
    loadState().catch(() => null),
  ]);

  // Overrides come off the app records already loaded; `getAppTaskTypeOverrides` would
  // re-enter the app store per app, and its legacy migration only synthesizes
  // `{ enabled: false }` entries that are discarded here.
  const appIdsByTaskType = enabledAppIdsByTaskType(apps);

  // The schedule's own gate, so the verdict agrees with `triggerOnDemandTask`.
  const featureEnabled = createFeatureGate();
  const builtin = {};
  await Promise.all(Object.entries(schedule?.tasks || {}).map(async ([taskType, config]) => {
    builtin[taskType] = {
      enabled: manual || config?.enabled === true,
      featureEnabled: await featureEnabled(config),
      feature: config?.feature || null,
      eligible: getTaskTypeInvocation(taskType).userInvokable !== false,
      appIds: manual ? undefined : appIdsByTaskType.get(taskType) || [],
      config,
    };
  }));

  const custom = Object.fromEntries((jobs || []).map((job) => [job.id, {
    enabled: job.enabled === true,
    eligible: isBurnEligibleCustomJob(job),
    appId: job.appId || null,
    job,
  }]));

  return {
    builtin,
    custom,
    improvementEnabled: state ? isImprovementEnabled(state) : null,
    queued: queuedOnDemandKeys(schedule),
  };
}

/** `taskType` + app scope of every on-demand request already waiting to drain. */
const onDemandKey = (taskType, appId) => `${taskType}::${appId ?? ''}`;
const queuedOnDemandKeys = (schedule) =>
  new Set((schedule?.onDemandRequests || []).map((request) => onDemandKey(request.taskType, request.appId)));

/** Whether a custom app job is something a burn may invoke: `shell` and `script` jobs spend no provider quota. Jobs without `type` are agent jobs. */
export function isBurnEligibleCustomJob(job) {
  return Boolean(job) && (!job.type || job.type === 'agent');
}

/**
 * Resolve a step against the live catalog into everything an invocation needs, or the
 * `unavailable` verdict. `effective` is the step's overrides layered over the task's SAVED
 * settings; nothing is written back.
 */
export async function resolveQuotaBurnStep(step, catalog = null, { explicit = false } = {}) {
  const resolvedCatalog = catalog || await getQuotaBurnTaskCatalog();
  const unavailable = resolveQuotaBurnStepAvailability(step, resolvedCatalog);
  if (unavailable) return { unavailable };

  const ref = step.taskRef;
  if (ref.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM) {
    // An EMPTY catalog (failed read) passes the resolver; dispatch can't run on overrides
    // alone with no saved settings to inherit.
    const job = entryOf(resolvedCatalog.custom, ref.jobId)?.job;
    if (!job) {
      return { unavailable: { code: QUOTA_BURN_UNAVAILABLE.DANGLING_JOB, reason: `custom scheduled job "${ref.jobId}" could not be read` } };
    }
    return { kind: 'custom', catalog: resolvedCatalog, ref, job, effective: effectiveSettings(step, job) };
  }

  const interval = entryOf(resolvedCatalog.builtin, ref.taskType)?.config;
  if (!interval) {
    return { unavailable: { code: QUOTA_BURN_UNAVAILABLE.UNKNOWN_TASK, reason: `scheduled task "${ref.taskType}" could not be read` } };
  }
  const effective = effectiveSettings(step, interval);
  // Here so the probe and the runner agree an inapplicable audit is not ready work.
  const notApplicable = explicit ? null : await notApplicableReason(ref, effective.params);
  if (notApplicable) return { unavailable: { code: QUOTA_BURN_UNAVAILABLE.NOT_APPLICABLE, reason: notApplicable } };
  return {
    kind: isProgrammaticScheduledTaskType(ref.taskType) ? 'programmatic' : 'builtin',
    // Lets callers keep reading one snapshot instead of the uncached schedule store.
    catalog: resolvedCatalog,
    ref,
    interval,
    effective,
  };
}

/** Why an audit step cannot apply to its app, or null — honoring the user's explicit override. */
async function notApplicableReason(ref, params) {
  if (!ref.appId || params?.runInapplicableAudit === true || !isAuditTaskType(ref.taskType)) return null;
  const { inapplicableAuditReason } = await import('./appQualitySchedule.js');
  const reason = await inapplicableAuditReason(ref.appId, ref.taskType);
  return reason ? `"${ref.taskType}" does not apply to this app: ${reason}` : null;
}

/**
 * Layer a step's overrides over saved settings. `??` is correct because an unset override
 * is already `null`; `params` MERGE key-by-key.
 */
export function effectiveSettings(step, saved) {
  const overrides = step?.overrides || {};
  return {
    providerId: overrides.providerId ?? saved?.providerId ?? null,
    model: overrides.model ?? saved?.model ?? null,
    effort: overrides.effort ?? saved?.effort ?? null,
    ...((overrides.executionOptions ?? saved?.executionOptions) !== undefined ? { executionOptions: overrides.executionOptions ?? saved.executionOptions } : {}),
    params: { ...(saved?.taskMetadata || {}), ...(overrides.params || {}) },
  };
}

/**
 * `countPending(reference) -> { count, detail, context? }`: the probe contract the runner
 * and the status page share. Side-effect free: no writes, no enqueues, no AI provider call
 * (the status page calls it per step on every load).
 *
 *   - an eligible AI agent task reports ONE ready unit;
 *   - an ineligible, disabled, dangling or ALREADY-ACTIVE task reports zero with the reason;
 *   - a programmatic handler reports its own backlog and may return an opaque `context`
 *     for `run` to reuse.
 */
export async function countQuotaBurnStepPending({ step, family, catalog = null } = {}) {
  const resolved = await resolveQuotaBurnStep(step, catalog);
  if (resolved.unavailable) return noWork(resolved.unavailable.reason);

  if (resolved.kind === 'programmatic') {
    const { countScheduledHandlerPending } = await import('./scheduledHandlers/index.js');
    return countScheduledHandlerPending({
      taskType: resolved.ref.taskType,
      params: resolved.effective.params,
      job: resolved.effective,
      family,
    });
  }

  // Approval outranks the provider check, matching `runCustomJobStep`.
  // report a provider problem the user would then go and "fix".
  const approval = resolved.kind === 'custom' ? unattendedApprovalRefusal(resolved.job) : null;
  if (approval) return noWork(approval);

  // Both agent lanes need a provider in the burning family, else the runner must move on
  // rather than dispatch onto another subscription.
  const picked = await resolveStepProvider(resolved.effective, family);
  if (picked.error) return noWork(picked.error);

  if (resolved.kind === 'custom') {
    const active = await activeCustomJobReason(resolved.job);
    return active ? noWork(active) : { count: 1, detail: `ready to queue "${resolved.job.name}" via ${picked.provider.id}` };
  }

  const queued = await queuedOnDemandReason(resolved.catalog?.queued, resolved.ref.taskType, resolved.ref.appId);
  return queued
    ? noWork(queued)
    : { count: 1, detail: `ready to run scheduled task "${resolved.ref.taskType}" via ${picked.provider.id}` };
}

/**
 * The provider a burn will actually spend, or a refusal. Without this a step whose family
 * has no enabled CLI/TUI provider would queue on the daemon's pick and spend another
 * subscription. `providerForFamily` honors a pin WITHOUT re-checking its family, so the
 * check is made here against the resolved record (the command basename identifies a
 * family: `antigravity-cli` is `agy`; an id-substring rule strands whole families).
 *
 * Programmatic handlers don't come through here: each resolves its backend from `family`.
 * An UNFAMILIED run (only `maintenanceRun.js` makes one) has no window to misspend, and
 * `providerForFamily` still requires an ENABLED, process-capable provider.
 */
async function resolveStepProvider(effective, family) {
  const { noProviderReason, matchesFamily, isUnfamiliedBurn, resolveBurnProvider } = await import('./scheduledHandlers/providerPick.js');
  const provider = await resolveBurnProvider({ job: { providerId: effective.providerId }, family });
  if (!provider) {
    return {
      error: effective.providerId
        ? `pinned provider "${effective.providerId}" is not an enabled CLI/TUI provider`
        : noProviderReason(family),
    };
  }
  if (!isUnfamiliedBurn(family) && !matchesFamily(provider, family.id)) {
    return { error: `pinned provider "${provider.id}" does not belong to the ${family.id} family` };
  }
  return { provider };
}

/**
 * Why an unattended burn may not run this custom job, or null. Below `yolo` the job needs an
 * approval a burn cannot give, and the manual endpoint's bypass must not be inherited.
 */
function unattendedApprovalRefusal(job) {
  return job.autonomyLevel === UNATTENDED_AUTONOMY_LEVEL
    ? null
    : `custom scheduled job "${job.name}" needs approval to run (autonomy level "${job.autonomyLevel || 'manager'}") — a quota burn cannot approve it`;
}

/**
 * Whether an equivalent invocation of this custom job is already in flight. Reuses
 * `cosJobScheduler.isJobFireInFlight`: part of it (`spawningJobIds`) is process-local state
 * a copy could not see.
 */
async function activeCustomJobReason(job) {
  const [{ loadState }, { isJobFireInFlight }] = await Promise.all([
    import('./cosState.js'),
    import('./cosJobScheduler.js'),
  ]);
  const state = await loadState().catch(() => null);
  if (!state) return null;
  return isJobFireInFlight(job.id, state) ? `a run of "${job.name}" is already in flight` : null;
}

/**
 * Whether this built-in task already has an on-demand request waiting; otherwise two burn
 * cycles stack requests and `addTask` dedup only catches it after the cap was charged.
 */
async function queuedOnDemandReason(queued, taskType, appId) {
  const pending = queued instanceof Set
    ? queued.has(onDemandKey(taskType, appId))
    // No snapshot: ask the schedule directly rather than reporting "nothing queued".
    : (await import('./taskSchedule.js')
      .then(({ getOnDemandRequests }) => getOnDemandRequests())
      .catch(() => []))
      .some((request) => onDemandKey(request.taskType, request.appId) === onDemandKey(taskType, appId));
  return pending ? `an on-demand run of "${taskType}" is already queued` : null;
}

/**
 * Invoke one burn step. Returns the registry's dispatch shape
 * `{ dispatched, summary?, reason?, detail?, awaiting? }`.
 *
 * A decline is reported, never thrown: work that failed to start must not charge the cap.
 * `awaiting` marks a dispatch not yet accepted, so the runner reserves instead of charging
 * (`quotaBurnAcceptance.js`). The master Improve switch is refused HERE for all three lanes
 * so a burn can't spend while CoS improvement is off.
 */
export async function invokeQuotaBurnStep({ step, family, candidate, context, force = false, catalog = null, maintenanceRunId = null } = {}) {
  // A forced run is the user clicking this one step: like a manual Run, it is an
  // A forced run is an explicit choice; not refused as not-applicable.
  const resolved = await resolveQuotaBurnStep(step, catalog, { explicit: force });
  // The code lets a caller tell "does not apply" (skipped) from a refusal to hold on.
  if (resolved.unavailable) return { ...declined(resolved.unavailable.reason), code: resolved.unavailable.code };

  if (resolved.kind === 'programmatic') return runProgrammaticStep({ resolved, family, context, force });
  if (resolved.kind === 'custom') return runCustomJobStep({ resolved, step, family, candidate, maintenanceRunId });
  return runBuiltinTaskStep({ resolved, step, family, candidate, maintenanceRunId });
}

/** A programmatic handler runs INLINE: no agent, no slot. `family` pins the render backend (see `scheduledHandlers/index.js`). */
async function runProgrammaticStep({ resolved, family, context, force }) {
  const { runScheduledHandler } = await import('./scheduledHandlers/index.js');
  return runScheduledHandler({
    taskType: resolved.ref.taskType,
    params: resolved.effective.params,
    job: resolved.effective,
    family,
    context,
    force,
  });
}

/**
 * A built-in agent task goes through the schedule's on-demand lane, so every gate is
 * enforced by `triggerOnDemandTask` via `evaluateOnDemandEligibility`, the same ladder
 * `resolveQuotaBurnStep` ran. `force` is NOT passed: it means "past the quota gates".
 */
async function runBuiltinTaskStep({ resolved, step, family, candidate, maintenanceRunId }) {
  // Re-checked HERE: a forced run skips the probe and `triggerOnDemandTask` appends
  // unconditionally, so two forced clicks would double-queue and double-charge.
  const queued = await queuedOnDemandReason(resolved.catalog?.queued, resolved.ref.taskType, resolved.ref.appId);
  if (queued) return declined(queued);


  const picked = await resolveStepProvider(resolved.effective, family);
  if (picked.error) return declined(picked.error);

  const { triggerOnDemandTask } = await import('./taskSchedule.js');
  const request = await triggerOnDemandTask(resolved.ref.taskType, resolved.ref.appId, {
    origin: ON_DEMAND_ORIGINS.QUOTA_BURN,
    burn: {
      // Omitted, not null, when no subscription window is spent (`maintenanceRunId` attributes).
      ...(family.id ? { family: family.id } : {}),
      stepId: step.id,
      limitingResetAt: candidate?.limitingResetAt ?? null,
      // Set only by a MANUAL maintenance run: keeps the quota-burn loop from walking its plan
      // on this agent's completion.
      ...(maintenanceRunId ? { maintenanceRunId } : {}),
      overrides: {
        // The RESOLVED provider, not the step's pin, so an unpinned step lands on this family.
        providerId: picked.provider.id,
        model: resolved.effective.model,
        effort: resolved.effective.effort,
        ...(resolved.effective.executionOptions !== undefined ? { executionOptions: resolved.effective.executionOptions } : {}),
        // Run params, handed to the generator as `runOverrides` before the mode banner and
        // prompt are built (carries a migrated issues-only burn's `fileIssues: true`). The
        // generator merges saved global/app metadata itself; resending defaults here would
        // overwrite app-specific claim filters.
        params: step.overrides?.params || {},
      },
    },
  });
  if (request?.error) return declined(request.error);

  // Shared by the quota-burn loop and MANUAL maintenance runs; key the wording on provenance
  // so a maintenance dispatch doesn't read as quota-burn activity.
  console.log(maintenanceRunId
    ? `🧹 Maintenance run ${maintenanceRunId} requested scheduled task ${resolved.ref.taskType} (${request.id})`
    : `🔥 Quota-burn requested scheduled task ${resolved.ref.taskType} for ${burnLabel(family)} (${request.id})`);
  return {
    dispatched: true,
    // The only lane with asynchronous acceptance: the runner reserves instead of charging and
    // settles when the request joins its task (`quotaBurnAcceptance.js`).
    awaiting: { requestId: request.id },
    summary: `Requested "${resolved.ref.taskType}"${resolved.ref.appId ? ` for ${resolved.ref.appId}` : ''}`,
    detail: {
      requestId: request.id,
      taskType: resolved.ref.taskType,
      appId: resolved.ref.appId,
      providerId: picked.provider.id,
      model: resolved.effective.model,
      effort: resolved.effective.effort,
      ...(resolved.effective.executionOptions !== undefined ? { executionOptions: resolved.effective.executionOptions } : {}),
    },
  };
}

/**
 * A custom app job is generated by the job's generator and queued with `addTask`, carrying
 * the step's overrides and burn provenance. `approvalRequired` follows the job's autonomy
 * level (already gated to `yolo`); no `forceSpawnTask`, no reviving a blocked twin.
 */
async function runCustomJobStep({ resolved, step, family, candidate, maintenanceRunId }) {
  const approval = unattendedApprovalRefusal(resolved.job);
  if (approval) return declined(approval);
  // `addTask` dedup catches a QUEUED twin but not one mid-spawn; a forced run has no probe.
  const active = await activeCustomJobReason(resolved.job);
  if (active) return declined(active);
  const picked = await resolveStepProvider(resolved.effective, family);
  if (picked.error) return declined(picked.error);

  const [{ generateTaskFromJob }, { addTask }] = await Promise.all([
    import('./autonomousJobs.js'),
    import('./cosTaskStore.js'),
  ]);
  const generated = await generateTaskFromJob(resolved.job);
  const persisted = await addTask({
    // Shared field projection with the manual endpoint; what follows deliberately overrides it.
    ...generatedJobTaskFields(generated),
    // Names who asked for it, so a maintenance dispatch doesn't read as a quota-burn spend.
    context: maintenanceRunId
      ? `Maintenance run ${maintenanceRunId}: ${resolved.job.name}`
      : `Quota burn (${burnLabel(family)}): ${resolved.job.name}`,
    approvalRequired: !generated.autoApprove,
    // Step overrides win over the job's saved pins; an unpinned step lands on THIS family.
    provider: picked.provider.id,
    model: resolved.effective.model || undefined,
    effort: resolved.effective.effort || undefined,
    ...(resolved.effective.executionOptions !== undefined ? { executionOptions: resolved.effective.executionOptions } : {}),
    // Same attribution keys the built-in lane stamps via its request. No
    // `quotaBurnRequestId`: that records the ASYNC hop and a fake one would corrupt a join.
    // Omit, never placeholder.
    ...(family.id ? { quotaBurnFamily: family.id } : {}),
    quotaBurnLimitingResetAt: candidate?.limitingResetAt ?? null,
    quotaBurnStepId: step.id,
    ...(maintenanceRunId ? { quotaBurnMaintenanceRunId: maintenanceRunId } : {}),
  }, 'internal', { suppressDequeue: true });

  if (!persisted?.id) return declined(`"${resolved.job.name}" was not queued`);
  // A blocked twin stays blocked: reviving is the manual endpoint's explicit retry.
  if (persisted.duplicate) return declined(`an identical "${resolved.job.name}" task is already ${persisted.status}`);

  // Same attribution rule as the built-in lane.
  console.log(maintenanceRunId
    ? `🧹 Maintenance run ${maintenanceRunId} queued custom job ${resolved.job.id} as task ${persisted.id}`
    : `🔥 Quota-burn queued custom job ${resolved.job.id} as task ${persisted.id} for ${burnLabel(family)}`);
  return {
    dispatched: true,
    summary: `Queued "${resolved.job.name}" via ${picked.provider.id}`,
    detail: {
      taskId: persisted.id,
      jobId: resolved.job.id,
      providerId: picked.provider.id,
      model: resolved.effective.model,
      effort: resolved.effective.effort,
      ...(resolved.effective.executionOptions !== undefined ? { executionOptions: resolved.effective.executionOptions } : {}),
    },
  };
}
