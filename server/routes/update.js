import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { UPSTREAM_FULL_NAME } from '../lib/gitRemote.js';
import * as updateChecker from '../services/updateChecker.js';
import { executeUpdate } from '../services/updateExecutor.js';
import { getActiveAgentIds, spawningTasks } from '../services/agentState.js';

const router = Router();

// Count CoS agents a PortOS restart (update.sh → pm2 restart) would disrupt:
// live processes (direct + runner spawns) PLUS any task mid-spawn. During a
// spawn the task sits in `spawningTasks` while its child process is created and
// only THEN registered in the process maps (`withSpawnDedupGuard` holds the set
// across the whole launch) — so an agent that has already spawned a process but
// not yet registered it is invisible to getActiveAgentIds() alone. Summing both
// includes every distinct in-flight task in the count (a live agent plus two
// spawning tasks reads as 3, not 1). It can transiently over-report by 1 during
// the sub-second overlap where a single launching agent sits in BOTH sets, but
// the guard only needs `> 0` and the count is a near-exact upper bound shown in
// an advisory notice — an occasional +1 mid-launch is preferable to dropping
// the spawning tasks entirely.
//
// This still can't close the window where a NEW spawn begins AFTER a caller
// reads this but before update.sh's pm2 restart. The route's post-lock re-check
// below narrows it; fully closing it needs every CoS spawn engine to consult
// updateInProgress (tracked in PLAN.md) — the orphan reaper bounds the residual.
function countActiveCosAgents() {
  return getActiveAgentIds().length + spawningTasks.size;
}

// The 409 the update flow raises when a restart would sever a live/spawning
// agent — shared by the fast-fail pre-check and the post-lock re-check.
function agentsActiveError(n) {
  return new ServerError(
    `${n} CoS agent${n === 1 ? ' is' : 's are'} running — updating would restart PortOS and ` +
    `sever ${n === 1 ? 'it' : 'them'}. Pause or wait for the agent${n === 1 ? '' : 's'} to finish, then update.`,
    { status: 409, code: 'AGENTS_ACTIVE' }
  );
}

const ignoreSchema = z.object({
  version: z.string().min(1, 'version is required')
});

const syncForkSchema = z.object({
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/, 'branch contains invalid characters').optional()
});

const executeSchema = z.object({
  acknowledgeFork: z.boolean().optional(),
  // Reconcile a half-updated install (issue #1779): run update.sh to pull +
  // install + build + restart even when there's no NEWER GitHub release — the
  // user did a bare `git pull` and just needs the rest of the update steps.
  reconcile: z.boolean().optional()
});

// GET /api/update/status — returns update state (also clears stale locks).
// `activeCosAgents` counts live CoS agent processes (direct + runner spawns) so
// the UI can suppress the reconcile/update actions while an agent is in flight —
// updating restarts PortOS and would sever those live processes (issue: don't
// restart out from under a running agent).
router.get('/status', asyncHandler(async (req, res) => {
  await updateChecker.clearStaleUpdateInProgress();
  const status = await updateChecker.getUpdateStatus();
  res.json({ ...status, activeCosAgents: countActiveCosAgents() });
}));

// POST /api/update/check — triggers manual check
router.post('/check', asyncHandler(async (req, res) => {
  const result = await updateChecker.checkForUpdate();
  res.json(result);
}));

// POST /api/update/ignore — adds version to ignored list
router.post('/ignore', asyncHandler(async (req, res) => {
  const { version } = validateRequest(ignoreSchema, req.body);
  await updateChecker.ignoreVersion(version.replace(/^v/, ''));
  const status = await updateChecker.getUpdateStatus();
  res.json(status);
}));

// DELETE /api/update/ignore — clears all ignored versions
router.delete('/ignore', asyncHandler(async (req, res) => {
  await updateChecker.clearIgnored();
  const status = await updateChecker.getUpdateStatus();
  res.json(status);
}));

