/**
 * Quota-burn PROVENANCE carried on an on-demand scheduled-task request, and the
 * metadata an on-demand engine stamps from it.
 *
 * A burn step no longer queues its own synthesized task: it asks the schedule to
 * run a task the user already owns (`quotaBurnInvoke.js` →
 * `taskSchedule.triggerOnDemandTask` with `origin: 'quota-burn'`). Acceptance is
 * therefore ASYNCHRONOUS — the request lands on the schedule now and one of the
 * two on-demand engines (`cos.js#spawnDequeuePriority0OnDemand`,
 * `cosTaskGenerator.js#spawnPriority0OnDemand`) generates the task later — so
 * the "which burn was this?" facts have to ride ON the request and be stamped
 * onto the task the engine produces.
 *
 * Pure, and deliberately import-light (`objects.js` only): `taskScheduleConstants.js`
 * declares the origin strings and is reached by a large share of the server suite,
 * so this module must never pull the quota-burn config graph in behind it
 * (server/AGENTS.md, "Import scoping"). That is also why `onDemandOrigin` below
 * is copied through as an opaque string rather than validated against the enum.
 *
 * The provenance keys are the SAME ones the legacy `quotaBurnJobs/agentPrompt.js`
 * executor stamps, on purpose: `cosTaskGenerator.js#isCooldownExemptTask`, the
 * runner's completion continuation, and `quotaBurnDenials.js` all read them off
 * the finished agent, and a reference-dispatched burn must be indistinguishable
 * to those readers. `QUOTA_BURN_PROVENANCE_FIELDS` below is the one place they
 * are named.
 */

import { isPlainObject } from './objects.js';

/**
 * The `origin` a quota-burn on-demand request carries. Declared here rather
 * than in `taskScheduleConstants.js` so the stamp below can gate on it without
 * importing upward out of `lib/`; that module re-exports it as
 * `ON_DEMAND_ORIGINS.QUOTA_BURN`, so there is still exactly one literal.
 */
export const QUOTA_BURN_REQUEST_ORIGIN = 'quota-burn';

const MAX_FIELD = 64;

/**
 * THE quota-burn provenance block: the facts that say which burn a task is, in
 * one place. Every hop that persists or projects them derives from this table
 * rather than naming keys, so a fifth fact is one row here instead of four
 * hand-written lines that can each be forgotten independently — which is exactly
 * how `quotaBurnStepId` came to reach disk but never reach the agent (#6406).
 *
 * The three hops:
 *   - `onDemandRequestMetadata` below (raw path — the on-demand engines).
 *   - `cosTaskStore.js#addTask` (non-raw path — the synchronous custom-job lane).
 *   - `agentLifecycle.js` (the agent projection the runner and the denial
 *     ledger read a finished run back out of).
 *
 * The PERSISTED and cross-peer shape stays FLAT (`quotaBurnFamily`, …), not a
 * nested `quotaBurn` object. CoS tasks federate as markdown replicated between
 * peers that upgrade independently (`cosTaskMerge.js`), and `metadata.quotaBurnFamily`
 * is what makes a burn cooldown-exempt and what credits a refusal to a family —
 * so a nested-only write would make a burn queued on a new peer read as an
 * ordinary task on an older one, for no functional gain. `quotaBurnProvenance`
 * still ACCEPTS a nested block, so a producer may hand its provenance over as a
 * unit and a task that ever arrives in that shape resolves identically.
 *
 * Readers coerce, because a COS-TASKS.md round-trip hands every scalar back as a
 * string: a task written by a previous release must still read as burn-provenanced.
 */
const asId = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const asEpochMs = (value) => {
  const numeric = typeof value === 'number' ? value : (asId(value) === undefined ? NaN : Number(value));
  return Number.isFinite(numeric) ? numeric : undefined;
};

export const QUOTA_BURN_PROVENANCE_FIELDS = Object.freeze([
  // Which provider family's window this run is spending. The one field a burn
  // cannot be attributed without — `isCooldownExemptTask` and the denial ledger
  // both key on it.
  { field: 'family', taskKey: 'quotaBurnFamily', agentKey: 'taskQuotaBurnFamily', read: asId },
  // The reset of the SHORT rolling window that will refuse first, so a refused
  // run blocks the family until that window rolls rather than re-dispatching
  // into the same wall. See quotaBurnDenials.js.
  { field: 'limitingResetAt', taskKey: 'quotaBurnLimitingResetAt', agentKey: 'taskQuotaBurnLimitingResetAt', read: asEpochMs },
  // Which STEP of the burn plan asked.
  { field: 'stepId', taskKey: 'quotaBurnStepId', agentKey: 'taskQuotaBurnStepId', read: asId },
  // The on-demand REQUEST this task was generated for. Absent — never null, never
  // synthesized — on the synchronous custom-job lane, which queues the task itself
  // and has no request to name; a fake id would make a join over it silently wrong.
  { field: 'requestId', taskKey: 'quotaBurnRequestId', agentKey: 'taskQuotaBurnRequestId', read: asId },
].map(Object.freeze));

