import { join } from 'path';
import { EventEmitter } from 'events';
import { readJSONFile, PATHS, ensureDir, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPlainObject } from '../lib/objects.js';
import { getOriginInfo, UPSTREAM_OWNER, UPSTREAM_REPO, UPSTREAM_FULL_NAME } from '../lib/gitRemote.js';
import { execGh } from './github.js';

const UPDATE_FILE = join(PATHS.data, 'update.json');
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 10 * 1000; // 10 seconds

/**
 * How long a `lastForkSync` record counts as "fresh enough" to skip the
 * fork-sync gate on /api/update/execute. Exported so the route + UI agree on
 * a single number — the UI doesn't need to re-implement the time math; it
 * reads `status.forkSyncFresh` directly.
 */
export const FORK_SYNC_FRESHNESS_MS = 10 * 60 * 1000;

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
  lastUpdateResult: null,
  lastForkSync: null
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
    const noBuild = v.split('+')[0];
    const hyphenIdx = noBuild.indexOf('-');
    const core = hyphenIdx === -1 ? noBuild : noBuild.slice(0, hyphenIdx);
    const pre = hyphenIdx === -1 ? null : noBuild.slice(hyphenIdx + 1);
    return { nums: core.split('.').map(Number), pre: pre || null };
  };
  const comparePreRelease = (preA, preB) => {
    const segsA = preA.split('.');
    const segsB = preB.split('.');
    const len = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < len; i++) {
      if (i >= segsA.length) return -1; // fewer segments = lower precedence
      if (i >= segsB.length) return 1;
      const numA = /^\d+$/.test(segsA[i]) ? Number(segsA[i]) : null;
      const numB = /^\d+$/.test(segsB[i]) ? Number(segsB[i]) : null;
      // Numeric identifiers sort before string identifiers
      if (numA !== null && numB !== null) {
        if (numA < numB) return -1;
        if (numA > numB) return 1;
      } else if (numA !== null) {
        return -1;
      } else if (numB !== null) {
        return 1;
      } else {
        if (segsA[i] < segsB[i]) return -1;
        if (segsA[i] > segsB[i]) return 1;
      }
    }
    return 0;
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
  if (pa.pre && pb.pre) return comparePreRelease(pa.pre, pb.pre);
  return 0;
}

async function loadState() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(UPDATE_FILE, defaultState(), { allowArray: false });
  const defaults = defaultState();
  const stateFromFile = isPlainObject(raw) ? raw : {};
  return {
    ...defaults,
    ...stateFromFile,
    ignoredVersions: Array.isArray(stateFromFile.ignoredVersions) ? stateFromFile.ignoredVersions : defaults.ignoredVersions,
    updateInProgress: typeof stateFromFile.updateInProgress === 'boolean' ? stateFromFile.updateInProgress : defaults.updateInProgress,
  };
}

