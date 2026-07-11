/**
 * Xcode management-script provisioning.
 *
 *   POST /:id/xcode-scripts/install → { installed, skipped, errors }
 */

import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../../lib/validation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { installScripts, XCODE_SCRIPT_NAMES } from '../../services/xcodeScripts.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

// POST /api/apps/:id/xcode-scripts/install - Install missing management scripts
// Restrict the request payload to the known, fixed set of script names so that
// arbitrary or oversized arrays are rejected at the validation layer.
const installScriptsSchema = z.object({
  scripts: z.array(z.enum(XCODE_SCRIPT_NAMES)).min(1).max(XCODE_SCRIPT_NAMES.length)
});
router.post('/:id/xcode-scripts/install', loadApp, asyncHandler(async (req, res) => {
  const { scripts } = validateRequest(installScriptsSchema, req.body);
  if (!req.loadedApp.repoPath || !await pathExists(req.loadedApp.repoPath)) {
    throw new ServerError('App repository path not found', { status: 400, code: 'PATH_NOT_FOUND' });
  }
  const result = await installScripts(req.loadedApp, scripts);
  if (result.errors.length && !result.installed.length) {
    throw new ServerError(result.errors.join(', '), { status: 400, code: 'INSTALL_FAILED' });
  }
  res.json(result);
}));

export default router;
