/**
 * Quota-burn configuration: shape, defaults, and normalization.
 *
 * Quota-burn is ONE machine-local loop in PortOS itself (not a per-managed-app task type); schedule, provider-family windows and the ordered job list are install-level config held here.
 * Pure module: no storage, no provider I/O, so the route validator, store, runner and client share one vocabulary. `quotaBurnStore.js` persists it; `quotaBurnRunner.js` executes it.
 *
 * Normalization is TOTAL and never throws: every read path funnels through `normalizeQuotaBurnConfig`, which fills every family key and drops what it cannot make sense of.
 * Absent is never "off" (an unconfigured family materializes with `enabled: false`), and an unknown job type is DROPPED, never coerced (the wrong burn job spends real quota).
 */

import { isPlainObject } from './objects.js';
import {
  QUOTA_BURN_UNAVAILABLE,
  normalizeQuotaBurnOverrides,
  normalizeQuotaBurnParams,
  normalizeQuotaBurnTaskRef,
} from './quotaBurnTaskRef.js';
import { BIBLE_DESCRIBE_DEPTHS, BIBLE_DESCRIBE_SCOPES } from './universeBibleCompleteness.js';
import { trimTo } from './textUtils.js';

/** Provider quota families a burn plan may target. Mirrors `providerUsage.js`'s card ids. */
export const QUOTA_BURN_FAMILIES = Object.freeze(['claude', 'codex', 'agy', 'grok']);

/**
 * How a burn task queued by the RETIRED executor opened: `[Quota burn: <family>] …`. Kept as a parser only, for migration 225, which back-fills
 * `metadata.quotaBurnFamily` onto old tasks; rewording it silently turns that migration into a no-op.
 */
export const QUOTA_BURN_TASK_PREFIX = '[Quota burn: ';

/** The family id in a burn-task description, or null. Migration-only: requires the exact minted shape rather than sniffing loosely. */
export function quotaBurnFamilyOfDescription(description) {
  if (typeof description !== 'string' || !description.startsWith(QUOTA_BURN_TASK_PREFIX)) return null;
  const family = description.slice(QUOTA_BURN_TASK_PREFIX.length).split(']')[0].trim();
  return QUOTA_BURN_FAMILIES.includes(family) ? family : null;
}

/** The completion-ledger key for one job: `<familyId>:<jobId>`. Job ids are only unique within a family, so the family must be in the key. */
export const quotaBurnJobKey = (familyId, jobId) => `${familyId}:${jobId}`;

// `maxDispatchesPerWindow` "no cap" sentinel (the default). Lives in a leaf
// module so the client shares it; see docs/QUOTA-BURN.md for why the cap is opt-in.
export { QUOTA_BURN_UNLIMITED_DISPATCHES, isUnlimitedDispatchCap } from './quotaBurnDispatchCap.js';
import { QUOTA_BURN_UNLIMITED_DISPATCHES, } from './quotaBurnDispatchCap.js';

/**
 * Every numeric/length bound in the plan, in ONE place. The normalizer (CLAMPS), `quotaBurnValidation.js` (REJECTS with 400) and the job catalog's param descriptors
 * (client `min`/`max`) must agree, or a PUT 400s on a plan the normalizer would accept.
 */
export const QUOTA_BURN_BOUNDS = Object.freeze({
  checkIntervalMinutes: { min: 5, max: 720, default: 30 },
  resetWithinHours: { min: 0, max: 168, default: 24 },
  reservePercent: { min: 0, max: 100, default: 0 },
  // `min` is the smallest REAL cap; the default opts out of capping entirely.
  maxDispatchesPerWindow: { min: 1, max: 50, default: QUOTA_BURN_UNLIMITED_DISPATCHES },
  priority: { min: 0, max: 100, default: 0 },
  maxEntries: { min: 1, max: 50, default: 10 },
  jobsPerFamily: { max: 25 },
  idLength: { max: 64 },
  labelLength: { max: 120 },
  // Sized for the longest param (an audit preset's work prompt) with headroom: a too-tight cap silently slices the END of stored preset jobs. It bounds a runaway paste, not the presets.
  paramLength: { max: 16000 },
});
const BOUNDS = QUOTA_BURN_BOUNDS;

