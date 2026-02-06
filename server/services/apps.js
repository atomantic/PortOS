import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.data;
const APPS_FILE = join(DATA_DIR, 'apps.json');

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
 * Load apps registry from disk (with caching)
 */
async function loadApps() {
  const now = Date.now();

  // Return cached data if still valid
  if (appsCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return appsCache;
  }

  await ensureDataDir();

  if (!existsSync(APPS_FILE)) {
    appsCache = { apps: {} };
    cacheTimestamp = now;
    return appsCache;
  }

  const content = await readFile(APPS_FILE, 'utf-8');
  appsCache = JSON.parse(content);
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
  const app = data.apps[id];
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
    apiPort: appData.apiPort || null,
    startCommands: appData.startCommands || ['npm run dev'],
    pm2ProcessNames: appData.pm2ProcessNames || [appData.name.toLowerCase().replace(/\s+/g, '-')],
    envFile: appData.envFile || '.env',
    icon: appData.icon || null,
    editorCommand: appData.editorCommand || 'code .',
    archived: false,
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
 * Delete an app
 */
export async function deleteApp(id) {
  const data = await loadApps();

  if (!data.apps[id]) {
    return false;
  }

  delete data.apps[id];
  await saveApps(data);

  return true;
}

/**
 * Archive an app (soft-delete that excludes from COS tasks)
 */
export async function archiveApp(id) {
  return updateApp(id, { archived: true });
}

/**
 * Unarchive an app (restore to active status)
 */
export async function unarchiveApp(id) {
  return updateApp(id, { archived: false });
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
  ports.add(5554);
  ports.add(5555);

  return Array.from(ports).sort((a, b) => a - b);
}
