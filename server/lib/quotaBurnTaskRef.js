/**
 * Quota-burn step → scheduled-task REFERENCE, plus its per-invocation overrides. A step stores a reference instead of a copied prompt, so preset identity no longer depends on prompt text.
 *
 * Two reference kinds, discriminated on `kind`:
 *   - `builtin`: a PortOS scheduled task TYPE (`ux`, `security`, …) plus the managed app it targets when the type requires one (scope rules from `taskTargetScope.js`).
 *   - `custom`: an app custom scheduled job by id. The job owns its app scope, so the reference stores no `appId` (a second copy could disagree).
 * Anything the burn wants to do differently from the task's saved settings lives in `overrides` (provider/model/effort/params); unset inherits, and nothing writes back to the schedule.
 *
 * Pure: shape, normalization, and a resolver that takes the catalog as an argument; no storage, provider I/O, or imports out of `lib/`.
 *
 * `evaluateOnDemandEligibility` is deliberately WIDER than the burn: the one gate ladder for invoking a built-in scheduled task on demand, read by this resolver (so the page can say why a step
 * cannot run) and by `taskSchedule.triggerOnDemandTask` (so dispatch refuses for the same reasons). It lives in `lib/` so a service and a display path can share it (#6405).
 */

import { QUOTA_BURN_TASK_REF_KIND } from './quotaBurnTaskRefKind.js';
import { isPlainObject, POLLUTING_KEYS } from './objects.js';
import { auditDomainFor, currentTaskTypeName } from './scheduledTaskTypes.js';
import { requiresInstallWideTarget, requiresManagedAppTarget } from './taskTargetScope.js';
import { trimTo } from './textUtils.js';

export { QUOTA_BURN_TASK_REF_KIND };

/**
 * Why a step is retained but not dispatchable: a code the client can react to plus a human-readable `reason`. A step is never DELETED for being unavailable
 * (its label, order, overrides and run-once state are the user's, and a returning task should find its step intact).
 */
export const QUOTA_BURN_UNAVAILABLE = Object.freeze({
  /** A legacy `jobType` payload that migration has not converted to a reference yet. */
  LEGACY_UNMIGRATED: 'legacy-unmigrated',
  /** A `builtin` reference naming a task type this install does not ship. */
  UNKNOWN_TASK: 'unknown-task',
  /** A `custom` reference whose job id no longer exists. */
  DANGLING_JOB: 'dangling-job',
  /** The referenced task/job exists but is switched off. */
  DISABLED: 'disabled',
  /** A type that requires a managed app, with none named. */
  MISSING_APP: 'missing-app',
  /** An app named that the type cannot target (install-wide type, or an app that is gone). */
  WRONG_SCOPE: 'wrong-scope',
  /** The task exists and is enabled, but is not something a burn may invoke. */
  INCOMPATIBLE: 'incompatible',
  /** The master CoS Improve switch is off or unreadable (fails closed). Its own code, not `DISABLED`: the fix is in CoS → Config and every step reports it at once. */
  IMPROVEMENT_DISABLED: 'improvement-disabled',
  /** A quality audit the target repo cannot have findings for (see `resolveAuditApplicability`); exempt with the step's `runInapplicableAudit` override. */
  NOT_APPLICABLE: 'not-applicable',
});

const MAX_REF_FIELD = 64;

const nullable = (value, max) => trimTo(value, max) || null;

/**
 /**
  * Normalize a stored/submitted task reference, or `null` when there is no usable one (the caller decides if that is a legacy step). Never GUESSES a kind:
  * inferring one from `taskType` would silently downgrade a reference.
  */
export function normalizeQuotaBurnTaskRef(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.kind === QUOTA_BURN_TASK_REF_KIND.BUILTIN) {
    // A step saved before a task rename (TASK_TYPE_RENAMES) resolves to the current name, or it reads as an unknown task and never runs.
    const taskType = auditDomainFor(currentTaskTypeName(trimTo(raw.taskType, MAX_REF_FIELD)));
    if (!taskType) return null;
    return { kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN, taskType, appId: nullable(raw.appId, MAX_REF_FIELD) };
  }
  if (raw.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM) {
    const jobId = trimTo(raw.jobId, MAX_REF_FIELD);
    if (!jobId) return null;
    return { kind: QUOTA_BURN_TASK_REF_KIND.CUSTOM, jobId };
  }
  return null;
}

