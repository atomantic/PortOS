/**
 * Chief-of-Staff (CoS) Zod schemas (split out of validation.js, issue #1831).
 *
 * Covers CoS tasks, the Code-Review settings slice, recurring jobs, loops,
 * learning insights, and the task-metadata sanitizer. The Review-Loop reviewer
 * vocabulary + helpers (`normalizeReviewers` / `buildReviewWithArgs`) moved to
 * `reviewerConfig.js` (issue #5702) and are re-exported flat from here, so
 * existing deep imports keep working. validation.js re-exports everything here
 * (flat); the barrel surfaces it as the `cosValidation` namespace.
 */
import { z } from 'zod';
import { emptyToUndefined, emptyToNull } from './zodCompat.js';
import { isPlainObject } from './objects.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { isValidSlashdoCommand } from './slashdoInvocation.js';
import { PR_COMPLETION_VALUES } from './prDisposition.js';
import { PUBLIC_REVIEW_EXECUTION_PROFILES } from './agentExecutionProfiles.js';
import { AGENT_RUN_EVENT_KINDS, RUN_EVENT_READ_LIMITS } from './agentRunEvents.js';
import { recurrenceRuleSchema } from './recurrenceValidation.js';
import { TASK_DATA_INPUT_DEFINITIONS, TASK_DATA_INPUT_IDS } from './taskDataInputCatalog.js';
import {
  EFFORT_SELECTABLE_REVIEWERS,
  KEYED_REVIEWER_PINS,
  LOCAL_LLM_REVIEWERS,
  MAX_REVIEWER_MAX_ROUNDS,
  MAX_REVIEWER_MODEL_LENGTH,
  MODEL_CAPABLE_CLI_REVIEWERS,
  MODEL_SELECTABLE_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_VALUES,
  REVIEW_STOP_MODES,
  normalizeOptionalReviewers,
  normalizeReviewUsernames,
  normalizeReviewerEffort,
  normalizeReviewerEfforts,
  normalizeReviewerMaxRounds,
  normalizeReviewerModel,
  normalizeReviewerModels,
  resolveReviewUsernames,
} from './reviewerConfig.js';

export { TASK_DATA_INPUT_DEFINITIONS, TASK_DATA_INPUT_IDS } from './taskDataInputCatalog.js';
// Transitional shim: the reviewer vocabulary lives in reviewerConfig.js but is
// still reachable from every existing `cosValidation.js` / `validation.js` import.
export * from './reviewerConfig.js';

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

// A bare slashdo command name (`plan-task`, `pr-better`). Shared by the task
// schema and the quick-template schemas. `isValidSlashdoCommand` is the single
// definition of the shape — it also gates `loadSlashdoFile`'s path join.
const slashdoCommandSchema = z.string().refine(isValidSlashdoCommand, {
  message: 'must be a bare slashdo command name (lowercase, digits, hyphens)',
});

// The app Issues tab already fetched the selected forge issue while listing the
// page. Keep that payload bounded when it is carried into a manual claim so the
// prompt cannot be inflated by a hand-crafted request. The generator truncates
// direct service calls too; this is the route boundary for browser requests.
const prefetchedIssueContextSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1000).optional(),
  body: z.string().max(12_000).optional(),
  url: z.string().max(2048).optional(),
});

// Optional guidance entered on the managed-app Issues tab. It is appended to
// the selected claim prompt, not stored as the task's human note, so it reaches
// the agent even though the claim prompt is assembled before queueing.
export const CLAIM_OVERRIDE_CONTEXT_MAX_CHARS = 4_000;
const claimOverrideContextSchema = z.preprocess(
  v => typeof v === 'string' ? (v.trim() || undefined) : v,
  z.string().max(CLAIM_OVERRIDE_CONTEXT_MAX_CHARS).optional()
);

