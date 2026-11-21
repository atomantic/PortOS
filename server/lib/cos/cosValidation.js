/**
 * Chief-of-Staff (CoS) route-boundary Zod schemas (split out of the retired validation.js catch-all, issue #1831).
 *
 * `createCosTaskSchema`'s metadata-bound fields are carried onto the task by
 * `services/cos/cosTaskIntake.js` (parity-checked by its test). Task-metadata
 * constants and `sanitizeTaskMetadata` / `reviewerConfigMetadata` live in `cosTaskMetadata.js`.
 */

import { CODEX_SPEED_PROBE_FAILURES } from '../executionOptions.js';
import { executionOptionsSchema } from '../aiToolkit/internal/executionOptionsValidation.js';
import { PREFETCHED_ISSUE_CONTEXT_MAX_CHARS } from '../../../lib/issueContext.js';
import { z } from 'zod';
import { MALFORMED_REVIEW_REASONS, REVIEW_FINISH_REASONS, MAX_REVIEW_RESPONSE_LENGTH, CLI_REVIEW_PHASES, CLI_REVIEW_METRICS } from '../reviewerHealth.js';
import { emptyToUndefined, emptyToNull, providerRefFieldSchema, providerRefSchema } from '../zodCompat.js';
import { MIN_INTERVAL_MS, MAX_INTERVAL_MS, isValidLoopInterval } from '../loopInterval.js';
import { EFFORT_LEVELS } from '../provider/providerModels.js';
import { PR_COMPLETION_VALUES, PR_REVIEW_MODE_VALUES } from '../prDisposition.js';
import { ORCHESTRATION_MODES, ORCHESTRATION_ROLES } from '../orchestrationProfile.js';
import { AGENT_RUN_EVENT_KINDS, RUN_EVENT_READ_LIMITS } from '../agent/agentRunEvents.js';
import { TASK_STATUS_VALUES, TASK_PRIORITY_VALUES } from '../taskParser.js';
import { recurrenceRuleSchema } from '../recurrenceValidation.js';
import { AUDIT_EXECUTION_TASK_TYPES, DEPFREE_MODES } from '../auditCatalog.js';
import { CLAIM_DRAIN_TASK_TYPES } from '../qualitySchedulePlan.js';
import { JOB_INTERVAL_VALUES } from '../autonomousJobIntervals.js';
import { jobFormFieldsSchema, jobFormValuesSchema } from '../jobFormFields.js';
import { TASK_DATA_INPUT_IDS } from '../taskDataInputCatalog.js';
import { GOAL_FIDELITY_FOLLOW_UP_TRIGGERS } from '../goalFidelityFollowUp.js';
import {
  EFFORT_SELECTABLE_REVIEWERS,
  LOCAL_LLM_REVIEWERS,
  MAX_REVIEWER_MAX_ROUNDS,
  MAX_REVIEWER_MODEL_LENGTH,
  MODEL_SELECTABLE_REVIEWERS,
  REVIEWER_ALIASES,
  isReviewer,
  isCliReviewer,
  isToolFreeReviewer,
  REVIEW_STOP_MODES,
  normalizeOptionalReviewers,
  normalizeReviewUsernames,
  normalizeStoredReviewerEffort,
  normalizeStoredReviewerEfforts,
  normalizeReviewerMaxRounds,
  normalizeReviewerModel,
  normalizeReviewerModels,
} from '../reviewerConfig.js';
import { nullishString, nonEmptyString } from '../sharedSchemas.js';
import {
  CLAIM_OVERRIDE_CONTEXT_MAX_CHARS,
  cosTaskTypeSchema,
  slashdoCommandSchema,
  slashdoCommandInputSchema,
  slashdoArgsInputSchema,
  ISSUE_AUTHOR_FILTERS,
} from './cosTaskMetadata.js';

export { scheduleExecutionFieldsSchema } from '../scheduleExecutionFieldsValidation.js';

// =============================================================================
// COS TASK SCHEMAS
// =============================================================================


// A generic file attachment uploaded via POST /api/attachments and referenced
// by the returned metadata — matches the fileInfo shape TaskAddForm.jsx sends
// (client/src/utils/fileUpload.js uploadAttachmentFile).
const cosTaskAttachmentSchema = z.object({
  filename: z.string(),
  originalName: z.string().optional(),
  path: z.string(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
});

// Structured auto-fix diagnostics (#2328) — the record autoFixer.buildFixDiagnostics
// attaches to error-driven tasks so downstream telemetry can break auto-fix outcomes
// out by fallback tier / category / failure reason. Server-internal today (autoFixer
// calls addTask directly), but validated for schema parity now that addTask persists
// it as first-class metadata.
const cosTaskDiagnosticsSchema = z.object({
  triggerEvent: z.string().optional(),
  target: z.string().optional(),
  errorType: z.string().optional(),
  category: z.string().optional(),
  tier: z.number().optional(),
  fixStrategy: z.string().optional(),
  failureReason: z.string().optional(),
}).passthrough();

// Reasoning-effort override for effort-capable CLIs (claude/codex). On create,
// '' from a form's "Default" option → undefined (no override persisted). On
// update, ''/null must survive as null so the store's legacy-field normalizer
// deletes the pin (absent-vs-cleared, AGENTS.md) — emptyToUndefined would drop
// the clear signal at the route's `!== undefined` gate and make a set effort
// permanent through the API.
// Form posts and legacy callers send booleans as 'true'/'false' strings.
const optionalBoolInputSchema = z.preprocess(
  v => v === 'true' ? true : v === 'false' ? false : v,
  z.boolean().optional()
);
const effortInputSchema = z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional());
const effortUpdateSchema = z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional());
// Federated instance this task is PINNED to (#4520) — only that instance's CoS
// evaluator claims and runs it. On create, '' from the picker's "Any instance"
// option → undefined (no pin persisted). On update, ''/null must survive as null
// so the route can clear an existing pin (absent-vs-cleared, AGENTS.md).
// Bounded-but-format-free on purpose: the id vocabulary is whatever the peers in
// this install's registry advertise, and the route is what checks membership.
const INSTANCE_ID_MAX_LENGTH = 128;
const targetInstanceIdInputSchema = z.preprocess(emptyToUndefined, z.string().trim().min(1).max(INSTANCE_ID_MAX_LENGTH).optional());
const targetInstanceIdUpdateSchema = z.preprocess(emptyToNull, z.string().trim().min(1).max(INSTANCE_ID_MAX_LENGTH).nullable().optional());
const taskTemperatureInputSchema = z.number().min(0).max(2).optional();
const taskTemperatureUpdateSchema = z.number().min(0).max(2).nullable().optional();

const prefetchedIssueContextSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(PREFETCHED_ISSUE_CONTEXT_MAX_CHARS.title).optional(),
  body: z.string().max(PREFETCHED_ISSUE_CONTEXT_MAX_CHARS.body).optional(),
  url: z.string().max(PREFETCHED_ISSUE_CONTEXT_MAX_CHARS.url).optional(),
});

// Optional guidance entered on the managed-app Issues tab. It is appended to
// the selected claim prompt, not stored as the task's human note, so it reaches
// the agent even though the claim prompt is assembled before queueing.
const claimOverrideContextSchema = z.preprocess(
  v => typeof v === 'string' ? (v.trim() || undefined) : v,
  z.string().max(CLAIM_OVERRIDE_CONTEXT_MAX_CHARS).optional()
);

// Orchestrated execution (#5992). `direct` — the default — is today's behavior:
// one provider, one model, one effort for the whole run. `orchestrated` splits it
// into architect / implementer / reviewer roles, each with its own provider+model,
// and hands the architect the six-part spec contract a context-free delegated lane
// needs. '' from a form's "Default" option → undefined so no mode is persisted;
// on update ''/null survives as null so the store can clear the pin
// (absent-vs-cleared, AGENTS.md).
const orchestrationRoleSchema = z.object({
  provider: z.preprocess(emptyToUndefined, providerRefSchema.optional()),
  model: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(300).optional()),
  // Per-role reasoning effort. The architect's own rung for its planning pass;
  // for the implementer it is the DEFAULT a spec's `REASONING:` line overrides.
  effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
  executionOptions: executionOptionsSchema.optional(),
}).strict();

export const orchestrationProfileSchema = z.object(
  Object.fromEntries(ORCHESTRATION_ROLES.map(role => [role, orchestrationRoleSchema.optional()]))
).strict();

export const namedOrchestrationProfileSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  description: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
  profile: orchestrationProfileSchema,
  isBuiltin: z.boolean().optional(),
}).strict();

export const orchestrationProfilesSettingsSchema = z.array(namedOrchestrationProfileSchema);

const orchestrationModeInputSchema = z.preprocess(emptyToUndefined, z.enum(ORCHESTRATION_MODES).optional());
const orchestrationModeUpdateSchema = z.preprocess(emptyToNull, z.enum(ORCHESTRATION_MODES).nullable().optional());

const reviewerSchema = z.string().refine(isReviewer, 'Unknown reviewer');

// Priority and status are bounded by what TASKS.md can REPRESENT, not by a free
// string. The markdown store is the only copy of a queued task, and a value
// outside these vocabularies used to delete the task and its `metadata.prompt`
// on the next full-file rewrite — a 200 response for irreversible data loss
// (#7239). `generateTasksMarkdown` now repairs rather than drops, but the
// request that would have caused it belongs at the boundary as a 400.
//
// Case-insensitive with a trim, because real callers already send `'high'`
// (apps/tabs/GitTab.jsx, GitRecoveryAction.jsx) alongside `'MEDIUM'`; an empty
// string is the form's unset and stays absent rather than becoming a rejection.
const normalizeEnumInput = transform => value =>
  typeof value === 'string' ? (transform(value.trim()) || undefined) : value;

const taskPriorityInputSchema = z.preprocess(
  normalizeEnumInput(v => v.toUpperCase()),
  z.enum(TASK_PRIORITY_VALUES).optional()
);

const taskStatusInputSchema = z.preprocess(
  normalizeEnumInput(v => v.toLowerCase()),
  z.enum(TASK_STATUS_VALUES).optional()
);

// Query schemas for the CoS insight/learning/workflow reads. Counts stay strings: each handler
// clamps or defaults them itself, so a bad number degrades exactly as before; unknown keys are stripped.
export const cosActivityCalendarQuerySchema = z.object({ weeks: z.string().optional() });
export const cosDecisionsQuerySchema = z.object({ limit: z.string().optional(), type: z.string().optional() });
export const cosDigestCompareQuerySchema = z.object({ week1: z.string().optional(), week2: z.string().optional() });
export const cosWorkflowQuerySchema = z.object({ hours: z.string().optional() });

export const cosTaskDeleteQuerySchema = z.object({ type: cosTaskTypeSchema.default('user') });

