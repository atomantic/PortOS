import { writeFile, rename } from 'fs/promises';
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
  updateStartedAt: null,
  lastUpdateResult: null
});

/**
 * Read the current version from the root package.json.
 * Re-reads on each call so it picks up changes after updates.
 */
export async function getCurrentVersion() {
  const pkgPath = join(PATHS.root, 'package.json');
  const pkg = await readJSONFile(pkgPath, { version: '0.0.0' });
  const version = (typeof pkg.version === 'string' && pkg.version) ? pkg.version : '0.0.0';
  return version;
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareSemver(a, b) {
  const extractParts = (v) => {
    const [core, pre] = v.split('+')[0].split('-', 2);
    return { nums: core.split('.').map(Number), pre: pre || null };
  };
  const pa = extractParts(a);
  const pb = extractParts(b);
  for (let i = 0; i < 3; i++) {
    const na = pa.nums[i] || 0;
    const nb = pb.nums[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  // Equal core versions: no pre-release > pre-release (1.0.0 > 1.0.0-rc.1)
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

async function loadState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(UPDATE_FILE, defaultState());
  const defaults = defaultState();
  return {
    ...defaults,
    ...raw,
    ignoredVersions: Array.isArray(raw.ignoredVersions) ? raw.ignoredVersions : defaults.ignoredVersions,
    updateInProgress: typeof raw.updateInProgress === 'boolean' ? raw.updateInProgress : defaults.updateInProgress,
  };
}

async function saveState(state) {
  await ensureDir(PATHS.data);
  const tmpFile = `${UPDATE_FILE}.tmp`;
  await writeFile(tmpFile, JSON.stringify(state, null, 2) + '\n');
  await rename(tmpFile, UPDATE_FILE);
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
  const latestVersion =
    state.latestRelease && typeof state.latestRelease.version === 'string'
      ? state.latestRelease.version
      : null;
  const isNewer = latestVersion
    ? compareSemver(latestVersion, currentVersion) > 0
    : false;
  const isIgnored = latestVersion
    ? state.ignoredVersions.includes(latestVersion)
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
    state.updateStartedAt = inProgress ? new Date().toISOString() : null;
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
    state.updateStartedAt = null;
    state.lastUpdateResult = result;
    await saveState(state);
  });
}

const STALE_UPDATE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Clear stale updateInProgress flag on boot.
 * If the server was killed mid-update (before recordUpdateResult ran),
 * updateInProgress stays true and blocks future updates indefinitely.
 * This detects that condition via updateStartedAt age and clears it.
 */
export async function clearStaleUpdateInProgress() {
  return withLock(async () => {
    const state = await loadState();
    if (!state.updateInProgress) return false;

    const startedAtMs = state.updateStartedAt ? new Date(state.updateStartedAt).getTime() : NaN;
    const hasValidTimestamp = Number.isFinite(startedAtMs);
    const ageMs = hasValidTimestamp ? Date.now() - startedAtMs : null;

    // If no valid timestamp or older than timeout, treat as stale
    if (!hasValidTimestamp || ageMs > STALE_UPDATE_TIMEOUT_MS) {
      const ageStr = ageMs !== null ? `${Math.round(ageMs / 60000)}min` : 'unknown';
      console.log(`🧹 Clearing stale updateInProgress (started ${state.updateStartedAt ?? 'unknown'}, age ${ageStr})`);
      state.updateInProgress = false;
      state.updateStartedAt = null;
      state.lastUpdateResult = {
        version: state.latestRelease?.version ?? 'unknown',
        success: false,
        completedAt: new Date().toISOString(),
        log: 'Cleared stale update lock on boot — server was likely killed mid-update'
      };
      await saveState(state);
      return true;
    }

    return false;
  });
}

/**
 * Start the periodic update checker.
 */
export function startUpdateScheduler() {
  if (startupTimeout || schedulerInterval) return;

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