export const createCosTaskSchema = z.object({
  description: z.string().min(1),
  diagnostics: cosTaskDiagnosticsSchema.optional(),
  priority: z.string().optional(),
  // `context` is the one-line human note; `prompt` is the full agent-facing
  // payload (#4153). A producer that passes a multi-line `context` is still
  // accepted — `cosTaskStore.addTask` routes it to `metadata.prompt`.
  context: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: effortInputSchema,
  temperature: taskTemperatureInputSchema,
  thinking: z.boolean().optional(),
  app: z.string().optional(),
  targetInstanceId: targetInstanceIdInputSchema,
  type: z.string().optional().default('user'),
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
    z.enum(REVIEWER_VALUES).optional()
  ),
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
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
  // takes none, or a level that reviewer's CLI rejects. Absent → undefined (not `{}`).
  reviewerEfforts: z.preprocess(
    v => normalizeReviewerEfforts(v),
    z.record(z.enum(EFFORT_LEVELS)).optional()
  ),
  // Bundled slashdo workflow this task runs (#3089) — the BARE command name,
  // never a rendered `/do:x` string (see slashdoInvocation.js).
  slashdoCommand: z.preprocess(emptyToUndefined, slashdoCommandSchema.optional()),
  // Explicit arguments for the workflow. Absent → the prompt builder falls back
  // to the task description, which is what the task form sends.
  slashdoArgs: z.preprocess(emptyToUndefined, z.string().max(4000).optional()),
});

export const updateCosTaskSchema = z.object({
  description: z.string().min(1).optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  context: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  effort: effortUpdateSchema,
  temperature: taskTemperatureUpdateSchema,
  thinking: z.boolean().nullable().optional(),
  app: z.string().optional(),
  targetInstanceId: targetInstanceIdUpdateSchema,
  blockedReason: z.string().optional(),
  type: z.string().optional().default('user'),
});

// Worker's dispute of a reviewer rejection (#2441). `reason` is the required
// case; `evidence` is optional supporting detail; `reviewer` names which reviewer
// verdict is being disputed (constrained to the known reviewer vocab). Bounds are
// generous but present so a hand-crafted request can't smuggle in an unbounded
// blob that then round-trips the TASKS.md store.
export const challengeTaskSchema = z.object({
  reason: z.string().trim().min(1).max(5000),
  evidence: z.string().trim().max(20_000).optional(),
  reviewer: z.enum(REVIEWER_VALUES).optional(),
});

// Automatic re-check request (#2471). Instead of a human `outcome`, the resolver
// re-runs a local-LLM reviewer against the current diff and derives the verdict
// from its fresh findings (classifyRecheckOutcome in cosChallenge.js). `model` is
// optional — falls back to the Code Review Defaults for the backend. Only the
// in-process local reviewers are supported here; CLI reviewers (claude/codex) are
// re-run by the follow-up agent itself, which then resolves with an explicit
// `outcome`.
export const challengeRecheckSchema = z.object({
  backend: z.enum(LOCAL_LLM_REVIEWERS),
  model: z.string().trim().min(1).optional(),
  diff: z.string().min(1).max(500_000),
});

// Resolution of a parked challenge (#2441, #2471). Either the caller supplies an
// explicit `outcome` (manual verdict) OR a `recheck` object (auto re-run a
// reviewer and derive the verdict) — exactly one, never both. `outcome` mirrors
// CHALLENGE_OUTCOMES in server/services/cosChallenge.js (source of truth; a parity
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

// =============================================================================
// LOOP SCHEMAS
// =============================================================================

export const createLoopSchema = z.object({
  prompt: z.string().min(1),
  interval: z.union([z.string().min(1), z.number().positive()]),
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
  interval: z.string().optional(),
  intervalMs: z.number().positive().int().optional(),
  // Null actively clears a pinned time/cron mode on update. The jobs UI has
  // always emitted null for the inactive mode; accepting it here lets updateJob
  // distinguish "clear this field" from an omitted field it should preserve.
  scheduledTime: z.string().nullable().optional(),
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
  command: z.string().optional(),
  triggerAction: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
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
  }).optional(),
});

export const updateCosJobSchema = createCosJobSchema.partial().extend({
  weekdaysOnly: z.boolean().optional(),
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

export const generateWeeklyDigestSchema = z.object({
  weekId: z.string().optional(),
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
  provider: z.string().max(120).optional(),
  model: z.string().max(200).optional(),
  effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
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
    provider: z.string().max(120).optional(),
    model: z.string().max(200).optional(),
    effort: z.preprocess(emptyToUndefined, z.enum(EFFORT_LEVELS).optional()),
    app: z.string().max(200).optional(),
  }),
  templateName: z.string().trim().min(1).max(120).optional(),
});

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
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
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
    z.preprocess(v => normalizeReviewerEffort(v, reviewer), z.string().optional()),
  ])),
}).strict();

