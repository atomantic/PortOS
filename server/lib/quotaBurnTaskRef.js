/**
 * Quota-burn step → scheduled-task REFERENCE, plus its per-invocation overrides.
 *
 * A burn step used to BE its work: a copied prompt in a free-form `params` bag
 * keyed by a `jobType` from a quota-only enum, with no durable link back to the
 * scheduled task it was cloned from. Preset identity was never persisted at all
 * — both `quotaBurnPresets.js` and the client's `matchedPreset` re-derived it by
 * comparing prompt text, so editing one word of a shipped prompt orphaned the
 * step. This module replaces that with a reference the step actually stores.
 *
 * Two reference kinds, discriminated on `kind`:
 *   - `builtin` — a PortOS scheduled task TYPE (`ux`, `security`, …), plus the
 *     managed app it targets when the type requires one. Scope rules come from
 *     `taskTargetScope.js`, the same contract the schedule's own request gate
 *     reads.
 *   - `custom`  — an app custom scheduled job, addressed by its id. The job
 *     record owns its app scope, so the reference deliberately stores no
 *     `appId`: a second copy could disagree with the job it points at.
 *
 * Everything the burn wants to do DIFFERENTLY from the task's saved settings
 * lives in `overrides` (provider / model / effort / run params). An unset
 * override inherits; nothing here ever writes back to the schedule.
 *
 * Pure: shape, normalization, and a resolver that takes the catalog as an
 * argument. No storage, no provider I/O, no imports out of `lib/`.
 *
 * `evaluateOnDemandEligibility` below is deliberately WIDER than the burn: it is
 * the one gate ladder for invoking a built-in scheduled task on demand, read
 * both by this module's resolver (so the page can say why a step cannot run) and
 * by `taskSchedule.triggerOnDemandTask` (so dispatch refuses for the same
 * reasons). It lives here because the reason codes and their prose already do,
 * and because a `lib/` module is the only place both a service and a display
 * path can share without one importing the other (#6405).
 */

import { isPlainObject, POLLUTING_KEYS } from './objects.js';
import { requiresInstallWideTarget, requiresManagedAppTarget } from './taskTargetScope.js';
import { trimTo } from './textUtils.js';

/** The two things a burn step may point at. */
export const QUOTA_BURN_TASK_REF_KIND = Object.freeze({
  BUILTIN: 'builtin',
  CUSTOM: 'custom',
});

/**
 * Why a step is retained but not dispatchable. A code so the client can react
 * (offer "pick another task", "re-enable it in Scheduled Tasks") and a
 * human-readable `reason` so the row can say it without a lookup table.
 *
 * A step is never DELETED for being unavailable — its label, order, overrides
 * and run-once state are the user's, and a task that comes back should find its
 * step exactly as it left it.
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
  /**
   * The master CoS Improve switch is off — or its state could not be read, which
   * fails closed into the same verdict. Its own code rather than `DISABLED`: the
   * referenced task is not switched off and telling the user to re-enable it in
   * Scheduled Tasks would send them to a toggle that is already on. The fix
   * lives in CoS → Config, and every step reports it at once.
   */
  IMPROVEMENT_DISABLED: 'improvement-disabled',
});

const MAX_REF_FIELD = 64;

const nullable = (value, max) => trimTo(value, max) || null;

/**
 * Normalize a stored/submitted task reference. Returns `null` when the payload
 * carries no usable reference — the caller then decides whether that is a
 * legacy step (keep it, mark it for migration) or nothing at all.
 *
 * Never GUESSES a kind: a payload missing `kind`, or naming one that is not in
 * the enum, is not a reference. Inferring one from the presence of `taskType`
 * would be exactly the "silently downgrade a reference" failure the reference
 * model exists to remove.
 */
