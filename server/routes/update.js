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

// GET /api/update/status — returns update state
router.get('/status', asyncHandler(async (req, res) => {
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
  await updateChecker.ignoreVersion(version);
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
  if (status.updateInProgress) {
    throw new ServerError('Update already in progress', { status: 409, code: 'UPDATE_IN_PROGRESS' });
  }

  const tag = status.latestRelease.tag;

  // Validate tag is a well-formed semver release (e.g. "v1.27.0") to prevent option injection
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new ServerError('Invalid release tag format', { status: 400, code: 'INVALID_TAG' });
  }

  const io = req.app.get('io');

  // Start update in background, stream progress via socket
  const emit = (step, stepStatus, message) => {
    if (io) {
      io.emit('portos:update:step', { step, status: stepStatus, message, timestamp: Date.now() });
    }
  };

  // Don't await — respond immediately, progress streams via socket
  executeUpdate(tag, emit).then(result => {
    if (io) {
      if (result.success) {
        io.emit('portos:update:complete', { success: true, newVersion: tag.replace(/^v/, '') });
      } else {
        io.emit('portos:update:error', { message: 'Update failed', step: 'unknown' });
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