// =============================================================================
// TASK METADATA SANITIZATION
// =============================================================================

// Agent behavior flags that can be overridden per-pipeline-stage
export const PIPELINE_BEHAVIOR_FLAGS = ['useWorktree', 'openPR', 'prCompletion', 'simplify', 'reviewLoop'];

// These two flags are dispatch/completion posture rather than ordinary
// user-facing task switches, but a pipeline stage must carry them forward to
// the child task. Keeping the list beside the generic behavior flags prevents
// each hand-off path from silently dropping the throwaway-worktree contract.
export const PIPELINE_STAGE_BEHAVIOR_FLAGS = [
  ...PIPELINE_BEHAVIOR_FLAGS,
  'discardWorktree',
  'noCodeOutput',
];

// Pipeline stage roles are semantic contracts, not display labels. The
// pr-reviewer stages use these values to decide which content may cross the
// boundary and which provider posture is safe; generic pipelines may omit the
// role and continue to use their existing promptKey-only behavior.
export const PIPELINE_STAGE_ROLES = ['security', 'eligibility', 'actions'];
// Re-exported, not restated: a new profile must be legal to persist the moment
// it is declared, or the sanitizer silently rejects the stage that uses it.
export const PIPELINE_EXECUTION_PROFILES = PUBLIC_REVIEW_EXECUTION_PROFILES;

const PIPELINE_STAGE_BOOLEAN_FIELDS = [
  'readOnly', 'managed', 'useWorktree', 'openPR', 'simplify', 'reviewLoop',
  'discardWorktree', 'noCodeOutput',
];
const PIPELINE_STAGE_STRING_LIMITS = {
  name: 120,
  promptKey: 120,
  providerId: 200,
  model: 200,
  guardId: 120,
};

function safePipelinePrecondition(raw) {
  if (!isPlainObject(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || !['fileExists', 'fileNotExists'].includes(keys[0])) return null;
  const value = raw[keys[0]];
  if (typeof value !== 'string' || !value.trim() || value.length > 240) return null;
  const path = value.trim();
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\0')) return null;
  if (path.split(/[\\/]/).some((part) => part === '..')) return null;
  return { [keys[0]]: path };
}

function sanitizePipelineStage(raw) {
  if (!isPlainObject(raw)) return null;
  const clean = Object.create(null);
  for (const [field, maxLength] of Object.entries(PIPELINE_STAGE_STRING_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    if (raw[field] === null && ['providerId', 'model'].includes(field)) continue;
    if (typeof raw[field] !== 'string') return null;
    const value = raw[field].trim();
    if (!value || value.length > maxLength) return null;
    clean[field] = value;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'role')) {
    if (!PIPELINE_STAGE_ROLES.includes(raw.role)) return null;
    clean.role = raw.role;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'executionProfile')) {
    if (!PIPELINE_EXECUTION_PROFILES.includes(raw.executionProfile)) return null;
    clean.executionProfile = raw.executionProfile;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'effort')) {
    if (raw.effort !== null && !EFFORT_LEVELS.includes(raw.effort)) return null;
    if (raw.effort !== null) clean.effort = raw.effort;
  }
  for (const field of PIPELINE_STAGE_BOOLEAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    if (typeof raw[field] !== 'boolean') return null;
    clean[field] = raw[field];
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'precondition')) {
    const precondition = safePipelinePrecondition(raw.precondition);
    if (!precondition) return null;
    clean.precondition = precondition;
  }
  return { ...clean };
}

function sanitizePipeline(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.stages) || raw.stages.length > 10) return null;
  const stages = raw.stages.map(sanitizePipelineStage);
  if (stages.some((stage) => !stage)) return null;
  return { stages };
}

// Absolute cap on total agent spawns per task (across all retry types)
export const MAX_TOTAL_SPAWNS = 5;

// `cleanupMerged` / `openPr` / `resolveConflicts` / `autoMerge` /
// `finishAbandoned` are the per-app action toggles for the `branch-reconcile`
// task type (`finishAbandoned` governs committing + shipping the uncommitted
// work left in a dead agent's worktree); `autoClose` is
// the `issue-reconcile` toggle (ON unless explicitly false — OFF forbids the
// coordinator from closing an issue or filing a follow-up, leaving it to only
// comment + release the claim). Each lives in the shared task-metadata
// allowlist — like `prAuthorFilter` / `issueAuthorFilter` — so a per-app
// override can disable an individual rectification behavior and survive
// sanitizeTaskMetadata.

