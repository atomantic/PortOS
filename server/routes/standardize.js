import { Router } from 'express';
import { realpath } from 'fs/promises';
import { resolve } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { standardizeApplySchema, standardizeTargetBodySchema, validateRequest } from '../lib/validation.js';
import { isWithinAllowedRoots, outsideAllowedRootsMessage } from '../lib/workspaceRoots.js';
import * as pm2Standardizer from '../services/pm2Standardizer.js';
import * as appsService from '../services/apps.js';

const router = Router();

/**
 * Resolve the repo to standardize from `repoPath` or `appId`.
 *
 * Whenever an `appId` names a real record, it gets the precondition check —
 * even alongside an explicit `repoPath`, so passing both can't smuggle a
 * refused app past the gate. Standardization rewrites the target repo, so an
 * app PortOS never runs under PM2 (or a non-Node repo, or PortOS itself) is
 * refused here rather than relying on the button being hidden in the UI. A bare
 * `repoPath` has no app record to type-check, so it is taken at face value.
 *
 * The checked record's OWN `repoPath` is what gets returned — a companion
 * `repoPath` is ignored rather than preferred. Typing an app record and then
 * rewriting a different directory would make the gate decorative: a permitted
 * Node `appId` alongside some other repo's path would carry a Python or Docker
 * project straight past the refusal. No caller sends both (the client wrappers
 * in `apiSystem.js` send one or the other), so this only closes the hole. Every
 * selected target is still canonicalized and confined to the workspace roots.
 */
async function resolveStandardizeTarget({ repoPath, appId }) {
  let target;
  if (appId) {
    const app = await appsService.getAppById(appId);
    if (!app) {
      throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
    }
    const refusal = pm2Standardizer.standardizeRefusalFor(app);
    if (refusal) {
      throw new ServerError(refusal, { status: 400, code: 'NOT_STANDARDIZABLE' });
    }
    target = app.repoPath;
  } else if (repoPath) {
    target = repoPath;
  } else {
    throw new ServerError('Either repoPath or appId is required', { status: 400, code: 'MISSING_PATH' });
  }

  if (typeof target !== 'string' || !target.trim()) {
    throw new ServerError('Standardization target is invalid', { status: 400, code: 'INVALID_PATH' });
  }

  // Resolve symlinks before checking containment so a path that appears to sit
  // below an allowed root cannot redirect the standardizer's writes elsewhere.
  const realTarget = await realpath(resolve(target)).catch(() => null);
  if (!realTarget) {
    throw new ServerError('Standardization target is not accessible', { status: 400, code: 'INVALID_PATH' });
  }
  if (!isWithinAllowedRoots(realTarget)) {
    console.error(`❌ ${outsideAllowedRootsMessage(realTarget, { field: 'standardization target' })}`);
    throw new ServerError('Standardization target is outside allowed directories', {
      status: 403,
      code: 'FORBIDDEN'
    });
  }

  // Keep the registered/requested spelling after checking its canonical target.
  // analyzeApp uses the stored repoPath for managed-app identity (including its
  // own-port exemption), so replacing a symlinked path with realTarget would
  // make that app look unrelated and unnecessarily reassign its ports.
  return target;
}

// POST /api/standardize/analyze - Analyze app and generate standardization plan
router.post('/analyze', asyncHandler(async (req, res) => {
  const { repoPath, appId, providerId } = validateRequest(standardizeTargetBodySchema, req.body);

  const path = await resolveStandardizeTarget({ repoPath, appId });

  console.log(`🔧 Analyzing PM2 standardization for: ${path}`);

  const result = await pm2Standardizer.analyzeApp(path, providerId);

  if (!result.success) {
    throw new ServerError(result.error, { status: 400, code: 'ANALYSIS_FAILED' });
  }

  console.log(`✅ Analysis complete: ${result.proposedChanges.processes?.length || 0} processes identified`);

  res.json(result);
}));

// POST /api/standardize/apply - Apply standardization changes
router.post('/apply', asyncHandler(async (req, res) => {
  const { repoPath, appId, plan, overwriteEcosystem } = validateRequest(standardizeApplySchema, req.body);

  const path = await resolveStandardizeTarget({ repoPath, appId });

  console.log(`🔧 Applying PM2 standardization to: ${path}`);

  const result = await pm2Standardizer.applyStandardization(path, plan, { overwriteEcosystem });

  if (!result.success) {
    throw new ServerError(result.error || 'Standardization failed', { status: 400, code: 'APPLY_FAILED' });
  }

  if (result.backupBranch) {
    console.log(`📦 Backup branch created: ${result.backupBranch}`);
  }

  console.log(`✅ Standardization applied: ${result.filesModified.length} files modified`);

  // If appId was provided, update the app with new PM2 process names
  if (appId && plan.proposedChanges?.processes) {
    const pm2ProcessNames = plan.proposedChanges.processes.map(p => p.name);
    await appsService.updateApp(appId, { pm2ProcessNames });
  }

  res.json(result);
}));

// GET /api/standardize/template - Get the standard PM2 template
router.get('/template', asyncHandler(async (req, res) => {
  const template = pm2Standardizer.getStandardTemplate();
  res.json({ template });
}));

// POST /api/standardize/backup - Create git backup only
router.post('/backup', asyncHandler(async (req, res) => {
  const { repoPath, appId } = validateRequest(standardizeTargetBodySchema, req.body);

  const path = await resolveStandardizeTarget({ repoPath, appId });

  const result = await pm2Standardizer.createGitBackup(path);

  if (!result.success) {
    throw new ServerError(result.reason, { status: 400, code: 'BACKUP_FAILED' });
  }

  res.json(result);
}));

export default router;
