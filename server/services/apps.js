import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import {
  containsPortosRootToken,
  expandPortosRootInApp,
} from '../lib/portosRootPlaceholder.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { NON_PM2_TYPES } from './appProcessTypes.js';
import { SELF_IMPROVEMENT_TASK_TYPES } from './taskScheduleRegistry.js';
import { sanitizeTaskMetadata } from '../lib/cosValidation.js';
import { isPlainObject } from '../lib/objects.js';
import { resolveAppWorkTracker } from '../lib/workTracker.js';
import { PORTS } from '../lib/ports.js';
import { hasTailscaleCert } from '../../lib/tailscale-https.js';
import { certPaths } from '../../lib/certPaths.js';

const DATA_DIR = PATHS.data;
const APPS_FILE = join(DATA_DIR, 'apps.json');

// Stable ID for the PortOS app — always present, never deletable. Defined in
// `lib/appIdentity.js` so a caller that only needs to name PortOS (a CoS task's
// target app, a scope check) can import it without this whole service graph;
// re-exported here so every existing importer is unchanged.
export { PORTOS_APP_ID };

/**
 * Build the baseline PortOS app entry with repoPath resolved to the actual project root.
 */
function buildPortosApp() {
  // tlsPort reflects whether the Tailscale cert is actually on disk; if not,
  // don't advertise HTTPS so the Launch button doesn't target a broken scheme.
  const certPresent = hasTailscaleCert(certPaths(PATHS.data).dir);
  return {
    name: 'PortOS',
    description: 'Local App OS portal for dev machines',
    repoPath: PATHS.root,
    type: 'express',
    uiPort: PORTS.API,
    devUiPort: PORTS.UI,
    apiPort: PORTS.API,
    tlsPort: certPresent ? PORTS.API : null,
    buildCommand: 'npm run build',
    startCommands: ['npm start'],
    pm2ProcessNames: [
      'portos-server',
      'portos-cos',
      'portos-ui',
      'portos-autofixer',
      'portos-autofixer-ui',
      'portos-browser'
    ],
    processes: [
      // portos-server binds a loopback HTTP mirror on API_LOCAL only when HTTPS is active
      // on API. If no cert is present, don't advertise api-local — nothing is listening
      // there and Overview would otherwise show a dead port.
      { name: 'portos-server', port: PORTS.API, ports: certPresent ? { api: PORTS.API, 'api-local': PORTS.API_LOCAL } : { api: PORTS.API } },
      { name: 'portos-cos', port: PORTS.COS, ports: { api: PORTS.COS } },
      { name: 'portos-ui', port: PORTS.UI, ports: { devUi: PORTS.UI } },
      { name: 'portos-autofixer', port: PORTS.AUTOFIXER, ports: { api: PORTS.AUTOFIXER } },
      { name: 'portos-autofixer-ui', port: PORTS.AUTOFIXER_UI, ports: { ui: PORTS.AUTOFIXER_UI } },
      { name: 'portos-browser', port: PORTS.CDP, ports: { cdp: PORTS.CDP, health: PORTS.CDP_HEALTH } }
    ],
    envFile: '.env',
    icon: 'portos',
    editorCommand: 'code .',
    archived: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  };
}

// Event emitter for apps changes
export const appsEvents = new EventEmitter();

// In-memory cache for apps data
let appsCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000; // Cache for 2 seconds to reduce file reads during rapid polling

/**
 * Load apps registry from disk (with caching).
 * Ensures the PortOS baseline app always exists.
 */