async function saveState(state) {
  await ensureDir(PATHS.data);
  await atomicWrite(UPDATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Inspect the local git origin remote and return its classification.
 * Pure read — never mutates state.
 */
export async function getRemoteInfo() {
  return getOriginInfo();
}

/**
 * Sync the user's GitHub fork from the upstream atomantic/PortOS repo via
 * `gh repo sync owner/fork`. Default fast-forward only — `gh` refuses to
 * overwrite divergent fork history unless `--force` is passed, so this is
 * non-destructive by design.
 *
 * Returns { synced, alreadyUpToDate, fullName, source, mergedBranch, message }.
 *
 * Error handling — by layer:
 *   - This function throws plain `Error` for pre-flight refusals (no origin,
 *     not GitHub, already upstream, not a fork).
 *   - `execGh` rejections (gh CLI failure including the diverged-fork case)
 *     bubble up unchanged.
 *   - The /api/update/sync-fork route runs an upfront 400 gate against the
 *     same conditions (NO_ORIGIN / NOT_GITHUB / ALREADY_UPSTREAM / NOT_A_FORK)
 *     so the pre-flight throws above are defense-in-depth and would normally
 *     be unreachable from the route. The route only string-matches `err.message`
 *     to distinguish the gh diverged-fork case (409 FORK_DIVERGED) from other
 *     gh failures (502 FORK_SYNC_FAILED).
 */
export async function syncFork({ branch, remoteInfo } = {}) {
  // Accept a pre-fetched remoteInfo from the route so we don't spawn `git
  // remote get-url origin` twice per /sync-fork call (and so a TOCTOU race
  // between the route's gate and ours can't surface as confusing messaging).
  const info = remoteInfo || await getRemoteInfo();
  if (!info.hasOrigin) {
    throw new Error('No git origin remote — cannot sync fork.');
  }
  if (!info.isGithub) {
    throw new Error(`Origin remote is not on GitHub (host: ${info.host || 'unknown'}). Fork sync is GitHub-only.`);
  }
  if (info.isUpstream) {
    throw new Error(`Origin is already the upstream ${UPSTREAM_FULL_NAME} — nothing to sync.`);
  }
  if (!info.isFork) {
    // Catches a GitHub remote that points at a repo with a different name
    // (e.g. someone forked-and-renamed). `gh repo sync` would fail with a
    // confusing 502; surface a clear refusal instead.
    throw new Error(
      `Origin ${info.fullName} is not a fork of ${UPSTREAM_FULL_NAME} ` +
      `(repo name differs). Fork sync requires the origin to be a GitHub fork named "${UPSTREAM_REPO}".`
    );
  }

  const targetBranch = branch || 'main';
  const args = ['repo', 'sync', info.fullName, '--source', UPSTREAM_FULL_NAME, '--branch', targetBranch];
  const stdout = await execGh(args);

  // `gh repo sync` prints e.g. "✓ Synced the "main" branch from atomantic/PortOS to owner/PortOS"
  // or "✓ Repository is up to date with atomantic/PortOS"
  const alreadyUpToDate = /up to date/i.test(stdout);

  await withLock(async () => {
    const state = await loadState();
    state.lastForkSync = {
      fullName: info.fullName,
      source: UPSTREAM_FULL_NAME,
      branch: targetBranch,
      alreadyUpToDate,
      syncedAt: new Date().toISOString(),
      message: stdout.trim()
    };
    await saveState(state);
  });

  return {
    synced: true,
    alreadyUpToDate,
    fullName: info.fullName,
    source: UPSTREAM_FULL_NAME,
    mergedBranch: targetBranch,
    message: stdout.trim()
  };
}

/**
 * Check GitHub for the latest release and compare to current version.
 * Always polls the upstream atomantic/PortOS releases so users running
 * from a fork still see upstream version availability. Pull/checkout
 * behavior is unchanged — update.sh still pulls from origin.
 */
export async function checkForUpdate() {
  return withLock(async () => {
    const state = await loadState();
    const currentVersion = await getCurrentVersion();

    const raw = await execGh(['api', `repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/releases/latest`]);
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
 * Includes `remoteInfo` so the UI can render fork-aware messaging.
 * Remote inspection is best-effort — a failure (no git, no origin, etc.)
 * never blocks the status response.
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
  const remoteInfo = await getRemoteInfo().catch(() => null);

  // Single source of truth for the freshness check — the UI reads this
  // directly instead of re-implementing the time math + fullName match.
  // GitHub owner/repo names are case-insensitive, so the fullName match
  // must be too (otherwise a remote like `ALICE/PortOS` vs a stored
  // `alice/PortOS` falsely flips this to false).
  const lastSync = state.lastForkSync;
  const forkSyncFresh = !!(
    lastSync &&
    remoteInfo?.fullName &&
    typeof lastSync.fullName === 'string' &&
    lastSync.fullName.toLowerCase() === remoteInfo.fullName.toLowerCase() &&
    (Date.now() - new Date(lastSync.syncedAt).getTime()) < FORK_SYNC_FRESHNESS_MS
  );

  return {
    currentVersion,
    ...state,
    updateAvailable: isNewer && !isIgnored,
    remoteInfo,
    upstream: { owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO, fullName: UPSTREAM_FULL_NAME },
    forkSyncFresh,
    forkSyncWindowMs: FORK_SYNC_FRESHNESS_MS
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
 * When setting to true, atomically rejects if already in progress (returns false).
 * Returns true if the flag was set successfully.
 */
export async function setUpdateInProgress(inProgress) {
  return withLock(async () => {
    const state = await loadState();
    if (inProgress && state.updateInProgress) return false;
    state.updateInProgress = inProgress;
    state.updateStartedAt = inProgress ? new Date().toISOString() : null;
    await saveState(state);
    return true;
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
