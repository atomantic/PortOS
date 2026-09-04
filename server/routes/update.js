import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { UPSTREAM_FULL_NAME } from '../lib/gitRemote.js';
import * as updateChecker from '../services/updateChecker.js';
import { startPortosSelfUpdate } from '../services/portosSelfUpdate.js';
import {
  countActiveCosAgents,
  getPersistentMindImageWorkGuard,
} from '../services/updatePreflight.js';

const router = Router();

const ignoreSchema = z.object({
  version: z.string().min(1, 'version is required')
});

const syncForkSchema = z.object({
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/, 'branch contains invalid characters').optional()
});

const executeSchema = z.object({
  acknowledgeFork: z.boolean().optional(),
  acknowledgePersistentMindImageBackup: z.boolean().optional(),
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
  const [status, persistentMindImages, activeCosAgents] = await Promise.all([
    updateChecker.getUpdateStatus(),
    getPersistentMindImageWorkGuard(),
    countActiveCosAgents(),
  ]);
  res.json({ ...status, activeCosAgents, persistentMindImages });
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
  const { acknowledgeFork, acknowledgePersistentMindImageBackup, reconcile } = validateRequest(executeSchema, req.body || {});

  // Every refusal, the update lock, and the fire-and-forget launch live in
  // `portosSelfUpdate` — shared with App Management's Git tab so both entry
  // points into update.sh behave identically (#5984, and the Git tab hang the
  // shared launcher was extracted to fix).
  const { started, tag } = await startPortosSelfUpdate({
    io: req.app.get('io'),
    acknowledgeFork,
    acknowledgePersistentMindImageBackup,
    mode: reconcile ? 'reconcile' : 'release',
  });

  res.json({ started, tag });
}));

export default router;
