/**
 * CoS task-metadata constants, pipeline/label normalizers, and `sanitizeTaskMetadata`.
 */

import { z } from 'zod';
import { executionOptionsSchema } from '../aiToolkit/internal/executionOptionsValidation.js';
import { auditWorkflow } from '../auditWorkflow.js';
import { isPlainObject } from '../objects.js';
import { isValidSelfManagedPrStaleMinutes, normalizeSelfManagedPrAuthors } from '../selfManagedPrAuthors.js';
import { EFFORT_LEVELS } from '../provider/providerModels.js';
import { isValidSlashdoCommand } from '../slashdoInvocation.js';
import { PR_COMPLETION_VALUES } from '../prDisposition.js';
import { QUEUEABLE_IMAGE_MODES } from '../generationModes.js';
import { normalizeAutopilotParams } from '../musicVideo/musicVideoAutonomous.js';
import { PUBLIC_REVIEW_EXECUTION_PROFILES } from '../agent/agentExecutionProfiles.js';
import { DEPFREE_MODES } from '../auditCatalog.js';
import { emptyToUndefined } from '../zodCompat.js';
import {
  KEYED_REVIEWER_PINS,
  REVIEWER_ALIASES,
  isReviewer,
  normalizeReviewerList,
  REVIEW_STOP_MODES,
  normalizeOptionalReviewers,
  normalizeReviewUsernames,
} from '../reviewerConfig.js';

export const cosTaskTypeSchema = z.enum(['user', 'internal']);

// A bare slashdo command name (`plan-task`, `pr-better`). Shared by the task
// schema, quick-template schemas, and `sanitizeTaskMetadata`. `isValidSlashdoCommand`
// is the single definition of the shape — it also gates `loadSlashdoFile`'s path join.
export const slashdoCommandSchema = z.string().refine(isValidSlashdoCommand, {
  message: 'must be a bare slashdo command name (lowercase, digits, hyphens)',
});

export const slashdoCommandInputSchema = z.preprocess(emptyToUndefined, slashdoCommandSchema.optional());
export const slashdoArgsInputSchema = z.preprocess(emptyToUndefined, z.string().max(4000).optional());

// Optional guidance entered on the managed-app Issues tab. It is appended to
// the selected claim prompt, not stored as the task's human note, so it reaches
// the agent even though the claim prompt is assembled before queueing.
export const CLAIM_OVERRIDE_CONTEXT_MAX_CHARS = 4_000;

// =============================================================================
// TASK METADATA SANITIZATION
// =============================================================================

// Agent behavior flags that can be overridden per-pipeline-stage
const PIPELINE_BEHAVIOR_FLAGS = ['useWorktree', 'openPR', 'prCompletion', 'simplify', 'reviewLoop'];

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
const PIPELINE_STAGE_ROLES = ['security', 'eligibility', 'actions'];
// Re-exported, not restated: a new profile must be legal to persist the moment
// it is declared, or the sanitizer silently rejects the stage that uses it.
const PIPELINE_EXECUTION_PROFILES = PUBLIC_REVIEW_EXECUTION_PROFILES;

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