// The metadata-bound fields below are carried onto the task by
// `services/cos/cosTaskIntake.js#buildTaskMetadata`; its test fails when a field is
// added here without a mapping there (or an explicit non-metadata verdict).
export const createCosTaskSchema = z.object({
  description: z.string().min(1),
  diagnostics: cosTaskDiagnosticsSchema.optional(),
  priority: taskPriorityInputSchema,
  // `context` is the one-line human note; `prompt` is the full agent-facing
  // payload (#4153). A producer that passes a multi-line `context` is still
  // accepted — `cosTaskStore.addTask` routes it to `metadata.prompt`.
  context: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: providerRefFieldSchema.optional(),
  effort: effortInputSchema,
  executionOptions: executionOptionsSchema.optional(),
  orchestrationMode: orchestrationModeInputSchema,
  orchestrationProfile: orchestrationProfileSchema.optional(),
  temperature: taskTemperatureInputSchema,
  thinking: z.boolean().optional(),
  app: z.string().optional(),
  targetInstanceId: targetInstanceIdInputSchema,
  type: cosTaskTypeSchema.default('user'),
  approvalRequired: z.boolean().optional(),
  screenshots: z.array(z.string()).optional(),
  attachments: z.array(cosTaskAttachmentSchema).optional(),
  position: z.enum(['top', 'bottom']).optional().default('bottom'),
  createJiraTicket: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  jiraTicketId: z.string().optional(),
  jiraTicketUrl: z.string().optional(),
  useWorktree: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // Marks a task the user queued as an INVESTIGATION (#6043) — today the
  // installer-failure "Queue agent to investigate" button. The flag is all a
  // client may supply: the route derives the dedup fingerprint server-side
  // (`clientInvestigationFingerprint`) and applies `CLIENT_INVESTIGATION_DELIVERY`,
  // so a client can neither hand-craft a key that collides with an auto-filed
  // investigation nor pick its own delivery posture. Without this field Zod
  // stripped the flag, leaving UI-queued repairs outside the investigation
  // dedup, the circuit breaker, and the meta-cascade guard.
  isInvestigation: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // A self-managed recovery of the configured checkout, rather than CoS delivery.
  workflow: z.enum(['app-checkout-recovery']).optional(),
  whenDone: z.enum(['commit-push', 'leave-uncommitted']).optional(),
  // Read-only planning mode: investigate the codebase and file the issue, but
  // do not start implementation delivery. The task store expands this into
  // the safe no-worktree/no-PR/no-simplify posture before persistence.
  planOnly: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // Plan-only issue destination when the selected app is a fork. The server
  // resolves this role to a validated forge repository; callers never provide
  // an arbitrary owner/repo string.
  issueTarget: z.enum(['upstream', 'origin']).optional(),
  openPR: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  prCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
  // Absent inherits the app's `useAutoMerge` (resolveUseAutoMerge).
  useAutoMerge: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // Absent inherits the app's `autoApprovePR` / `adminMerge` (resolveAutoApprovePR / resolveAdminMerge).
  autoApprovePR: optionalBoolInputSchema,
  adminMerge: optionalBoolInputSchema,
  simplify: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // The slashdo catalog's deliverable posture (#3636): whether this run is
  // EXPECTED to leave commits in its worktree. A report-shaped workflow
  // (`/do:review`) carries `false` so downstream bookkeeping does not treat its
  // correctly-clean tree as missing code work. Carried onto the task by
  // `cosTaskStore.js` only on a strict boolean — absent means "no opinion".
  worktreeChangesExpected: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  reviewLoop: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  reviewer: z.preprocess(
    v => v === '' ? undefined : (typeof v === 'string' ? (REVIEWER_ALIASES[v] ?? v) : v),
    reviewerSchema.optional()
  ),
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(reviewerSchema).optional()
  ),
  reviewStopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  // Arbitrary GitHub reviewer usernames requested as PR reviewers to gate the
  // merge. Normalized (strip `@`, drop unsafe/duplicate tokens) so the schema
  // can't accept a shell-unsafe or oversized list. Absent → undefined (not `[]`)
  // so an omitted field isn't persisted as an empty override.
  usernames: z.preprocess(
    v => Array.isArray(v) ? normalizeReviewUsernames(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Reviewer identities (keyed slugs and/or `@username`) marked non-blocking —
  // emitted with slashdo's `~opt` suffix. Normalized so a hand-crafted request
  // can't smuggle junk in. Absent → undefined (not `[]`).
  optionalReviewers: z.preprocess(
    v => Array.isArray(v) ? normalizeOptionalReviewers(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Per-reviewer iteration caps (slashdo `~max=<n>`), keyed by the emitted
  // `--review-with` token. Normalized so a hand-crafted request can't smuggle in
  // an unbounded or non-integer budget. Absent → undefined (not `{}`); an entry
  // with no usable cap is dropped rather than coerced to `0` (which slashdo reads
  // as "loop until clean").
  reviewerMaxRounds: z.preprocess(
    v => normalizeReviewerMaxRounds(v),
    z.record(z.number().int().min(0).max(MAX_REVIEWER_MAX_ROUNDS)).optional()
  ),
  // Per-reviewer model pins, keyed by the emitted `--review-with` token — the
  // model id ONE reviewer runs with (emitted as slashdo's `[<model>]`, or threaded
  // into the follow-up prompt as `<reviewer> --model <id>`). Normalized so a
  // hand-crafted request can't pin a model on a reviewer that takes none, or
  // persist a blank id. Absent → undefined (not `{}`).
  reviewerModels: z.preprocess(
    v => normalizeReviewerModels(v),
    z.record(z.string().min(1).max(MAX_REVIEWER_MODEL_LENGTH)).optional()
  ),
  // Per-reviewer reasoning-effort pins, keyed by the emitted `--review-with`
  // token — how hard ONE reviewer thinks (`codex -c model_reasoning_effort=high`,
  // `claude --effort high`, or a local reviewer's `reasoning_effort` body field).
  // Normalized so a hand-crafted request can't pin an effort on a reviewer that
  // takes none. Catalog-dependent tiers are preserved here and validated with
  // their model at execution. Absent → undefined (not `{}`).
  reviewerEfforts: z.preprocess(
    v => normalizeStoredReviewerEfforts(v),
    z.record(z.enum(EFFORT_LEVELS)).optional()
  ),
  // Bundled slashdo workflow this task runs (#3089) — the BARE command name,
  // never a rendered `/do:x` string (see slashdoInvocation.js).
  slashdoCommand: slashdoCommandInputSchema,
  // Explicit arguments for the workflow. Absent → the prompt builder falls back
  // to the task description, which is what the task form sends.
  slashdoArgs: slashdoArgsInputSchema,
});

export const updateCosTaskSchema = z.object({
  description: z.string().min(1).optional(),
  priority: taskPriorityInputSchema,
  status: taskStatusInputSchema,
  context: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: providerRefFieldSchema.optional(),
  effort: effortUpdateSchema,
  executionOptions: executionOptionsSchema.optional(),
  orchestrationMode: orchestrationModeUpdateSchema,
  orchestrationProfile: orchestrationProfileSchema.nullable().optional(),
  temperature: taskTemperatureUpdateSchema,
  thinking: z.boolean().nullable().optional(),
  app: z.string().optional(),
  targetInstanceId: targetInstanceIdUpdateSchema,
  blockedReason: z.string().optional(),
  type: cosTaskTypeSchema.default('user'),
});

// Worker's dispute of a reviewer rejection (#2441). `reason` is the required
// case; `evidence` is optional supporting detail; `reviewer` names which reviewer
// verdict is being disputed (constrained to the known reviewer vocab). Bounds are
// generous but present so a hand-crafted request can't smuggle in an unbounded
// blob that then round-trips the TASKS.md store.
export const challengeTaskSchema = z.object({
  reason: z.string().trim().min(1).max(5000),
  evidence: z.string().trim().max(20_000).optional(),
  reviewer: reviewerSchema.optional(),
});

// Automatic re-check request (#2471). Instead of a human `outcome`, the resolver
// re-runs a local-LLM reviewer against the current diff and derives the verdict
// from its fresh findings (classifyRecheckOutcome in cosChallenge.js). `model` is
// optional — falls back to the Code Review Defaults for the backend. Only the
// in-process local reviewers are supported here; CLI reviewers (claude/codex) are
// re-run by the follow-up agent itself, which then resolves with an explicit
// `outcome`.
export const challengeRecheckSchema = z.object({
  backend: z.string().refine(isToolFreeReviewer),
  model: z.string().trim().min(1).optional(),
  diff: z.string().min(1).max(500_000),
});

// Resolution of a parked challenge (#2441, #2471). Either the caller supplies an
// explicit `outcome` (manual verdict) OR a `recheck` object (auto re-run a
// reviewer and derive the verdict) — exactly one, never both. `outcome` mirrors
// CHALLENGE_OUTCOMES in server/services/cos/cosChallenge.js (source of truth; a parity
// test keeps them in lockstep). `upheld` overturns the rejection (task → pending);
// `escalated` surfaces the unresolved dispute to the user (task → blocked +
// arbitration task).
export const resolveChallengeSchema = z.object({
  outcome: z.enum(['upheld', 'escalated']).optional(),
  recheck: challengeRecheckSchema.optional(),
  note: z.string().trim().max(5000).optional(),
  resolvedBy: z.string().trim().max(200).optional(),
}).refine(
  (v) => (v.outcome != null) !== (v.recheck != null),
  { message: 'Provide exactly one of `outcome` or `recheck`.', path: ['outcome'] },
);

// A follow-up investigator reporting that a goal-fidelity finding was WRONG —
// the objective was delivered and the reviewer misjudged it
// (`lib/goalFidelityCalibration.js`).
//
// Every field is a BOUNDED STRING, including `gap`, which is the one field that
// changes behaviour (the queued calibration dedupes on it). Deliberately not the
// `GOAL_FIDELITY_CONTEXT_GAPS` enum: `normalizeGoalFidelityContextGap` is the
// single gate, and it folds an unrecognized gap onto `other` rather than
// dropping the report. Rejecting here instead would throw away the prose
// diagnosis — the expensive part, produced by an agent that investigated a
// finished run — over a near-miss enum value, and would put that module in the
// closure of the 283 suites this file is reached from to re-check what the
// normalizer already checks.
//
// `fingerprint` / `taskId` / `verdict` are provenance the server never trusts as
// identity: the dedup key is derived from the gap, and the verdict is restated
// in the task body as text with nothing branching on it.
export const goalFidelityFalsePositiveSchema = z.object({
  gap: z.string().trim().min(1).max(60),
  detail: z.string().trim().max(5000).optional(),
  evidence: z.string().trim().max(20_000).optional(),
  fingerprint: z.string().trim().max(500).optional(),
  taskId: z.string().trim().max(200).optional(),
  verdict: z.string().trim().max(40).optional(),
});

// =============================================================================
// LOOP SCHEMAS
// =============================================================================

export const createLoopSchema = z.object({
  prompt: z.string().trim().min(1),
  interval: z.union([z.string().min(1), z.number().positive()])
    .refine(isValidLoopInterval, `Interval must be between ${MIN_INTERVAL_MS / 1000} seconds and ${Math.floor(MAX_INTERVAL_MS / 86_400_000)} days`),
  name: z.string().optional(),
  cwd: z.string().optional(),
  providerId: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  timeout: z.number().positive().optional(),
  runImmediately: z.boolean().optional(),
});

// =============================================================================
// TASK SCHEDULE SCHEMAS
// =============================================================================

// Provenance of a schedule config's stored prompt. `promptCustomized` alone cannot
// tell a deliberate user pin from a flag the legacy migration inferred, so the
// self-heal in taskScheduleStore.js reads this instead (#5432):
//   'user'            — written by updateTaskInterval from an explicit prompt write.
//   'legacy-inferred' — written by the legacy migration's "differs from every known
//                       shipped default" branch.
// Absent/null is pre-existing state and is treated as 'legacy-inferred', so an
// install upgrading into this keeps today's self-heal behavior. Additive and
// absent-tolerant, so no migration is required.
export const PROMPT_SOURCES = ['user', 'legacy-inferred'];

// Empty string from a client clears the provenance rather than 400ing, matching
// the clearable-null convention the other schedule overrides use.
export const promptSourceSchema = z.preprocess(emptyToNull, z.enum(PROMPT_SOURCES).nullable().optional());

// =============================================================================
// COS JOB SCHEMAS
// =============================================================================

// Deterministic context sources that can be preloaded before a scheduled agent
// starts. The ids are persisted on both built-in schedule entries and custom
// agent jobs; taskDataInputs.js owns the I/O behind each id. Keep this catalog
// descriptive and side-effect-free so APIs can expose it directly to every
// configuration surface without duplicating labels or capabilities in clients.
export const taskDataInputsSchema = z.array(z.enum(TASK_DATA_INPUT_IDS))
  .max(TASK_DATA_INPUT_IDS.length)
  .transform((ids) => [...new Set(ids)]);

export const createCosJobSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['agent', 'shell', 'script']).optional(),
  // The autonomous-job cadence vocabulary. Previously a bare z.string(), so a
  // typo'd cadence reached disk and silently rescheduled the job daily via
  // resolveIntervalMs's old `default: DAY` fall-through. Note this is NOT the
  // scheduled-CoS-task INTERVAL_TYPES vocabulary — nothing converts between them.
  interval: z.enum(JOB_INTERVAL_VALUES).optional(),
  // Only meaningful for the `custom` cadence; never required or back-filled for
  // the on-demand one, which resolves to a null intervalMs by design.
  intervalMs: z.number().positive().int().optional(),
  // Null actively clears a pinned time/cron mode on update. The jobs UI has
  // always emitted null for the inactive mode; accepting it here lets updateJob
  // distinguish "clear this field" from an omitted field it should preserve.
  scheduledTime: z.string().nullable().optional(),
  // Local weekday (0-6, weekly/biweekly) or day of month (1-31, monthly) a clock
  // job stays on. Which range applies depends on the cadence, so updateJob checks
  // the fit; null asks the server to default it from the job's lastRun.
  scheduleAnchor: z.number().int().min(0).max(31).nullable().optional(),
  cronExpression: z.string().nullable().optional(),
  // Optional calendar rule for schedules that need an anchored interval (for
  // example every two weeks). cronExpression remains the compatibility preview
  // and the raw/custom path.
  cronSchedule: recurrenceRuleSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.string().optional(),
  autonomyLevel: z.enum(['standby', 'assistant', 'manager', 'yolo']).optional(),
  promptTemplate: z.string().optional(),
  // Deterministic repository/tracker context appended before the agent starts.
  // An empty array actively clears every selection on update; absent preserves
  // the stored selection.
  dataInputs: taskDataInputsSchema.optional(),
  // The job's own configuration form: `formFields` declares the inputs, and
  // `formValues` carries what they are currently set to. They are validated —
  // and stored — separately so re-aiming a job (a new value) is not an edit to
  // its design (a new field), and an empty array/object actively clears each.
  formFields: jobFormFieldsSchema.optional(),
  formValues: jobFormValuesSchema.optional(),
  // Null actively clears the field: the jobs UI emits `command: null` /
  // `triggerAction: null` whenever a job is saved as an AI-agent type (the two
  // keys only apply to shell/script jobs), so rejecting null 400'd every edit of
  // an agent job. Empty string keeps its historical meaning per field.
  command: z.string().nullable().optional(),
  triggerAction: z.preprocess(v => (v === '' ? undefined : v), z.string().nullable().optional()),
  // Optional AI provider + model override for agent jobs. Empty string from the
  // UI picker → null so a PUT can actively clear the override back to the active
  // provider/default model (updateJob only skips `undefined`). Forwarded into the
  // generated task's metadata as `provider`/`model` by generateTaskFromJob.
  providerId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  model: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional reasoning-effort override (claude/codex). Mirrors providerId's
  // clearable-null semantics — '' from the UI picker → null so a PUT can reset it
  // back to the provider default. Forwarded into the generated task's metadata as
  // `effort` by generateTaskFromJob; no-op'd at spawn for non-effort providers.
  effort: effortUpdateSchema,
  executionOptions: executionOptionsSchema.optional(),
  // Optional managed-app scope. Empty string from the UI picker → null so a PUT
  // can actively un-scope a job back to global (updateJob only skips `undefined`,
  // so undefined would silently preserve the old scope). Absent key stays
  // undefined (preserve existing on PUT, default null on create).
  appId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional git-workflow options for app-scoped agent jobs.
  taskMetadata: z.object({
    useWorktree: z.boolean().optional(),
    openPR: z.boolean().optional(),
    prCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
    simplify: z.boolean().optional(),
    // Absent = true for code-shaped work. `false` marks a report-shaped job whose
    // deliverable is intentionally outside the worktree — see
    // ALLOWED_TASK_METADATA_KEYS below and agentTuiSpawning.js (#3102).
    worktreeChangesExpected: z.boolean().optional(),
    // PortOS-owned audits may succeed after proving the branch is empty; the
    // finalizer still requires the forge/no-commit proof before honoring this.
    noChangeSuccess: z.boolean().optional(),
    // Opt a custom AGENT job into file-issues delivery. A custom job is
    // user-authored, so unlike a built-in audit type it has no catalog default
    // — the explicit flag IS the opt-in, and `generateTaskFromJob` turns it
    // into the shared posture from lib/auditCatalog.js
    // (`FILE_ISSUES_DELIVERY_SETTINGS`), overriding the code-shipping
    // useWorktree/openPR/simplify keys above. Zod strips unknown keys, so
    // without this row the flag never survives a job create/update.
    fileIssues: z.boolean().optional(),
    auditDepth: z.enum(['quick', 'deep']).optional(),
    auditWorkflow: z.literal('extended-v1').optional(),
    deepAuditId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).optional(),
    // The two "lands no code" postures, which are NOT the same. `noCodeOutput`
    // = the deliverable is something the agent DOES during the run (files an
    // issue, calls an endpoint), so there is no branch and every commit/push/PR
    // instruction is stripped from the prompt. `discardWorktree` = it wants a
    // scratch checkout but nothing in it may land — without which
    // `useWorktree` + `openPR: false` is the AUTO-MERGE posture. Both are
    // carried by a job converted from a legacy quota-burn step (#6381), and Zod
    // strips unknown keys, so without these rows the posture would silently
    // vanish the first time the user saved that job.
    noCodeOutput: z.boolean().optional(),
    discardWorktree: z.boolean().optional(),
  }).optional(),
});

