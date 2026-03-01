import { writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { SELF_IMPROVEMENT_TASK_TYPES } from './taskSchedule.js';
import { PORTS } from '../lib/ports.js';

const DATA_DIR = PATHS.data;
const APPS_FILE = join(DATA_DIR, 'apps.json');

// Stable ID for the PortOS app — always present, never deletable
export const PORTOS_APP_ID = 'portos-default';

/**
 * Build the baseline PortOS app entry with repoPath resolved to the actual project root.
 */
function buildPortosApp() {
  return {
    name: 'PortOS',
    description: 'Local App OS portal for dev machines',
    repoPath: PATHS.root,
    type: 'express',
    uiPort: PORTS.API,
    devUiPort: PORTS.UI,
    apiPort: PORTS.API,
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
      { name: 'portos-server', port: PORTS.API, ports: { api: PORTS.API } },
      { name: 'portos-cos', port: 5558, ports: { api: 5558 } },
      { name: 'portos-ui', port: PORTS.UI, ports: { devUi: PORTS.UI } },
      { name: 'portos-autofixer', port: 5559, ports: { api: 5559 } },
      { name: 'portos-autofixer-ui', port: 5560, ports: { ui: 5560 } },
      { name: 'portos-browser', port: 5556, ports: { cdp: 5556, health: 5557 } }
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
 * Ensure data directory exists
 */
async function ensureDataDir() {
  await ensureDir(DATA_DIR);
}

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

  await ensureDataDir();

  const data = await readJSONFile(APPS_FILE, { apps: {} });

  // Normalize: ensure data.apps is always an object
  if (!data.apps || typeof data.apps !== 'object') {
    data.apps = {};
  }

  // Ensure PortOS baseline app is always present and up-to-date
  const baseline = buildPortosApp();
  if (!data.apps[PORTOS_APP_ID]) {
    data.apps[PORTOS_APP_ID] = baseline;
    await writeFile(APPS_FILE, JSON.stringify(data, null, 2));
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
    const forceSync = ['uiPort', 'devUiPort', 'apiPort', 'buildCommand', 'startCommands', 'processes', 'pm2ProcessNames'];
    for (const key of forceSync) {
      if (JSON.stringify(data.apps[PORTOS_APP_ID][key]) !== JSON.stringify(baseline[key])) {
        data.apps[PORTOS_APP_ID][key] = baseline[key];
        dirty = true;
      }
    }
    if (dirty) {
      await writeFile(APPS_FILE, JSON.stringify(data, null, 2));
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
  await ensureDataDir();
  await writeFile(APPS_FILE, JSON.stringify(data, null, 2));
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
    editorCommand: appData.editorCommand || 'code .',
    archived: false,
    jira: appData.jira || null,
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
  return overrides[taskType]?.enabled !== false;
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
export async function updateAppTaskTypeOverride(id, taskType, { enabled, interval } = {}) {
  const data = await loadApps();
  if (!data.apps[id]) return null;

  // Migrate legacy format if needed
  await migrateTaskTypeOverrides(id);

  const overrides = data.apps[id].taskTypeOverrides || {};
  const existing = overrides[taskType] || {};

  const updated = { ...existing };
  if (typeof enabled === 'boolean') updated.enabled = enabled;
  if (interval !== undefined) updated.interval = interval;

  // If override matches "inherit everything" defaults, remove the entry
  if (updated.enabled !== false && !updated.interval) {
    delete overrides[taskType];
  } else {
    overrides[taskType] = updated;
  }

  data.apps[id].taskTypeOverrides = overrides;
  delete data.apps[id].disabledTaskTypes; // Remove legacy field
  data.apps[id].updatedAt = new Date().toISOString();
  await saveApps(data);
  appsEvents.emit('changed', { action: 'update-task-types', timestamp: Date.now() });

  return { id, ...data.apps[id] };
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

    if (updated.enabled !== false && !updated.interval) {
      delete overrides[taskType];
    } else {
      overrides[taskType] = updated;
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
 * Get reserved ports from all registered apps
 */
export async function getReservedPorts() {
  const apps = await getAllApps();
  const ports = new Set();

  for (const app of apps) {
    if (app.uiPort) ports.add(app.uiPort);
    if (app.apiPort) ports.add(app.apiPort);
  }

  // Also reserve PortOS ports
  ports.add(PORTS.API);
  ports.add(PORTS.UI);

  return Array.from(ports).sort((a, b) => a - b);
}