// repo-sync's per-app / per-schedule action toggles. Each is ON unless
// explicitly `false` (branch-reconcile's opt-out convention), EXCEPT
// `reapRemotes`, which mutates `origin` and is therefore opt-IN. Lives here so
// the sanitizer's allowlist and services/repoSync.js read ONE list — the two
// drifting would silently drop a toggle at the app-override boundary.
export const REPO_SYNC_ACTION_KEYS = ['syncPush', 'syncPull', 'switchDefault', 'cleanupMerged', 'dropStashes', 'reapRemotes'];

const ALLOWED_TASK_METADATA_KEYS = [
  ...PIPELINE_BEHAVIOR_FLAGS, 'readOnly', 'claimFlow',
  'cleanupMerged', 'openPr', 'resolveConflicts', 'autoMerge', 'finishAbandoned', 'autoClose',
  // repo-sync's action toggles (REPO_SYNC_ACTION_KEYS above): publish branches
  // strictly ahead of their upstream, fast-forward the default branch, return the
  // checkout to it, delete merged branches, drop provably-redundant stashes, and
  // (opt-IN, since it mutates origin) reap merged orphan remote branches.
  // `cleanupMerged` deliberately reuses branch-reconcile's NAME because it means
  // the same thing — but task metadata is stored per task type, so the two are
  // independent settings. Turning it off on branch-reconcile does NOT turn it off
  // here; each task type carries its own value.
  ...REPO_SYNC_ACTION_KEYS,
  // repo-sync's per-app opt-OUT. The sweep is install-wide by design, so it
  // needs a key of its own rather than reading the per-app `enabled` flag next
  // to it: createApp SEEDS `{ enabled: false }` for every task type, so
  // `enabled` cannot distinguish "leave this repo alone" from "never configured",
  // and reading it would exclude every app on a fresh install. `enabled` still
  // governs whether the app gets its own SCHEDULED repo-sync run; this governs
  // whether the install-wide sweep visits its checkout.
  'skipRepoSync',
  // Throwaway-worktree posture for programmatic-I/O reasoning tasks (layered-
  // intelligence): the worktree is discarded without a merge or PR so a reasoning
  // agent can't land code. See agentWorktreeCleanup.js.
  'discardWorktree',
  // Whether a successful run is EXPECTED to leave file changes in the worktree
  // (#3102). Default (absent) = true for code-shaped work. `false` marks a task
  // type whose deliverable is outside the repo — e.g. a reference-watch run
  // against a GitHub/GitLab/JIRA work tracker files its proposals as issues and,
  // per the prompt, edits no application code, so a clean worktree is expected.
  'worktreeChangesExpected',
  // Allows a PortOS-owned audit's verified-empty-branch contract to survive
  // app task-type override sanitization. The finalizer also requires the
  // autonomous-job marker and a live forge proof before honoring it.
  'noChangeSuccess',
  // Audit-type toggle: file tracker issues (no code) vs implement the fix.
  // Dispatch stamps `noCodeOutput` when this is true. See server/lib/auditCatalog.js.
  'fileIssues',
  // Dispatch gate: when true, the generated system task is always awaiting-
  // approve — including an explicit Run Now. Absent/false keeps the default
  // (Run Now consents; unattended runs follow confidence/safety-kind).
  'requireApproval'
];

// pr-watcher author-gate values. 'self' = PRs opened by the gh-authenticated
// user (the PortOS operator / their automation); 'others' = everyone else;
// 'any' = no gate. Kept here so both the sanitizer and the prWatcher service
// agree on the vocabulary.
export const PR_AUTHOR_FILTERS = ['any', 'self', 'others'];

// claim-issue author-gate values. 'self' = only claim issues YOU filed (the
// gh/glab-authenticated `@me` account — the slashdo `/do:next --self` security
// boundary, and the default so a shared/multi-contributor tracker never
// auto-feeds third-party issues into an agent); 'collaborators' = you PLUS every
// account with repo/project access (a trusted-team widening of 'self' — the
// people who could already push code are not a lower trust tier than the issues
// they file); 'owner' = only claim issues filed by the repository
// owner/creator; 'any' = claim any open issue regardless of who filed it. Kept
// here so both the sanitizer and the claim-issue prompt-builder agree on the
// vocabulary.
export const ISSUE_AUTHOR_FILTERS = ['self', 'collaborators', 'owner', 'any'];