/**
 * Read the provenance block off anything carrying it — task metadata, an
 * `addTask` payload, or a producer's own `quotaBurn` block. A field the source
 * does not carry (or carries unreadably) is ABSENT from the result, so callers
 * can tell "not recorded" from a legitimate value without a sentinel of their own.
 */
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
 * The provenance projection `agentLifecycle` stamps onto the agent record.
 * agent.metadata is a hand-picked projection of task.metadata, so EVERY
 * persisted field is listed here by construction — a field that reaches disk
 * cannot fail to reach the runner's completion continuation or the denial ledger.
 * `null` (not absent) for a field the task never carried, matching the rest of
 * that projection's "not recorded" convention.
 */
export function quotaBurnAgentMetadata(taskMetadata) {
  const block = quotaBurnProvenance(taskMetadata);
  return Object.fromEntries(
    QUOTA_BURN_PROVENANCE_FIELDS.map(({ field, agentKey }) => [agentKey, block[field] ?? null]),
  );
}

/** Whether a task carries attributable burn provenance at all. */
export const hasQuotaBurnProvenance = (taskMetadata) => Boolean(quotaBurnProvenance(taskMetadata).family);

const trimmed = (value, max = MAX_FIELD) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const nullable = (value, max = MAX_FIELD) => trimmed(value, max) || null;

/**
 * Normalize the `burn` block of an on-demand request. Returns `null` unless it
 * names BOTH the family whose window is being spent and the burn step that asked
 * — without either, nothing downstream can attribute the run, and an
 * unattributable burn is worse than no burn: `isCooldownExemptTask` would treat
 * an ordinary task as burn-exempt, and the denial ledger would credit a refusal
 * to the wrong family.
 *
 * `overrides` carries only the three per-invocation settings the generated task
 * can absorb AFTER generation — the provider, model and reasoning effort the
 * spawner reads straight off `task.metadata`. A step's run `params` are NOT here:
 * they have to reach the PROMPT, which means the generator itself must overlay
 * them onto the task's saved `taskMetadata`, and that plumbing belongs with the
 * audit-mode contract that needs it (#6380). Paths that consume params directly
 * — the programmatic scheduled handlers and custom-job generation — read them
 * from the step, and never travel through a request at all.
 */
export function normalizeQuotaBurnProvenance(raw) {
  if (!isPlainObject(raw)) return null;
  const family = trimmed(raw.family);
  const stepId = trimmed(raw.stepId);
  if (!family || !stepId) return null;
  const limitingResetAt = Number(raw.limitingResetAt);
  const overrides = isPlainObject(raw.overrides) ? raw.overrides : {};
  return {
    family,
    stepId,
    limitingResetAt: Number.isFinite(limitingResetAt) ? limitingResetAt : null,
    overrides: {
      providerId: nullable(overrides.providerId),
      model: nullable(overrides.model),
      effort: nullable(overrides.effort),
    },
  };
}

/**
 * The metadata BOTH on-demand engines merge onto the task they just generated
 * for a request — `cos.js#spawnDequeuePriority0OnDemand` and
 * `cosTaskGenerator.js#spawnPriority0OnDemand`, either of which may drain any
 * given request. One helper rather than the expression written out twice: the
 * engines are an exact mirror, and a rule repeated in two places is a rule that
 * eventually holds in one.
 *
 * `onDemand` says the task came out of the request queue at all; `onDemandOrigin`
 * says WHO asked, and is what `perpetualRefillPlan` reads to decide whether the
 * completed run may continue its perpetual drain. They are separate keys because
 * they are separate facts — folding "a human asked" into `onDemand` is what made
 * a burn indistinguishable from a Run Now, and forced the exclusion to be
 * re-asserted as a second key-specific rule in `cos.js`.
 *
 * `null` origin means "not recorded", which every reader treats as a human Run:
 * that is what a request queued before the field existed is.
 *
 * The burn keys are gated on the ORIGIN, not merely on a `burn` block that
 * parses. `triggerOnDemandTask` refuses to persist one on any other origin, so
 * the two can only disagree in a hand-edited schedule — and stamping there would
 * be the worst of both: `isCooldownExemptTask` would treat an ordinary human Run
 * as burn-exempt and the denial ledger would credit its refusal to a family that
 * never dispatched it, while the refill planner still drained it as a human Run.
 */
export function onDemandRequestMetadata(request) {
  const burn = request?.origin === QUOTA_BURN_REQUEST_ORIGIN
    ? normalizeQuotaBurnProvenance(request.burn)
    : null;
  const requestId = trimmed(request?.id, 128);
  return {
    onDemand: true,
    onDemandOrigin: nullable(request?.origin),
    ...(burn ? {
      // One spread of the shared block, so this path cannot carry a different
      // set of provenance keys than the non-raw `addTask` mapping does. An
      // unreadable reset (and an unnamed request) drops out rather than being
      // written as null — see QUOTA_BURN_PROVENANCE_FIELDS.
      ...quotaBurnTaskMetadata({ ...burn, requestId }),
      ...(burn.overrides.providerId ? { provider: burn.overrides.providerId } : {}),
      ...(burn.overrides.model ? { model: burn.overrides.model } : {}),
      ...(burn.overrides.effort ? { effort: burn.overrides.effort } : {}),
    } : {}),
  };
}