export function normalizeQuotaBurnTaskRef(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.kind === QUOTA_BURN_TASK_REF_KIND.BUILTIN) {
    const taskType = trimTo(raw.taskType, MAX_REF_FIELD);
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
 * A step's per-invocation overrides bag, normalized to JSON-ish scalars.
 *
 * `params` stays free-form for the same reason the legacy bag did — each task
 * type owns which run parameters it reads — but its DEPTH is enforced, so a
 * hand-edited config cannot smuggle a prototype or a nested blob through.
 *
 * The two length caps are REQUIRED, and injected rather than imported: this
 * module has to stay free of `quotaBurnConfig.js` (which imports it, not the
 * other way round), and restating its numbers as defaults here would be a
 * second bounds table — exactly what `QUOTA_BURN_BOUNDS` exists to prevent.
 */
export function normalizeQuotaBurnOverrides(raw, { maxParamLength, maxFieldLength }) {
  const value = isPlainObject(raw) ? raw : {};
  return {
    providerId: nullable(value.providerId, maxFieldLength),
    model: nullable(value.model, maxFieldLength),
    effort: nullable(value.effort, maxFieldLength),
    params: normalizeQuotaBurnParams(value.params, maxParamLength),
  };
}

/**
 * The scalar-only `params` map shared by the overrides bag and the legacy job
 * bag. `maxParamLength` comes from `QUOTA_BURN_BOUNDS`, per the note above.
 */
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
 * The master Improve rung, shared by every kind of step and by the schedule's
 * own on-demand lane so the switch is read the same way everywhere.
 *
 * Three input states, per the sentinel rule: `undefined` is "the caller did not
 * check" and goes unjudged, `null` is "checked and could not tell" and fails
 * CLOSED, a boolean is the answer.
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
 * The ONE gate ladder deciding whether a built-in scheduled task may be invoked
 * on demand — read by `taskSchedule.triggerOnDemandTask` before it queues a
 * request, and by the quota-burn catalog to say why a step cannot run. Two
 * consumers, one ladder: a gate added here reaches dispatch and the page in the
 * same change, which is the step-level version of what `evaluateFamily` already
 * does for a burn family (docs/QUOTA-BURN.md).
 *
 * Pure, and the catalog is an ARGUMENT: the facts about a task type live in the
 * schedule store, the instance-feature service and the app store, so the caller
 * resolves them and hands them in as `entry`.
 *
 *   entry === undefined  the caller has no catalog — every per-type rung goes
 *                        unjudged, so a read taken before the schedule store is
 *                        up cannot mass-orphan a user's plan.
 *   entry === null       the catalog was read and this type is not on it.
 *   entry === object     `{ enabled, featureEnabled, feature, eligible, appIds }`,
 *                        each key `undefined` when that fact is unknown.
 *     `eligible`        — false for a type another automation owns
 *                         (`invocation.userInvokable === false`).
 *     `appIds`          — the managed apps with this type switched ON. Supplied
 *                         only by a caller that ENFORCES per-app enablement (see
 *                         `enabledAppIdsByTaskType`); omitted, the rung is
 *                         skipped, which is how a human "Run Now" keeps its
 *                         deliberate override of the app's cadence switch.
 *
 * Target SCOPE is judged with or without an entry, deliberately: it is a
 * property of the reference itself, so a hand-edited step that dropped its
 * required app is broken whether or not a catalog is to hand.
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

  return improvementVerdict(improvementEnabled);
}

/**
 * `Map<taskType, appId[]>` of the managed apps that have each built-in type
 * switched ON, derived from app records the caller already loaded.
 *
 * An app with no override for a type is NOT in its list: no override means
 * disabled (`apps.isTaskTypeEnabledForApp`), which is the same reading the
 * scheduled fire applies. Shared so the burn catalog and the schedule's own
 * on-demand lane cannot disagree about which apps a type may target.
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
 * Resolve one normalized step against the live task catalog and return its
 * `{ code, reason }` unavailability, or `null` when the step is good to run.
 *
 * The catalog is an ARGUMENT, not an import: resolution needs the schedule
 * store and the per-app job store, which are services, and this module must
 * stay in `lib/`. Callers pass plain lookup maps:
 *
 *   builtin: { [taskType]: { enabled, featureEnabled, feature, eligible, appIds } }
 *             — the `entry` shape `evaluateOnDemandEligibility` reads, which is
 *               where every built-in rung is decided.
 *   custom:  { [jobId]: { enabled, eligible, appId } }
 *   improvementEnabled: the master CoS Improve switch (`null` = unreadable).
 *
 * An EMPTY catalog answers only the questions that need one. Existence, enabled
 * state, eligibility and the Improve switch all go unjudged — with no
 * `builtin`/`custom` map the step keeps whatever the normalizer already decided
 * rather than being declared dangling, so a caller reading the plan before the
 * schedule store is up cannot mass-orphan a user's plan. Target SCOPE is the
 * exception, and deliberately so: it is a property of the reference itself,
 * decidable from the payload alone, so it is judged either way.
 */
export function resolveQuotaBurnStepAvailability(step, catalog = {}) {
  // A legacy step's verdict is decided by the payload itself, not by the
  // catalog — the reference it will eventually point at does not exist yet.
  if (step?.unavailable?.code === QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED) return step.unavailable;
  const ref = step?.taskRef;
  if (!ref) return step?.unavailable || null;

  // The reference's OWN problems outrank the master switch: a user who turns
  // Improve back on should not then discover a dangling job the page could have
  // named all along.
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
 * The same resolution applied across a whole normalized config, returning a new
 * config. Non-mutating, so a status read can stamp availability for the page
 * without the derived verdict ever reaching disk — it is a fact about the
 * catalog RIGHT NOW, and persisting it would go stale the moment a task is
 * re-enabled.
 */
export function applyQuotaBurnAvailability(config, catalog = {}) {
  const families = Object.fromEntries(Object.entries(config?.families || {}).map(([id, family]) => [
    id,
    { ...family, jobs: (family?.jobs || []).map((job) => ({ ...job, unavailable: resolveQuotaBurnStepAvailability(job, catalog) })) },
  ]));
  return { ...config, families };
}

/**
 * Whether a step may be dispatched through the reference path.
 *
 * Three independent gates, deliberately spelled out rather than folded into
 * `enabled`: the user switched it off, the catalog says it cannot run, or it
 * has no reference to run at all. The third is an un-migrated legacy step, and
 * since #6381 retired the quota-only executor there is nothing else for it to
 * run through — it stays visible and refused rather than dispatched.
 */
export function quotaBurnStepIsDispatchable(step) {
  return step?.enabled !== false && !step?.unavailable && Boolean(step?.taskRef);
}
