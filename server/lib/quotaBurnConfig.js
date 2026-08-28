/**
 * Quota-burn configuration — shape, defaults, and normalization.
 *
 * Quota-burn is ONE machine-local loop that lives in PortOS itself, not a
 * per-managed-app scheduled CoS task type (it used to be the latter; migration
 * 221 moves installs over). The work it dispatches may still target a managed
 * app — an `agent-prompt` burn job names the app it runs in — but the schedule,
 * the provider-family windows, and the ordered job list are all install-level
 * config held here.
 *
 * Pure module: shape + normalization only, no storage and no provider I/O, so
 * the route validator, the store, the runner, and the client can all agree on
 * one vocabulary. `server/services/quotaBurnStore.js` persists it;
 * `server/services/quotaBurnRunner.js` executes it.
 *
 * Normalization is TOTAL and never throws: every read path (config file written
 * by an older PortOS, a migrated per-app override, a PUT body) funnels through
 * `normalizeQuotaBurnConfig`, which fills every family key and drops anything
 * it cannot make sense of. Absent is never confused with "off" — a family the
 * user has not configured materializes with `enabled: false`, and an unknown
 * job type is DROPPED rather than silently coerced to a different one (running
 * the wrong burn job spends real quota on work nobody asked for).
 */

import { isPlainObject, POLLUTING_KEYS } from './objects.js';
import { BIBLE_DESCRIBE_DEPTHS, BIBLE_DESCRIBE_SCOPES } from './universeBibleCompleteness.js';

/** Provider quota families a burn plan may target. Mirrors `providerUsage.js`'s card ids. */
export const QUOTA_BURN_FAMILIES = Object.freeze(['claude', 'codex', 'agy', 'grok']);

/**
 * How a queued burn task's description opens: `[Quota burn: <family>] …`.
 *
 * `quotaBurnJobs/agentPrompt.js` mints it; migration 225 matches it to back-fill
 * `metadata.quotaBurnFamily` onto tasks queued before that stamp existed. Shared
 * because the two live in different trees and a reworded description would
 * silently make the migration a no-op — leaving exactly the stranded tasks it
 * exists to rescue.
 */
export const QUOTA_BURN_TASK_PREFIX = '[Quota burn: ';

/** The description a burn task is queued under. Parsed back by `quotaBurnFamilyOfDescription`. */
export const burnTaskDescription = (familyId, label, appName) =>
  `${QUOTA_BURN_TASK_PREFIX}${familyId}] ${label} for ${appName}`;

/**
 * The family id in a burn-task description, or null when it isn't one. Only the
 * migration needs this — a live task carries `metadata.quotaBurnFamily` — so it
 * deliberately requires the exact minted shape rather than sniffing loosely.
 */
export function quotaBurnFamilyOfDescription(description) {
  if (typeof description !== 'string' || !description.startsWith(QUOTA_BURN_TASK_PREFIX)) return null;
  const family = description.slice(QUOTA_BURN_TASK_PREFIX.length).split(']')[0].trim();
  return QUOTA_BURN_FAMILIES.includes(family) ? family : null;
}

/**
 * The completion-ledger key for one job: `<familyId>:<jobId>`.
 *
 * Job ids are only unique within a family (they are minted from a clock), so the
 * family has to be part of the key or a `run once` job in one plan would mark
 * its namesake in another as already spent.
 */
export const quotaBurnJobKey = (familyId, jobId) => `${familyId}:${jobId}`;

/**
 * `maxDispatchesPerWindow` sentinel for "no cap on how many burns this window
 * may spend" — and the default. Why the cap is opt-in rather than a safety
 * property is argued once, in `docs/QUOTA-BURN.md`.
 *
 * -1 rather than 0/null: it stays a number for the client's `<input
 * type="number">` and the run log, and it can never be confused with "0 burns
 * allowed" (which is what disabling the family already means). It sits BELOW
 * the field's own minimum, which is what `clampDispatchCap` exists to handle.
 */
export const QUOTA_BURN_UNLIMITED_DISPATCHES = -1;

/**
 * Every numeric/length bound in the plan, in ONE place.
 *
 * Three consumers read these and must agree: the normalizer below (which
 * CLAMPS, so an older on-disk plan still loads), `quotaBurnValidation.js`
 * (which REJECTS with a 400, so a bad request is not silently reshaped), and
 * the job catalog's param descriptors (which the client renders as `min`/`max`
 * on the input). When they were three sets of literals, raising a cap in one
 * meant the PUT 400'd on a plan the normalizer would happily have accepted —
 * a split-brain invisible from inside any single file.
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
  // Sized for the longest thing a param actually holds: an audit preset's work
  // prompt. At 8000 the largest shipped preset rendered to 7999 — one character
  // of headroom — so the next sentence added to the shared audit contract would
  // have been silently sliced off the END of every stored preset job, taking the
  // "change no code" and redaction rules with it and leaving nothing on screen
  // saying so. The cap exists to bound a runaway paste, not to fit the presets.
  paramLength: { max: 16000 },
});
const BOUNDS = QUOTA_BURN_BOUNDS;

/** Whether a family's dispatch cap means "no cap". Any negative value reads as unlimited. */
export const isUnlimitedDispatchCap = (cap) => Number(cap) < 0;

