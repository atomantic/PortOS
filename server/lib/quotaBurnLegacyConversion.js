/**
 * The ONE rule that turns a LEGACY quota-burn step into a scheduled-task
 * reference — read by the migration that rewrites `data/cos/quota-burn.json`
 * and by the runtime compat path that normalizes an old client's PUT before it
 * reaches disk (`services/quotaBurnConversion.js`).
 *
 * A legacy step WAS its work: a copied prompt in a free-form `params` bag keyed
 * by a quota-only `jobType`. A step now REFERENCES a scheduled task the user
 * owns (`quotaBurnTaskRef.js`). Converting between the two is the one place in
 * PortOS that has to guess what a stored prompt MEANT, so it is written once and
 * shared — two conversions would disagree the first time either was tightened,
 * and the disagreement would show up as a duplicated automation or a silently
 * downgraded reference.
 *
 * Three outcomes, and the boundary between them is deliberately conservative:
 *
 *   - a RECOGNIZED, unmodified shipped audit preset maps onto its scheduled
 *     counterpart (`auditCatalog.js`), with issues-only mode pinned explicitly;
 *   - the two PROGRAMMATIC types map onto the scheduled handler that already
 *     implements them, carrying their run params across;
 *   - anything else — a customized prompt, an unrecognized one, a preset with
 *     no target app — becomes a CUSTOM scheduled job holding the user's exact
 *     text and workflow settings, which the step then references.
 *
 * Recognition is `matchStoredAuditPreset` (`quotaBurnPresets.js`), i.e.
 * migration 305's mission-half rule, NOT a byte match (migration 294's failure)
 * and NOT a label or a partial match. A label is a display string the user may
 * have renamed, and a partial mission match would map an edited prompt onto a
 * shipped task — silently discarding the edit and running different work with
 * the user's quota. When in doubt this module chooses the custom lane, because
 * a preserved prompt is always recoverable and a discarded one is not.
 *
 * Pure: shape and decisions only. Job creation, file writes and catalog reads
 * belong to the two adapters.
 */

import { AUDIT_DEFINITIONS } from './auditCatalog.js';
import { ON_DEMAND_INTERVAL } from './autonomousJobIntervals.js';
import { QUOTA_BURN_BOUNDS, QUOTA_BURN_JOB_TYPE } from './quotaBurnConfig.js';
import { matchStoredAuditPreset } from './quotaBurnPresets.js';
import { QUOTA_BURN_TASK_REF_KIND } from './quotaBurnTaskRef.js';
import { isProgrammaticScheduledTaskType } from './taskTargetScope.js';

/**
 * `<preset id> → <scheduled audit task type>`, INVERTED from the catalog rather
 * than restated. `auditCatalog.test.js` already fails when a burn preset ships
 * without a scheduled counterpart, so deriving the map here means the conversion
 * cannot drift from the pairing that guard enforces.
 */
export const AUDIT_TASK_TYPE_BY_PRESET_ID = Object.freeze(Object.fromEntries(
  Object.entries(AUDIT_DEFINITIONS)
    .filter(([, definition]) => typeof definition.quotaBurnId === 'string' && definition.quotaBurnId)
    .map(([taskType, definition]) => [definition.quotaBurnId, taskType]),
));

/**
 * The autonomy level a custom job needs for an UNATTENDED burn to run it
 * (`quotaBurnInvoke.js#unattendedApprovalRefusal`). A legacy `agent-prompt` step
 * ran with no approval at all, so a converted job that needed one would be a
 * step that silently stopped burning — the conversion would have "preserved"
 * the plan into something that never runs.
 */
const UNATTENDED_AUTONOMY_LEVEL = 'yolo';

/**
 * Workflow params a recognized preset step may legitimately have DIVERGED from
 * its shipped defaults on, carried across as per-invocation overrides.
 *
 * Restricted to keys `sanitizeTaskMetadata` accepts (`lib/cosValidation.js`),
 * because the generator sanitizes run overrides through exactly that allowlist —
 * carrying a key it drops would be a promise the dispatch cannot keep.
 */