// repo-sync verify-mode vocabulary — when the coordinator agent is dispatched
// after the deterministic sweep. 'always' verifies every run; 'when-changed'
// (the default) verifies only a run that actually mutated a checkout, so a sweep
// over an already-clean machine makes no provider call at all; 'never' dispatches
// only when the sweep left something unresolved. An ESCALATION dispatches under
// every mode. Kept here so the sanitizer and services/repoSync.js agree on the
// vocabulary — and so the static task registry can name the default without
// importing the git-heavy service (it is deliberately dependency-light).
export const REPO_SYNC_VERIFY_MODES = ['always', 'when-changed', 'never'];
export const DEFAULT_REPO_SYNC_VERIFY_MODE = 'when-changed';

// `issueExcludeLabels` — extra labels a user wants left for human contributors
// (e.g. `good first issue`) rather than auto-claimed by claim-issue/claim-work.
// Unioned with the fixed NON_ACTIONABLE_ISSUE_LABELS set at read time
// (perpetualWork.js#isActionableIssue) — never replacing it. Capped well below
// GitHub/GitLab's own per-issue label limits; this is a short curated list, not
// an arbitrary label dump.
export const MAX_ISSUE_EXCLUDE_LABELS = 20;

// Per-entry length cap. GitHub caps a label name at 50 chars; GitLab allows up
// to 255. Cap at GitLab's (larger) limit rather than GitHub's — a GitHub
// label can never exceed 50 anyway, so the wider cap is a no-op there, while
// capping at 50 would silently truncate a valid long GitLab label to a prefix
// that never matches the real label, making the exclusion silently no-op.
const MAX_ISSUE_EXCLUDE_LABEL_LENGTH = 255;

/**
 * Normalize a raw `issueExcludeLabels` list: keep only non-empty strings,
 * trim, cap length per entry (GitLab's label name limit — the larger of the
 * two forges', see MAX_ISSUE_EXCLUDE_LABEL_LENGTH), case-insensitively
 * dedupe (labels are compared lowercased at read time), and cap the list at
 * MAX_ISSUE_EXCLUDE_LABELS. Unlike reviewer usernames, label text is
 * free-form ("good first issue") so no character-class restriction is
 * applied beyond trimming. Non-array input → [].
 */
export function normalizeIssueExcludeLabels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().slice(0, MAX_ISSUE_EXCLUDE_LABEL_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_ISSUE_EXCLUDE_LABELS) break;
  }
  return out;
}

// claim-issue `--swarm` fan-out size. Mirrors slashdo `/do:next --swarm=<N>`,
// which clamps N to 1..6 and treats bare `--swarm` as 3. Here a swarmCount of
// 0 (or absent) means swarm OFF (the default one-issue-per-run flow); a value
// of 2..6 turns on swarm with that many parallel claim agents. 1 is collapsed
// to off (a one-agent swarm is just the single-issue flow with overhead), so
// the smallest meaningful swarm is 2. Kept here so the sanitizer and the
// claim-issue prompt-builder agree on the vocabulary.
export const SWARM_COUNT_MIN = 2;
export const SWARM_COUNT_MAX = 6;

// branch-reconcile coordinator batch size. Unlike claim-issue's swarm count,
// this is the number of already-classified branches one coordinator receives
// in a run. A one-branch batch is valid, and the scheduler supplies the default
// when the key is absent so old task records remain compatible.
export const BRANCHES_PER_AGENT_MIN = 1;
export const BRANCHES_PER_AGENT_MAX = 6;

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
    reviewerModels: true, reviewerEfforts: true, issueTarget: true
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

/**
 * Sanitize taskMetadata to an allow-list of agent-option keys. Boolean flags
 * (`useWorktree`/`openPR`/`simplify`/`reviewLoop`/`readOnly`/`claimFlow`/
 * `reviewerApplies`)
 * are kept only when actually boolean; constrained values include `prCompletion`,
 * reviewers, reviewer usernames, and `reviewStopMode` — plus a validated pipeline
 * object. Prevents prototype pollution and reserved-field overrides.
 * Returns a clean plain object or null if input is empty/invalid.
 */