/**
 * LEGACY burn job types: a frozen COMPATIBILITY INPUT. A step's work is now a scheduled-task reference (`quotaBurnTaskRef.js`); this enum, the catalog below and
 * `quotaBurnPresets.js` stay readable so an old plan loads and migration 359 (`lib/quotaBurnLegacyConversion.js`) can convert it. Nothing new belongs in them;
 * a new burn action ships as an on-demand SCHEDULED task and is referenced. `agent-prompt` spawned a CoS agent in a managed app; the other two were PROGRAMMATIC jobs.
 */
export const QUOTA_BURN_JOB_TYPE = Object.freeze({
  AGENT_PROMPT: 'agent-prompt',
  UNIVERSE_BIBLE_DESCRIBE: 'universe-bible-describe',
  UNIVERSE_BIBLE_IMAGES: 'universe-bible-images',
});
export const QUOTA_BURN_JOB_TYPES = Object.freeze(Object.values(QUOTA_BURN_JOB_TYPE));

/** LEGACY catalog, frozen with `QUOTA_BURN_JOB_TYPE`: lets the config page describe each type; `params` is the field list the client builds its form from. */
export const QUOTA_BURN_JOB_CATALOG = Object.freeze([
  {
    id: QUOTA_BURN_JOB_TYPE.AGENT_PROMPT,
    label: 'Agent prompt',
    description: 'Queue a CoS agent in a managed app with a custom prompt. Burns the family\'s agent quota.',
    programmatic: false,
    params: Object.freeze([
      { key: 'appId', kind: 'app', label: 'Managed app', required: true },
      { key: 'prompt', kind: 'text', label: 'Work prompt', required: true },
      { key: 'useWorktree', kind: 'boolean', label: 'Run in a worktree', default: true },
      { key: 'openPR', kind: 'boolean', label: 'Open a PR', default: true },
      { key: 'simplify', kind: 'boolean', label: 'Run /simplify', default: true },
      // Two distinct "does not land code" postures. `noCodeOutput`: the deliverable is something the agent DOES (files an issue, calls an endpoint); no branch or isolation, runs in the app's
      // checkout, prompt drops commit/push/PR steps. `discardWorktree`: wants a scratch checkout (builds, tests) but nothing may land; without it, worktree + no PR means AUTO-MERGE
      // (agentWorktreeCleanup.js). Either forces `openPR`/`simplify` off.
      { key: 'noCodeOutput', kind: 'boolean', label: 'No code output (files issues / calls an API)', default: false },
      { key: 'discardWorktree', kind: 'boolean', label: 'Discard the worktree (nothing lands)', default: false },
    ]),
  },
  {
    id: QUOTA_BURN_JOB_TYPE.UNIVERSE_BIBLE_DESCRIBE,
    label: 'Universe bible descriptions',
    description: 'Fill in blank fields on universe bible entries — the full character sheet for cast, description + world detail for places and objects. No agent; PortOS sends one expand prompt per entry. Order this BEFORE the image job so renders have something to work from.',
    programmatic: true,
    params: Object.freeze([
      { key: 'universeId', kind: 'universe', label: 'Universe', default: 'all', emptyLabel: 'All universes', emptyValue: 'all' },
      { key: 'scope', kind: 'enum', label: 'Entries', options: BIBLE_DESCRIBE_SCOPES, default: 'all' },
      // `full` is the default: a cast member with only a description still renders inconsistently across panels.
      { key: 'depth', kind: 'enum', label: 'Depth', options: BIBLE_DESCRIBE_DEPTHS, default: 'full' },
      { key: 'maxEntries', kind: 'number', label: 'Max entries per run', min: BOUNDS.maxEntries.min, max: BOUNDS.maxEntries.max, default: BOUNDS.maxEntries.default },
    ]),
  },
  {
    id: QUOTA_BURN_JOB_TYPE.UNIVERSE_BIBLE_IMAGES,
    label: 'Universe bible images',
    description: 'Render images for universe bible entries that have none yet. No agent — PortOS enqueues the renders itself.',
    programmatic: true,
    params: Object.freeze([
      { key: 'universeId', kind: 'universe', label: 'Universe', default: 'all', emptyLabel: 'All universes', emptyValue: 'all' },
      { key: 'scope', kind: 'enum', label: 'Entries', options: ['all', 'variations', 'canon', 'sheets'], default: 'all' },
      { key: 'maxEntries', kind: 'number', label: 'Max entries per run', min: BOUNDS.maxEntries.min, max: BOUNDS.maxEntries.max, default: BOUNDS.maxEntries.default },
      { key: 'mode', kind: 'imageMode', label: 'Render backend', default: null, emptyLabel: 'Match the burning provider', emptyValue: '' },
      // Opt-IN (default false) so existing plans keep their backlog; on, canon entries still blank wait for a description instead of spending image quota on a generic render.
      { key: 'requireDescribed', kind: 'boolean', label: 'Skip canon entries that have no description yet', default: false },
    ]),
  },
]);

