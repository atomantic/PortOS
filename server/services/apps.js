import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const APPS_FILE = join(DATA_DIR, 'apps.json');

/**
 * Ensure data directory exists
 */
async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/**
 * Load apps registry from disk
 */
async function loadApps() {
  await ensureDataDir();

  if (!existsSync(APPS_FILE)) {
    return { apps: {} };
  }

  const content = await readFile(APPS_FILE, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save apps registry to disk
 */
async function saveApps(data) {
  await ensureDataDir();
  await writeFile(APPS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get all apps (injects id from key)
 */
export async function getAllApps() {
  const data = await loadApps();
  return Object.entries(data.apps).map(([id, app]) => ({ id, ...app }));
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
