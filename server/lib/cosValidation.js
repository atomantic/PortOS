/**
 * Chief-of-Staff (CoS) Zod schemas + reviewer config (split out of validation.js,
 * issue #1831).
 *
 * Covers CoS tasks, the Review-Loop reviewer vocabulary + helpers
 * (`normalizeReviewers` / `buildReviewWithArgs`), the Code-Review settings slice,
 * recurring jobs, loops, learning insights, and the task-metadata sanitizer.
 * validation.js re-exports everything here (flat) so existing deep imports keep
 * working; the barrel surfaces it as the `cosValidation` namespace.
 */
import { z } from 'zod';
import { emptyToUndefined, emptyToNull } from './zodCompat.js';

// =============================================================================
// COS TASK SCHEMAS
// =============================================================================

// Reviewer choices for the Review Loop. `copilot` requests a native GitHub
// Copilot review; `claude`/`antigravity`/`codex` instruct the review-loop follow-up
// agent to invoke the named CLI to critique the PR diff; `lmstudio`/`ollama`
// route the diff through PortOS's local code-review endpoint
// (`POST /api/code-review/local`) which runs the configured local LLM model.
// Mirrored in client/src/components/cos/constants.js → REVIEWER_OPTIONS.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'lmstudio', 'ollama'];
export const REVIEWER_ALIASES = { gemini: 'antigravity' };
export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = ['copilot'];
// Reviewers that resolve to a local-LLM backend (rather than a CLI or GitHub
// bot). Used by the code-review endpoint, settings panel, and prompt builder
// to gate model-id resolution.
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama'];
// Stop-mode for the multi-reviewer loop (slashdo `--review-stop-on-*`).
export const REVIEW_STOP_MODES = ['all', 'on-findings', 'on-clean'];
export const DEFAULT_REVIEW_STOP_MODE = 'all';

/**
 * Resolve task metadata to an ordered, deduped reviewer list. Prefers the new
 * `reviewers` array; falls back to the legacy single `reviewer` string. When
 * the metadata yields nothing, returns `fallback` (default `['copilot']`) —
 * pass the settings-resolved defaults here so a Review Loop run picks up the
 * user's Code Review Defaults instead of the hardcoded copilot when the task
 * itself didn't pin reviewers. Filters to known reviewers and preserves
 * first-occurrence order.
 */
export function normalizeReviewers(meta, fallback = DEFAULT_REVIEWERS) {
  const raw = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const source = Array.isArray(raw.reviewers)
    ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const seen = new Set();
  const out = [];
  for (const r of source) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  if (out.length) return out;
  const fallbackList = [];
  const fallbackSeen = new Set();
  for (const r of Array.isArray(fallback) ? fallback : []) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !fallbackSeen.has(normalized)) {
      fallbackSeen.add(normalized);
      fallbackList.push(normalized);
    }
  }
  return fallbackList.length ? [...fallbackList] : [...DEFAULT_REVIEWERS];
}

/**
 * Build the slashdo review flag string for an ordered reviewer list.
 * - `--review-with a,b,c` only when the list isn't the lone default copilot.
 * - `--review-stop-on-*` only when 2+ reviewers (stop-mode is meaningless for one).
 * - `--reviewer-applies` only when a non-copilot reviewer is present (no-op on copilot).
 */
export function buildReviewWithArgs(reviewers, stopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false) {
  const list = normalizeReviewers({ reviewers });
  const isDefaultOnly = list.length === 1 && list[0] === DEFAULT_REVIEWER;
  const hasNonCopilot = list.some(r => r !== DEFAULT_REVIEWER);
  const parts = [];
  if (!isDefaultOnly) parts.push(`--review-with ${list.join(',')}`);
  if (list.length >= 2) {
    if (stopMode === 'on-findings') parts.push('--review-stop-on-findings');
    else if (stopMode === 'on-clean') parts.push('--review-stop-on-clean');
  }
  if (reviewerApplies && hasNonCopilot) parts.push('--reviewer-applies');
  return parts.join(' ');
}

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

