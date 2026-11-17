/**
 * Quota-burn PROVENANCE carried on an on-demand scheduled-task request, and the metadata an on-demand engine stamps from it.
 *
 * A burn step asks the schedule to run a task the user owns (`quotaBurnInvoke.js` → `taskSchedule.triggerOnDemandTask` with `origin: 'quota-burn'`). Acceptance is ASYNCHRONOUS
 * (`cos.js#spawnDequeuePriority0OnDemand` / `cosTaskGenerator.js#spawnPriority0OnDemand` generate the task later), so the "which burn was this?" facts ride ON the request.
 *
 * Pure and import-light (`objects.js` only): `taskScheduleConstants.js` declares the origin strings and is reached by much of the server suite, so this must not pull the quota-burn
 * config graph in (server/AGENTS.md "Import scoping"); hence `onDemandOrigin` is copied as an opaque string, not validated against the enum.
 *
 * The provenance keys are the same ones the retired `quotaBurnJobs/agentPrompt.js` stamped: `isCooldownExemptTask`, the runner's completion continuation and
 * `quotaBurnDenials.js` read them off the finished agent and must keep seeing them unchanged (#6381). `QUOTA_BURN_PROVENANCE_FIELDS` is the one place they are named.
 */

import { isPlainObject, POLLUTING_KEYS } from './objects.js';
import { trimTo } from './textUtils.js';

/** The `origin` a quota-burn on-demand request carries; declared here so the stamp can gate on it without importing upward (`taskScheduleConstants.js` re-exports it as `ON_DEMAND_ORIGINS.QUOTA_BURN`). */
export const QUOTA_BURN_REQUEST_ORIGIN = 'quota-burn';

/** Explicit runs bypass cadence switches; automated burns and refills do not. */
export function isManualOnDemandRequest(request) {
  return (request.origin ?? 'user') === 'user'
    || (request.origin === QUOTA_BURN_REQUEST_ORIGIN && Boolean(normalizeQuotaBurnProvenance(request.burn)?.maintenanceRunId));
}

const MAX_FIELD = 64;

/**
 * THE quota-burn provenance block: the facts that say which burn a task is. Every hop that persists or projects them derives from this table, so a new fact is one row
 * (`quotaBurnStepId` once reached disk but not the agent, #6406). Hops: `onDemandRequestMetadata` (on-demand engines), `cosTaskStore.js#addTask` (synchronous custom-job lane),
 * `agentLifecycle.js` (agent projection the runner and denial ledger read).
 *
 * The PERSISTED and cross-peer shape stays FLAT (`quotaBurnFamily`, …), not nested: CoS tasks federate as markdown between independently upgrading peers (`cosTaskMerge.js`),
 * and a nested-only write would read as an ordinary task on an older peer. `quotaBurnProvenance` still ACCEPTS a nested block.
 * Readers coerce because rows stored before #16407 and peers on older versions hold every scalar as a string.
 */
const asId = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const asEpochMs = (value) => {
  const numeric = typeof value === 'number' ? value : (asId(value) === undefined ? NaN : Number(value));
  return Number.isFinite(numeric) ? numeric : undefined;
};

export const QUOTA_BURN_PROVENANCE_FIELDS = Object.freeze([
  // The provider family window this run spends; the key the denial ledger and plan walk attribute by. ABSENT (never a placeholder) on a manual run pinned to a provider outside every
  // subscription family; `maintenanceRunId` is that run's attribution (see `normalizeQuotaBurnProvenance`).
  { field: 'family', taskKey: 'quotaBurnFamily', agentKey: 'taskQuotaBurnFamily', read: asId },
  // Reset of the SHORT rolling window that refuses first, so a refused run blocks the family until it rolls (quotaBurnDenials.js).
  { field: 'limitingResetAt', taskKey: 'quotaBurnLimitingResetAt', agentKey: 'taskQuotaBurnLimitingResetAt', read: asEpochMs },
  // Which STEP of the burn plan asked.
  { field: 'stepId', taskKey: 'quotaBurnStepId', agentKey: 'taskQuotaBurnStepId', read: asId },
  // The on-demand REQUEST this task was generated for; absent (never null or synthesized) on the synchronous custom-job lane, where a fake id would corrupt joins.
  { field: 'requestId', taskKey: 'quotaBurnRequestId', agentKey: 'taskQuotaBurnRequestId', read: asId },
  // The MANUAL maintenance run that asked (`services/maintenanceRun.js`); absent on an automatic burn. Lets the runner leave a manual run's agents to its own ladder while family
  // attribution still credits a refusal to the window spent. The ONLY attribution a family-less manual run has, so `hasQuotaBurnProvenance` accepts either key.
  { field: 'maintenanceRunId', taskKey: 'quotaBurnMaintenanceRunId', agentKey: 'taskQuotaBurnMaintenanceRunId', read: asId },
].map(Object.freeze));

/**
 /** Read the provenance block off task metadata, an `addTask` payload or a producer's `quotaBurn` block; a field not carried (or unreadable) is ABSENT from the result. */
export function quotaBurnProvenance(source) {
  const block = {};
  if (!isPlainObject(source)) return block;
  const nested = isPlainObject(source.quotaBurn) ? source.quotaBurn : null;
  for (const { field, taskKey, read } of QUOTA_BURN_PROVENANCE_FIELDS) {
    const value = read(nested?.[field] ?? source[taskKey]);
    if (value !== undefined) block[field] = value;
  }
  return block;
}

/** The flat metadata keys a block persists as. Absent fields stay absent. */
export function quotaBurnTaskMetadata(block) {
  const metadata = {};
  if (!isPlainObject(block)) return metadata;
  for (const { field, taskKey, read } of QUOTA_BURN_PROVENANCE_FIELDS) {
    const value = read(block[field]);
    if (value !== undefined) metadata[taskKey] = value;
  }
  return metadata;
}