// POST /api/update/sync-fork — fast-forward the user's GitHub fork from upstream
// via `gh repo sync`. Non-destructive: gh refuses to overwrite divergent fork
// history without --force, so a 409 FORK_DIVERGED here means the fork's main has
// commits not on upstream (user customizations). Other failures (gh missing,
// network, etc.) bubble as 502 FORK_SYNC_FAILED.
router.post('/sync-fork', asyncHandler(async (req, res) => {
  const { branch } = validateRequest(syncForkSchema, req.body || {});
  // Surface git-binary/spawn failures as a structured 502 instead of an
  // unclassified 500 — the UI banner relies on err.message for guidance.
  const info = await updateChecker.getRemoteInfo().catch(err => {
    throw new ServerError(`Could not inspect git origin remote: ${err.message}`,
      { status: 502, code: 'GIT_UNAVAILABLE' });
  });
  if (!info?.hasOrigin) {
    throw new ServerError('No git origin remote found — fork sync requires a GitHub remote.',
      { status: 400, code: 'NO_ORIGIN' });
  }
  if (!info.isGithub) {
    throw new ServerError('Origin remote is not on GitHub — fork sync is GitHub-only.',
      { status: 400, code: 'NOT_GITHUB' });
  }
  if (info.isUpstream) {
    throw new ServerError(`Origin is already the upstream ${UPSTREAM_FULL_NAME} — nothing to sync.`,
      { status: 400, code: 'ALREADY_UPSTREAM' });
  }
  if (!info.isFork) {
    throw new ServerError(
      `Origin ${info.fullName} is not a fork of ${UPSTREAM_FULL_NAME} (repo name differs). ` +
      `Fork sync requires the origin to be a GitHub fork.`,
      { status: 400, code: 'NOT_A_FORK' }
    );
  }

  // Default mirrors syncFork()'s internal default so error messaging matches
  // the actual branch the gh call targeted.
  const targetBranch = branch || 'main';
  const result = await updateChecker.syncFork({ branch, remoteInfo: info }).catch(err => {
    const msg = err.message || 'Fork sync failed';
    // gh's "would not be a fast forward" / "diverged" error → 409 so client
    // can show the "you have local customizations" guidance
    if (/fast forward|diverge|non-fast/i.test(msg)) {
      throw new ServerError(
        `Fork sync would overwrite commits on ${info.fullName}'s ${targetBranch} branch (GitHub): ${msg}. ` +
        `Move customizations to a feature branch, PR them upstream, or run ` +
        `\`gh repo sync ${info.fullName} --branch ${targetBranch} --force\` from a terminal if you want to discard them.`,
        { status: 409, code: 'FORK_DIVERGED' }
      );
    }
    throw new ServerError(msg, { status: 502, code: 'FORK_SYNC_FAILED' });
  });

  res.json(result);
}));