// Clamp against one QUOTA_BURN_BOUNDS entry, falling back to its documented
// default when the value is missing or non-numeric.
const clamp = ({ min, max, default: fallback }, value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const clampInt = (bounds, value) => Math.round(clamp(bounds, value));

/**
 * The dispatch cap can't use `clampInt`: its sentinel sits BELOW its minimum, so -1 would fold up to 1. Any negative reads as unlimited; a real cap clamps into 1-50
 * (a legacy 0 lands on 1; disabling the family is how to say "never burn").
 */
const clampDispatchCap = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return BOUNDS.maxDispatchesPerWindow.default;
  return num < 0 ? QUOTA_BURN_UNLIMITED_DISPATCHES : clampInt(BOUNDS.maxDispatchesPerWindow, num);
};

const nullableString = (value, max) => {
  const trimmed = trimTo(value, max);
  return trimmed || null;
};

/**
 * A step's run `params` stay free-form (each task type owns its contract) but must be a plain object of JSON-ish scalars so a hand-edited file can't smuggle a
 * prototype or nested blob. The rule lives in `quotaBurnTaskRef.js` (shared with the overrides bag); the BOUND stays here.
 */
const normalizeParams = (raw) => normalizeQuotaBurnParams(raw, BOUNDS.paramLength.max);

/**
 * Normalize one burn STEP. A step names its work either by a `taskRef` (scheduled task the user owns, plus per-invocation `overrides`) or a legacy `jobType`
 * (copied prompt in a params bag). The two are kept strictly apart: a legacy step LOADS but normalizes to unavailable with a migration reason, and is never rewritten
 * into a reference here (guessing which task a hand-edited prompt meant would strand edits or duplicate an automation; the conversion service owns that).
 *
 * Returns `null` for a payload naming NEITHER; the caller drops it, since a step running the wrong work spends real quota.
 * `index` seeds a stable id for steps written before ids existed.
 *
 * Overrides and compat mirrors: `overrides` is the canonical home for provider/model/effort/params, but the shipped editor still reads and writes them at the TOP level
 * (moves in #6382), so both are emitted in lockstep. Tie-break is presence, not truthiness: a payload CARRYING a top-level key wins (even a cleared `null`);
 * truthiness would resurrect the stale override each time the editor cleared a pinned model.
 */
export function normalizeQuotaBurnJob(raw, index = 0) {
  if (!isPlainObject(raw)) return null;
  const taskRef = normalizeQuotaBurnTaskRef(raw.taskRef);
  const jobType = typeof raw.jobType === 'string' ? raw.jobType : '';
  const legacyType = QUOTA_BURN_JOB_TYPES.includes(jobType) ? jobType : null;
  if (!taskRef && !legacyType) return null;

  const stored = normalizeQuotaBurnOverrides(raw.overrides, {
    maxParamLength: BOUNDS.paramLength.max,
    maxFieldLength: BOUNDS.labelLength.max,
  });
  const override = (key) => (Object.hasOwn(raw, key)
    ? nullableString(raw[key], BOUNDS.labelLength.max)
    : stored[key]);
  const overrides = {
    providerId: override('providerId'),
    model: override('model'),
    effort: override('effort'),
    ...((raw.executionOptions ?? stored.executionOptions) !== undefined ? { executionOptions: raw.executionOptions ?? stored.executionOptions } : {}),
    params: Object.hasOwn(raw, 'params') ? normalizeParams(raw.params) : stored.params,
  };

  return {
    id: trimTo(raw.id, BOUNDS.idLength.max) || `job-${index + 1}`,
    enabled: raw.enabled !== false,
    label: trimTo(raw.label, BOUNDS.labelLength.max),
    taskRef,
    // Only a legacy step keeps a `jobType`, so no reader mistakes a stale field for a reference step's identity.
    jobType: taskRef ? null : legacyType,
    overrides,
    // Derived, never trusted from the payload; only the un-migrated legacy verdict is decidable here (catalog availability is stamped by `resolveQuotaBurnStepAvailability`).
    unavailable: taskRef ? null : {
      code: QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED,
      reason: `legacy "${legacyType}" step is waiting to be migrated to a scheduled task`,
    },
    // Opt-IN; absent reads as `false`. See `jobIsSpent`.
    runOnce: raw.runOnce === true,
    ...(raw.drain === true ? { drain: true } : {}),
    // Compat mirrors of `overrides` for the shipped editor and legacy executor, derived on every read so they can't drift. Removed with #6382.
    model: overrides.model,
    providerId: overrides.providerId,
    effort: overrides.effort,
    ...(overrides.executionOptions !== undefined ? { executionOptions: overrides.executionOptions } : {}),
    params: overrides.params,
  };
}

