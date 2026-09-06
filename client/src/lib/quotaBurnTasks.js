/**
 * The Quota Burn page's view of the SHARED scheduled-task catalog.
 *
 * A burn step no longer carries its own copied prompt: it REFERENCES a scheduled
 * task the user already owns (`server/lib/quotaBurnTaskRef.js`) and layers
 * per-invocation overrides on top. So the page's picker is a view over the same
 * two catalogs the CoS Schedule and System Tasks pages render — PortOS built-in
 * task types (`GET /api/cos/schedule`) and app custom jobs (`GET /api/cos/jobs`)
 * — rather than a second automation catalog of its own.
 *
 * Everything here is pure, so the page can test the grouping, the search, the
 * inheritance display and the PUT payload without a server.
 */

/** Mirrors `QUOTA_BURN_TASK_REF_KIND` in `server/lib/quotaBurnTaskRef.js`. */
export const QUOTA_BURN_TASK_REF_KIND = Object.freeze({ BUILTIN: 'builtin', CUSTOM: 'custom' });

export const BUILTIN_TASK_GROUP = 'PortOS scheduled tasks';
export const CUSTOM_TASK_GROUP = 'App custom tasks';

/**
 * A reference rendered as one `<select>` value.
 *
 * Deliberately WITHOUT the app: which task to run and which app to run it against
 * are two separate controls, so folding the target into this key would multiply
 * the picker by the app list and make "same audit, different app" read as two
 * unrelated entries.
 */
export const taskRefKey = (ref) => (ref?.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM
  ? `custom:${ref.jobId}`
  : ref?.taskType
    ? `builtin:${ref.taskType}`
    : '');

/**
 * Which managed apps a built-in type may be pointed at.
 *
 * The server's own catalog builder (`getQuotaBurnTaskCatalog`) reads exactly this
 * — an app whose `taskTypeOverrides[type].enabled === true` — and its availability
 * resolver reports `wrong-scope` for any other app, so offering the full app list
 * here would offer targets the step can never run against.
 */
const enabledAppIds = (task) => Object.entries(task?.appOverrides || {})
  .filter(([, override]) => override?.enabled === true)
  .map(([appId]) => appId);

/**
 * Whether a step targeting this entry needs to name a managed app.
 *
 * Mirrors the affordance `RunTaskButton` already applies on the Schedule page:
 * an install-wide type's real run is the app-less one, and a programmatic type
 * acts on PortOS's own records and is REJECTED when it names an app. Everything
 * else acts on one app.
 *
 * Deliberately derived from the two flags the schedule status already publishes
 * rather than from a client copy of `taskTargetScope.js`'s sets — a mirrored
 * constant is a constant that drifts, and these two already cover every type the
 * server's schema would 400 for naming (or omitting) an app.
 */
export const taskEntryNeedsApp = (entry) => entry?.kind === QUOTA_BURN_TASK_REF_KIND.BUILTIN
  && !entry.installWide && !entry.programmatic;

/**
 * Whether a burn may invoke a custom job at all — the client mirror of
 * `isBurnEligibleCustomJob`. A `shell` job runs an allowlisted command and a
 * `script` job runs a built-in handler; neither spends provider quota, which is
 * the only thing a burn is for. A job written before `type` existed is an agent.
 */
const isBurnEligibleCustomJob = (job) => Boolean(job) && (!job.type || job.type === 'agent');

/**
 * Build the picker's catalog from the two reads the page makes.
 *
 * Entries a burn can NEVER invoke are dropped outright rather than offered and
 * then refused; entries that are merely switched off, or that no app has enabled
 * yet, are kept with a `blockedReason` so the picker can say what to go and fix.
 * `config` is the raw task/job record, carried through so the settings panel can
 * read the saved provider/model/effort/metadata it inherits from.
 */
export function buildQuotaBurnTaskCatalog({ schedule, jobs, apps } = {}) {
  const appName = new Map((apps || []).map((app) => [app.id, app.name || app.id]));
  const builtin = Object.entries(schedule?.tasks || {})
    .filter(([, task]) => task?.invocation?.userInvokable !== false)
    .map(([taskType, task]) => {
      const appIds = enabledAppIds(task);
      const entry = {
        key: `builtin:${taskType}`,
        kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN,
        taskType,
        jobId: null,
        label: taskType,
        group: BUILTIN_TASK_GROUP,
        description: task?.description || '',
        enabled: task?.enabled === true,
        installWide: task?.installWide === true,
        programmatic: task?.programmatic === true,
        appIds,
        appNames: appIds.map((id) => appName.get(id) || id),
        config: task || {},
      };
      return { ...entry, blockedReason: builtinBlockedReason(entry) };
    });

  const custom = (jobs || [])
    .filter(isBurnEligibleCustomJob)
    .map((job) => ({
      key: `custom:${job.id}`,
      kind: QUOTA_BURN_TASK_REF_KIND.CUSTOM,
      taskType: null,
      jobId: job.id,
      label: job.name || job.id,
      group: CUSTOM_TASK_GROUP,
      description: job.description || '',
      enabled: job.enabled === true,
      installWide: false,
      programmatic: false,
      appIds: job.appId ? [job.appId] : [],
      appNames: job.appId ? [appName.get(job.appId) || job.appId] : [],
      config: job,
      blockedReason: job.enabled === true ? null : 'disabled in System Tasks',
    }));

  const byLabel = (a, b) => a.label.localeCompare(b.label);
  return [
    { id: BUILTIN_TASK_GROUP, label: BUILTIN_TASK_GROUP, entries: builtin.sort(byLabel) },
    { id: CUSTOM_TASK_GROUP, label: CUSTOM_TASK_GROUP, entries: custom.sort(byLabel) },
  ].filter((group) => group.entries.length > 0);
}