// POST /api/update/execute — kicks off update
router.post('/execute', asyncHandler(async (req, res) => {
  const { acknowledgeFork, reconcile } = validateRequest(executeSchema, req.body || {});

  // Never restart PortOS out from under a live CoS agent. Both a normal update
  // and a reconcile run update.sh, which pm2-restarts THIS server process and
  // severs any in-flight agent (each agent's PTY/child process is a child of it).
  // countActiveCosAgents() reflects exactly what a restart would kill — live
  // processes plus in-flight spawns — so a stale persisted `status: 'running'`
  // on disk can't spuriously block, and a paused agent (its process already
  // stopped) correctly doesn't. Fast-fail here so it covers reconcile, normal
  // update, and both fork variants (all funnel through /execute) before doing
  // the git/fork work below; a second re-check after the lock closes the window
  // an agent could start in during that work.
  const preCheck = countActiveCosAgents();
  if (preCheck > 0) throw agentsActiveError(preCheck);

  const status = await updateChecker.getUpdateStatus();

  // Two distinct entry points:
  //   - Normal update: requires a known, newer release tag to update TO.
  //   - Reconcile (issue #1779): finishes a bare `git pull` by running update.sh
  //     even with no newer release. It must be gated on the install ACTUALLY
  //     being out of sync — branch on `reconcile` first so a cached release tag
  //     can't let `reconcile: true` force update.sh on an in-sync install (or
  //     target a stale release). update.sh pulls main regardless of the tag, so
  //     the tag here is purely for logging; prefer the current version.
  let tag;
  if (reconcile) {
    if (!status.installState) {
      // installState is best-effort (.catch(() => null) in getUpdateStatus); a
      // transient git/fs hiccup shouldn't read as "already in sync".
      throw new ServerError('Could not determine install state — try again', { status: 503, code: 'INSTALL_STATE_UNAVAILABLE' });
    }
    if (!status.installState.outOfSync) {
      throw new ServerError('Install is already in sync — nothing to reconcile', { status: 400, code: 'ALREADY_IN_SYNC' });
    }
    tag = `v${status.currentVersion}`;
  } else {
    if (!status.latestRelease?.tag) {
      throw new ServerError('No release available to update to', { status: 400, code: 'NO_RELEASE' });
    }
    tag = status.latestRelease.tag;
  }

  // Validate tag is a well-formed semver release (e.g. "v1.27.0" or "v1.27.0-rc.1") to prevent option injection
  if (!/^v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(tag)) {
    throw new ServerError('Invalid release tag format', { status: 400, code: 'INVALID_TAG' });
  }

  // Fork gate: update.sh pulls from origin, so running from an unsynced fork
  // would silently no-op (or pull a stale version). Require either a recent
  // fork sync of the upstream branch or an explicit acknowledgement that the
  // user knows they're updating from their own origin.
  const remote = status.remoteInfo;
  if (remote?.isFork && !acknowledgeFork) {
    // Reuse the freshness boolean the service already computed so the route
    // and `status.forkSyncFresh` agree by construction (no duplicate math).
    if (!status.forkSyncFresh) {
      throw new ServerError(
        `Running from a fork (${remote.fullName}). Sync your fork from ${status.upstream.fullName} ` +
        `first, or re-submit with acknowledgeFork: true to update from your fork's origin as-is.`,
        { status: 412, code: 'FORK_SYNC_REQUIRED' }
      );
    }
  }

  // Atomic check-and-set: rejects if already in progress, preventing concurrent updates
  const acquired = await updateChecker.setUpdateInProgress(true);
  if (!acquired) {
    throw new ServerError('Update already in progress', { status: 409, code: 'UPDATE_IN_PROGRESS' });
  }

  // Re-check after acquiring the lock: an agent (e.g. a scheduled/autopilot
  // spawn) may have started live during the git/fork awaits between the
  // fast-fail pre-check and here. If so, release the lock and reject rather than
  // restart out from under it. A spawn that begins AFTER this, during update.sh
  // itself, is the residual the PLAN.md spawn-engine gate will close.
  const postLock = countActiveCosAgents();
  if (postLock > 0) {
    await updateChecker.setUpdateInProgress(false);
    throw agentsActiveError(postLock);
  }

  const io = req.app.get('io');

  // Start update in background, stream progress via socket
  const emit = (step, stepStatus, message) => {
    if (io) {
      io.emit('portos:update:step', { step, status: stepStatus, message, timestamp: Date.now() });
    }
  };

  // Don't await — respond immediately, progress streams via socket.
  // The update script runs `git pull --rebase` to get the latest code,
  // so the actual post-update version may differ from `tag` if new commits
  // landed after the release. The script writes the true version to
  // data/update-complete.json, which the server reads on boot.
  //
  // For a reconcile, hand the updater the workspaces whose installed deps are
  // stale (per installState's receipt check) so it force-reinstalls exactly
  // those — a bare `git pull` (possibly already restarted) leaves the scripts'
  // commit-diff dependency detection empty. 'root' maps to update.sh's '.' token.
  const forceCleanWorkspaces = reconcile
    ? (status.installState.staleDeps?.workspaces || [])
        .filter(w => w.stale)
        .map(w => (w.name === 'root' ? '.' : w.name))
    : undefined;
  executeUpdate(tag, emit, { forceCleanWorkspaces }).then(result => {
    // Note: this .then() may never fire if the update script's PM2 restart
    // kills this server process first. The client handles this by polling
    // /api/system/health after receiving the 'restart' step.
    if (io) {
      if (result.success) {
        io.emit('portos:update:complete', { success: true, newVersion: result.version || tag.replace(/^v/, ''), versionKnown: !!result.version });
      } else {
        io.emit('portos:update:error', { message: result.errorMessage ?? 'Update failed', step: result.failedStep ?? 'unknown' });
      }
    }
  }).catch(err => {
    if (io) {
      io.emit('portos:update:error', { message: err.message, step: 'unknown' });
    }
  });

  res.json({ started: true, tag });
}));

export default router;