async function loadApps() {
  const now = Date.now();

  // Return cached data if still valid
  if (appsCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return appsCache;
  }

  await ensureDir(DATA_DIR);

  // STRICT (#4115): this reader WRITES — an empty `data.apps` makes the baseline
  // branch below rewrite apps.json with a lone PortOS entry, so a swallowed
  // EACCES/EIO would delete every registered app. Absent is still a legitimate
  // first-run empty; unreadable is not.
  const data = await readJSONFile(APPS_FILE, { apps: {} }, { strict: true });

  // Normalize: ensure data.apps is always an object
  if (!data.apps || typeof data.apps !== 'object') {
    data.apps = {};
  }

  // Safety net: expand leftover `__PORTOS_ROOT__` tokens from a partial
  // data.reference copy (setup-data only rewrote them on first create historically).
  // Persist so Apps → Git stops looking for `__PORTOS_ROOT__/.git`.
  let placeholderDirty = false;
  for (const [id, app] of Object.entries(data.apps)) {
    const { app: expanded, changed } = expandPortosRootInApp(app, PATHS.root);
    if (changed) {
      data.apps[id] = expanded;
      placeholderDirty = true;
    }
  }

  // Ensure PortOS baseline app is always present and up-to-date
  const baseline = buildPortosApp();
  if (!data.apps[PORTOS_APP_ID]) {
    data.apps[PORTOS_APP_ID] = baseline;
    await atomicWrite(APPS_FILE, data);
    console.log('📦 Seeded baseline PortOS app into apps registry');
  } else {
    // Reconcile: merge new baseline fields into existing entry (preserves user overrides)
    let dirty = placeholderDirty;
    for (const [key, value] of Object.entries(baseline)) {
      if (!(key in data.apps[PORTOS_APP_ID])) {
        data.apps[PORTOS_APP_ID][key] = value;
        dirty = true;
      }
    }
    // Force-sync specific fields that should always match the code definition
    const forceSync = ['uiPort', 'devUiPort', 'apiPort', 'tlsPort', 'buildCommand', 'startCommands', 'processes', 'pm2ProcessNames'];
    for (const key of forceSync) {
      if (JSON.stringify(data.apps[PORTOS_APP_ID][key]) !== JSON.stringify(baseline[key])) {
        data.apps[PORTOS_APP_ID][key] = baseline[key];
        dirty = true;
      }
    }
    // A literal `__PORTOS_ROOT__` is not a real user override — force repoPath
    // to the live checkout. Concrete custom paths are preserved (expand left them).
    if (containsPortosRootToken(data.apps[PORTOS_APP_ID].repoPath)) {
      data.apps[PORTOS_APP_ID].repoPath = baseline.repoPath;
      dirty = true;
    }
    if (dirty) {
      await atomicWrite(APPS_FILE, data);
      console.log(placeholderDirty
        ? '📦 Expanded __PORTOS_ROOT__ placeholders and reconciled PortOS baseline app'
        : '📦 Reconciled PortOS baseline app with latest fields');
    }
  }

  appsCache = data;
  cacheTimestamp = now;
  return appsCache;
}

/**
 * Save apps registry to disk (and invalidate cache)
 */
async function saveApps(data) {
  await ensureDir(DATA_DIR);
  await atomicWrite(APPS_FILE, data);
  // Update cache with saved data
  appsCache = data;
  cacheTimestamp = Date.now();
}

/**
 * Invalidate the apps cache (call after external changes)
 */
export function invalidateCache() {
  appsCache = null;
  cacheTimestamp = 0;
}

/**
 * Notify clients that apps data has changed
 * Call this after any operation that modifies app state
 */
export function notifyAppsChanged(action = 'update', appId) {
  appsEvents.emit('changed', {
    action,
    ...(appId ? { appId } : {}),
    timestamp: Date.now()
  });
}

/**
 * Get all apps (injects id from key)
 * @param {Object} options - Filter options
 * @param {boolean} options.includeArchived - Include archived apps (default: true for backwards compatibility)
 */
export async function getAllApps({ includeArchived = true } = {}) {
  const data = await loadApps();
  const apps = Object.entries(data.apps).map(([id, app]) => ({ id, ...app }));

  if (!includeArchived) {
    return apps.filter(app => !app.archived);
  }

  return apps;
}

/**
 * Get all active (non-archived) apps
 */
export async function getActiveApps() {
  return getAllApps({ includeArchived: false });
}