export const updateCosJobSchema = createCosJobSchema.partial().extend({
  weekdaysOnly: z.boolean().optional(),
});

// Manual "Run now", with an optional one-off configuration. The values are
// merged over the job's stored `formValues` for THAT RUN ONLY — nothing is
// written back to the job — which is the whole point of an on-demand job: it is
// re-aimed per trigger without an edit to its saved design. An absent body (the
// historical shape of this endpoint) runs the job exactly as stored.
export const triggerCosJobSchema = z.object({
  formValues: jobFormValuesSchema.optional(),
});

// =============================================================================
// COS LEARNING SCHEMAS
// =============================================================================

export const recordLearningInsightSchema = z.object({
  type: z.string().optional(),
  message: z.string().min(1),
  taskType: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});

export const dismissRecommendationSchema = z.object({
  id: z.string().min(1),
  snapshot: z.unknown().optional(),
});

export const restoreRecommendationSchema = z.object({
  id: z.string().min(1),
});

// weekId becomes the digest filename (`<weekId>.json`), so it must be exactly an ISO week id.
export const generateWeeklyDigestSchema = z.object({
  weekId: z.string().regex(/^\d{4}-W\d{2}$/, 'Invalid weekId format. Use YYYY-WXX (e.g., 2026-W02)').optional(),
});

