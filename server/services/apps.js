import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { NON_PM2_TYPES, usesPm2, isDesktopType } from './streamingDetect.js';
import { listProcessesStrict } from './pm2.js';
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
  // EACCES/EIO would delete every registered app. It also feeds displayed counts
  // (`getAppStatusSummary`'s total/online/unmanaged), where a fake 0 reads as
  // fact. Absent is still a legitimate first-run empty; unreadable is not.
  const data = await readJSONFile(APPS_FILE, { apps: {} }, { strict: true });

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
 * PM2 process names whose exit is expected: desktop apps and optional native
 * launch targets attached to otherwise web-based apps.
 *
 * A desktop process is launched with `autorestart: false` because the user
 * closing the window is a normal exit — but that alone does NOT stop every
 * relaunch path. Anything that reacts to an `errored` PM2 status by restarting
 * it (the CoS health monitor) would reopen the game window, and anything that
 * alerts on `errored` (proactive alerts) would report a quit as a failure.
 * A force-quit or a non-zero exit lands in exactly that state, so those
 * supervisors consult this set and skip desktop processes. See issue #2991.
 *
 * Archived apps are included: their PM2 entries can outlive the archive, and a
 * stale entry must not become auto-restartable just because the app was hidden.
 *
 * @returns {Promise<Set<string>>} Process names to exempt from auto-restart/alerts.
 */
export async function getDesktopProcessNames() {
  const apps = await getAllApps();
  const names = new Set();
  for (const app of apps) {
    if (isDesktopType(app.type)) {
      for (const name of app.pm2ProcessNames || []) names.add(name);
    }
    if (app.nativeLaunch?.processName) names.add(app.nativeLaunch.processName);
  }
  return names;
}

/**
 * Resolve the custom PM2 home for a registered process name.
 *
 * Process-name-only log consumers use this as a backward-compatible fallback
 * when they do not already have an app id. An app id remains the preferred
 * disambiguator because process names may be reused across PM2 homes.
 *
 * @param {string} processName PM2 process name to look up
 * @returns {Promise<string|null>} The owning app's custom PM2_HOME, if any
 */
export async function resolvePm2HomeForProcess(processName) {
  const apps = await getAllApps();
  const app = apps.find(candidate =>
    candidate.pm2ProcessNames?.includes(processName)
    || candidate.nativeLaunch?.processName === processName
  );
  return app?.pm2Home || null;
}

/**
 * Stamp `expectedExit` onto each PM2 process so supervisors can branch on the
 * concept rather than each re-deriving it from a name set.
 *
 * `expectedExit: true` means "this process stopping is a normal outcome, not a
 * failure" — today that covers desktop (GUI) app processes and the optional
 * native launch targets attached to web apps. The user closing either window
 * ends its process (cleanly as `stopped`, or as `errored` on a force-quit /
 * non-zero exit). Consumers that auto-restart or alert on `errored` must skip
 * these. Current consumers:
 *   - services/cosHealthMonitor.js   — auto-restarts errored processes
 *   - services/proactiveAlerts.js    — alerts on errored / crash-looping processes
 *   - routes/systemHealth.js         — drives overallHealth + the dashboard/city HUD
 *   - services/voice/tools/system.js — `pm2_status` reads "issues" back aloud
 * A further consumer that reacts to `errored` needs this too; naming the concept
 * here is what makes that discoverable (see issue #2991).
 *
 * What NONE of them exempt is *liveness*. `expectedExit` says a process
 * STOPPING is a normal outcome, so only the failure-bearing counts filter on
 * it — an `online` count must still include an exempt process, or a *running*
 * desktop app lands in `total` and in no status bucket at all.
 *
 * Fails open: if the registry can't be read, nothing is marked expected, so the
 * pre-existing behavior stands rather than silently exempting every process.
 * Accepts either shape of process object — raw `pm2 jlist` entries or `mapProcess`
 * output — since both carry a top-level `name`.
 *
 * @param {Array<{name: string}>} processes
 * @returns {Promise<Array<object>>} the same processes, each with `expectedExit`.
 */
export async function annotateExpectedExit(processes) {
  const desktopNames = await getDesktopProcessNames().catch(err => {
    console.error(`❌ Could not read the app registry for process supervision: ${err.message}`);
    return new Set();
  });
  return processes.map(p => ({ ...p, expectedExit: desktopNames.has(p?.name) }));
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
 * primitive behind both `getAppStatusSummary()` (counts) and the OpenWorld
 * snapshot pipeline (per-building status), so the two never drift.
 *
 * Absent-vs-empty rule (AGENTS.md): `listProcessesStrict(home)` returns `null`
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
    // app (the OpenWorld snapshot's agent-assignment mapping, mirroring the
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
 * Update a task type override for a specific app (enable/disable + optional interval)
 */
export async function updateAppTaskTypeOverride(id, taskType, { enabled, interval, intervalMs, providerId, model, taskMetadata } = {}) {
  const data = await loadApps();
  if (!data.apps[id]) return null;

  // Migrate legacy format if needed
  await migrateTaskTypeOverrides(id);

  const overrides = data.apps[id].taskTypeOverrides || {};
  const existing = overrides[taskType] || {};

  const updated = { ...existing };
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

  // Disabling pr-watcher clears its high-water mark AND its execution cooldown
  // so a later re-enable baselines promptly (like first enable) instead of
  // dispatching the backlog of PRs opened while it was off. See prWatcher.js /
  // cosTaskGenerator.js.
  if (taskType === 'pr-watcher' && enabled === false) {
    delete data.apps[id].prWatcherState;
    await resetWatcherCooldown('pr-watcher', id);
  }
  if (taskType === 'issue-watcher' && enabled === false) {
    delete data.apps[id].issueWatcherState;
    await resetWatcherCooldown('issue-watcher', id);
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
      await resetWatcherCooldown('pr-watcher', id);
    }
    if (taskType === 'issue-watcher' && enabled === false) {
      delete data.apps[id].issueWatcherState;
      await resetWatcherCooldown('issue-watcher', id);
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
    delete data.apps[id].issueWatcherState;
    await resetWatcherCooldown('pr-watcher', id);
    await resetWatcherCooldown('issue-watcher', id);
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
