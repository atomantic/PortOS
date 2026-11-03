/** Shared authenticated launcher; the script supervisor owns deferred admission. */
import { ServerError } from '../lib/errorHandler.js';
import { createMutex } from '../lib/asyncMutex.js';
import { launchUpdate } from './updateExecutor.js';
import * as updateChecker from './updateChecker.js';
import { checkManualUpdateActivity, checkPortosUpdatePreflight } from './updatePreflight.js';

const withLaunch = createMutex();

// Well-formed semver release tag (e.g. "v1.27.0" or "v1.27.0-rc.1"). The tag
// reaches a shell script, so anything option-shaped is refused outright.
const TAG_PATTERN = /^v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

/**
 * Which run this is, and therefore what the caller is allowed to launch:
 *
 * - `release`   — update TO a newer GitHub release. Requires a known release tag.
 * - `reconcile` — finish a half-updated install (issue #1779): run update.sh
 *                 even with no newer release. Gated on the install ACTUALLY
 *                 being out of sync, so a cached release tag can't force
 *                 update.sh onto an install that has nothing to do.
 * - `refresh`   — run the lifecycle over whatever is on disk NOW. For a caller
 *                 that has already advanced the checkout itself: the state a
 *                 reconcile's gate looks for is the state that caller just
 *                 created, so re-checking it would only ask whether its own
 *                 pull happened.
 *
 * Refusals only; the tag comes from `resolveTag` below.
 */
function assertCanRun(status, mode) {
  if (mode === 'release' && !status.latestRelease?.tag) {
    throw new ServerError('No release available to update to', { status: 400, code: 'NO_RELEASE' });
  }
  if (mode !== 'reconcile') return;
  if (!status.installState) {
    // installState is best-effort (.catch(() => null) in getUpdateStatus); a
    // transient git/fs hiccup shouldn't read as "already in sync".
    throw new ServerError('Could not determine install state — try again', { status: 503, code: 'INSTALL_STATE_UNAVAILABLE' });
  }
  if (!status.installState.outOfSync) {
    throw new ServerError('Install is already in sync — nothing to reconcile', { status: 400, code: 'ALREADY_IN_SYNC' });
  }
}

/**
 * The tag this run is labelled with. update.sh pulls the default branch
 * regardless of it, so outside `release` it is purely what the run is logged
 * and reported under.
 */
function resolveTag(status, mode) {
  return mode === 'release' ? status.latestRelease.tag : `v${status.currentVersion}`;
}

/**
 * Workspaces whose installed deps are stale per installState's receipt check.
 *
 * update.sh decides what to reinstall from the commit diff its OWN `git pull`
 * produced — so when HEAD already advanced before the script ran, that diff is
 * empty and the stale node_modules survive the update (#1779). Naming the
 * workspaces here forces a from-scratch reinstall of exactly those. 'root' maps
 * to update.sh's '.' token.
 */
function forceCleanWorkspacesFor(status) {
  return (status.installState?.staleDeps?.workspaces || [])
    .filter(w => w.stale)
    .map(w => (w.name === 'root' ? '.' : w.name));
}

/**
 * Validate and launch a deferred PortOS self-update. Resolves as soon as the
 * detached script is running — NOT when the update finishes.
 *
 * @param {object} options
 * @param {object} [options.io] - Socket.IO server for `portos:update:*` frames.
 *   Omit on a caller that renders the run from `onStep` alone — mirroring the
 *   whole stream onto both channels doubles the fan-out for no new reader.
 * @param {boolean} [options.acknowledgeFork]
 * @param {boolean} [options.acknowledgePersistentMindImageBackup]
 * @param {boolean} [options.preflightAlreadyRun] - the caller ran
 *   `checkPortosUpdatePreflight` itself (to refuse BEFORE touching the checkout,
 *   and to report the refusal code its UI offers an acknowledgement for), so
 *   re-running the guards here would re-read the whole CoS state and re-walk
 *   every dep receipt for an answer already given. The script rechecks image
 *   state after acquiring the shared maintenance hold.
 * @param {'release'|'reconcile'|'refresh'} [options.mode]
 * @param {(step: string, status: string, message: string) => void} [options.onStep]
 *   Extra progress sink, for a caller with its own step stream.
 * @returns {Promise<{started: true, tag: string}>}
 */