// =============================================================================
// QUICK TASK TEMPLATE SCHEMAS (#3089)
// =============================================================================

// Run-shape defaults a template implies. Every key is optional and each one is
// a tri-state: ABSENT means "leave the form's current toggle alone", `false`
// means "turn it off". Collapsing absent to false would make every template
// silently clear toggles it never intended to touch.
// `.strict()`, so every run-shape key a built-in (or user-saved) template may
// carry must be listed here — including the catalog's deliverable posture
// `worktreeChangesExpected`, or saving such a template 400s.
export const taskTemplateSettingsSchema = z.object({
  useWorktree: z.boolean().optional(),
  openPR: z.boolean().optional(),
  simplify: z.boolean().optional(),
  worktreeChangesExpected: z.boolean().optional(),
}).strict();

export const createTaskTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().min(1).max(4000),
  icon: z.string().max(16).optional(),
  context: z.string().max(4000).optional(),
  category: z.string().max(60).optional(),
  provider: providerRefFieldSchema.optional(),
  model: z.string().max(200).optional(),
  effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
  executionOptions: executionOptionsSchema.optional(),
  app: z.string().max(200).optional(),
  slashdoCommand: z.preprocess(emptyToUndefined, slashdoCommandSchema.optional()),
  settings: taskTemplateSettingsSchema.optional(),
}).strict();

