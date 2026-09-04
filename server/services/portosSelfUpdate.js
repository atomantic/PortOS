/**
 * The single launcher for PortOS's own update.sh / update.ps1.
 *
 * Two surfaces start a PortOS self-update — the Update page
 * (`POST /api/update/execute`) and App Management's Git tab (the `app:update`
 * socket handler for the PortOS app record) — and they used to carry two
 * different implementations of the same lifecycle. The Update page's version
 * was the correct one, so it is the one that lives here and both callers now
 * share it:
 *
 *   1. Refuse the update (preflight) before touching anything.
 *   2. Resolve the release tag the run is labelled with.
 *   3. Take the atomic `updateInProgress` lock, then re-check the guards that
 *      could have gone live during step 1-2's awaits.
 *   4. Launch `executeUpdate` and RETURN — never await it.
 *
 * Step 4 is the whole point. `update.sh` deletes this server's PM2 entries
 * partway through, so the process that launched it is killed long before the
 * script reaches its closing `pm2 start`. `executeUpdate`'s double-fork keeps
 * the SCRIPT alive across that (see `server/lib/detachedSpawn.js`), but nothing
 * can keep the awaiting caller alive — so a caller that awaits it simply never
 * runs its own completion code, and any UI waiting on that completion hangs on
 * "Stopping apps..." forever even though the install came back fine. The
 * client side of the contract is `usePortosRestartWatch`, which watches the
 * step stream and the health endpoint rather than a completion event.
 */

import { ServerError } from '../lib/errorHandler.js';
import { withStateLock } from './cosState.js';
import { executeUpdate } from './updateExecutor.js';
import * as updateChecker from './updateChecker.js';
import {
  agentsActiveError,
  checkPortosUpdatePreflight,
  countActiveCosAgents,
  getPersistentMindImageWorkGuard,
  persistentMindImageWorkError,
  persistentMindStateUntrustedError,
} from './updatePreflight.js';

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
 * Refuse, lock, and launch a PortOS self-update. Resolves as soon as the
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
 *   every dep receipt for an answer already given. The post-lock re-check below
 *   is the authoritative one either way.
 * @param {'release'|'reconcile'|'refresh'} [options.mode]
 * @param {(step: string, status: string, message: string) => void} [options.onStep]
 *   Extra progress sink, for a caller with its own step stream.
 * @returns {Promise<{started: true, tag: string}>}
 */