/**
 /**
  * The provenance projection `agentLifecycle` stamps onto the agent record. agent.metadata is a hand-picked projection of task.metadata, so EVERY persisted field is listed
  * by construction. `null` (not absent) for a field the task never carried.
  */
export function quotaBurnAgentMetadata(taskMetadata) {
  const block = quotaBurnProvenance(taskMetadata);
  return Object.fromEntries(
    QUOTA_BURN_PROVENANCE_FIELDS.map(({ field, agentKey }) => [agentKey, block[field] ?? null]),
  );
}

/**
 /**
  * Whether a task carries attributable burn provenance. EITHER key suffices: a family names the window spent, a `maintenanceRunId` names the manual ladder. A manual run on a
  * provider outside every subscription family carries only the latter and must still be cooldown-exempt.
  */
export const hasQuotaBurnProvenance = (taskMetadata) => {
  const block = quotaBurnProvenance(taskMetadata);
  return Boolean(block.family || block.maintenanceRunId);
};

/**
 /**
  * Whether the family's burn PLAN owns this task: burn-provenanced and not a manual maintenance run's (which spends the window but walks its own ladder, so the plan neither advances
  * on it nor waits). `burnPlanOwnsAgent` is the same rule over the agent projection.
  */
export function burnPlanOwnsTask(taskMetadata) {
  const block = quotaBurnProvenance(taskMetadata);
  return Boolean(block.family) && !block.maintenanceRunId;
}
export const burnPlanOwnsAgent = (agent) => Boolean(agent?.metadata?.taskQuotaBurnFamily) && !agent.metadata.taskQuotaBurnMaintenanceRunId;

const nullable = (value, max = MAX_FIELD) => trimTo(value, max) || null;

const scalarParams = (raw) => {
  if (!isPlainObject(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) clean[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
  }
  return clean;
};

/**
 /**
  * Normalize the `burn` block of an on-demand request. Returns `null` unless it names the burn step AND an attribution: an unattributable burn would make `isCooldownExemptTask`
  * treat an ordinary task as exempt and credit a refusal to the wrong family.
  *
  * Attribution is the family whose window is spent OR the manual maintenance run. An AUTOMATIC burn never carries a run id, so family stays required. A MANUAL run pinned outside every
  * subscription family omits `family` (`null` means "spends no subscription"), keeping `recordBurnAgentCompletion` and the plan walk from crediting a subscription it never touched.
  *
  * `overrides` carries provider, model and reasoning effort (absorbed AFTER generation off `task.metadata`) plus the step's run `params`. Params must reach the PROMPT, so both engines hand
  * them to `prepareManagedAppImprovementTask` as `runOverrides`, layered over the saved `taskMetadata` before the mode banner is chosen (#6381: a migrated issues-only burn pins
  * `fileIssues: true` even against a default-false audit type). Shallow scalars only; the generator validates them via `sanitizeTaskMetadata`. Copied rather than imported from
  * `quotaBurnTaskRef.js` to keep this module's one-import budget.
  */
export function normalizeQuotaBurnProvenance(raw) {
  if (!isPlainObject(raw)) return null;
  const family = trimTo(raw.family, MAX_FIELD);
  const stepId = trimTo(raw.stepId, MAX_FIELD);
  const maintenanceRunId = nullable(raw.maintenanceRunId);
  if (!stepId || (!family && !maintenanceRunId)) return null;
  const limitingResetAt = Number(raw.limitingResetAt);
  const overrides = isPlainObject(raw.overrides) ? raw.overrides : {};
  return {
    ...(family ? { family } : {}),
    stepId,
    limitingResetAt: Number.isFinite(limitingResetAt) ? limitingResetAt : null,
    ...(maintenanceRunId ? { maintenanceRunId } : {}),
    overrides: {
      providerId: nullable(overrides.providerId),
      model: nullable(overrides.model),
      effort: nullable(overrides.effort),
      params: scalarParams(overrides.params),
    },
  };
}

/**
 /**
  * The metadata BOTH on-demand engines merge onto the task they generated (`cos.js#spawnDequeuePriority0OnDemand`, `cosTaskGenerator.js#spawnPriority0OnDemand`), one helper so the mirrored engines agree.
  * `onDemand` says the task came from the request queue; `onDemandOrigin` says WHO asked (read by `perpetualRefillPlan`); separate keys keep a burn distinguishable from a Run Now.
  * A `null` origin is "not recorded" and every reader treats it as a human Run.
  *
  * Burn keys are gated on the ORIGIN, not merely a parseable `burn` block: `triggerOnDemandTask` refuses to persist one on another origin, so only a hand-edited schedule could disagree,
  * and stamping there would make a human Run cooldown-exempt and credit its refusal to a family that never dispatched it.
  */
export function onDemandRequestMetadata(request) {
  const burn = request?.origin === QUOTA_BURN_REQUEST_ORIGIN
    ? normalizeQuotaBurnProvenance(request.burn)
    : null;
  const requestId = trimTo(request?.id, 128);
  return {
    onDemand: true,
    onDemandOrigin: nullable(request?.origin),
    ...(burn ? {
      // One spread of the shared block so this path carries the same keys as the non-raw `addTask` mapping; an unreadable reset or unnamed request drops out rather than being written null.
      ...quotaBurnTaskMetadata({ ...burn, requestId }),
      ...(burn.overrides.providerId ? { provider: burn.overrides.providerId } : {}),
      ...(burn.overrides.model ? { model: burn.overrides.model } : {}),
      ...(burn.overrides.effort ? { effort: burn.overrides.effort } : {}),
    } : {}),
  };
}