// PUT accepts any subset — the route only forwards the keys actually present.
export const updateTaskTemplateSchema = createTaskTemplateSchema.partial();

// POST /templates/from-task snapshots a live task into a user template. Only the
// fields createTemplateFromTask actually reads are accepted.
export const taskTemplateFromTaskSchema = z.object({
  task: z.object({
    description: z.string().min(1).max(4000),
    context: z.string().max(4000).optional(),
    provider: providerRefFieldSchema.optional(),
    model: z.string().max(200).optional(),
    effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
    executionOptions: executionOptionsSchema.optional(),
    app: z.string().max(200).optional(),
  }),
  templateName: z.string().trim().min(1).max(120).optional(),
});

// CLI outcome reports carry only a bounded projection, never raw output or
// provider headers. A successful process exit alone is not a review verdict.
const cliReviewerIdentitySchema = z.string().max(40).refine(value => isReviewer(value) && isCliReviewer(value));
export const cliReviewerOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({
    reviewer: cliReviewerIdentitySchema,
    outcome: z.literal('reviewed'),
    verdict: z.enum(['clean', 'findings']),
    // Optional so reports from prompts built before #16572 still validate; with
    // agentId the verdict is also recorded on that running agent's record.
    agentId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
    round: z.number().int().min(1).max(1000).optional(),
    changedLines: z.number().int().min(0).max(10_000_000).optional(),
  }).strict(),
  z.object({
    reviewer: cliReviewerIdentitySchema,
    outcome: z.literal('failed'),
    failure: z.object({
      name: z.string().max(80).optional(),
      statusCode: z.number().int().min(100).max(599).optional(),
      isRetryable: z.boolean().optional(),
      providerErrorType: z.string().max(80).optional(),
      message: z.string().max(512).optional(),
    }).strict(),
  }).strict(),
]);