/**
 * Get app by ID (injects id from key)
 */
export async function getAppById(id) {
  const data = await loadApps();
  const app = data?.apps?.[id];
  return app ? { id, ...app } : null;
}

/**
 * Create a new app
 */
export async function createApp(appData) {
  const data = await loadApps();
  const id = uuidv4();
  const now = new Date().toISOString();

  // Store without id (key is id) and without uiUrl (derived from uiPort)
  const app = {
    name: appData.name,
    description: appData.description || '',
    repoPath: appData.repoPath,
    companionRepoPaths: Array.isArray(appData.companionRepoPaths) ? [...appData.companionRepoPaths] : [],
    type: appData.type || 'unknown',
    uiPort: appData.uiPort || null,
    devUiPort: appData.devUiPort || null,
    apiPort: appData.apiPort || null,
    buildCommand: appData.buildCommand || undefined,
    updateCommand: appData.updateCommand || undefined,
    startCommands: appData.startCommands || ['npm run dev'],
    pm2ProcessNames: appData.pm2ProcessNames || [appData.name.toLowerCase().replace(/\s+/g, '-')],
    nativeLaunch: appData.nativeLaunch || null,
    envFile: appData.envFile || '.env',
    icon: appData.icon || null,
    appIconPath: appData.appIconPath || null,
    editorCommand: appData.editorCommand
      || (NON_PM2_TYPES.has(appData.type) && process.platform === 'darwin' ? 'xed .' : 'code .'),
    archived: false,
    jira: appData.jira || null,
    // Where this app's autonomous work items live. 'auto' resolves to a
    // concrete tracker (PLAN.md / GitHub / GitLab / JIRA) from the git origin
    // host at dispatch time — see server/lib/workTracker.js.
    workTracker: appData.workTracker || 'auto',
    // The gh account this app's repo is driven under. Absent (the default) means
    // "infer from the repo owner" — see services/forgeAuth.js.
    ...(appData.forgeAccount?.trim() ? { forgeAccount: appData.forgeAccount.trim() } : {}),
    // Only persisted when explicitly sent. Absent means ON (see
    // repoStateVerificationEnabled), so writing a default here would freeze the
    // app against a future change of that default — but an explicit `false` on
    // create MUST survive, or a new app cannot opt out through POST at all.
    ...(typeof appData.verifyRepoStateOnCompletion === 'boolean'
      ? { verifyRepoStateOnCompletion: appData.verifyRepoStateOnCompletion }
      : {}),
    taskTypeOverrides: Object.fromEntries(
      SELF_IMPROVEMENT_TASK_TYPES.map(t => [t, { enabled: false }])
    ),
    createdAt: now,
    updatedAt: now
  };

  // Persist an explicitly-provided Layered Intelligence config on create; when
  // omitted the app has no key and the config accessor supplies the baseline on
  // first read (no per-app seed write). Only set it when present so absent stays
  // absent — createApp otherwise builds the object field-by-field and would drop it.
  if (appData.layeredIntelligence && typeof appData.layeredIntelligence === 'object') {
    app.layeredIntelligence = appData.layeredIntelligence;
  }

  // An absent map means every managed-app feature inherits the install-wide
  // setting. Preserve an explicitly supplied (possibly empty) map so create
  // and update have the same override contract.
  if (isPlainObject(appData.featureOverrides)) {
    app.featureOverrides = appData.featureOverrides;
  }

  data.apps[id] = app;
  await saveApps(data);

  // Return with id injected
  return { id, ...app };
}

/**
 * Update an existing app
 */