export function sanitizeTaskMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clean = Object.create(null);
  let hasKeys = false;
  for (const key of ALLOWED_TASK_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === 'boolean') {
      clean[key] = raw[key];
      hasKeys = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'prCompletion') && PR_COMPLETION_VALUES.includes(raw.prCompletion)) {
    clean.prCompletion = raw.prCompletion;
    hasKeys = true;
  }
  // `reviewer` is a legacy single constrained string.
  const normalizedReviewer = REVIEWER_ALIASES[raw.reviewer] || raw.reviewer;
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewer') && REVIEWER_VALUES.includes(normalizedReviewer)) {
    clean.reviewer = normalizedReviewer;
    hasKeys = true;
  }
  // `reviewers` is the ordered multi-reviewer list — filter to known values, dedupe, preserve order.
  if (Array.isArray(raw.reviewers)) {
    const seen = new Set();
    const list = [];
    for (const r of raw.reviewers) {
      const normalized = REVIEWER_ALIASES[r] || r;
      if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); list.push(normalized); }
    }
    if (list.length) { clean.reviewers = list; hasKeys = true; }
  }
  // `usernames` is the arbitrary GitHub reviewer-username list — normalize to
  // shell-safe, deduped, capped tokens (strips `@`, drops bogus entries). Unlike
  // `reviewers` above, an explicitly empty array is KEPT (not dropped): for
  // usernames, `[]` is a meaningful "no external gate for this task/type" choice
  // that must override the Code Review Defaults, matching resolveReviewUsernames'
  // `Array.isArray` override contract and the task-form/global-panel surfaces.
  if (Array.isArray(raw.usernames)) {
    clean.usernames = normalizeReviewUsernames(raw.usernames);
    hasKeys = true;
  }
  // `optionalReviewers` marks reviewers non-blocking (slashdo `~opt`). Like
  // `usernames`, an explicitly empty array is KEPT so a task/type can override
  // the Code Review Defaults' optional set back to "none optional."
  if (Array.isArray(raw.optionalReviewers)) {
    clean.optionalReviewers = normalizeOptionalReviewers(raw.optionalReviewers) || [];
    hasKeys = true;
  }
  // The token-keyed per-reviewer pins (caps / model / effort). Like
  // `optionalReviewers`, an explicitly empty MAP is KEPT so a task/type can
  // override the Code Review Defaults back to "each reviewer's own default" —
  // see KEYED_REVIEWER_PINS for the shared contract.
  for (const [key, normalizeMap] of KEYED_REVIEWER_PINS) {
    if (!isPlainObject(raw[key])) continue;
    clean[key] = normalizeMap(raw[key]) || {};
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewStopMode') && REVIEW_STOP_MODES.includes(raw.reviewStopMode)) {
    clean.reviewStopMode = raw.reviewStopMode;
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewerApplies') && typeof raw.reviewerApplies === 'boolean') {
    clean.reviewerApplies = raw.reviewerApplies;
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'whenDone') && ['commit-push', 'leave-uncommitted'].includes(raw.whenDone)) {
    clean.whenDone = raw.whenDone;
    hasKeys = true;
  }
  // `prAuthorFilter` gates pr-watcher dispatch on PR authorship — constrained
  // to a known value so a hand-edited config can't smuggle in an arbitrary
  // string the watcher would silently treat as "any".
  if (Object.prototype.hasOwnProperty.call(raw, 'prAuthorFilter') && PR_AUTHOR_FILTERS.includes(raw.prAuthorFilter)) {
    clean.prAuthorFilter = raw.prAuthorFilter;
    hasKeys = true;
  }
  // `verifyMode` decides when repo-sync dispatches its coordinator agent after a
  // clean deterministic pass — constrained, so an arbitrary string can't reach the
  // dispatch gate (which would fall back to the default anyway, silently).
  if (Object.prototype.hasOwnProperty.call(raw, 'verifyMode') && REPO_SYNC_VERIFY_MODES.includes(raw.verifyMode)) {
    clean.verifyMode = raw.verifyMode;
    hasKeys = true;
  }
  // `issueAuthorFilter` gates claim-issue dispatch on issue authorship —
  // constrained to a known value so a hand-edited config can't smuggle in an
  // arbitrary string the claim flow would silently treat as "owner".
  if (Object.prototype.hasOwnProperty.call(raw, 'issueAuthorFilter') && ISSUE_AUTHOR_FILTERS.includes(raw.issueAuthorFilter)) {
    clean.issueAuthorFilter = raw.issueAuthorFilter;
    hasKeys = true;
  }
  // `issueExcludeLabels` — like `usernames`/`optionalReviewers` above, an
  // explicitly empty array is KEPT (not dropped): `[]` is a meaningful "no
  // extra exclusions for this task/type" choice that must override a global
  // default's non-empty list, not silently inherit it.
  if (Array.isArray(raw.issueExcludeLabels)) {
    clean.issueExcludeLabels = normalizeIssueExcludeLabels(raw.issueExcludeLabels);
    hasKeys = true;
  }
  // `swarmCount` turns claim-issue `--swarm` fan-out on (2..6 parallel agents)
  // or off. 0 is kept as an explicit "off" (so a per-app override can disable
  // swarm even when the global default has it on — `0` = off, absent = inherit);
  // 2..6 is the swarm size. 1/non-integer/out-of-range are dropped, so a
  // hand-edited config can't smuggle in an unbounded swarm size. The prompt
  // builder treats anything below SWARM_COUNT_MIN as off (resolveSwarmBlock).
  if (Object.prototype.hasOwnProperty.call(raw, 'swarmCount')
      && Number.isInteger(raw.swarmCount)
      && (raw.swarmCount === 0
        || (raw.swarmCount >= SWARM_COUNT_MIN && raw.swarmCount <= SWARM_COUNT_MAX))) {
    clean.swarmCount = raw.swarmCount;
    hasKeys = true;
  }
  // `branchesPerAgent` bounds the branch-reconcile prompt to a deterministic
  // prefix of the prioritized in-flight set. It is separate from swarmCount:
  // branch-reconcile runs one coordinator over a batch, while claim-issue fans
  // out independent issue agents. Absent means inherit; there is no "off"
  // value because the task default intentionally supplies a safe batch size.
  if (Object.prototype.hasOwnProperty.call(raw, 'branchesPerAgent')
      && Number.isInteger(raw.branchesPerAgent)
      && raw.branchesPerAgent >= BRANCHES_PER_AGENT_MIN
      && raw.branchesPerAgent <= BRANCHES_PER_AGENT_MAX) {
    clean.branchesPerAgent = raw.branchesPerAgent;
    hasKeys = true;
  }
  // Pipeline configuration is the one nested task-metadata shape. Keep only
  // known stage fields and fail the whole update when a known field is malformed
  // so a bad custom pipeline cannot silently lose its safety posture.
  if (Object.prototype.hasOwnProperty.call(raw, 'pipeline')) {
    const pipeline = sanitizePipeline(raw.pipeline);
    if (!pipeline) return null;
    clean.pipeline = pipeline;
    hasKeys = true;
  }
  return hasKeys ? { ...clean } : null;
}

// `reviewerConfigMetadata` stays here rather than in reviewerConfig.js (#5702):
// it is a thin wrapper over `sanitizeTaskMetadata` above, and reviewerConfig.js
// must not import this module (that would close a cycle and drag Zod back into
// the reviewer vocabulary). Re-exported to callers unchanged.
/**
 * The reviewer fields a task must PERSIST so a later
 * `resolveReviewerConfig(task.metadata, …)` resolves the same list its prompt
 * names, instead of re-deriving the install-wide Code Review Defaults (#4770).
 *
 * All six travel together: resolving only `reviewers` still lets the usernames,
 * `~opt` set, and the three keyed pins fall back to the defaults, which is the
 * same disagreement one field down. Sanitized on the way out so a hand-crafted
 * request body can't smuggle an unrecognized key onto the task record, and every
 * value is re-validated rather than trusted.
 */
export function reviewerConfigMetadata(config) {
  return sanitizeTaskMetadata({
    reviewers: config?.reviewers,
    usernames: config?.usernames,
    optionalReviewers: config?.optionalReviewers,
    reviewerMaxRounds: config?.reviewerMaxRounds,
    reviewerModels: config?.reviewerModels,
    reviewerEfforts: config?.reviewerEfforts
  }) || {};
}

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