/**
 /**
  * A step's per-invocation overrides bag, normalized to JSON-ish scalars. `params` stays free-form (each task type owns what it reads) but its DEPTH is enforced.
  * The two length caps are REQUIRED and injected: this module must stay free of `quotaBurnConfig.js` (which imports it), and defaults here would be a second bounds table.
  */
export function normalizeQuotaBurnOverrides(raw, { maxParamLength, maxFieldLength }) {
  const value = isPlainObject(raw) ? raw : {};
  return {
    providerId: nullable(value.providerId, maxFieldLength),
    model: nullable(value.model, maxFieldLength),
    effort: nullable(value.effort, maxFieldLength),
    ...(value.executionOptions !== undefined ? { executionOptions: value.executionOptions } : {}),
    params: normalizeQuotaBurnParams(value.params, maxParamLength),
  };
}

/**
 /** The scalar-only `params` map shared by the overrides bag and the legacy job bag; `maxParamLength` comes from `QUOTA_BURN_BOUNDS`. */
export function normalizeQuotaBurnParams(raw, maxParamLength) {
  if (!isPlainObject(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, maxParamLength);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean' || value === null) clean[key] = value;
  }
  return clean;
}

const unavailable = (code, reason) => ({ code, reason });

/**
 /**
  * The master Improve rung, shared by every step kind and the schedule's on-demand lane. `undefined` = caller did not check (unjudged), `null` = checked and could not tell
  * (fails CLOSED), boolean = the answer.
  */
function improvementVerdict(improvementEnabled) {
  if (improvementEnabled === undefined || improvementEnabled === true) return null;
  return unavailable(
    QUOTA_BURN_UNAVAILABLE.IMPROVEMENT_DISABLED,
    improvementEnabled === null
      ? 'CoS state could not be read, so Improvement cannot be confirmed'
      : 'Improvement is disabled — enable it in CoS → Config to run on-demand tasks',
  );
}

/**
 /**
  * The ONE gate ladder deciding whether a built-in scheduled task may be invoked on demand, read by `taskSchedule.triggerOnDemandTask` and the quota-burn catalog,
  * so a gate added here reaches dispatch and the page together (docs/QUOTA-BURN.md). Pure; the catalog is an ARGUMENT supplied as `entry`:
  *
  *   entry === undefined  no catalog: every per-type rung goes unjudged (a read before the schedule store is up must not mass-orphan a plan).
  *   entry === null       the catalog was read and this type is not on it.
  *   entry === object     `{ enabled, featureEnabled, feature, eligible, appIds }`, each `undefined` when unknown.
  *     `eligible`  false for a type another automation owns (`invocation.userInvokable === false`).
  *     `appIds`    managed apps with this type switched ON; supplied only by a caller that ENFORCES per-app enablement (see `enabledAppIdsByTaskType`);
  *                 omitted, the rung is skipped (a human "Run Now" keeps its override of the cadence switch).
  *
  * Target SCOPE is judged with or without an entry: it is a property of the reference itself.
  */
export function evaluateOnDemandEligibility({ taskType, appId = null, entry, improvementEnabled } = {}) {
  if (entry === null) return unavailable(QUOTA_BURN_UNAVAILABLE.UNKNOWN_TASK, `Unknown task type '${taskType}'`);
  if (isPlainObject(entry)) {
    if (entry.enabled === false) {
      return unavailable(QUOTA_BURN_UNAVAILABLE.DISABLED, `Task type '${taskType}' is disabled`);
    }
    if (entry.featureEnabled === false) {
      return unavailable(QUOTA_BURN_UNAVAILABLE.DISABLED, `Task type '${taskType}' requires the '${entry.feature}' feature`);
    }
    if (entry.eligible === false) {
      return unavailable(QUOTA_BURN_UNAVAILABLE.INCOMPATIBLE, `Task type '${taskType}' is managed by another automation and cannot be invoked on demand`);
    }
  }

  if (requiresManagedAppTarget(taskType) && !appId) {
    return unavailable(QUOTA_BURN_UNAVAILABLE.MISSING_APP, `Task type '${taskType}' requires a managed app target`);
  }
  if (requiresInstallWideTarget(taskType) && appId) {
    return unavailable(QUOTA_BURN_UNAVAILABLE.WRONG_SCOPE, `Task type '${taskType}' requires an install-wide target (no app)`);
  }
  if (appId && Array.isArray(entry?.appIds) && !entry.appIds.includes(appId)) {
    return unavailable(QUOTA_BURN_UNAVAILABLE.WRONG_SCOPE, `Task type '${taskType}' is not enabled for app '${appId}'`);
  }

  // The local maintainer role supplies its own standing grant and cadence.
  return taskType === 'development-watchdog' ? null : improvementVerdict(improvementEnabled);
}

