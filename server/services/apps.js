import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { NON_PM2_TYPES, usesPm2 } from './streamingDetect.js';
import { listProcessesStrict } from './pm2.js';
import { SELF_IMPROVEMENT_TASK_TYPES } from './taskSchedule.js';
import { sanitizeTaskMetadata } from '../lib/validation.js';
import { resolveAppWorkTracker } from '../lib/workTracker.js';
import { PORTS } from '../lib/ports.js';
import { hasTailscaleCert } from '../../lib/tailscale-https.js';
import { certPaths } from '../../lib/certPaths.js';

const DATA_DIR = PATHS.data;
const APPS_FILE = join(DATA_DIR, 'apps.json');

// Stable ID for the PortOS app — always present, never deletable
export const PORTOS_APP_ID = 'portos-default';

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

  const data = await readJSONFile(APPS_FILE, { apps: {} });

  // Normalize: ensure data.apps is always an object
  if (!data.apps || typeof data.apps !== 'object') {
    data.apps = {};
  }

  // Ensure PortOS baseline app is always present and up-to-date
  const baseline = buildPortosApp();
  if (!data.apps[PORTOS_APP_ID]) {
    data.apps[PORTOS_APP_ID] = baseline;
    await atomicWrite(APPS_FILE, data);
    console.log('📦 Seeded baseline PortOS app into apps registry');
  } else {
    // Reconcile: merge new baseline fields into existing entry (preserves user overrides)
    let dirty = false;
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
    if (dirty) {
      await atomicWrite(APPS_FILE, data);
      console.log('📦 Reconciled PortOS baseline app with latest fields');
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
export function notifyAppsChanged(action = 'update') {
  appsEvents.emit('changed', { action, timestamp: Date.now() });
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
 * Summarize PM2-managed app status for dashboards.
 *
 * Only counts apps whose `type` is PM2-runnable (Express services, etc.).
 * Native projects (Xcode, iOS, macOS) have no detectable runtime state and
 * are reported separately under `unmanaged` so callers can show context
 * without inflating the running denominator.
 */
/**
 * Resolve each active app's overall PM2 status in one pass.
 *
 * Returns one entry per active app — PM2-runnable apps carry a derived
 * `overallStatus` of `online` / `stopped` / `not_started` / `unknown`; native
 * projects (Xcode, iOS, macOS) report `n/a` since they have no detectable
 * runtime. Each unique PM2_HOME is queried at most once. This is the shared
 * primitive behind both `getAppStatusSummary()` (counts) and the CyberCity
 * snapshot pipeline (per-building status), so the two never drift.
 *
 * Absent-vs-empty rule (CLAUDE.md): `listProcessesStrict(home)` returns `null`
 * when the PM2 read FAILED (vs `[]` for a successful read with no processes).
 * The generic `listProcesses` flattens a failed read into `[]`, which would
 * record every app in that home as `not_started` (status known: never launched)
 * when the truth is `unknown` (status unavailable: PM2 unreachable). We track
 * failed homes explicitly and mark their apps `overallStatus: 'unknown'` +
 * `degraded: true`, so a transient PM2 blip can't masquerade as "all apps
 * offline." Homes that read fine still report accurate status alongside.
 *
 * @returns {Promise<Array<{ id, name, type, repoPath, overallStatus, managed: boolean, degraded?: boolean }>>}
 */
export async function getAppStatuses() {
  const apps = await getAllApps({ includeArchived: false });

  // Group PM2 apps by pm2Home so each unique home is queried at most once.
  const homeGroups = new Map();
  for (const app of apps) {
    if (!usesPm2(app.type)) continue;
    const home = app.pm2Home || null;
    if (!homeGroups.has(home)) homeGroups.set(home, true);
  }

  const procMaps = new Map();
  const failedHomes = new Set();
  for (const home of homeGroups.keys()) {
    // `null` = PM2 read failed (vs `[]` = read OK, no processes).
    const procs = await listProcessesStrict(home);
    if (procs === null) {
      failedHomes.add(home);
      procMaps.set(home, new Map());
    } else {
      procMaps.set(home, new Map(procs.map(p => [p.name, p])));
    }
  }

  return apps.map(app => {
    const managed = usesPm2(app.type);
    // repoPath is carried so callers can map an agent's workspacePath back to its
    // app (the CyberCity snapshot's agent-assignment mapping, mirroring the
    // client's agentMap) without a second apps read.
    const base = { id: app.id, name: app.name, type: app.type, repoPath: app.repoPath };
    if (!managed) {
      return { ...base, overallStatus: 'n/a', managed: false };
    }
    const home = app.pm2Home || null;
    if (failedHomes.has(home)) {
      // PM2 read for this home failed — runtime status is genuinely unknown,
      // NOT a confident `not_started`. `degraded` lets callers surface the gap.
      return { ...base, overallStatus: 'unknown', managed: true, degraded: true };
    }
    const procMap = procMaps.get(home) || new Map();
    const names = app.pm2ProcessNames || [];
    let overallStatus = 'not_started';
    if (names.length > 0) {
      const statuses = names.map(n => procMap.get(n)?.status || 'not_found');
      if (statuses.some(s => s === 'online')) overallStatus = 'online';
      else if (statuses.some(s => s === 'stopped')) overallStatus = 'stopped';
      else overallStatus = 'not_started';
    }
    return { ...base, overallStatus, managed: true };
  });
}

export async function getAppStatusSummary() {
  const statuses = await getAppStatuses();
  const managed = statuses.filter(s => s.managed);
  // `unknown` = PM2 home read failed (status unavailable), distinct from
  // `notStarted` (read succeeded, app simply isn't running). `degraded` flags
  // that at least one managed app's runtime status couldn't be determined, so
  // consumers don't report a PM2 blip as a confident "everything offline."
  const unknown = managed.filter(s => s.overallStatus === 'unknown').length;

  return {
    total: managed.length,
    online: managed.filter(s => s.overallStatus === 'online').length,
    stopped: managed.filter(s => s.overallStatus === 'stopped').length,
    notStarted: managed.filter(s => s.overallStatus === 'not_started').length,
    unknown,
    degraded: unknown > 0,
    unmanaged: statuses.length - managed.length
  };
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
    type: appData.type || 'unknown',
    uiPort: appData.uiPort || null,
    devUiPort: appData.devUiPort || null,
    apiPort: appData.apiPort || null,
    buildCommand: appData.buildCommand || undefined,
    startCommands: appData.startCommands || ['npm run dev'],
    pm2ProcessNames: appData.pm2ProcessNames || [appData.name.toLowerCase().replace(/\s+/g, '-')],
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
    taskTypeOverrides: Object.fromEntries(
      SELF_IMPROVEMENT_TASK_TYPES.map(t => [t, { enabled: false }])
    ),
    createdAt: now,
    updatedAt: now
  };

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

  const app = {
    ...data.apps[id],
    ...cleanUpdates,
    createdAt: data.apps[id].createdAt, // Preserve creation date
    updatedAt: new Date().toISOString()
  };

  data.apps[id] = app;
  await saveApps(data);

  // Return with id injected
  return { id, ...app };
}

/**
 * Delete an app (PortOS baseline app cannot be deleted)
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
 * Update a task type override for a specific app (enable/disable + optional interval)
 */
export async function updateAppTaskTypeOverride(id, taskType, { enabled, interval, taskMetadata } = {}) {
  const data = await loadApps();
  if (!data.apps[id]) return null;

  // Migrate legacy format if needed
  await migrateTaskTypeOverrides(id);

  const overrides = data.apps[id].taskTypeOverrides || {};
  const existing = overrides[taskType] || {};

  const updated = { ...existing };
  if (typeof enabled === 'boolean') updated.enabled = enabled;
  if (interval !== undefined) updated.interval = interval;
  if (taskMetadata !== undefined) {
    const sanitized = sanitizeTaskMetadata(taskMetadata);
    if (!sanitized) {
      delete updated.taskMetadata;
    } else {
      updated.taskMetadata = sanitized;
    }
  }

  // Remove entry when all fields are inherit (enabled undefined, no interval, no metadata)
  if (updated.enabled === undefined && !updated.interval && !updated.taskMetadata) {
    delete overrides[taskType];
  } else {
    overrides[taskType] = updated;
  }

  // Disabling pr-watcher clears its high-water mark AND its execution cooldown
  // so a later re-enable baselines promptly (like first enable) instead of
  // dispatching the backlog of PRs opened while it was off. See prWatcher.js /
  // cosTaskGenerator.js.
  if (taskType === 'pr-watcher' && enabled === false) {
    delete data.apps[id].prWatcherState;
    await resetPrWatcherCooldown(id);
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
 * already imports this module). Best-effort: a missing history is a no-op.
 */
async function resetPrWatcherCooldown(appId) {
  const { resetExecutionHistory } = await import('./taskSchedule.js');
  await resetExecutionHistory('pr-watcher', appId).catch(() => {});
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
    const existing = overrides[taskType] || {};
    const updated = { ...existing, enabled };

    if (updated.enabled === undefined && !updated.interval && !updated.taskMetadata) {
      delete overrides[taskType];
    } else {
      overrides[taskType] = updated;
    }

    // See updateAppTaskTypeOverride: clear pr-watcher's mark + cooldown on disable.
    if (taskType === 'pr-watcher' && enabled === false) {
      delete data.apps[id].prWatcherState;
      await resetPrWatcherCooldown(id);
    }

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

  // Disabling everything disables pr-watcher too — clear its mark + cooldown so
  // a later re-enable baselines promptly. See updateAppTaskTypeOverride.
  if (enabled === false) {
    delete data.apps[id].prWatcherState;
    await resetPrWatcherCooldown(id);
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
