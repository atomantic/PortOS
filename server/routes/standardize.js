import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import * as pm2Standardizer from '../services/pm2Standardizer.js';
import * as appsService from '../services/apps.js';

const router = Router();

// POST /api/standardize/analyze - Analyze app and generate standardization plan
router.post('/analyze', asyncHandler(async (req, res) => {
  const { repoPath, appId, providerId } = req.body;

  // Get path from appId if provided
  let path = repoPath;
  if (!path && appId) {
    const app = await appsService.getAppById(appId);
    if (!app) {
      throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
    }
    path = app.repoPath;
  }

  if (!path) {
    throw new ServerError('Either repoPath or appId is required', { status: 400, code: 'MISSING_PATH' });
  }

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
  const { repoPath, appId, plan } = req.body;

  // Get path from appId if provided
  let path = repoPath;
  if (!path && appId) {
    const app = await appsService.getAppById(appId);
    if (!app) {
      throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
    }
    path = app.repoPath;
  }

  if (!path) {
    throw new ServerError('Either repoPath or appId is required', { status: 400, code: 'MISSING_PATH' });
  }

  if (!plan) {
    throw new ServerError('Standardization plan is required', { status: 400, code: 'MISSING_PLAN' });
  }

  console.log(`🔧 Applying PM2 standardization to: ${path}`);

  const result = await pm2Standardizer.applyStandardization(path, plan);

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
  const { repoPath, appId } = req.body;

  let path = repoPath;
  if (!path && appId) {
    const app = await appsService.getAppById(appId);
    if (!app) {
      throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
    }
    path = app.repoPath;
  }

  if (!path) {
    throw new ServerError('Either repoPath or appId is required', { status: 400, code: 'MISSING_PATH' });
  }

  const result = await pm2Standardizer.createGitBackup(path);

  if (!result.success) {
    throw new ServerError(result.reason, { status: 400, code: 'BACKUP_FAILED' });
  }

  res.json(result);
}));

export default router;
