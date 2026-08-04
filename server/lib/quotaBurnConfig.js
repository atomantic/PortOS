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

/** Provider quota families a burn plan may target. Mirrors `providerUsage.js`'s card ids. */
export const QUOTA_BURN_FAMILIES = Object.freeze(['claude', 'codex', 'agy', 'grok']);

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
  maxDispatchesPerWindow: { min: 1, max: 50, default: 5 },
  priority: { min: 0, max: 100, default: 0 },
  maxEntries: { min: 1, max: 50, default: 10 },
  jobsPerFamily: { max: 25 },
  idLength: { max: 64 },
  labelLength: { max: 120 },
  scopeLength: { max: 60 },
  paramLength: { max: 8000 },
});
const BOUNDS = QUOTA_BURN_BOUNDS;

/**
 * Burn job types. `agent-prompt` is the original behavior (spawn a CoS agent in
 * a managed app with a custom prompt); everything else is a PROGRAMMATIC job
 * that PortOS performs itself with no agent in the loop.
 */
export const QUOTA_BURN_JOB_TYPE = Object.freeze({
  AGENT_PROMPT: 'agent-prompt',
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
      // Worktree + no PR means AUTO-MERGE onto the source workspace's default
      // branch (agentWorktreeCleanup.js). That is the right posture for a burn
      // that is supposed to land code, and the wrong one for a job whose
      // deliverable is filed issues — so the audit presets turn this on and the
      // agent is told, by the spawner itself, not to commit at all.
      { key: 'discardWorktree', kind: 'boolean', label: 'Discard the worktree (nothing lands)', default: false },
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
    ]),
  },
]);

const DEFAULT_QUOTA_BURN_FAMILY = Object.freeze({
  enabled: false,
  providerId: null,
  scope: null,
  resetWithinHours: BOUNDS.resetWithinHours.default,
  reservePercent: BOUNDS.reservePercent.default,
  maxDispatchesPerWindow: BOUNDS.maxDispatchesPerWindow.default,
  priority: BOUNDS.priority.default,
  jobs: Object.freeze([]),
});

// Clamp against one QUOTA_BURN_BOUNDS entry, falling back to its documented
// default when the value is missing or non-numeric.
const clamp = ({ min, max, default: fallback }, value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const clampInt = (bounds, value) => Math.round(clamp(bounds, value));

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
    params: normalizeParams(raw.params),
  };
}

/**
 * Normalize one provider family's burn plan. Bounds mirror the pre-#3179
 * per-app sanitizer so a migrated config keeps its meaning: reset window up to
 * a week, reserve 0–100%, 1–50 dispatches per window.
 */
export function normalizeQuotaBurnFamily(raw) {
  const value = isPlainObject(raw) ? raw : {};
  const jobs = (Array.isArray(value.jobs) ? value.jobs : [])
    .slice(0, BOUNDS.jobsPerFamily.max)
    .map((job, index) => normalizeQuotaBurnJob(job, index))
    .filter(Boolean);
  return {
    enabled: value.enabled === true,
    providerId: nullableString(value.providerId, BOUNDS.labelLength.max),
    scope: nullableString(value.scope, BOUNDS.scopeLength.max),
    resetWithinHours: clamp(BOUNDS.resetWithinHours, value.resetWithinHours),
    reservePercent: clamp(BOUNDS.reservePercent, value.reservePercent),
    maxDispatchesPerWindow: clampInt(BOUNDS.maxDispatchesPerWindow, value.maxDispatchesPerWindow),
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
 * Whether a family has anything the runner could dispatch: it must be enabled
 * AND carry at least one enabled job. An enabled family with an empty job list
 * is a half-finished setup, not a burn plan — treating it as actionable would
 * spawn a candidate the runner then has to discard, which shows up as a
 * confusing "selected, then skipped" cycle in the run log.
 */
export function familyIsActionable(family) {
  return family?.enabled === true && (family.jobs || []).some((job) => job?.enabled !== false);
}