export async function startPortosSelfUpdate({
  io,
  acknowledgeFork = false,
  acknowledgePersistentMindImageBackup = false,
  preflightAlreadyRun = false,
  mode = 'release',
  onStep,
} = {}) {
  // Never restart PortOS out from under a live CoS agent, in-flight Persistent
  // Mind image work, or an unacknowledged fork. Fast-fail before the lock so
  // every mode is covered before doing the work below; the post-lock re-check
  // closes the window an agent could start in during it. The status is re-read
  // even when the guards are skipped: a caller that already ran them did so
  // before advancing the checkout, so its snapshot predates the pull whose
  // stale workspaces this run has to clean.
  const status = preflightAlreadyRun
    ? await updateChecker.getUpdateStatus()
    : await checkPortosUpdatePreflight({ acknowledgeFork, acknowledgePersistentMindImageBackup });

  assertCanRun(status, mode);
  const tag = resolveTag(status, mode);
  if (!TAG_PATTERN.test(tag)) {
    throw new ServerError('Invalid release tag format', { status: 400, code: 'INVALID_TAG' });
  }

  // Atomic check-and-set: rejects if already in progress, preventing concurrent
  // updates. Holding it is also what keeps CoS agent spawns off a process
  // update.sh is about to `pm2 delete` (#4124) — `subAgentSpawner`,
  // `agentLifecycle` and `persistentMindSupervisor` all gate on it.
  const acquired = await updateChecker.setUpdateInProgress(true);
  if (!acquired) {
    throw new ServerError('Update already in progress', { status: 409, code: 'UPDATE_IN_PROGRESS' });
  }

  // Re-check after acquiring the lock: an agent (e.g. a scheduled/autopilot
  // spawn) may have started live during the awaits above. If so, release the
  // lock and reject rather than restart out from under it. A spawn that begins
  // AFTER this, during update.sh itself, is closed from the spawn side by the
  // lock we just took.
  const postLock = await countActiveCosAgents();
  if (postLock > 0) {
    await updateChecker.setUpdateInProgress(false);
    throw agentsActiveError(postLock);
  }
  const postLockImageCheck = await withStateLock(() => getPersistentMindImageWorkGuard()).catch(async (error) => {
    await updateChecker.setUpdateInProgress(false);
    throw error;
  });
  if (!postLockImageCheck.trusted || (!postLockImageCheck.safe && !acknowledgePersistentMindImageBackup)) {
    await updateChecker.setUpdateInProgress(false);
    if (!postLockImageCheck.trusted) throw persistentMindStateUntrustedError();
    throw persistentMindImageWorkError(postLockImageCheck);
  }

  const emit = (step, stepStatus, message) => {
    if (io) {
      io.emit('portos:update:step', { step, status: stepStatus, message, timestamp: Date.now() });
    }
    onStep?.(step, stepStatus, message);
  };

  const forceCleanWorkspaces = mode === 'release' ? undefined : forceCleanWorkspacesFor(status);

  // `executeUpdate` is two phases behind one promise: a LAUNCH (the
  // still-running guard, then the double-fork spawn) that can refuse or throw,
  // and then the script's whole lifetime. Only the second is fire-and-forget.
  // Reporting `started: true` for a script that never spawned is what would
  // leave a caller waiting for a restart that is not coming — and on the App
  // Management path it also leaves the operation registered forever, since that
  // handler deliberately skips its cleanup for a real handoff, so every later
  // update is then refused as a duplicate. So hold the return until the spawn.
  let launchedFlag = false;
  let markLaunched;
  const launched = new Promise((resolve) => {
    markLaunched = () => { launchedFlag = true; resolve(); };
  });

  // The script writes the true post-update version to data/update-complete.json,
  // which the server reads on boot, so `tag` is only the label this launch is
  // reported under.
  const run = executeUpdate(tag, emit, { forceCleanWorkspaces, onLaunched: markLaunched });

  run.then(result => {
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
      io.emit('portos:update:error', { message: result.errorMessage ?? 'Update failed', step: result.failedStep ?? 'unknown' });
    }
  }).catch(async err => {
    console.error(`❌ Update launch failed for ${tag}: ${err.message}`);
    io?.emit('portos:update:error', { message: err.message, step: 'unknown' });
    // A rejection means executeUpdate never reached `recordUpdateResult`, which
    // is what normally clears the lock on both its resolved outcomes. Without
    // this release the lock stays set until the 30-minute stale timeout —
    // wedging every later update at 409 UPDATE_IN_PROGRESS and blocking every
    // CoS agent spawn in the meantime (issue #6036).
    await updateChecker.setUpdateInProgress(false).catch(releaseErr => {
      console.error(`❌ Failed to release update lock after launch failure: ${releaseErr.message}`);
    });
  });

  // Settling before the launch signal means the LAUNCH failed: the
  // still-running guard refused (a resolved `success: false`) or the spawn threw
  // (a rejection). Both are the caller's to report. After the signal this
  // resolves regardless — a script that fails later is the fire-and-forget
  // handler's business, and re-throwing it here would be an unhandled rejection
  // (fatal on Node >= 15) because the race below has already settled.
  const launchFailure = run.then(
    (result) => {
      if (!launchedFlag && !result.success) {
        throw new ServerError(result.errorMessage || 'PortOS update failed to launch',
          { status: 409, code: 'UPDATE_LAUNCH_FAILED' });
      }
    },
    (err) => { if (!launchedFlag) throw err; },
  );
  await Promise.race([launched, launchFailure]);

  return { started: true, tag };
}