async function startSelfUpdate({
  io,
  acknowledgeFork = false,
  acknowledgePersistentMindImageBackup = false,
  preflightAlreadyRun = false,
  mode = 'release',
  onStep,
  peerExecution,
  automatic = false,
  acknowledgeInterruption = false,
} = {}) {
  // The Git-tab caller already advanced HEAD; read its new install state.
  // Activity is deferred by the script, not blocked here by a process-local flag.
  const status = preflightAlreadyRun
    ? await updateChecker.getUpdateStatus()
    : await checkPortosUpdatePreflight({ acknowledgeFork, acknowledgePersistentMindImageBackup, acknowledgeInterruption, deferActivity: true });

  assertCanRun(status, mode);
  const tag = resolveTag(status, mode);
  if (!TAG_PATTERN.test(tag)) {
    throw new ServerError('Invalid release tag format', { status: 400, code: 'INVALID_TAG' });
  }
  if (!peerExecution && !preflightAlreadyRun) await checkManualUpdateActivity({ automatic, acknowledgeInterruption });

  const emit = (step, stepStatus, message) => {
    if (io) {
      io.emit('portos:update:step', { step, status: stepStatus, message, timestamp: Date.now() });
    }
    onStep?.(step, stepStatus, message);
  };

  const forceCleanWorkspaces = mode === 'release' ? undefined : forceCleanWorkspacesFor(status);

  const reportFailure = (err) => {
    console.error(`❌ Update launch failed for ${tag}: ${err.message}`);
    io?.emit('portos:update:error', { message: err.message, step: 'unknown' });
  };
  const launch = await launchUpdate(tag, emit, { forceCleanWorkspaces, ...(automatic ? { automatic } : {}), ...(acknowledgeInterruption ? { acknowledgeInterruption } : {}), ...(acknowledgePersistentMindImageBackup ? { acknowledgePersistentMindImageBackup } : {}), ...(peerExecution ? { peerExecution } : {}) }).catch(err => {
    reportFailure(err);
    throw err;
  });
  if (!launch.started) {
    const result = launch.result;
    io?.emit('portos:update:error', { message: result.errorMessage ?? 'Update failed', step: result.failedStep ?? 'unknown' });
    throw new ServerError(result.errorMessage || 'PortOS update failed to launch',
      { status: 409, code: result.errorCode || 'UPDATE_LAUNCH_FAILED' });
  }

  // Observe the lifetime without awaiting it: the script normally kills this
  // server at pm2-stop, then the restarted server reads its completion marker.
  launch.completion.then(result => {
    if (result.superseded) return;
    // May never fire: update.sh's PM2 delete usually kills this process first.
    // The client polls /api/system/health instead of relying on it.
    if (!io) return;
    if (result.success) {
      io.emit('portos:update:complete', {
        success: true,
        newVersion: result.version || tag.replace(/^v/, ''),
        versionKnown: !!result.version,
      });
    } else {
      io.emit('portos:update:error', { message: result.errorMessage ?? 'Update failed', step: result.failedStep ?? 'unknown', ...(result.errorCode ? { code: result.errorCode } : {}) });
    }
  }).catch(reportFailure);

  const result = { started: true, tag };
  Object.defineProperties(result, {
    supervisorPid: { value: launch.supervisorPid }, completed: { value: launch.completed === true },
    completion: { value: launch.completion },
  });
  return result;
}

export function startPortosSelfUpdate(options) {
  return withLaunch(() => startSelfUpdate(options));
}
