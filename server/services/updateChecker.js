import { writeFile } from 'fs/promises';
import { join } from 'path';
import { EventEmitter } from 'events';
import { readJSONFile, PATHS, ensureDir } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { execGh } from './github.js';

const UPDATE_FILE = join(PATHS.data, 'update.json');
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 10 * 1000; // 10 seconds

export const updateEvents = new EventEmitter();

const withLock = createMutex();

let schedulerInterval = null;
let startupTimeout = null;

const defaultState = () => ({
  lastCheck: null,
  latestRelease: null,
  ignoredVersions: [],
  updateInProgress: false,
  lastUpdateResult: null
});

/**
 * Read the current version from the root package.json.
 * Re-reads on each call so it picks up changes after updates.
 */
export async function getCurrentVersion() {
  const pkgPath = join(PATHS.root, 'package.json');
  const pkg = await readJSONFile(pkgPath, { version: '0.0.0' });
  return pkg.version;
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

async function loadState() {
  await ensureDir(PATHS.data);
  return readJSONFile(UPDATE_FILE, defaultState());
}

async function saveState(state) {
  await ensureDir(PATHS.data);
  await writeFile(UPDATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Check GitHub for the latest release and compare to current version.
 */
export async function checkForUpdate() {
  return withLock(async () => {
    const state = await loadState();
    const currentVersion = await getCurrentVersion();

    const raw = await execGh(['api', 'repos/atomantic/PortOS/releases/latest']);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`Failed to parse GitHub release response: ${raw.slice(0, 200)}`); }
    const release = {
      version: data.tag_name?.replace(/^v/, '') || '0.0.0',
      tag: data.tag_name || '',
      url: data.html_url || '',
      publishedAt: data.published_at || '',
      body: data.body || ''
    };

    state.lastCheck = new Date().toISOString();
    state.latestRelease = release;
    await saveState(state);

    const isNewer = compareSemver(release.version, currentVersion) > 0;
    const isIgnored = state.ignoredVersions.includes(release.version);

    updateEvents.emit('update:checked', {
      currentVersion,
      latestRelease: release,
      updateAvailable: isNewer && !isIgnored
    });

    if (isNewer && !isIgnored) {
      updateEvents.emit('update:available', {
        currentVersion,
        latestVersion: release.version,
        latestRelease: release
      });
    }

    return {
      currentVersion,
      latestRelease: release,
      updateAvailable: isNewer && !isIgnored,
      isIgnored
    };
  });
}

/**
 * Get the current update status without checking GitHub.
 */
export async function getUpdateStatus() {
  const state = await loadState();
  const currentVersion = await getCurrentVersion();
  const isNewer = state.latestRelease
    ? compareSemver(state.latestRelease.version, currentVersion) > 0
    : false;
  const isIgnored = state.latestRelease
    ? state.ignoredVersions.includes(state.latestRelease.version)
    : false;

  return {
    currentVersion,
    ...state,
    updateAvailable: isNewer && !isIgnored
  };
}

/**
 * Add a version to the ignore list.
 */
export async function ignoreVersion(version) {
  return withLock(async () => {
    const state = await loadState();
    if (!state.ignoredVersions.includes(version)) {
      state.ignoredVersions.push(version);
      await saveState(state);
    }
    return state;
  });
}

/**
 * Clear all ignored versions.
 */
export async function clearIgnored() {
  return withLock(async () => {
    const state = await loadState();
    state.ignoredVersions = [];
    await saveState(state);
    return state;
  });
}

/**
 * Mark update as in progress or completed in state file.
 */
export async function setUpdateInProgress(inProgress) {
  return withLock(async () => {
    const state = await loadState();
    state.updateInProgress = inProgress;
    await saveState(state);
  });
}

/**
 * Record the result of an update attempt.
 */
export async function recordUpdateResult(result) {
  return withLock(async () => {
    const state = await loadState();
    state.updateInProgress = false;
    state.lastUpdateResult = result;
    await saveState(state);
  });
}

/**
 * Start the periodic update checker.
 */
export function startUpdateScheduler() {
  // Initial check after startup delay
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    checkForUpdate().catch(err => {
      console.warn(`⚠️ Update check failed: ${err.message}`);
    });
  }, STARTUP_DELAY_MS);

  // Periodic checks
  schedulerInterval = setInterval(() => {
    checkForUpdate().catch(err => {
      console.warn(`⚠️ Update check failed: ${err.message}`);
    });
  }, CHECK_INTERVAL_MS);

  console.log(`🔄 Update scheduler started (every ${CHECK_INTERVAL_MS / 60000}min)`);
}

/**
 * Stop the periodic update checker.
 */
export function stopUpdateScheduler() {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