/**
 * Whether a `run once` job has already had its one dispatch. A plan is a ROTATION the runner walks until a quota gate closes (`quotaBurnRunner.js#rotatePlanAfter`);
 * `runOnce` marks one-shot work that drops out once `quotaBurnCompletions.js` records a dispatch, until the user re-arms it.
 * Held in a separate machine-local ledger so a config PUT replacing `jobs` can't resurrect a job that already ran.
 */
export function jobIsSpent(job, familyId, completions = {}) {
  return job?.runOnce === true && Boolean(completions?.[quotaBurnJobKey(familyId, job.id)]);
}

/** Normalize one family's burn plan: reset window up to a week, reserve 0-100%, 1-50 dispatches per window (or -1 for no cap, the default). */
export function normalizeQuotaBurnFamily(raw) {
  const value = isPlainObject(raw) ? raw : {};
  const jobs = (Array.isArray(value.jobs) ? value.jobs : [])
    .slice(0, BOUNDS.jobsPerFamily.max)
    .map((job, index) => normalizeQuotaBurnJob(job, index))
    .filter(Boolean);
  return {
    enabled: value.enabled === true,
    ...(value.sequence === true ? { sequence: true } : {}),
    resetWithinHours: clamp(BOUNDS.resetWithinHours, value.resetWithinHours),
    reservePercent: clamp(BOUNDS.reservePercent, value.reservePercent),
    maxDispatchesPerWindow: clampDispatchCap(value.maxDispatchesPerWindow),
    priority: clampInt(BOUNDS.priority, value.priority),
    jobs,
  };
}

/** Normalize a whole config: every known family key is materialized (disabled by default) so no reader distinguishes "absent" from "off"; unknown family keys are dropped. */
export function normalizeQuotaBurnConfig(raw) {
  const value = isPlainObject(raw) ? raw : {};
  const families = isPlainObject(value.families) ? value.families : {};
  return {
    enabled: value.enabled === true,
    checkIntervalMinutes: clampInt(BOUNDS.checkIntervalMinutes, value.checkIntervalMinutes),
    // Each family carries its own `id` so consumers read `config.families[x]` directly.
    families: Object.fromEntries(
      QUOTA_BURN_FAMILIES.map((id) => [id, { id, ...normalizeQuotaBurnFamily(families[id]) }]),
    ),
  };
}

/** Whether a family is SET UP to burn: enabled with at least one enabled job (an empty plan would spawn a candidate the runner then discards). */
export function familyIsConfigured(family) {
  return family?.enabled === true && (family.jobs || []).some((job) => job?.enabled !== false);
}

/**
 * Whether a family has anything dispatchable RIGHT NOW: configured, and not every enabled job already spent as a one-shot.
 * A separate predicate rather than an optional arg on `familyIsConfigured`: the answers differ ("add a job" vs "Re-arm"), and an arity-overloaded predicate breaks
 * under `some`/`filter`/`map`, which pass the INDEX second and would make `completions` a number.
 */
export function familyHasRunnableJobs(family, completions = {}) {
  return familyIsConfigured(family)
    && (family.jobs || []).some((job) => job?.enabled !== false && !jobIsSpent(job, family.id, completions));
}
