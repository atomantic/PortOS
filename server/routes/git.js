import { Router } from 'express';
import * as git from '../services/git.js';
import * as appsService from '../services/apps.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/git/:appId - Get git info for an app
router.get('/:appId', asyncHandler(async (req, res) => {
  const { appId } = req.params;

  const app = await appsService.getAppById(appId);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const info = await git.getGitInfo(app.repoPath);
  res.json(info);
}));

// POST /api/git/status - Get status for a path
router.post('/status', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const status = await git.getStatus(path);
  res.json(status);
}));

// POST /api/git/diff - Get diff for a path
router.post('/diff', asyncHandler(async (req, res) => {
  const { path, staged } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const diff = await git.getDiff(path, staged);
  res.json({ diff });
}));

// POST /api/git/commits - Get recent commits
router.post('/commits', asyncHandler(async (req, res) => {
  const { path, limit = 10 } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const commits = await git.getCommits(path, limit);
  res.json({ commits });
}));

// POST /api/git/stage - Stage files
router.post('/stage', asyncHandler(async (req, res) => {
  const { path, files } = req.body;

  if (!path || !files) {
    throw new ServerError('path and files are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  await git.stageFiles(path, files);
  res.json({ success: true });
}));

// POST /api/git/unstage - Unstage files
router.post('/unstage', asyncHandler(async (req, res) => {
  const { path, files } = req.body;

  if (!path || !files) {
    throw new ServerError('path and files are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  await git.unstageFiles(path, files);
  res.json({ success: true });
}));

// POST /api/git/commit - Create a commit
router.post('/commit', asyncHandler(async (req, res) => {
  const { path, message } = req.body;

  if (!path || !message) {
    throw new ServerError('path and message are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.commit(path, message);
  res.json(result);
}));

// POST /api/git/update-branches - Fetch and merge latest dev and main
router.post('/update-branches', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.updateBranches(path);
  res.json(result);
}));

// POST /api/git/branch-comparison - Compare two branches
router.post('/branch-comparison', asyncHandler(async (req, res) => {
  const { path, base, head } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.getBranchComparison(path, base || 'main', head || 'dev');
  res.json(result);
}));

// POST /api/git/push - Push to origin
router.post('/push', asyncHandler(async (req, res) => {
  const { path, branch } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.push(path, branch);
  res.json(result);
}));

// POST /api/git/info - Get full git info for a path
router.post('/info', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const info = await git.getGitInfo(path);
  res.json(info);
}));

// POST /api/git/branches - Get all local branches
router.post('/branches', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const branches = await git.getBranches(path);
  res.json({ branches });
}));

// POST /api/git/checkout - Switch to a branch
router.post('/checkout', asyncHandler(async (req, res) => {
  const { path, branch } = req.body;

  if (!path || !branch) {
    throw new ServerError('path and branch are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.checkout(path, branch);
  res.json(result);
}));

// POST /api/git/pull - Pull changes from remote
router.post('/pull', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.pull(path);
  res.json(result);
}));

// POST /api/git/sync - Sync branch (pull then push)
router.post('/sync', asyncHandler(async (req, res) => {
  const { path, branch } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.syncBranch(path, branch);
  res.json(result);
}));

export default router;
