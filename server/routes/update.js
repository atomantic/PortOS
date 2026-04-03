import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as updateChecker from '../services/updateChecker.js';
import { executeUpdate } from '../services/updateExecutor.js';

const router = Router();

const ignoreSchema = z.object({
  version: z.string().min(1, 'version is required')
});

// GET /api/update/status — returns update state (also clears stale locks)
router.get('/status', asyncHandler(async (req, res) => {
  await updateChecker.clearStaleUpdateInProgress();
  const status = await updateChecker.getUpdateStatus();
  res.json(status);
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

// POST /api/update/execute — kicks off update
router.post('/execute', asyncHandler(async (req, res) => {
  const status = await updateChecker.getUpdateStatus();
  if (!status.latestRelease?.tag) {
    throw new ServerError('No release available to update to', { status: 400, code: 'NO_RELEASE' });
  }
  const tag = status.latestRelease.tag;

  // Validate tag is a well-formed semver release (e.g. "v1.27.0" or "v1.27.0-rc.1") to prevent option injection
  if (!/^v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(tag)) {
    throw new ServerError('Invalid release tag format', { status: 400, code: 'INVALID_TAG' });
  }

  // Atomic check-and-set: rejects if already in progress, preventing concurrent updates
  const acquired = await updateChecker.setUpdateInProgress(true);
  if (!acquired) {
    throw new ServerError('Update already in progress', { status: 409, code: 'UPDATE_IN_PROGRESS' });
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
  executeUpdate(tag, emit).then(result => {
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