export async function updateApp(id, updates) {
  const data = await loadApps();

  if (!data.apps[id]) {
    return null;
  }

  // Remove id and uiUrl from updates if present (id is key, uiUrl is derived)
  const { id: _id, uiUrl: _uiUrl, ...cleanUpdates } = updates;
  // Feature overrides are a partial map: changing one app feature must not
  // erase the other per-app choices that are already persisted.
  const featureOverrides = isPlainObject(cleanUpdates.featureOverrides)
    ? {
      ...(isPlainObject(data.apps[id].featureOverrides) ? data.apps[id].featureOverrides : {}),
      ...cleanUpdates.featureOverrides,
    }
    : null;

  const app = {
    ...data.apps[id],
    ...cleanUpdates,
    ...(featureOverrides ? { featureOverrides } : {}),
    createdAt: data.apps[id].createdAt, // Preserve creation date
    updatedAt: new Date().toISOString()
  };

  data.apps[id] = app;
  await saveApps(data);

  // Return with id injected
  return { id, ...app };
}

/**
 * Remove an app from PortOS's registry (the repository on disk is untouched).
 * The PortOS baseline app cannot be removed.
 */
export async function deleteApp(id) {
  if (id === PORTOS_APP_ID) return false;

  const data = await loadApps();

  if (!data.apps[id]) {
    return false;
  }

  delete data.apps[id];
  await saveApps(data);

  return true;
}

/**
 * Archive an app (soft-delete that excludes from COS tasks).
 * PortOS baseline app cannot be archived.
 */
export async function archiveApp(id) {
  if (id === PORTOS_APP_ID) return null;
  return updateApp(id, { archived: true });
}

/**
 * Unarchive an app (restore to active status)
 */
export async function unarchiveApp(id) {
  return updateApp(id, { archived: false });
}

/**
 * Migrate app from legacy disabledTaskTypes array to taskTypeOverrides object.
 * Persists changes immediately so migration only runs once per app.
 */
async function migrateTaskTypeOverrides(id) {
  const data = await loadApps();
  const app = data?.apps?.[id];
  if (!app?.disabledTaskTypes || app.taskTypeOverrides) return;
  const overrides = {};
  for (const taskType of app.disabledTaskTypes) {
    overrides[taskType] = { enabled: false };
  }
  app.taskTypeOverrides = overrides;
  delete app.disabledTaskTypes;
  await saveApps(data);
  console.log(`📋 Migrated ${id} from disabledTaskTypes to taskTypeOverrides`);
}

/**
 * Resolve an app's effective work tracker (the single source its `claim-work`
 * task ships from). Returns `{ configured, resolved, host, forge, source }`;
 * see resolveAppWorkTracker. Returns null when the app id is unknown.
 */
export async function getAppWorkTracker(id) {
  const app = await getAppById(id);
  if (!app) return null;
  return resolveAppWorkTracker(app);
}

/**
 * Get an app's effective Layered Intelligence config (the loop's per-app
 * settings). Merges the stored `layeredIntelligence` over the defaults so a
 * partial/absent config still yields a complete, safe config. PortOS gets the
 * meta/self scopes. Returns null when the app id is unknown.
 *
 * `isPortos` is passed to the merge so a missing config picks up the right
 * default scopes without a per-app seed write — an install adopts the baseline
 * the first time the loop reads it.
 */
export async function getAppLayeredIntelligenceConfig(id) {
  const app = await getAppById(id);
  if (!app) return null;
  const { getEffectiveConfig } = await import('./layeredIntelligence.js');
  return getEffectiveConfig({ ...app, isPortos: id === PORTOS_APP_ID });
}

/**
 * Update an app's Layered Intelligence config. Shallow-merges `updates` over the
 * *stored* config only (with `sources` merged one level deep) so a partial PATCH
 * doesn't wipe untouched fields. We deliberately merge over the raw stored value,
 * NOT the effective (defaults-filled) config — persisting the full default set to
 * disk would freeze this install against future default changes (the config
 * accessor's "adopt baseline on read" forward-compat property). Untouched fields
 * stay absent and keep resolving to the shipped default via getEffectiveConfig.
 * Returns the updated app, or null if unknown.
 */