/**
 * Why picking this built-in entry would not immediately produce a runnable step.
 *
 * It does NOT hide the entry: "no app has this task enabled" and "it is switched
 * off" are both one click away from fixed on a page this row links to, and a
 * user assembling a plan for work they are about to enable is a real case. The
 * step then renders the SERVER's own unavailability reason until it is fixed.
 */
function builtinBlockedReason(entry) {
  if (!entry.enabled) return 'disabled in Scheduled Tasks';
  if (taskEntryNeedsApp(entry) && entry.appIds.length === 0) return 'no managed app has this task enabled';
  return null;
}

/** Every entry across every group, flattened — for lookups and for search. */
export const flattenTaskCatalog = (groups) => (groups || []).flatMap((group) => group.entries || []);

/** The catalog entry a step points at, or `null` when the reference is stale. */
export function findTaskEntry(groups, ref) {
  const key = taskRefKey(ref);
  return key ? flattenTaskCatalog(groups).find((entry) => entry.key === key) || null : null;
}

/**
 * Filter the grouped catalog by a free-text query, keeping the grouping.
 *
 * Matched against the label, the task type, the description and the names of the
 * apps the entry can target — searching "portos" for the app rather than the
 * task name is the obvious thing to type on an install with a dozen apps.
 */
export function searchTaskCatalog(groups, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return groups || [];
  const matches = (entry) => [entry.label, entry.taskType, entry.description, ...(entry.appNames || [])]
    .some((field) => String(field || '').toLowerCase().includes(needle));
  return (groups || [])
    .map((group) => ({ ...group, entries: (group.entries || []).filter(matches) }))
    .filter((group) => group.entries.length > 0);
}

/**
 * The settings an invocation will actually run with — the client mirror of
 * `effectiveSettings` in `server/services/quotaBurnInvoke.js`.
 *
 * Presence, not truthiness: an override the user cleared normalizes to `null`
 * and INHERITS, while a pinned value wins. `params` merge key-by-key rather than
 * replacing the bag, so overriding one run parameter does not blank the rest of
 * the task's saved metadata.
 */
export function effectiveQuotaBurnSettings(step, saved) {
  const overrides = step?.overrides || {};
  return {
    providerId: overrides.providerId ?? saved?.providerId ?? null,
    model: overrides.model ?? saved?.model ?? null,
    effort: overrides.effort ?? saved?.effort ?? null,
    params: { ...(saved?.taskMetadata || {}), ...(overrides.params || {}) },
  };
}

/**
 * One step, reduced to the fields the PUT schema accepts as INPUT.
 *
 * The point is the DROP: `normalizeQuotaBurnJob` resolves the top-level
 * `model` / `providerId` / `effort` / `params` compat mirrors by PRESENCE, so a
 * body that still carried them (the GET hands them back on every read) would let
 * a stale mirror outrank the `overrides` bag this editor writes — clearing a
 * pinned model would silently restore it. Everything else the GET grows is
 * dropped for a blunter reason: the job schema is `.strict()`, and one unknown
 * key 400s the whole coalesced save.
 *
 * `unavailable` is deliberately KEPT even though the server ignores it and
 * re-derives it from the live catalog: the page applies this same object to its
 * optimistic config, so stripping it would make a stale step's reason vanish the
 * moment any other field on the row was touched.
 */
export function quotaBurnStepPayload(job) {
  return {
    id: job.id,
    enabled: job.enabled !== false,
    label: job.label || '',
    // A legacy step carries a `jobType` and no reference; the schema rejects a
    // payload with both, and one with neither.
    ...(job.taskRef ? { taskRef: job.taskRef } : { jobType: job.jobType }),
    ...(job.unavailable ? { unavailable: job.unavailable } : {}),
    overrides: {
      providerId: job.overrides?.providerId ?? null,
      model: job.overrides?.model ?? null,
      effort: job.overrides?.effort ?? null,
      params: job.overrides?.params || {},
    },
    runOnce: job.runOnce === true,
  };
}

/** A brand-new burn step referencing `entry`. `id` is minted by the caller. */
export function stepFromTaskEntry(entry, { id, appId = null } = {}) {
  const taskRef = entry.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM
    ? { kind: QUOTA_BURN_TASK_REF_KIND.CUSTOM, jobId: entry.jobId }
    : {
      kind: QUOTA_BURN_TASK_REF_KIND.BUILTIN,
      taskType: entry.taskType,
      // Only a type that targets one app may carry an appId at all — the schema
      // rejects one on an install-wide or programmatic type.
      appId: taskEntryNeedsApp(entry) ? (appId ?? entry.appIds[0] ?? null) : null,
    };
  return { id, enabled: true, label: '', taskRef, jobType: null, runOnce: false, overrides: { providerId: null, model: null, effort: null, params: {} } };
}

/**
 * Where the source task is viewed, edited, or created.
 *
 * A burn step never edits the task it points at — that is the whole point of the
 * reference — so every row carries the link out instead. `?task=` is the deep
 * link the Schedule tab already reads for its config drawer.
 */
export const taskSourceHref = (entry) => (entry?.kind === QUOTA_BURN_TASK_REF_KIND.CUSTOM
  ? '/cos/jobs'
  : entry?.taskType
    ? `/cos/schedule?task=${encodeURIComponent(entry.taskType)}`
    : '/cos/schedule');

/** Where a user goes to CREATE the on-demand scheduled task a new step would reference. */
export const CREATE_TASK_HREF = '/cos/jobs';
