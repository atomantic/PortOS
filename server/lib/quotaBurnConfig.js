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

/** Provider quota families a burn plan may target. Mirrors `providerUsage.js`'s card ids. */
export const QUOTA_BURN_FAMILIES = Object.freeze(['claude', 'codex', 'agy', 'grok']);

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
    ]),
  },
  {
    id: QUOTA_BURN_JOB_TYPE.UNIVERSE_BIBLE_IMAGES,
    label: 'Universe bible images',
    description: 'Render images for universe bible entries that have none yet. No agent — PortOS enqueues the renders itself.',
    programmatic: true,
    params: Object.freeze([
      { key: 'universeId', kind: 'universe', label: 'Universe', default: 'all' },
      { key: 'scope', kind: 'enum', label: 'Entries', options: ['all', 'variations', 'canon', 'sheets'], default: 'all' },
      { key: 'maxEntries', kind: 'number', label: 'Max entries per run', min: 1, max: 50, default: 10 },
      { key: 'mode', kind: 'imageMode', label: 'Render backend', default: null },
    ]),
  },
]);

export const DEFAULT_QUOTA_BURN_FAMILY = Object.freeze({
  enabled: false,
  providerId: null,
  scope: null,
  resetWithinHours: 24,
  reservePercent: 0,
  maxDispatchesPerWindow: 5,
  priority: 0,
  jobs: Object.freeze([]),
});

/** How often the runner re-reads quota. Bounded so a typo can't hammer the CLIs. */
export const CHECK_INTERVAL_MINUTES_MIN = 5;
export const CHECK_INTERVAL_MINUTES_MAX = 720;
export const DEFAULT_CHECK_INTERVAL_MINUTES = 30;

const clampNumber = (value, fallback, min, max) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const clampInt = (value, fallback, min, max) =>
  Math.round(clampNumber(value, fallback, min, max));

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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof value === 'string') clean[key] = value.slice(0, 8000);
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const jobType = typeof raw.jobType === 'string' ? raw.jobType : '';
  if (!QUOTA_BURN_JOB_TYPES.includes(jobType)) return null;
  return {
    id: trimString(raw.id, 64) || `job-${index + 1}`,
    enabled: raw.enabled !== false,
    label: trimString(raw.label, 120),
    jobType,
    model: nullableString(raw.model, 120),
    providerId: nullableString(raw.providerId, 120),
    params: normalizeParams(raw.params),
  };
}

/**
 * Normalize one provider family's burn plan. Bounds mirror the pre-#3179
 * per-app sanitizer so a migrated config keeps its meaning: reset window up to
 * a week, reserve 0–100%, 1–50 dispatches per window.
 */
export function normalizeQuotaBurnFamily(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const jobs = (Array.isArray(value.jobs) ? value.jobs : [])
    .slice(0, 25)
    .map((job, index) => normalizeQuotaBurnJob(job, index))
    .filter(Boolean);
  return {
    enabled: value.enabled === true,
    providerId: nullableString(value.providerId, 120),
    scope: nullableString(value.scope, 60),
    resetWithinHours: clampNumber(value.resetWithinHours, DEFAULT_QUOTA_BURN_FAMILY.resetWithinHours, 0, 168),
    reservePercent: clampNumber(value.reservePercent, DEFAULT_QUOTA_BURN_FAMILY.reservePercent, 0, 100),
    maxDispatchesPerWindow: clampInt(value.maxDispatchesPerWindow, DEFAULT_QUOTA_BURN_FAMILY.maxDispatchesPerWindow, 1, 50),
    priority: clampInt(value.priority, 0, 0, 100),
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
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const families = value.families && typeof value.families === 'object' && !Array.isArray(value.families)
    ? value.families
    : {};
  return {
    enabled: value.enabled === true,
    checkIntervalMinutes: clampInt(
      value.checkIntervalMinutes,
      DEFAULT_CHECK_INTERVAL_MINUTES,
      CHECK_INTERVAL_MINUTES_MIN,
      CHECK_INTERVAL_MINUTES_MAX,
    ),
    families: Object.fromEntries(
      QUOTA_BURN_FAMILIES.map((id) => [id, normalizeQuotaBurnFamily(families[id])]),
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