export async function updateAppLayeredIntelligence(id, updates = {}) {
  const app = await getAppById(id);
  if (!app) return null;
  const stored = (app.layeredIntelligence && typeof app.layeredIntelligence === 'object' && !Array.isArray(app.layeredIntelligence))
    ? app.layeredIntelligence
    : {};
  const merged = { ...stored, ...updates };
  if (updates.sources && typeof updates.sources === 'object') {
    merged.sources = { ...(stored.sources && typeof stored.sources === 'object' ? stored.sources : {}), ...updates.sources };
  }
  if (updates.handoff && typeof updates.handoff === 'object') {
    merged.handoff = { ...(stored.handoff && typeof stored.handoff === 'object' ? stored.handoff : {}), ...updates.handoff };
  }
  return updateApp(id, { layeredIntelligence: merged });
}

/**
 * Get task type overrides for an app
 */
export async function getAppTaskTypeOverrides(id) {
  await migrateTaskTypeOverrides(id);
  const app = await getAppById(id);
  if (!app) return {};
  return app.taskTypeOverrides || {};
}

/**
 * Check if a task type is enabled for a specific app
 */
export async function isTaskTypeEnabledForApp(id, taskType) {
  const overrides = await getAppTaskTypeOverrides(id);
  // No override means disabled — new task types must be explicitly enabled per app
  return overrides[taskType]?.enabled === true;
}

/**
 * Get per-app interval for a task type (null = inherit global)
 */
export async function getAppTaskTypeInterval(appId, taskType) {
  const overrides = await getAppTaskTypeOverrides(appId);
  return overrides[taskType]?.interval || null;
}

/**
 * Get a per-app numeric intervalMs override for a task type (null = none). Used
 * by handler-backed tasks (e.g. layered-intelligence) whose per-app cadence can
 * be sub-daily — the string `interval` enum ('daily'/'weekly'/…) can't express
 * that, so those override entries also carry a numeric `intervalMs` that the
 * scheduler's CUSTOM branch honors. Returns null for a missing/invalid value.
 */
