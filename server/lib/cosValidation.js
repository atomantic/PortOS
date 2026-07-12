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
// Copilot review; `claude`/`antigravity`/`codex`/`grok` instruct the review-loop
// follow-up agent to invoke the named CLI to critique the PR diff; `lmstudio`/`ollama`
// route the diff through PortOS's local code-review endpoint
// (`POST /api/code-review/local`) which runs the configured local LLM model.
// Mirrored in client/src/components/cos/constants.js → REVIEWER_OPTIONS.
export const REVIEWER_VALUES = ['copilot', 'claude', 'antigravity', 'codex', 'grok', 'lmstudio', 'ollama'];
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

// Arbitrary GitHub reviewer usernames (e.g. `@CodeReviewbot`) requested as PR
// reviewers to gate merging — a class distinct from the fixed REVIEWER_VALUES
// enum (which either invoke a CLI, hit the local-LLM endpoint, or request the
// native Copilot reviewer). Usernames are appended to slashdo's `--review-with`
// as `@user` tokens after the keyed reviewers; the review-loop follow-up prompt
// instructs the agent to request each as a PR reviewer and gate the merge on it.
//
// Stored WITHOUT the leading `@` (added back only in the flag string). The
// charset is deliberately shell-safe — a GitHub username (1–39 chars,
// alphanumeric + single hyphens, no leading/trailing hyphen) optionally followed
// by a `/team-slug` for org-team mentions. No shell metacharacters, so the token
// stays inert wherever it lands in a command string.
export const MAX_REVIEW_USERNAMES = 20;
const REVIEW_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;

/**
 * Normalize a raw list of reviewer usernames: strip an optional leading `@`,
 * trim, drop anything that isn't a shell-safe GitHub username/team slug,
 * case-insensitively dedupe (GitHub logins are case-insensitive) while
 * preserving first-occurrence order, and cap at MAX_REVIEW_USERNAMES. Returns
 * a clean array of usernames WITHOUT the `@` prefix. Non-array input → [].
 */
export function normalizeReviewUsernames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/^@+/, '');
    if (!trimmed || !REVIEW_USERNAME_RE.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_REVIEW_USERNAMES) break;
  }
  return out;
}

/**
 * Resolve reviewer usernames with task-over-default precedence: a task-level
 * list (even explicitly empty) overrides the Code Review Defaults; only fall
 * back to the defaults when the task didn't pin its own. Mirrors how
 * `normalizeReviewers`'s fallback param works for the keyed reviewers.
 */
export function resolveReviewUsernames(metadataUsernames, defaultUsernames) {
  return Array.isArray(metadataUsernames)
    ? normalizeReviewUsernames(metadataUsernames)
    : normalizeReviewUsernames(defaultUsernames);
}

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
 * Resolve the keyed (enum) reviewer list, honoring the "username-only" case: an
 * EXPLICITLY empty keyed list with username reviewers present (e.g. copilot was
 * stripped on a non-GitHub forge) stays empty rather than falling back to the
 * copilot default normalizeReviewers would apply. Absent/legacy input still
 * normalizes to the default. Single source for the guard shared by
 * `buildReviewWithArgs` and the review-loop follow-up prompt builder.
 */
export function resolveKeyedReviewers(reviewers, hasUsernames) {
  if (Array.isArray(reviewers) && reviewers.length === 0 && hasUsernames) return [];
  return normalizeReviewers({ reviewers });
}

/**
 * Build the comma-separated reviewer token list used to fill the `{reviewers}`
 * placeholder in claim/plan prompts: keyed reviewers (falling back to the
 * default when empty) followed by `@user` tokens for the reviewer usernames.
 * The flag-string variant is `buildReviewWithArgs`.
 */
export function buildReviewersCsv(reviewers, usernames = []) {
  const keyed = Array.isArray(reviewers) && reviewers.length ? reviewers : [...DEFAULT_REVIEWERS];
  const users = normalizeReviewUsernames(usernames);
  return [...keyed, ...users.map(u => `@${u}`)].join(',');
}

/**
 * Build the slashdo review flag string for an ordered reviewer list plus any
 * arbitrary GitHub reviewer usernames.
 * - `--review-with a,b,@user` only when the effective list isn't the lone default
 *   copilot (any username, or any non-default keyed reviewer, forces it on).
 *   Usernames are appended as `@user` tokens after the keyed reviewers.
 * - `--review-stop-on-*` only when the effective list is 2+ (stop-mode is
 *   meaningless for one).
 * - `--reviewer-applies` only when a non-copilot KEYED reviewer is present (a
 *   username reviewer is an external PR reviewer, not a CLI that applies fixes).
 */
export function buildReviewWithArgs(reviewers, stopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false, usernames = []) {
  const users = normalizeReviewUsernames(usernames);
  const keyed = resolveKeyedReviewers(reviewers, users.length > 0);
  const combined = [...keyed, ...users.map(u => `@${u}`)];
  const isDefaultOnly = combined.length === 1 && combined[0] === DEFAULT_REVIEWER;
  const hasNonCopilot = keyed.some(r => r !== DEFAULT_REVIEWER);
  const parts = [];
  if (!isDefaultOnly) parts.push(`--review-with ${combined.join(',')}`);
  if (combined.length >= 2) {
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
  // Arbitrary GitHub reviewer usernames requested as PR reviewers to gate the
  // merge. Normalized (strip `@`, drop unsafe/duplicate tokens) so the schema
  // can't accept a shell-unsafe or oversized list. Absent → undefined (not `[]`)
  // so an omitted field isn't persisted as an empty override.
  usernames: z.preprocess(
    v => Array.isArray(v) ? normalizeReviewUsernames(v) : undefined,
    z.array(z.string()).optional()
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
// COS JOB SCHEMAS
// =============================================================================

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
// `codexModel` is the Codex CLI model tier (e.g. `gpt-5.6-sol`) threaded into
// the review-loop follow-up prompt as `codex --model <id>` (empty/undefined =
// let the Codex CLI pick its own default).
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
  stopMode: z.enum(REVIEW_STOP_MODES).optional(),
  reviewerApplies: z.boolean().optional(),
  lmstudioModel: z.preprocess(emptyToUndefined, z.string().optional()),
  ollamaModel: z.preprocess(emptyToUndefined, z.string().optional()),
  codexModel: z.preprocess(emptyToUndefined, z.string().optional()),
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
  'cleanupMerged', 'openPr', 'resolveConflicts', 'autoMerge', 'autoClose',
  // Throwaway-worktree posture for programmatic-I/O reasoning tasks (layered-
  // intelligence): the worktree is discarded without a merge or PR so a reasoning
  // agent can't land code. See agentWorktreeCleanup.js.
  'discardWorktree'
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
 * of known reviewers, `usernames` to shell-safe GitHub reviewer usernames,
 * `reviewStopMode` to a known stop-mode — plus a validated `pipeline` object.
 * Prevents prototype pollution and reserved-field overrides.
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
