/**
 * The ONE rule turning a LEGACY quota-burn step into a scheduled-task reference, shared by migration 359 and the live compat path.
 *
 * The ONE rule turning a LEGACY quota-burn step (copied prompt + quota-only `jobType`) into a scheduled-task reference, shared by migration 359 (rewrites `data/cos/quota-burn.json`) and the live compat path
 * (`services/quotaBurnConversion.js`, normalizing an old client's PUT) so the two cannot drift: it is the one place that must guess what a stored prompt MEANT, and two conversions would disagree
 * as a duplicated automation or a silently downgraded reference. Three conservative outcomes:
 *
 *   - a RECOGNIZED, unmodified shipped audit preset maps onto its scheduled counterpart (`auditCatalog.js`), issues-only mode pinned explicitly;
 *   - the two PROGRAMMATIC types map onto the scheduled handler that implements them, carrying run params across;
 *   - anything else (customized/unrecognized prompt, preset with no target app) becomes a CUSTOM scheduled job holding the user's exact text and settings, which the step references.
 *
 * Recognition is `matchStoredAuditPreset` (`quotaBurnPresets.js`, migration 305's mission-half rule), NOT a byte match (migration 294's failure), a label (user-renameable), or a partial match
 * (it would map an edited prompt onto a shipped task and silently discard the edit). When in doubt choose the custom lane: a preserved prompt is recoverable, a discarded one is not.
 * Pure: shape and decisions only; job creation, file writes and catalog reads belong to the two adapters.
 */

import { ON_DEMAND_INTERVAL } from './autonomousJobIntervals.js';
import { QUOTA_BURN_BOUNDS, QUOTA_BURN_JOB_TYPE } from './quotaBurnConfig.js';
import { matchStoredAuditPreset } from './quotaBurnPresets.js';
import { QUOTA_BURN_TASK_REF_KIND } from './quotaBurnTaskRef.js';
import { isProgrammaticScheduledTaskType } from './taskTargetScope.js';

// Frozen preset IDs are input to older quota-burn migrations.
export const AUDIT_TASK_TYPE_BY_PRESET_ID = Object.freeze({
  'security-audit': 'security',
  'a11y-audit': 'accessibility',
  'api-contract-audit': 'api-contract',
  'test-gap-audit': 'test-quality-coverage',
  'perf-audit': 'performance-efficiency',
  'docs-audit': 'documentation-content',
  'mobile-audit': 'design-usability',
  'resilience-audit': 'reliability-error-handling',
  'ux-audit': 'design-usability',
  'data-safety-audit': 'data-integrity-safety',
  'simplify-audit': 'code-simplification',
  'ui-lifecycle-audit': 'ui-runtime-bugs',
  'observability-audit': 'reliability-error-handling',
  'copy-audit': 'documentation-content',
});

/** Autonomy a custom job needs for an UNATTENDED burn (`quotaBurnInvoke.js#unattendedApprovalRefusal`); a legacy `agent-prompt` step ran with no approval, so a converted job needing one would silently stop burning. */
const UNATTENDED_AUTONOMY_LEVEL = 'yolo';

/** Workflow params a recognized preset step may have DIVERGED on, carried as per-invocation overrides. Restricted to keys `sanitizeTaskMetadata` (`lib/cos/cosValidation.js`) accepts, since the generator sanitizes run overrides through that allowlist. */
const MATERIAL_PRESET_PARAMS = Object.freeze(['useWorktree', 'openPR', 'simplify', 'discardWorktree']);

