import { Router } from 'express';
import * as git from '../services/git.js';
import * as appsService from '../services/apps.js';
import { getAgents } from '../services/cosAgents.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

/**
 * Collect branch names actively used by running CoS agents.
 * Includes worktree branches and workspace branches from agent metadata.
 */
async function getActiveAgentBranches() {
  const agents = await getAgents().catch(() => []);
  const branches = new Set();
  for (const agent of agents) {
    if (agent.status !== 'running') continue;
    if (agent.metadata?.worktreeBranch) branches.add(agent.metadata.worktreeBranch);
  }
  return branches;
}

const router = Router();

// GET /api/git/submodules/status - Get all submodule statuses
router.get('/submodules/status', asyncHandler(async (req, res) => {
  const submodules = await git.getSubmodules();
  res.json(submodules);
}));

// POST /api/git/submodules/update - Update a specific submodule
router.post('/submodules/update', asyncHandler(async (req, res) => {
  const rawPath = req.body?.path;
  if (!rawPath || typeof rawPath !== 'string') {
    throw new ServerError('path must be a non-empty string', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const path = rawPath.trim();
  if (!path) {
    throw new ServerError('path must be a non-empty string', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Validate that this is a known submodule path (cheap check, no remote fetches)
  const knownPaths = await git.getSubmodulePaths();
  if (!knownPaths.includes(path)) {
    throw new ServerError(`Unknown submodule path: ${path}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const newCommit = await git.updateSubmodule(path);
  res.json({ success: true, newCommit });
}));

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

// POST /api/git/push-all - Push all branches with unpushed commits
router.post('/push-all', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.pushAll(path);
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

// POST /api/git/remote-branches - Get remote branches with merge status
router.post('/remote-branches', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.getRemoteBranches(path);
  res.json(result);
}));

// POST /api/git/merge - Merge a branch into the current branch
router.post('/merge', asyncHandler(async (req, res) => {
  const { path, branch } = req.body;

  if (!path || !branch) {
    throw new ServerError('path and branch are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.mergeBranch(path, branch);
  res.json(result);
}));

// POST /api/git/checkout-remote - Checkout a remote branch locally
router.post('/checkout-remote', asyncHandler(async (req, res) => {
  const { path, branch } = req.body;

  if (!path || !branch) {
    throw new ServerError('path and branch are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const result = await git.checkoutRemoteBranch(path, branch);
  res.json(result);
}));

// POST /api/git/cleanup-merged - Delete all merged branches (local + remote)
router.post('/cleanup-merged', asyncHandler(async (req, res) => {
  const { path } = req.body;

  if (!path) {
    throw new ServerError('path is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const excludeBranches = await getActiveAgentBranches();
  const result = await git.deleteMergedBranches(path, { excludeBranches });
  res.json(result);
}));

// POST /api/git/delete-branch - Delete a branch locally and/or remotely
router.post('/delete-branch', asyncHandler(async (req, res) => {
  const { path, branch, local, remote } = req.body;

  if (!path || !branch) {
    throw new ServerError('path and branch are required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (!local && !remote) {
    throw new ServerError('at least one of local or remote must be true', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const excludeBranches = await getActiveAgentBranches();
  const result = await git.deleteBranch(path, branch, { local, remote, excludeBranches });
  res.json(result);
}));

export default router;