const largeInputFallbackSchema = z.object({
  providerId: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  executionOptions: executionOptionsSchema.optional(),
}).strict();

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
  if (Object.hasOwn(raw, 'largeInputFallback') && raw.largeInputFallback !== null) {
    const fallback = largeInputFallbackSchema.safeParse(raw.largeInputFallback);
    if (!fallback.success) return null;
    clean.largeInputFallback = fallback.data;
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

// repo-sync's per-app / per-schedule action toggles. Each is ON unless
// explicitly `false` (branch-reconcile's opt-out convention), EXCEPT
// `reapRemotes`, which mutates `origin` and is therefore opt-IN. Lives here so
// the sanitizer's allowlist and services/repoSync.js read ONE list — the two
// drifting would silently drop a toggle at the app-override boundary.
export const REPO_SYNC_ACTION_KEYS = ['syncPush', 'syncPull', 'switchDefault', 'cleanupMerged', 'dropStashes', 'reapRemotes'];

// do-release's per-app / per-schedule options, each ON unless explicitly `false`:
// finish in-flight work no live agent owns, merge dependency-bot PRs, fix
// release blockers (delegating to a sub-agent rather than stopping), and make
// routine design/preference decisions for later operator review. One list read
// by the sanitizer allowlist, the schedule defaults, and the {releaseOptions}
// prompt block, so a toggle cannot be dropped at one boundary.
export const RELEASE_OPTION_KEYS = ['finishInFlight', 'mergeDependencyUpdates', 'resolveBlockers', 'autoDecide'];

// Boolean-only keys: `prCompletion` is a string enum (ENUM_METADATA_RULES), so it is deliberately absent.
const ALLOWED_BOOLEAN_METADATA_KEYS = [
  ...PIPELINE_BEHAVIOR_FLAGS.filter((key) => key !== 'prCompletion'), 'reviewerApplies', 'readOnly', 'claimFlow',
  'cleanupMerged', 'reapSuperseded', 'openPr', 'resolveConflicts', 'autoMerge', 'finishAbandoned', 'autoClose',
  ...REPO_SYNC_ACTION_KEYS,
  ...RELEASE_OPTION_KEYS,
  'skipRepoSync',
  'discardWorktree',
  'worktreeChangesExpected',
  'noChangeSuccess',
  'fileIssues',
  'runInapplicableAudit',
  'requireApproval',
  'requireDescribed',
  'stallNudge',
];

const BIBLE_HANDLER_SCOPES = ['all', 'characters', 'places', 'objects', 'variations', 'canon', 'sheets'];
const BIBLE_HANDLER_DEPTHS = ['core', 'full'];
// Mirrors QUOTA_BURN_BOUNDS.maxEntries in lib/quotaBurnConfig.js — the same
// range the burn job form advertises. Both doors bound the same batch.
const BIBLE_HANDLER_MAX_ENTRIES = { min: 1, max: 50 };
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const isBibleUniverseId = (value) =>
  value === 'all' || (typeof value === 'string' && UNIVERSE_ID_PATTERN.test(value));

const PR_AUTHOR_FILTERS = ['trusted', 'any', 'self', 'others'];
export const ISSUE_AUTHOR_FILTERS = ['self', 'collaborators', 'owner', 'any'];
export const REPO_SYNC_VERIFY_MODES = ['always', 'when-changed', 'never'];
export const DEFAULT_REPO_SYNC_VERIFY_MODE = 'when-changed';
const MAX_ISSUE_MIN_AGE_MINUTES = 1440;
export const MAX_ISSUE_EXCLUDE_LABELS = 20;
const MAX_ISSUE_EXCLUDE_LABEL_LENGTH = 255;

/**
 * Normalize a raw `issueExcludeLabels` list: keep only non-empty strings,
 * trim, cap length per entry (GitLab's label name limit — the larger of the
 * two forges', see MAX_ISSUE_EXCLUDE_LABEL_LENGTH), case-insensitively
 * dedupe (labels are compared lowercased at read time), and cap the list at
 * MAX_ISSUE_EXCLUDE_LABELS. Non-array input -> [].
 */
function normalizeIssueExcludeLabels(list) {
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

export const SWARM_COUNT_MIN = 2;
export const SWARM_COUNT_MAX = 12;
export const BRANCHES_PER_AGENT_MIN = 1;
export const BRANCHES_PER_AGENT_MAX = 6;

export const ERROR_LOG_TRIAGE_LIMITS = Object.freeze({
  triageMinOccurrences: Object.freeze({ min: 1, max: 100, default: 3 }),
  triageMaxInvestigations: Object.freeze({ min: 0, max: 10, default: 2 }),
});

// Declarative enum / bounded-integer gates for sanitizeTaskMetadata; each key is kept only when its value passes.
const ENUM_METADATA_RULES = [
  ['prCompletion', PR_COMPLETION_VALUES],
  ['auditDepth', ['quick', 'deep']],
  ['reviewStopMode', REVIEW_STOP_MODES],
  ['whenDone', ['commit-push', 'leave-uncommitted']],
  ['prAuthorFilter', PR_AUTHOR_FILTERS],
  ['verifyMode', REPO_SYNC_VERIFY_MODES],
  ['depfreeMode', DEPFREE_MODES],
  ['issueAuthorFilter', ISSUE_AUTHOR_FILTERS],
  ['scope', BIBLE_HANDLER_SCOPES],
  ['depth', BIBLE_HANDLER_DEPTHS],
  ['mode', QUEUEABLE_IMAGE_MODES],
];

const inRange = ({ min, max }) => (n) => n >= min && n <= max;
const BOUNDED_INT_METADATA_RULES = [
  ['issueMinAgeMinutes', inRange({ min: 0, max: MAX_ISSUE_MIN_AGE_MINUTES })],
  // 0 means "swarm off"; otherwise the configured swarm range.
  ['swarmCount', (n) => n === 0 || inRange({ min: SWARM_COUNT_MIN, max: SWARM_COUNT_MAX })(n)],
  ['branchesPerAgent', inRange({ min: BRANCHES_PER_AGENT_MIN, max: BRANCHES_PER_AGENT_MAX })],
  ...Object.entries(ERROR_LOG_TRIAGE_LIMITS).map(([key, limits]) => [key, inRange(limits)]),
  ['maxEntries', inRange(BIBLE_HANDLER_MAX_ENTRIES)],
];

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
  for (const key of ALLOWED_BOOLEAN_METADATA_KEYS) {
    if (Object.hasOwn(raw, key) && typeof raw[key] === 'boolean') clean[key] = raw[key];
  }
  for (const [key, allowed] of ENUM_METADATA_RULES) {
    if (Object.hasOwn(raw, key) && allowed.includes(raw[key])) clean[key] = raw[key];
  }
  for (const [key, valid] of BOUNDED_INT_METADATA_RULES) {
    if (Object.hasOwn(raw, key) && Number.isInteger(raw[key]) && valid(raw[key])) clean[key] = raw[key];
  }
  if (raw.auditWorkflow != null) { auditWorkflow(raw); clean.auditWorkflow = raw.auditWorkflow; }
  if (typeof raw.deepAuditId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(raw.deepAuditId)) clean.deepAuditId = raw.deepAuditId;
  // Schedule dispatch must preserve the workflow and its reviewer pin. Reuse
  // the task-input schemas so command paths and argument bounds stay identical.
  for (const [key, schema] of [['slashdoCommand', slashdoCommandInputSchema], ['slashdoArgs', slashdoArgsInputSchema]]) {
    const parsed = schema.safeParse(raw[key]);
    if (parsed.success && parsed.data !== undefined) {
      clean[key] = parsed.data;
    }
  }
  // `reviewer` is a legacy single constrained string.
  const normalizedReviewer = REVIEWER_ALIASES[raw.reviewer] || raw.reviewer;
  if (Object.prototype.hasOwnProperty.call(raw, 'reviewer') && isReviewer(normalizedReviewer)) {
    clean.reviewer = normalizedReviewer;
  }
  // `reviewers` is the ordered multi-reviewer list — filter to known values, dedupe, preserve order.
  if (Array.isArray(raw.reviewers)) {
    const list = normalizeReviewerList(raw.reviewers);
    // Explicitly empty survives only beside forge reviewers: that is the
    // username-only roster (`usernameOnlyRoster`), not "inherit the defaults".
    const usernameOnly = !list.length && Array.isArray(raw.usernames) && normalizeReviewUsernames(raw.usernames).length > 0;
    if (list.length || usernameOnly) clean.reviewers = list;
  }
  if (Array.isArray(raw.usernames)) {
    clean.usernames = normalizeReviewUsernames(raw.usernames);
  }
  if (Array.isArray(raw.optionalReviewers)) {
    clean.optionalReviewers = normalizeOptionalReviewers(raw.optionalReviewers) || [];
  }
  for (const [key, normalizeMap] of KEYED_REVIEWER_PINS) {
    if (!isPlainObject(raw[key])) continue;
    clean[key] = normalizeMap(raw[key]) || {};
  }
  if (Array.isArray(raw.selfManagedPrAuthors)) {
    const authors = normalizeSelfManagedPrAuthors(raw.selfManagedPrAuthors);
    if (authors.length || raw.selfManagedPrAuthors.length === 0) {
      clean.selfManagedPrAuthors = authors;
    }
  }
  if (isValidSelfManagedPrStaleMinutes(raw.selfManagedPrStaleMinutes)) {
    clean.selfManagedPrStaleMinutes = raw.selfManagedPrStaleMinutes;
  }
  if (Array.isArray(raw.issueExcludeLabels)) {
    clean.issueExcludeLabels = normalizeIssueExcludeLabels(raw.issueExcludeLabels);
  }
  if (isBibleUniverseId(raw.universeId)) {
    clean.universeId = raw.universeId;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'musicVideoAutopilot')) {
    const params = normalizeAutopilotParams(raw.musicVideoAutopilot);
    if (params) {
      clean.musicVideoAutopilot = params;
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'pipeline')) {
    const pipeline = sanitizePipeline(raw.pipeline);
    if (!pipeline) return null;
    clean.pipeline = pipeline;
  }
  return Object.keys(clean).length ? { ...clean } : null;
}

/**
 * The reviewer fields a task must PERSIST so a later
 * `resolveReviewerConfig(task.metadata, …)` resolves the same list its prompt
 * names, instead of re-deriving the install-wide Code Review Defaults (#4770).
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