/** Job-id alphabet, matching what `createJob` mints. */
const idSafe = (value) => String(value || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

/** The custom job a converted step points at, keyed by FAMILY and STEP. Deterministic, which is the idempotency story: a re-run or resumed migration finds its earlier job by id instead of minting a duplicate (step ids are preserved). */
export const quotaBurnCustomJobId = (familyId, stepId) =>
  `job-burn-${idSafe(familyId)}-${idSafe(stepId)}`.slice(0, QUOTA_BURN_BOUNDS.idLength.max);

const boolParam = (params, key, fallback) => (typeof params?.[key] === 'boolean' ? params[key] : fallback);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The task posture the retired `quotaBurnJobs/agentPrompt.js` derived at dispatch, computed once so a converted job runs as before. Two distinct "lands no code" postures: `noCodeOutput` (the deliverable is
 * something the agent DOES: no branch) and `discardWorktree` (scratch checkout, nothing may land). Either forces `openPR`/`simplify` off and makes a clean tree a SUCCESS rather than a `pr-missing` retry
 * that would burn up to five agent runs of quota.
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
 * The full custom-job RECORD a converted step references, every field `createJob` writes, so the migration (appends to `data/cos/autonomous-jobs.json` directly) and the runtime adapter (`createJob`)
 * produce the same job (`quotaBurnConversion.test.js` asserts it). `interval: 'on-demand'` keeps it off the clock (`getDueJobs` skips it) so conversion adds no second recurring automation, yet it stays `enabled`
 * (a disabled job resolves the step as unavailable). A step that could never have run (no target app or prompt) ships disabled so it stays non-runnable rather than going live against PortOS's own checkout.
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
    scheduleAnchor: null,
    enabled: runnable,
    priority: 'MEDIUM',
    autonomyLevel: UNATTENDED_AUTONOMY_LEVEL,
    promptTemplate: prompt,
    dataInputs: [],
    // No configuration form (the prompt is fully specified), stamped anyway so this record matches what `createJob` produces for the same legacy PUT (quotaBurnConversion.test.js).
    formFields: [],
    formValues: {},
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
    // Provider / model / effort pins are the step's own and survive untouched: they name the subscription spent, not the work.
    providerId: step?.overrides?.providerId ?? null,
    model: step?.overrides?.model ?? null,
    effort: step?.overrides?.effort ?? null,
    params,
  },
  customJob: null,
});

/**
 * Convert ONE normalized legacy step. Returns `null` for a step that already carries a reference (a re-run is a no-op) or an unrecognized `jobType` (no work to point at; inventing one would spend
 * quota on something never configured; the step stays unavailable with its migration reason), else `{ taskRef, overrides, customJob }` where `customJob` must exist before the reference resolves.
 */
export function planQuotaBurnStepConversion(step, { familyId, now } = {}) {
  if (!step || step.taskRef) return null;
  const jobType = step.jobType;
  const params = step.params || step.overrides?.params || {};

  if (isProgrammaticScheduledTaskType(jobType)) {
    // The legacy programmatic ids ARE the scheduled task types implementing them (#6376 kept the name); the params bag crosses as per-invocation overrides.
    return refOutcome({ kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN, taskType: jobType, appId: null }, { ...params }, step);
  }
  if (jobType !== QUOTA_BURN_JOB_TYPE.AGENT_PROMPT) return null;

  const appId = trimmed(params.appId) || null;
  const prompt = typeof params.prompt === 'string' ? params.prompt : '';
  const preset = matchStoredAuditPreset(prompt);
  const taskType = preset ? AUDIT_TASK_TYPE_BY_PRESET_ID[preset.id] : null;

  // A recognized preset still needs a target: the built-in audit lane generates a MANAGED-APP task, and an app-less request would route to the install-wide generator (different work). An app-less step
  // could never run, so it takes the custom lane and stays non-runnable.
  if (taskType && appId) {
    return refOutcome({ kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN, taskType, appId }, {
      // Explicit even where the scheduled default is `false`: every burn preset is an issues-only audit, and a catalog default flipping it into code-writing would spend quota changing the repo unasked.
      fileIssues: true,
      // Only a REAL divergence rides along; `?? false` supplies the default for a key the preset never set, so a stored `false` reads as agreement, not a no-op override.
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

/** The converted step with its legacy identity dropped. Everything that is not the WORK (id, which the run-once ledger and dispatch records key on, label, enabled, `runOnce`) is carried through untouched. */
export function applyQuotaBurnStepConversion(step, outcome) {
  return { ...step, taskRef: outcome.taskRef, jobType: null, overrides: outcome.overrides, params: outcome.overrides.params, unavailable: null };
}