/**
 /**
  * `Map<taskType, appId[]>` of apps with each built-in type switched ON, from already-loaded app records. No override means disabled (`apps.isTaskTypeEnabledForApp`),
  * matching the scheduled fire, so the burn catalog and the on-demand lane agree.
  */
export function enabledAppIdsByTaskType(apps) {
  const byTaskType = new Map();
  for (const app of apps || []) {
    for (const [taskType, override] of Object.entries(app?.taskTypeOverrides || {})) {
      if (override?.enabled !== true) continue;
      if (!byTaskType.has(taskType)) byTaskType.set(taskType, []);
      byTaskType.get(taskType).push(app.id);
    }
  }
  return byTaskType;
}

/**
 /**
  * Resolve one normalized step against the live task catalog; returns `{ code, reason }` or `null` when good to run. The catalog is an ARGUMENT (it needs services; this stays in `lib/`):
  *
  *   builtin: { [taskType]: { enabled, featureEnabled, feature, eligible, appIds } }  (the `entry` shape `evaluateOnDemandEligibility` reads)
  *   custom:  { [jobId]: { enabled, eligible, appId } }
  *   improvementEnabled: master CoS Improve switch (`null` = unreadable).
  *
  * With no `builtin`/`custom` map, existence/enabled/eligibility/Improve go unjudged and the step keeps the normalizer's verdict (no mass-orphaning before the store is up).
  * Target SCOPE is judged either way (decidable from the payload alone).
  */
export function resolveQuotaBurnStepAvailability(step, catalog = {}) {
  // A legacy step's verdict comes from the payload, not the catalog (its future reference doesn't exist yet).
  if (step?.unavailable?.code === QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED) return step.unavailable;
  const ref = step?.taskRef;
  if (!ref) return step?.unavailable || null;

  // The reference's OWN problems outrank the master switch, so re-enabling Improve doesn't reveal a dangling job the page could have named.
  const specific = ref.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM
    ? customJobAvailability(ref, catalog)
    : evaluateOnDemandEligibility({
      taskType: ref.taskType,
      appId: ref.appId,
      entry: builtinEntry(ref.taskType, catalog),
    });
  return specific || improvementVerdict(catalog.improvementEnabled);
}

/** `undefined` when the caller passed no built-in map, `null` when it has no such type. */
function builtinEntry(taskType, catalog) {
  const types = isPlainObject(catalog.builtin) ? catalog.builtin : null;
  if (!types) return undefined;
  return Object.hasOwn(types, taskType) ? types[taskType] : null;
}

function customJobAvailability(ref, catalog) {
  const jobs = isPlainObject(catalog.custom) ? catalog.custom : null;
  if (!jobs) return null;
  const job = Object.hasOwn(jobs, ref.jobId) ? jobs[ref.jobId] : null;
  if (!job) return unavailable(QUOTA_BURN_UNAVAILABLE.DANGLING_JOB, `custom scheduled job "${ref.jobId}" no longer exists`);
  if (job.eligible === false) return unavailable(QUOTA_BURN_UNAVAILABLE.INCOMPATIBLE, `custom scheduled job "${ref.jobId}" cannot be invoked by a quota burn`);
  if (job.enabled === false) return unavailable(QUOTA_BURN_UNAVAILABLE.DISABLED, `custom scheduled job "${ref.jobId}" is disabled`);
  return null;
}

/**
 /** The same resolution across a whole normalized config, returning a new config; non-mutating so the derived verdict (true only RIGHT NOW) never reaches disk. */
export function applyQuotaBurnAvailability(config, catalog = {}) {
  const families = Object.fromEntries(Object.entries(config?.families || {}).map(([id, family]) => [
    id,
    { ...family, jobs: (family?.jobs || []).map((job) => ({ ...job, unavailable: resolveQuotaBurnStepAvailability(job, catalog) })) },
  ]));
  return { ...config, families };
}

/**
 /**
  * Whether a step may be dispatched through the reference path. Three independent gates: user switched it off, catalog says it cannot run, or it has no reference
  * (an un-migrated legacy step: #6381 retired the quota-only executor, so it stays visible and refused).
  */
export function quotaBurnStepIsDispatchable(step) {
  return step?.enabled !== false && !step?.unavailable && Boolean(step?.taskRef);
}