/**
 * Burn job types. `agent-prompt` is the original behavior (spawn a CoS agent in
 * a managed app with a custom prompt); everything else is a PROGRAMMATIC job
 * that PortOS performs itself with no agent in the loop.
 */
export const QUOTA_BURN_JOB_TYPE = Object.freeze({
  AGENT_PROMPT: 'agent-prompt',
  UNIVERSE_BIBLE_DESCRIBE: 'universe-bible-describe',
  UNIVERSE_BIBLE_IMAGES: 'universe-bible-images',
});
export const QUOTA_BURN_JOB_TYPES = Object.freeze(Object.values(QUOTA_BURN_JOB_TYPE));

/**
 * Catalog rendered by the config page so the job picker can describe each type
 * without the client re-encoding what a job does. `params` names the per-job
 * fields the runner reads — the client builds its form from this list, so a new
 * job type needs no client change beyond a field renderer for a novel kind.
 */
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
      // The two "this job does not land code" postures, which are NOT the same:
      //
      // `noCodeOutput` — the deliverable is something the agent DOES during the
      //   run (files an issue, calls an endpoint). It needs no branch and no
      //   isolation because it writes nothing, so it runs in the app's checkout
      //   as-is; the prompt drops every commit/push/PR instruction.
      // `discardWorktree` — the job DOES want a scratch checkout (it builds, it
      //   runs tests, it edits to reason) but nothing it produces may land.
      //   Without it, worktree + no PR means AUTO-MERGE onto the source
      //   workspace's default branch (agentWorktreeCleanup.js).
      //
      // Either one forces `openPR`/`simplify` off in the job runner — both
      // presuppose a diff to ship.
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
      // `full` is the default because the job exists for the sheet, not the
      // one-line description: a cast member with a description and nothing else
      // still renders inconsistently from panel to panel.
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
      // Opt-IN, and default `false`, so an existing plan keeps rendering exactly
      // the backlog it rendered yesterday. Turning it on pairs this job with the
      // describe job above: canon entries that are still blank wait for a
      // description instead of spending image quota on a generic render.
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
 * The dispatch cap can't go straight through `clampInt`: its sentinel sits
 * BELOW its own minimum, so the generic clamp would fold -1 back up to 1 and
 * silently reinstate a cap of one burn per window. Any negative reads as
 * unlimited; a real cap still clamps into 1–50 (so a legacy 0 keeps landing on
 * 1 rather than meaning "never burn", which is what disabling the family is
 * for).
 */
const clampDispatchCap = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return BOUNDS.maxDispatchesPerWindow.default;
  return num < 0 ? QUOTA_BURN_UNLIMITED_DISPATCHES : clampInt(BOUNDS.maxDispatchesPerWindow, num);
};

const trimString = (value, max) =>
  (typeof value === 'string' ? value.trim().slice(0, max) : '');

const nullableString = (value, max) => {
  const trimmed = trimString(value, max);
  return trimmed || null;
};

/**
 * A job's `params` bag stays free-form on purpose — each job type owns its own
 * contract, and the runner's registry validates the keys it actually reads.
 * What is enforced here is that it's a plain object of JSON-ish scalars, so a
 * hand-edited config file can't smuggle a prototype or a nested blob into it.
 */
function normalizeParams(raw) {
  if (!isPlainObject(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, BOUNDS.paramLength.max);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean' || value === null) clean[key] = value;
  }
  return clean;
}

/**
 * Normalize one burn job. Returns `null` for a job whose type is unknown — the
 * caller DROPS it rather than substituting a default type: a job that runs the
 * wrong work spends real subscription quota on something the user never asked
 * for, which is strictly worse than the job disappearing from the list.
 *
 * `index` seeds a stable id for a job written before ids existed (or by a
 * hand-edited file), so the client's list keys and the run ledger have
 * something to key on.
 */
export function normalizeQuotaBurnJob(raw, index = 0) {
  if (!isPlainObject(raw)) return null;
  const jobType = typeof raw.jobType === 'string' ? raw.jobType : '';
  if (!QUOTA_BURN_JOB_TYPES.includes(jobType)) return null;
  return {
    id: trimString(raw.id, BOUNDS.idLength.max) || `job-${index + 1}`,
    enabled: raw.enabled !== false,
    label: trimString(raw.label, BOUNDS.labelLength.max),
    jobType,
    model: nullableString(raw.model, BOUNDS.labelLength.max),
    providerId: nullableString(raw.providerId, BOUNDS.labelLength.max),
    effort: nullableString(raw.effort, BOUNDS.labelLength.max),
    // Opt-IN, and absent reads as `false`, so every plan written before this
    // field existed keeps repeating exactly as it did. See `jobIsSpent`.
    runOnce: raw.runOnce === true,
    params: normalizeParams(raw.params),
  };
}