// Global Code Review Loop defaults (settings.codeReview). Surfaced on the AI
// Providers page; TaskAddForm + ScheduleTab seed from this when the user
// hasn't already chosen a per-task / per-task-type reviewer list. The follow-
// up spawner reads it as the fallback for `reviewers` when none are passed in.
// `lmstudioModel` / `ollamaModel` are the installed model ids the local-LLM
// reviewer should run with (empty/undefined = pick the active default model).
// `codexModel` / `claudeModel` / `antigravityModel` are per-CLI-reviewer model
// tiers (see MODEL_CAPABLE_CLI_REVIEWERS) threaded into the review-loop follow-up
// prompt as `<reviewer> --model <id>` (empty/undefined = let that CLI pick its
// own default).
// `claudeModel` doubles as the Ollama model id when the user runs an
// Ollama-backed `claude` (isOllamaClaudeProvider) as their reviewer.
export const codeReviewSettingsSchema = z.object({
  reviewerFallbackGroups: z.preprocess(
    v => Array.isArray(v) ? v : undefined,
    z.array(z.array(reviewerSchema).min(1)).optional()
  ),
  reviewerHealth: z.record(z.object({
    pausedUntil: z.number().int().positive().optional(),
    reason: z.string().optional(),
    code: z.string().optional(),
    probeFailure: z.enum(CODEX_SPEED_PROBE_FAILURES).optional(),
    message: z.string().optional(),
    failureCount: z.number().int().nonnegative().optional(),
    lastFailureAt: z.number().int().positive().optional(),
    diagnostics: z.object({
      cli: z.object({
        phase: z.enum(CLI_REVIEW_PHASES),
        ...Object.fromEntries(CLI_REVIEW_METRICS.map(key => [key, z.number().int().min(0).max(2 ** 31 - 1).nullable()])),
      }).strict().optional(),
      reason: z.enum(MALFORMED_REVIEW_REASONS),
      finishReason: z.enum(REVIEW_FINISH_REASONS),
      responseLengthChars: z.number().int().min(0).max(MAX_REVIEW_RESPONSE_LENGTH).nullable(),
      responseLengthCapped: z.boolean().nullable(),
    }).strict().optional(),
  })).optional(),
  providerModels: z.preprocess(normalizeReviewerModels, z.record(z.string()).optional()),
  providerEfforts: z.preprocess(normalizeStoredReviewerEfforts, z.record(z.string()).optional()),
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(reviewerSchema).optional()
  ),
  // Arbitrary GitHub reviewer usernames (e.g. `@CodeReviewbot`) requested as PR
  // reviewers to gate the merge, appended to `--review-with` after the keyed
  // reviewers. Normalized so a hand-edited settings.json can't smuggle in a
  // shell-unsafe or oversized token list. Absent → undefined (not `[]`).
  usernames: z.preprocess(
    v => Array.isArray(v) ? normalizeReviewUsernames(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Reviewer identities (keyed slugs and/or `@username`) marked non-blocking —
  // emitted with slashdo's `~opt` suffix so an inconclusive verdict from them
  // doesn't gate the merge (a hard-error still does). Absent → undefined.
  optionalReviewers: z.preprocess(
    v => Array.isArray(v) ? normalizeOptionalReviewers(v) : undefined,
    z.array(z.string()).optional()
  ),
  // Per-reviewer iteration caps (slashdo `~max=<n>`) keyed by emitted token —
  // e.g. `{ ollama: 1 }` buys one review-and-fix pass from a slow local model.
  // Absent → undefined; an unusable entry is dropped, never coerced to `0`.
  reviewerMaxRounds: z.preprocess(
    v => normalizeReviewerMaxRounds(v),
    z.record(z.number().int().min(0).max(MAX_REVIEWER_MAX_ROUNDS)).optional()
  ),
  stopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.boolean().optional(),
  // Each scalar runs through the same shape check as a task-level pin
  // (`normalizeReviewerModel`), so a stored default can't carry an id the token
  // builders would silently drop — the picker would otherwise DISPLAY a pin that
  // never reaches a reviewer. An unusable value clears the field (undefined)
  // rather than persisting: same "absent = that reviewer's own default" contract.
  //
  // GENERATED from the roster, not hand-listed: this object is `.strict()`, so a
  // reviewer that gains model selection (`antigravity`, #3728) would have its
  // PATCH REJECTED until someone remembered to add a line here — while every other
  // site derives its `<reviewer>Model` key from MODEL_SELECTABLE_REVIEWERS and
  // would already be carrying the pin.
  ...Object.fromEntries(MODEL_SELECTABLE_REVIEWERS.map(reviewer => [
    `${reviewer}Model`,
    z.preprocess(v => normalizeReviewerModel(v, reviewer), z.string().optional()),
  ])),
  // Per-reviewer reasoning-effort defaults, one scalar per effort-capable reviewer
  // (the model scalars' twin — same rationale for staying scalars: the encoding
  // crosses installs). Each is checked against that reviewer's OWN ladder, so
  // `antigravityEffort: 'max'` — a level `agy` rejects — clears rather than
  // persisting a pin no invocation would carry.
  //
  // Generated from the roster for the same reason as the model scalars above.
  ...Object.fromEntries(EFFORT_SELECTABLE_REVIEWERS.map(reviewer => [
    `${reviewer}Effort`,
    z.preprocess(v => normalizeStoredReviewerEffort(v, reviewer), z.string().optional()),
  ])),
  // Goal-fidelity gate (#5994) — the second, objective-aware review that runs at
  // agent completion and asks whether the diff delivers what the task asked for.
  // Its own block rather than another `<reviewer>*` scalar because it is a
  // DIFFERENT review with a different question, and the user must be able to run
  // it on a model other than whatever reviews code quality.
  //
  // `backend` is restricted to the local-LLM set: the gate runs inside
  // `finalizeAgent`, in the server process, and the CLI reviewers are invoked by
  // the follow-up agent from a prompt with no server-side entry point. `model` /
  // `effort` go through the same per-reviewer normalizers as the scalars above,
  // keyed on that backend, so an unusable value clears rather than persisting a
  // pin no request would carry. All four absent = inherit the quality chain's own
  // local reviewer (see `resolveGoalFidelityConfig`); `enabled: false` is the
  // explicit off switch.
  //
  // `fileIssue` / `queueTask` / `followUpOn` are the FOLLOW-UP half (see
  // `lib/goalFidelityFollowUp.js`): what to do about a finding once the review
  // has one. Both actions default OFF — filing on someone's tracker and
  // spawning an unattended run are each a thing a user opts into — and
  // `followUpOn` narrows which verdicts count, defaulting to the `rethink` that
  // already holds a run.
  goalFidelity: z.object({
    enabled: z.boolean().optional(),
    backend: z.preprocess(emptyToUndefined, z.enum(LOCAL_LLM_REVIEWERS).optional()),
    model: z.string().max(MAX_REVIEWER_MODEL_LENGTH).optional(),
    effort: z.preprocess(emptyToUndefined, z.string().optional()),
    executionOptions: executionOptionsSchema.optional(),
    fileIssue: z.boolean().optional(),
    queueTask: z.boolean().optional(),
    followUpOn: z.preprocess(emptyToUndefined, z.enum(GOAL_FIDELITY_FOLLOW_UP_TRIGGERS).optional()),
  }).strict().optional(),
}).strict();

// POST /api/cos/tasks/slashdo — a `/do:*` button click from an app's Agent
// Operations panel. The run-settings fields are PICKED from createCosTaskSchema
// rather than restated, so the drawer's provider/model/effort/simplify/reviewer
// knobs stay in lockstep with the Add Task form's (one vocabulary, one set of
// preprocessors). `command` is only shape-checked here — the route owns the
// allowed-command map and its 400 message. The remaining fields are `/do:next`
// specific: `target` pins the run to ONE work item (empty ⇒ the agent picks),
// `issueContext` carries title/body already fetched by the app Issues tab, and
// `issueAuthorFilter` overrides the app's configured claim-work gate. The
// optional `overrideContext` is user guidance appended to the selected claim
// prompt, rather than the queue's one-line human note.
export const slashdoTaskSchema = createCosTaskSchema
  .pick({
    model: true, provider: true, effort: true, simplify: true,
    reviewers: true, usernames: true, optionalReviewers: true, reviewerMaxRounds: true,
    reviewerModels: true, reviewerEfforts: true, issueTarget: true, prCompletion: true
  })
  .extend({
    command: z.string().min(1),
    app: z.string().min(1),
    target: z.preprocess(emptyToUndefined, z.string().trim().max(80).optional()),
    // Content already fetched by the managed-app Issues tab for a manually
    // targeted forge claim. `buildClaimWorkTask` embeds it in the agent prompt;
    // scheduled/self-claim flows omit it and continue to read live issue state.
    issueContext: prefetchedIssueContextSchema.optional(),
    overrideContext: claimOverrideContextSchema,
    issueAuthorFilter: z.enum(ISSUE_AUTHOR_FILTERS).optional(),
    // `/do:depfree`-only: the removal bar, forwarded as the command's
    // `--heavy` / `--extreme` flag (the default bar sends no flag).
    depfreeMode: z.enum(DEPFREE_MODES).optional(),
  });

// The Pull Requests tab's "Run with" picker (mirrors the Issues tab's same
// picker). PICKED from createCosTaskSchema so the provider/model/effort
// vocabulary and its preprocessors stay identical to every other manual dispatch
// surface. Every field is optional — an untouched picker resolves the install's
// active provider, same as the bare button always did.
//
// This is the WHOLE body of `POST …/pull-requests/:number/review`, and
// deliberately so: that route queues a `pr-reviewer` run, whose reviewers come
// from that scheduled task's own stages, so review settings sent there would be
// a request the server accepts and nothing applies.
export const pullRequestProviderOverrideSchema = createCosTaskSchema
  .pick({ model: true, provider: true, effort: true });

// …and the body of `/resolve` and `/do-review`, the two actions PortOS composes
// itself: the same provider pin plus this run's review settings.
//
// `reviewMode` is the one field with no counterpart on the task schema: it is a
// property of how THIS action composes its review, not of the queued task's own
// settings, and each route translates it into that route's own vocabulary (a
// self-review marker on the follow-up for `/resolve`, `--review-with none` for
// `/do-review`). The reviewer fields beside it are the ordinary per-run override,
// resolved over the install's Code Review Defaults.
export const pullRequestRunSettingsSchema = pullRequestProviderOverrideSchema
  .extend(createCosTaskSchema
    .pick({
      reviewers: true, usernames: true, optionalReviewers: true,
      reviewerMaxRounds: true, reviewerModels: true, reviewerEfforts: true,
    })
    .shape)
  .extend({
    reviewMode: z.enum(PR_REVIEW_MODE_VALUES).optional(),
  });

// POST /api/cos/agents/:id/resume — the resume dialog's edits for a paused
// agent's next run. PICKED from createCosTaskSchema for the same reason
// slashdoTaskSchema is: one vocabulary and one set of preprocessors for the
// provider/model/effort knobs, whichever form supplied them. Every field is
// optional — the resume requeues the paused agent's OWN task, so an untouched
// dialog is a valid "resume exactly as it was". `description` only matters on
// the fallback path where the paused task is gone and a fresh one is queued.
export const resumeCosAgentSchema = createCosTaskSchema
  .pick({ description: true, context: true, model: true, provider: true, effort: true, app: true, screenshots: true })
  .partial();

// A relaunch is a resume aimed at a RUNNING agent: the point is swapping the
// provider/model/effort out from under a stalled run (a CLI parked on a usage
// limit), so it takes no `description` — the task it requeues is the one the
// agent is already working. `reason` is the pause note recorded against it.
// Derived from the resume schema, not re-picked from the task schema, so a field
// added to one resume door reaches the other instead of silently diverging.
export const relaunchCosAgentSchema = resumeCosAgentSchema
  .omit({ description: true, screenshots: true })
  .extend({ reason: z.string().trim().max(500).optional() });

// =============================================================================
// CoS RUN EVENT LEDGER (read-only diagnostics, #4540)
// =============================================================================

// Query bounds for the read-only run-event diagnostics under
// `/api/agents/activity/run-events`. `z.coerce` because these arrive as query
// strings; the `limit` ceiling IS the ledger's own `RUN_EVENT_READ_LIMITS.max`
// (imported, not copied — a literal here would drift into 400-ing requests the
// service would happily serve, or clamping ones it would refuse).
export const runEventsQuerySchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128).optional(),
  taskId: z.string().min(1).max(128).optional(),
  kind: z.enum(AGENT_RUN_EVENT_KINDS).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(RUN_EVENT_READ_LIMITS.max).optional()
}).strict();

export const runEventProjectionsQuerySchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(RUN_EVENT_READ_LIMITS.max).optional()
}).strict();

// A projection id is either a run id or the `agent:<agentId>` fallback key a
// run that never got an id folds under (see `runEventKey`).
export const runEventProjectionIdSchema = z.object({
  id: z.string().min(1).max(140)
});

// Reconciliation report/repair (#4540). `runId` narrows to one run; `limit`
// shares the ledger's read ceiling because the projections being reconciled
// come straight off that read path — a separate ceiling here could only
// disagree with it.
export const runEventReconcileSchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(RUN_EVENT_READ_LIMITS.max).optional()
}).strict();

// The Quality tab's "schedule every applicable check" form. Every
// field is optional: an untouched form is a valid "plan the applicable checks
// with the shipped defaults", which is the whole point of the feature.
//
// `taskTypes` is bounded by the audit catalog rather than by
// SELF_IMPROVEMENT_TASK_TYPES: the planner lays out AUDITS, and a request
// naming `do-release` would otherwise have its cadence rewritten by a form
// that never showed it. `fileIssuesByType` is keyed the same way and read only
// for the types actually scheduled.
export const qualitySchedulePlanSchema = z.object({
  taskTypes: z.array(z.enum(AUDIT_EXECUTION_TASK_TYPES)).max(AUDIT_EXECUTION_TASK_TYPES.length).optional(),
  // partialRecord, not record: a Zod 4 enum-keyed record demands EVERY key, and
  // the form only sends the checks whose mode the user actually changed.
  fileIssuesByType: z.partialRecord(z.enum(AUDIT_EXECUTION_TASK_TYPES), z.boolean()).optional(),
  // null = spread the selection evenly over the week.
  checksPerDay: z.number().int().min(1).max(24).nullable().optional(),
  windowStartHour: z.number().int().min(0).max(23).optional(),
  windowEndHour: z.number().int().min(0).max(23).optional(),
  claimBetween: z.boolean().optional(),
  claimOffsetHours: z.number().int().min(1).max(23).optional(),
  claimTaskType: z.enum(CLAIM_DRAIN_TASK_TYPES).optional(),
  padBeforeHours: z.number().int().min(0).max(12).optional(),
  padAfterHours: z.number().int().min(0).max(12).optional(),
  // null = let each audit's catalog default decide (the form's default),
  // which is NOT the same as an absent key meaning the same thing by accident.
  fileIssues: z.boolean().nullable().optional(),
}).strict();

// CoS agents / tasks / schedule
export const cosAgentFeedbackBodySchema = z.object({
  rating: z.enum(['positive', 'negative', 'neutral']),
  comment: nullishString,
});
export const cosAgentBtwBodySchema = z.object({ message: z.string().trim().min(1).max(5000) });
export const cosTaskReorderBodySchema = z.object({ taskIds: z.array(nonEmptyString) });
export const cosTaskSpawnBodySchema = z.object({ resetSpawnBudget: z.boolean().default(false) }).strict();
export const cosScheduleTriggerBodySchema = z.object({
  taskType: nonEmptyString,
  appId: nullishString,
  provider: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  effort: z.string().trim().nullable().optional(),
  executionOptions: z.record(z.unknown()).optional(),
  targetModels: z.array(nonEmptyString).nullable().optional(),
  targetPullRequest: z.union([z.number(), z.string()]).nullable().optional(),
});
export const releaseSynchronizationResetBodySchema = z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export const releaseDeliveryVerificationBodySchema = z.object({ identity: z.string().regex(/^[a-f0-9]{64}$/),
  prNumber: z.number().int().positive().safe() }).strict();

// A scoped release names the exact inventory row the operator saw (#12002).
// `checkoutIdentity` (the retired checkout fingerprint) stays accepted and
// ignored: persisted rows and older clients still carry it.
export const heldCheckoutRetireBodySchema = z.object({
  checkoutIdentity: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
  appId: nonEmptyString,
  path: nonEmptyString.optional(),
  head: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  branch: z.string().min(1).nullable(),
  locked: z.boolean(),
  lockReason: z.string().nullable(),
});
