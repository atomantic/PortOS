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
 * The two long-lived keys — `quotaBurnFamily` and `quotaBurnLimitingResetAt` —
 * are the SAME ones the legacy `quotaBurnJobs/agentPrompt.js` executor stamps,
 * on purpose: `cosTaskGenerator.js#isCooldownExemptTask`, the runner's completion
 * continuation, and `quotaBurnDenials.js` all read them off the finished agent,
 * and a reference-dispatched burn must be indistinguishable to those readers.
 */

import { isPlainObject } from './objects.js';

const MAX_FIELD = 64;

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
 */
export function onDemandRequestMetadata(request) {
  const burn = normalizeQuotaBurnProvenance(request?.burn);
  const requestId = trimmed(request?.id, 128);
  return {
    onDemand: true,
    onDemandOrigin: nullable(request?.origin),
    ...(burn ? {
      quotaBurnFamily: burn.family,
      // Omitted rather than nulled when unreadable: `cosTaskStore` only persists
      // a FINITE value, so writing an explicit null here would make the raw-task
      // path disagree with the mapped one.
      ...(burn.limitingResetAt === null ? {} : { quotaBurnLimitingResetAt: burn.limitingResetAt }),
      quotaBurnStepId: burn.stepId,
      ...(requestId ? { quotaBurnRequestId: requestId } : {}),
      ...(burn.overrides.providerId ? { provider: burn.overrides.providerId } : {}),
      ...(burn.overrides.model ? { model: burn.overrides.model } : {}),
      ...(burn.overrides.effort ? { effort: burn.overrides.effort } : {}),
    } : {}),
  };
}