export const createCosTaskSchema = z.object({
  description: z.string().min(1),
  diagnostics: cosTaskDiagnosticsSchema.optional(),
  priority: z.string().optional(),
  context: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  app: z.string().optional(),
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
  openPR: z.preprocess(
    v => v === 'true' ? true : v === 'false' ? false : v,
    z.boolean().optional()
  ),
  simplify: z.preprocess(
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
});

export const updateCosTaskSchema = z.object({
  description: z.string().min(1).optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
  context: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  app: z.string().optional(),
  blockedReason: z.string().optional(),
  type: z.string().optional().default('user'),
});

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
// COS JOB SCHEMAS
// =============================================================================

export const createCosJobSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['agent', 'shell', 'script']).optional(),
  interval: z.string().optional(),
  intervalMs: z.number().positive().int().optional(),
  scheduledTime: z.string().optional(),
  cronExpression: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.string().optional(),
  autonomyLevel: z.enum(['standby', 'assistant', 'manager', 'yolo']).optional(),
  promptTemplate: z.string().optional(),
  command: z.string().optional(),
  triggerAction: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  // Optional AI provider + model override for agent jobs. Empty string from the
  // UI picker → null so a PUT can actively clear the override back to the active
  // provider/default model (updateJob only skips `undefined`). Forwarded into the
  // generated task's metadata as `provider`/`model` by generateTaskFromJob.
  providerId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  model: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional managed-app scope. Empty string from the UI picker → null so a PUT
  // can actively un-scope a job back to global (updateJob only skips `undefined`,
  // so undefined would silently preserve the old scope). Absent key stays
  // undefined (preserve existing on PUT, default null on create).
  appId: z.preprocess(emptyToNull, z.string().nullable().optional()),
  // Optional git-workflow options for app-scoped agent jobs.
  taskMetadata: z.object({
    useWorktree: z.boolean().optional(),
    openPR: z.boolean().optional(),
    simplify: z.boolean().optional(),
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

// Global Code Review Loop defaults (settings.codeReview). Surfaced on the AI
// Providers page; TaskAddForm + ScheduleTab seed from this when the user
// hasn't already chosen a per-task / per-task-type reviewer list. The follow-
// up spawner reads it as the fallback for `reviewers` when none are passed in.
// `lmstudioModel` / `ollamaModel` are the installed model ids the local-LLM
// reviewer should run with (empty/undefined = pick the active default model).
export const codeReviewSettingsSchema = z.object({
  reviewers: z.preprocess(
    v => Array.isArray(v) ? v.map(r => (typeof r === 'string' ? (REVIEWER_ALIASES[r] ?? r) : r)) : v,
    z.array(z.enum(REVIEWER_VALUES)).optional()
  ),
  stopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.boolean().optional(),
  lmstudioModel: z.preprocess(emptyToUndefined, z.string().optional()),
  ollamaModel: z.preprocess(emptyToUndefined, z.string().optional()),
}).strict();

// =============================================================================
// TASK METADATA SANITIZATION
// =============================================================================

// Agent behavior flags that can be overridden per-pipeline-stage
export const PIPELINE_BEHAVIOR_FLAGS = ['useWorktree', 'openPR', 'simplify', 'reviewLoop'];

// Absolute cap on total agent spawns per task (across all retry types)
export const MAX_TOTAL_SPAWNS = 5;

// `cleanupMerged` / `openPr` / `resolveConflicts` / `autoMerge` are the
// per-app action toggles for the `branch-reconcile` task type; `autoClose` is
// the `issue-reconcile` toggle (ON unless explicitly false — OFF forbids the
// coordinator from closing an issue or filing a follow-up, leaving it to only
// comment + release the claim). Each lives in the shared task-metadata
// allowlist — like `prAuthorFilter` / `issueAuthorFilter` — so a per-app
// override can disable an individual rectification behavior and survive
// sanitizeTaskMetadata.
const ALLOWED_TASK_METADATA_KEYS = [
  ...PIPELINE_BEHAVIOR_FLAGS, 'readOnly',
  'cleanupMerged', 'openPr', 'resolveConflicts', 'autoMerge', 'autoClose'
];

// pr-watcher author-gate values. 'self' = PRs opened by the gh-authenticated
// user (the PortOS operator / their automation); 'others' = everyone else;
// 'any' = no gate. Kept here so both the sanitizer and the prWatcher service
// agree on the vocabulary.
export const PR_AUTHOR_FILTERS = ['any', 'self', 'others'];

// claim-issue author-gate values. 'self' = only claim issues YOU filed (the
// gh/glab-authenticated `@me` account — the slashdo `/do:next --self` security
// boundary, and the default so a shared/multi-contributor tracker never
// auto-feeds third-party issues into an agent); 'owner' = only claim issues
// filed by the repository owner/creator; 'any' = claim any open issue regardless
// of who filed it. Kept here so both the sanitizer and the claim-issue
// prompt-builder agree on the vocabulary.
export const ISSUE_AUTHOR_FILTERS = ['self', 'owner', 'any'];

// claim-issue `--swarm` fan-out size. Mirrors slashdo `/do:next --swarm=<N>`,
// which clamps N to 1..6 and treats bare `--swarm` as 3. Here a swarmCount of
// 0 (or absent) means swarm OFF (the default one-issue-per-run flow); a value
// of 2..6 turns on swarm with that many parallel claim agents. 1 is collapsed
// to off (a one-agent swarm is just the single-issue flow with overhead), so
// the smallest meaningful swarm is 2. Kept here so the sanitizer and the
// claim-issue prompt-builder agree on the vocabulary.
export const SWARM_COUNT_MIN = 2;
export const SWARM_COUNT_MAX = 6;

/**
 * Sanitize taskMetadata to an allow-list of agent-option keys. Boolean flags
 * (`useWorktree`/`openPR`/`simplify`/`reviewLoop`/`readOnly`/`reviewerApplies`)
 * are kept only when actually boolean; the review-loop keys are constrained by
 * value — `reviewer` to a known reviewer, `reviewers` to a filtered/deduped list
 * of known reviewers, `reviewStopMode` to a known stop-mode — plus a validated
 * `pipeline` object. Prevents prototype pollution and reserved-field overrides.
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
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewStopMode') && REVIEW_STOP_MODES.includes(raw.reviewStopMode)) {
    clean.reviewStopMode = raw.reviewStopMode;
    hasKeys = true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewerApplies') && typeof raw.reviewerApplies === 'boolean') {
    clean.reviewerApplies = raw.reviewerApplies;
    hasKeys = true;
  }
  // `prAuthorFilter` gates pr-watcher dispatch on PR authorship — constrained
  // to a known value so a hand-edited config can't smuggle in an arbitrary
  // string the watcher would silently treat as "any".
  if (Object.prototype.hasOwnProperty.call(raw, 'prAuthorFilter') && PR_AUTHOR_FILTERS.includes(raw.prAuthorFilter)) {
    clean.prAuthorFilter = raw.prAuthorFilter;
    hasKeys = true;
  }
  // `issueAuthorFilter` gates claim-issue dispatch on issue authorship —
  // constrained to a known value so a hand-edited config can't smuggle in an
  // arbitrary string the claim flow would silently treat as "owner".
  if (Object.prototype.hasOwnProperty.call(raw, 'issueAuthorFilter') && ISSUE_AUTHOR_FILTERS.includes(raw.issueAuthorFilter)) {
    clean.issueAuthorFilter = raw.issueAuthorFilter;
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
  // Pass through pipeline config (validated shape: object with stages array)
  if (raw.pipeline && typeof raw.pipeline === 'object' && Array.isArray(raw.pipeline.stages)) {
    clean.pipeline = raw.pipeline;
    hasKeys = true;
  }
  return hasKeys ? { ...clean } : null;
}