/**
 * Whether a `run once` job has already had its one dispatch.
 *
 * A plan is an ordered ROTATION the runner walks until a quota gate closes
 * (`quotaBurnRunner.js#rotatePlanAfter`), which is right for standing work
 * ("audit performance") and wrong for one-shot work ("write the missing README")
 * — the latter was simply re-done every lap. `runOnce` marks the second kind:
 * once `quotaBurnCompletions.js` has recorded a dispatch for it, it drops out of
 * the rotation until the user re-arms it from the page.
 *
 * Held in a separate machine-local ledger rather than as a flag on the job so
 * the plan the user edits stays a statement of intent, and so a config PUT that
 * replaces the `jobs` array (which is how every reorder and edit saves) can't
 * silently resurrect a job that already ran.
 */
export function jobIsSpent(job, familyId, completions = {}) {
  return job?.runOnce === true && Boolean(completions?.[quotaBurnJobKey(familyId, job.id)]);
}

/**
 * Normalize one provider family's burn plan. Bounds mirror the pre-#3179
 * per-app sanitizer so a migrated config keeps its meaning: reset window up to
 * a week, reserve 0–100%, and 1–50 dispatches per window (or -1 for no cap,
 * which is the default).
 */
export function normalizeQuotaBurnFamily(raw) {
  const value = isPlainObject(raw) ? raw : {};
  const jobs = (Array.isArray(value.jobs) ? value.jobs : [])
    .slice(0, BOUNDS.jobsPerFamily.max)
    .map((job, index) => normalizeQuotaBurnJob(job, index))
    .filter(Boolean);
  return {
    enabled: value.enabled === true,
    resetWithinHours: clamp(BOUNDS.resetWithinHours, value.resetWithinHours),
    reservePercent: clamp(BOUNDS.reservePercent, value.reservePercent),
    maxDispatchesPerWindow: clampDispatchCap(value.maxDispatchesPerWindow),
    priority: clampInt(BOUNDS.priority, value.priority),
    jobs,
  };
}

/**
 * Normalize a whole config. Every known family key is materialized (disabled by
 * default) so the page can render a complete card set and the runner never has
 * to distinguish "absent" from "off" at read time. Unknown family keys are
 * dropped — a card id the quota adapters don't produce could never be selected.
 */
export function normalizeQuotaBurnConfig(raw) {
  const value = isPlainObject(raw) ? raw : {};
  const families = isPlainObject(value.families) ? value.families : {};
  return {
    enabled: value.enabled === true,
    checkIntervalMinutes: clampInt(BOUNDS.checkIntervalMinutes, value.checkIntervalMinutes),
    // Each family carries its own `id`. Every consumer needs it (selection sorts
    // and keys on it, the runner logs it, a job pins its render backend to it),
    // and stamping it here is what lets them read `config.families[x]` straight
    // instead of re-attaching `{ id, ...normalize(...) }` at four call sites.
    families: Object.fromEntries(
      QUOTA_BURN_FAMILIES.map((id) => [id, { id, ...normalizeQuotaBurnFamily(families[id]) }]),
    ),
  };
}

/**
 * Whether a family is SET UP to burn: enabled, with at least one enabled job. An
 * enabled family with an empty job list is a half-finished setup, not a burn
 * plan — treating it as actionable would spawn a candidate the runner then has
 * to discard, which shows up as a confusing "selected, then skipped" cycle in
 * the run log.
 */
export function familyIsConfigured(family) {
  return family?.enabled === true && (family.jobs || []).some((job) => job?.enabled !== false);
}

/**
 * Whether a family has anything the runner could dispatch RIGHT NOW: configured,
 * and not every enabled job already spent as a one-shot. A plan made entirely of
 * `run once` work stops being runnable the moment its last step has run.
 *
 * Deliberately a second named predicate rather than an optional second argument
 * on `familyIsConfigured`. The two questions have different answers and callers
 * want different ones — "you configured nothing" needs a job added while "your
 * plan is finished" needs a Re-arm — and an arity-overloaded predicate is a trap
 * with `some`/`filter`/`map`, which pass the INDEX as the second argument and
 * would silently make `completions` a number.
 */
export function familyHasRunnableJobs(family, completions = {}) {
  return familyIsConfigured(family)
    && (family.jobs || []).some((job) => job?.enabled !== false && !jobIsSpent(job, family.id, completions));
}
