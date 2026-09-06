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
 */

import { isPlainObject, POLLUTING_KEYS } from './objects.js';
import { requiresInstallWideTarget, requiresManagedAppTarget } from './taskTargetScope.js';

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
});

const MAX_REF_FIELD = 64;

const trimmed = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nullable = (value, max) => trimmed(value, max) || null;

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
    const taskType = trimmed(raw.taskType, MAX_REF_FIELD);
    if (!taskType) return null;
    return { kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN, taskType, appId: nullable(raw.appId, MAX_REF_FIELD) };
  }
  if (raw.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM) {
    const jobId = trimmed(raw.jobId, MAX_REF_FIELD);
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
 * Resolve one normalized step against the live task catalog and return its
 * `{ code, reason }` unavailability, or `null` when the step is good to run.
 *
 * The catalog is an ARGUMENT, not an import: resolution needs the schedule
 * store and the per-app job store, which are services, and this module must
 * stay in `lib/`. Callers pass plain lookup maps:
 *
 *   builtin: { [taskType]: { enabled, eligible, appIds } }
 *     `appIds` — the managed apps this type may target, or `null`/absent for
 *     "any app on the install". `eligible` — false for a type a burn may not
 *     invoke (shell jobs, system-managed-only actions); absent reads as true.
 *   custom:  { [jobId]: { enabled, eligible, appId } }
 *
 * An EMPTY catalog resolves nothing: with no `builtin`/`custom` map supplied the
 * step keeps whatever the normalizer already decided rather than being declared
 * dangling, so a caller that has not loaded the catalog yet cannot mass-orphan a
 * user's plan.
 */
export function resolveQuotaBurnStepAvailability(step, catalog = {}) {
  // A legacy step's verdict is decided by the payload itself, not by the
  // catalog — the reference it will eventually point at does not exist yet.
  if (step?.unavailable?.code === QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED) return step.unavailable;
  const ref = step?.taskRef;
  if (!ref) return step?.unavailable || null;

  if (ref.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM) {
    const jobs = isPlainObject(catalog.custom) ? catalog.custom : null;
    if (!jobs) return null;
    const job = Object.hasOwn(jobs, ref.jobId) ? jobs[ref.jobId] : null;
    if (!job) return unavailable(QUOTA_BURN_UNAVAILABLE.DANGLING_JOB, `custom scheduled job "${ref.jobId}" no longer exists`);
    if (job.eligible === false) return unavailable(QUOTA_BURN_UNAVAILABLE.INCOMPATIBLE, `custom scheduled job "${ref.jobId}" cannot be invoked by a quota burn`);
    if (job.enabled === false) return unavailable(QUOTA_BURN_UNAVAILABLE.DISABLED, `custom scheduled job "${ref.jobId}" is disabled`);
    return null;
  }

  // Scope is checked BEFORE the catalog lookup so a hand-edited config that
  // dropped a required app reports the missing app rather than a confusing
  // "unknown task" — the type is fine, the target is not.
  if (requiresManagedAppTarget(ref.taskType) && !ref.appId) {
    return unavailable(QUOTA_BURN_UNAVAILABLE.MISSING_APP, `scheduled task "${ref.taskType}" must name a managed app`);
  }
  if (requiresInstallWideTarget(ref.taskType) && ref.appId) {
    return unavailable(QUOTA_BURN_UNAVAILABLE.WRONG_SCOPE, `scheduled task "${ref.taskType}" runs install-wide and cannot target one app`);
  }

  const types = isPlainObject(catalog.builtin) ? catalog.builtin : null;
  if (!types) return null;
  const entry = Object.hasOwn(types, ref.taskType) ? types[ref.taskType] : null;
  if (!entry) return unavailable(QUOTA_BURN_UNAVAILABLE.UNKNOWN_TASK, `scheduled task "${ref.taskType}" is not available on this install`);
  if (entry.eligible === false) return unavailable(QUOTA_BURN_UNAVAILABLE.INCOMPATIBLE, `scheduled task "${ref.taskType}" cannot be invoked by a quota burn`);
  if (entry.enabled === false) return unavailable(QUOTA_BURN_UNAVAILABLE.DISABLED, `scheduled task "${ref.taskType}" is disabled`);
  if (ref.appId && Array.isArray(entry.appIds) && !entry.appIds.includes(ref.appId)) {
    return unavailable(QUOTA_BURN_UNAVAILABLE.WRONG_SCOPE, `scheduled task "${ref.taskType}" is not configured for app "${ref.appId}"`);
  }
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
 * has no reference to run at all (an un-migrated legacy step — which the legacy
 * `JOB_MODULES` executor still handles until #6381 retires it).
 */
export function quotaBurnStepIsDispatchable(step) {
  return step?.enabled !== false && !step?.unavailable && Boolean(step?.taskRef);
}