const MATERIAL_PRESET_PARAMS = Object.freeze(['useWorktree', 'openPR', 'simplify', 'discardWorktree']);

/** Job-id alphabet, matching what `createJob` mints. */
const idSafe = (value) => String(value || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The custom job a converted step points at, keyed by the FAMILY and STEP it
 * came from.
 *
 * Deterministic, and that is the whole idempotency story: re-running the
 * migration (or resuming it after an interrupt) finds the job it created last
 * time by id and reuses it instead of minting a second copy of the same
 * automation. Step ids are preserved by the conversion, so the key is stable
 * across runs.
 */
export const quotaBurnCustomJobId = (familyId, stepId) =>
  `job-burn-${idSafe(familyId)}-${idSafe(stepId)}`.slice(0, QUOTA_BURN_BOUNDS.idLength.max);

const boolParam = (params, key, fallback) => (typeof params?.[key] === 'boolean' ? params[key] : fallback);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The task posture the retired `quotaBurnJobs/agentPrompt.js` executor derived
 * at dispatch time, computed once here so a converted job keeps running exactly
 * as it ran.
 *
 * The two "lands no code" postures are NOT the same and both had to be honored:
 * `noCodeOutput` means the deliverable is something the agent DOES during the
 * run (files an issue, calls an endpoint), so there is no branch; `discardWorktree`
 * means it wants a scratch checkout but nothing in it may land. Either one
 * forces `openPR`/`simplify` off — both presuppose a diff to ship — and makes a
 * clean tree a SUCCESS rather than the `pr-missing` retry that would otherwise
 * burn up to five agent runs of quota on a job that already did its work.
 */
export function legacyAgentTaskMetadata(params) {
  const discardWorktree = params?.discardWorktree === true;
  const landsNoCode = params?.noCodeOutput === true || discardWorktree;
  return {
    useWorktree: boolParam(params, 'useWorktree', true),
    openPR: !landsNoCode && boolParam(params, 'openPR', true),
    simplify: !landsNoCode && boolParam(params, 'simplify', true),
    discardWorktree,
    noCodeOutput: landsNoCode,
    worktreeChangesExpected: !landsNoCode,
  };
}

/**
 * The full custom-job RECORD a converted step references — every field
 * `createJob` writes, so the migration (which appends to
 * `data/cos/autonomous-jobs.json` directly) and the runtime adapter (which calls
 * `createJob`) produce the same job. `quotaBurnConversion.test.js` asserts the
 * two agree.
 *
 * `interval: 'on-demand'` is the "disabled from the clock" part: the job never
 * fires on a schedule (`getDueJobs` skips it), so converting a burn step does
 * not silently add a second recurring automation. It is still `enabled`, which
 * is what makes it INVOKABLE — a disabled job resolves the referencing step as
 * unavailable. The exception is a step that could never have run anyway (no
 * target app, or no prompt): that job ships disabled, so the step stays exactly
 * as non-runnable as it was instead of becoming newly live against PortOS's own
 * checkout.
 */
export function buildQuotaBurnCustomJob({ id, familyId, stepId, label, appId, prompt, params, now }) {
  const timestamp = now || new Date().toISOString();
  const runnable = Boolean(appId && prompt);
  return {
    id,
    name: label || `Quota burn — ${familyId} ${stepId}`,
    description: `Converted from the legacy quota-burn step ${familyId}/${stepId}.`,
    category: 'custom',
    appId: appId || null,
    taskMetadata: legacyAgentTaskMetadata(params),
    cronExpression: null,
    cronSchedule: null,
    type: 'agent',
    interval: ON_DEMAND_INTERVAL,
    intervalMs: null,
    scheduledTime: null,
    weekdaysOnly: false,
    enabled: runnable,
    priority: 'MEDIUM',
    autonomyLevel: UNATTENDED_AUTONOMY_LEVEL,
    promptTemplate: prompt,
    dataInputs: [],
    providerId: null,
    model: null,
    effort: null,
    command: null,
    triggerAction: null,
    config: null,
    lastRun: null,
    runCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const refOutcome = (taskRef, params, step) => ({
  taskRef,
  overrides: {
    // Provider / model / effort pins are the step's own and survive untouched —
    // they name the subscription this burn is spending, not the work.
    providerId: step?.overrides?.providerId ?? null,
    model: step?.overrides?.model ?? null,
    effort: step?.overrides?.effort ?? null,
    params,
  },
  customJob: null,
});

/**
 * Convert ONE normalized legacy step. Returns `null` for a step that already
 * carries a reference (nothing to do — which is what makes a re-run a no-op),
 * or `{ taskRef, overrides, customJob }` where `customJob` is the record the
 * adapter must ensure exists before the reference resolves.
 *
 * An unrecognized `jobType` returns `null` too: there is no work to point at, and
 * inventing one would spend real quota on something the user never configured.
 * The step keeps its settings and stays unavailable with its migration reason.
 */
export function planQuotaBurnStepConversion(step, { familyId, now } = {}) {
  if (!step || step.taskRef) return null;
  const jobType = step.jobType;
  const params = step.params || step.overrides?.params || {};

  if (isProgrammaticScheduledTaskType(jobType)) {
    // The legacy programmatic ids ARE the scheduled task types that implement
    // them — #6376 moved the implementation and kept the name. Nothing is
    // re-derived here; the params bag crosses as per-invocation overrides.
    return refOutcome({ kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN, taskType: jobType, appId: null }, { ...params }, step);
  }
  if (jobType !== QUOTA_BURN_JOB_TYPE.AGENT_PROMPT) return null;

  const appId = trimmed(params.appId) || null;
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  const preset = matchStoredAuditPreset(prompt);
  const taskType = preset ? AUDIT_TASK_TYPE_BY_PRESET_ID[preset.id] : null;

  // A recognized preset still needs a target: the built-in audit lane generates
  // a MANAGED-APP task, and an app-less request would be routed to the
  // install-wide self-improvement generator instead — different work. A step
  // with no app could never run before either, so it takes the custom lane and
  // stays as non-runnable as it was.
  if (taskType && appId) {
    return refOutcome({ kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN, taskType, appId }, {
      // Explicit, even where the shipped scheduled default is `false`: every
      // burn preset is an issues-only audit, and a migration that let a
      // catalog default flip it into code-writing work would spend the user's
      // quota changing their repository without being asked.
      fileIssues: true,
      // Only a REAL divergence from the shipped default rides along. `?? false`
      // supplies the default for a key the preset never set (`discardWorktree`),
      // so a stored `false` there is recognized as agreement rather than
      // written back as a no-op override on every converted step.
      ...Object.fromEntries(MATERIAL_PRESET_PARAMS
        .filter((key) => key in params && params[key] !== (preset.params[key] ?? false))
        .map((key) => [key, params[key]])),
    }, step);
  }

  const jobId = quotaBurnCustomJobId(familyId, step.id);
  return {
    ...refOutcome({ kind: QUOTA_BURN_TASK_REF_KIND.CUSTOM, jobId }, {}, step),
    customJob: buildQuotaBurnCustomJob({
      id: jobId,
      familyId,
      stepId: step.id,
      label: trimmed(step.label) || (preset ? preset.label : ''),
      appId,
      prompt,
      params,
      now,
    }),
  };
}

/**
 * The converted step, with its legacy identity dropped.
 *
 * Everything that is not the step's WORK is carried through untouched — id (the
 * run-once ledger and every dispatch record key on it), label, enabled state and
 * `runOnce` — so a conversion changes what a step points at and nothing else.
 */
export function applyQuotaBurnStepConversion(step, outcome) {
  return { ...step, taskRef: outcome.taskRef, jobType: null, overrides: outcome.overrides, params: outcome.overrides.params, unavailable: null };
}