export async function getAppTaskTypeIntervalMs(appId, taskType) {
  const overrides = await getAppTaskTypeOverrides(appId);
  const ms = overrides[taskType]?.intervalMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Merge one override patch into an app's stored overrides, in place.
 *
 * Extracted so a single-type edit and a whole-plan write (the Quality tab's
 * schedule form rewrites ~26 types at once) apply IDENTICAL field semantics —
 * the alternative was a second copy of the absent-vs-null ladder below, which
 * is exactly where "cleared back to inherit" and "left alone" drift apart.
 * Returns the watcher state keys the caller must reset for a disable.
 */
function mergeTaskTypeOverride(overrides, taskType, { enabled, interval, intervalMs, providerId, model, taskMetadata } = {}) {
  const updated = { ...(overrides[taskType] || {}) };
  if (typeof enabled === 'boolean') updated.enabled = enabled;
  if (interval !== undefined) updated.interval = interval;
  // intervalMs / providerId / model are the per-app scheduling fields for
  // handler-backed tasks (layered-intelligence, option A). `null` clears the
  // stored value (back to "inherit / use default").
  if (intervalMs !== undefined) {
    if (intervalMs === null) delete updated.intervalMs;
    else updated.intervalMs = intervalMs;
  }
  if (providerId !== undefined) {
    if (providerId === null || providerId === '') delete updated.providerId;
    else updated.providerId = providerId;
  }
  if (model !== undefined) {
    if (model === null || model === '') delete updated.model;
    else updated.model = model;
  }
  if (taskMetadata !== undefined) {
    const sanitized = sanitizeTaskMetadata(taskMetadata);
    if (!sanitized) {
      delete updated.taskMetadata;
    } else {
      updated.taskMetadata = sanitized;
    }
  }

  // Remove entry when every field is inherit (enabled undefined, no interval, no
  // intervalMs/provider/model, no metadata) — an empty override is just noise.
  if (updated.enabled === undefined && !updated.interval && updated.intervalMs === undefined &&
      updated.providerId === undefined && updated.model === undefined && !updated.taskMetadata) {
    delete overrides[taskType];
  } else {
    overrides[taskType] = updated;
  }
}

/**
 * Disabling pr-watcher/issue-watcher clears the high-water mark AND the
 * execution cooldown so a later re-enable baselines promptly (like first
 * enable) instead of dispatching the backlog opened while it was off. See
 * prWatcher.js / cosTaskGenerator.js.
 */
async function resetWatcherStateOnDisable(appRecord, id, taskType, enabled) {
  if (enabled !== false) return;
  if (taskType === 'pr-watcher') {
    delete appRecord.prWatcherState;
    await resetWatcherCooldown('pr-watcher', id);
  }
  if (taskType === 'issue-watcher') {
    delete appRecord.issueWatcherState;
    await resetWatcherCooldown('issue-watcher', id);
  }
}

/**
 * Update a task type override for a specific app (enable/disable + optional interval)
 */
export async function updateAppTaskTypeOverride(id, taskType, patch = {}) {
  return updateAppTaskTypeOverrides(id, { [taskType]: patch });
}

/**
 * Apply several task-type override patches to one app in a single write.
 *
 * `patches` maps task type → the same patch object `updateAppTaskTypeOverride`
 * takes. One load/save for the whole set: the Quality schedule form touches
 * every audit type at once, and doing that as ~26 sequential read-modify-writes
 * of `apps.json` is both slow and a window in which a partial plan is live.
 *
 * @param {string} id - App id
 * @param {Record<string, object>} patches - Task type → override patch
 * @returns {Promise<object|null>} The updated app record, or null when unknown
 */
export async function updateAppTaskTypeOverrides(id, patches = {}) {
  const data = await loadApps();
  if (!data.apps[id]) return null;

  // Migrate legacy format if needed
  await migrateTaskTypeOverrides(id);

  const overrides = data.apps[id].taskTypeOverrides || {};
  for (const [taskType, patch] of Object.entries(patches)) {
    mergeTaskTypeOverride(overrides, taskType, patch);
    await resetWatcherStateOnDisable(data.apps[id], id, taskType, patch?.enabled);
  }

  data.apps[id].taskTypeOverrides = overrides;
  delete data.apps[id].disabledTaskTypes; // Remove legacy field
  data.apps[id].updatedAt = new Date().toISOString();
  await saveApps(data);
  appsEvents.emit('changed', { action: 'update-task-types', timestamp: Date.now() });

  return { id, ...data.apps[id] };
}

/**
 * Reset the schedule execution cooldown for an app's pr-watcher so a re-enable
 * baselines on the next tick instead of waiting out the prior 30-min custom
 * interval — otherwise PRs opened in that delayed window slip past the firstRun
 * baseline. Dynamic import avoids a static apps↔taskSchedule cycle (taskSchedule
 * already imports this module). Best-effort: a missing history is a no-op and a
 * storage failure must not block the primary app-disable write, but it is logged
 * with app context instead of disappearing.
 */
async function resetWatcherCooldown(taskType, appId) {
  try {
    const { resetExecutionHistory } = await import('./taskSchedule.js');
    const result = await resetExecutionHistory(taskType, appId);
    if (result?.error && result.error !== 'No execution history found') {
      console.error(`❌ Failed to reset ${taskType} cooldown for app ${appId}: ${result.error}`);
    }
    return result;
  } catch (err) {
    console.error(`❌ Failed to reset ${taskType} cooldown for app ${appId}: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Clear the pr-watcher high-water mark on every app. Called when pr-watcher is
 * disabled GLOBALLY (CoS → Schedule), the counterpart to the per-app disable
 * clears in updateAppTaskTypeOverride/bulk/toggle-all — so a later global
 * re-enable baselines silently instead of dispatching the backlog of PRs
 * opened while it was paused. See prWatcher.js.
 */
export async function clearAllPrWatcherState() {
  const data = await loadApps();
  let changed = false;
  for (const app of Object.values(data.apps)) {
    if (app.prWatcherState) {
      delete app.prWatcherState;
      changed = true;
    }
  }
  if (changed) await saveApps(data);
  return { changed };
}

/** Clear issue-watcher cursors/pending approvals on global disable. */
export async function clearAllIssueWatcherState() {
  const data = await loadApps();
  let changed = false;
  for (const app of Object.values(data.apps)) {
    if (app.issueWatcherState) {
      delete app.issueWatcherState;
      changed = true;
    }
  }
  if (changed) await saveApps(data);
  return { changed };
}

/**
 * Bulk update a task type override for all active (non-archived) apps
 */
export async function bulkUpdateAppTaskTypeOverride(taskType, { enabled } = {}) {
  const data = await loadApps();
  const activeIds = Object.entries(data.apps)
    .filter(([, app]) => !app.archived)
    .map(([id]) => id);

  for (const id of activeIds) {
    const overrides = data.apps[id].taskTypeOverrides || {};
    mergeTaskTypeOverride(overrides, taskType, { enabled });
    await resetWatcherStateOnDisable(data.apps[id], id, taskType, enabled);

    data.apps[id].taskTypeOverrides = overrides;
    delete data.apps[id].disabledTaskTypes;
    data.apps[id].updatedAt = new Date().toISOString();
  }

  await saveApps(data);
  appsEvents.emit('changed', { action: 'update-task-types', timestamp: Date.now() });

  return { count: activeIds.length };
}

/**
 * Toggle all task types for a single app to enabled or disabled
 */
export async function toggleAllAppTaskTypes(id, enabled) {
  const data = await loadApps();
  if (!data.apps[id]) return null;

  await migrateTaskTypeOverrides(id);

  const overrides = data.apps[id].taskTypeOverrides || {};
  for (const taskType of SELF_IMPROVEMENT_TASK_TYPES) {
    const existing = overrides[taskType] || {};
    overrides[taskType] = { ...existing, enabled };
  }

  // Disabling everything disables the watchers too — same reset as any other
  // path that moves their gate, so a later re-enable baselines promptly.
  for (const watcher of ['pr-watcher', 'issue-watcher']) {
    await resetWatcherStateOnDisable(data.apps[id], id, watcher, enabled);
  }

  data.apps[id].taskTypeOverrides = overrides;
  delete data.apps[id].disabledTaskTypes;
  data.apps[id].updatedAt = new Date().toISOString();
  await saveApps(data);
  appsEvents.emit('changed', { action: 'update-task-types', timestamp: Date.now() });

  return { id, ...data.apps[id] };
}

/**
 * Reserved ports across every app — top-level uiPort/devUiPort/apiPort/tlsPort
 * plus every value in each process's `ports` map. Walking processes[] is what
 * lets the scaffolder avoid colliding with non-public ports (engine IPC, CDP)
 * that have no top-level field of their own.
 */
export async function getReservedPorts() {
  const apps = await getAllApps();
  const ports = new Set();

  const addPort = (p) => {
    let n = null;
    if (typeof p === 'number' && Number.isInteger(p)) n = p;
    // Strict /^\d+$/ rather than parseInt — '5565abc' should not coerce to 5565.
    else if (typeof p === 'string' && /^\d+$/.test(p)) n = Number(p);
    if (n !== null && n >= 1 && n <= 65535) ports.add(n);
  };

  for (const app of apps) {
    addPort(app.uiPort);
    addPort(app.devUiPort);
    addPort(app.apiPort);
    addPort(app.tlsPort);
    if (Array.isArray(app.processes)) {
      for (const proc of app.processes) {
        if (proc?.port) addPort(proc.port);
        if (proc?.ports && typeof proc.ports === 'object') {
          for (const value of Object.values(proc.ports)) addPort(value);
        }
      }
    }
  }

  // Also reserve PortOS ports
  addPort(PORTS.API);
  addPort(PORTS.UI);

  return Array.from(ports).sort((a, b) => a - b);
}
