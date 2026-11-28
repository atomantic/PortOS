import { Router } from 'express';
import * as gitStatus from '../services/git/status.js';
import * as gitSync from '../services/git/sync.js';
import * as gitCleanup from '../services/git/cleanup.js';
import * as gitSubmodules from '../services/gitSubmodules.js';
import * as appsService from '../services/apps.js';
import { getAgents } from '../services/cos/cosAgentLifecycle.js';
import { protectedAgentIds } from '../services/agent/agentState.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { assertAllowedWorkspaceDir } from '../lib/workspaceRoots.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  submoduleStatusQuerySchema, submoduleUpdateSchema, gitDeleteBranchBodySchema, gitPathBodySchema,
  gitCleanupMergedBodySchema, gitStageBodySchema, gitCommitBodySchema, gitBranchBodySchema,
  gitOptionalBranchBodySchema, gitBranchComparisonBodySchema, gitDiffBodySchema,
  gitRemoteBranchesBodySchema
} from '../lib/gitValidation.js';

/**
 * What a branch/worktree cleanup must leave alone, from ONE read of the agent
 * list so the two sets can't be built from different snapshots:
 *   - `excludeBranches` — the branch each running agent is working on.
 *   - `activeAgentIds` — every agent whose worktree is in use (`protectedAgentIds`).
 *
 * An unreadable agent list yields `activeAgentIds: null`, which the worktree
 * reaper reads as "liveness unknown" and fails closed on — the alternative,
 * an empty Set, would pass for "nothing is running" and take a live agent's
 * directory out from under it.
 * @returns {Promise<{excludeBranches: Set<string>, activeAgentIds: Set<string>|null}>}
 */
async function getAgentProtections() {
  const agents = await getAgents().catch(() => null);
  const branches = new Set();
  for (const agent of agents || []) {
    if (agent.status !== 'running') continue;
    if (agent.metadata?.worktreeBranch) branches.add(agent.metadata.worktreeBranch);
  }
  return { excludeBranches: branches, activeAgentIds: agents ? protectedAgentIds(agents) : null };
}

const router = Router();

// GET /api/git/submodules/status?repoPath=… - Submodule statuses for a repo,
// plus the branch a pointer bump would commit to (defaults to the PortOS
// checkout when repoPath is omitted).
router.get('/submodules/status', asyncHandler(async (req, res) => {
  const { repoPath } = validateRequest(submoduleStatusQuerySchema, req.query);
  if (repoPath) assertAllowedWorkspaceDir(repoPath);
  res.json(await gitSubmodules.getSubmoduleOverview(repoPath));
}));

// POST /api/git/submodules/update - Update a specific submodule
router.post('/submodules/update', asyncHandler(async (req, res) => {
  const { path, repoPath, commit } = validateRequest(submoduleUpdateSchema, req.body);
  if (repoPath) assertAllowedWorkspaceDir(repoPath);
  // The service owns the "is this a real submodule of that repo?" check and
  // throws a 400 ServerError — re-listing them here would just spawn git twice.
  const result = await gitSubmodules.updateSubmodule(path, { repoPath, commit });
  res.json({ success: true, ...result });
}));

// GET /api/git/:appId - Get git info for an app
router.get('/:appId', asyncHandler(async (req, res) => {
  const { appId } = req.params;

  const app = await appsService.getAppById(appId);

  if (!app) {
    throw new ServerError('App not found', { status: 404, code: 'NOT_FOUND' });
  }

  const info = await gitStatus.getGitInfo(app.repoPath);
  res.json(info);
}));

// POST /api/git/status - Get status for a path
router.post('/status', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const status = await gitStatus.getStatus(path);
  res.json(status);
}));

// POST /api/git/diff - Get diff for a path
router.post('/diff', asyncHandler(async (req, res) => {
  const { path, staged } = validateRequest(gitDiffBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const diff = await gitStatus.getDiff(path, staged);
  res.json({ diff });
}));

// POST /api/git/stage - Stage files
router.post('/stage', asyncHandler(async (req, res) => {
  const { path, files } = validateRequest(gitStageBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  await gitStatus.stageFiles(path, files);
  res.json({ success: true });
}));

// POST /api/git/unstage - Unstage files
router.post('/unstage', asyncHandler(async (req, res) => {
  const { path, files } = validateRequest(gitStageBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  await gitStatus.unstageFiles(path, files);
  res.json({ success: true });
}));

// POST /api/git/commit - Create a commit
router.post('/commit', asyncHandler(async (req, res) => {
  const { path, message } = validateRequest(gitCommitBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitStatus.commit(path, message);
  res.json(result);
}));

// POST /api/git/update-branches - Fetch and merge latest dev and main
router.post('/update-branches', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.updateBranches(path);
  res.json(result);
}));

// POST /api/git/branch-comparison - Compare two branches
router.post('/branch-comparison', asyncHandler(async (req, res) => {
  const { path, base, head } = validateRequest(gitBranchComparisonBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const baseBranch = base || await gitStatus.getDefaultBranch(path, { allowRemote: false }).catch(() => null) || 'main';
  const result = await gitStatus.getBranchComparison(path, baseBranch, head || 'dev');
  res.json(result);
}));

// POST /api/git/push - Push to origin
router.post('/push', asyncHandler(async (req, res) => {
  const { path, branch } = validateRequest(gitOptionalBranchBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.push(path, branch);
  res.json(result);
}));

// POST /api/git/push-all - Push all branches with unpushed commits
router.post('/push-all', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.pushAll(path);
  res.json(result);
}));

router.post('/rebase-push', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  res.json(await gitSync.rebaseAndPushDefaultBranch(path));
}));

// POST /api/git/info - Get full git info for a path
router.post('/info', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const info = await gitStatus.getGitInfo(path);
  res.json(info);
}));

// POST /api/git/branches - Get all local branches
router.post('/branches', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const branches = await gitStatus.getBranches(path);
  res.json({ branches });
}));

// POST /api/git/checkout - Switch to a branch
router.post('/checkout', asyncHandler(async (req, res) => {
  const { path, branch } = validateRequest(gitBranchBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.checkout(path, branch);
  res.json(result);
}));

// POST /api/git/sync - Sync branch (pull then push)
router.post('/sync', asyncHandler(async (req, res) => {
  const { path, branch } = validateRequest(gitOptionalBranchBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.syncBranch(path, branch);
  res.json(result);
}));

// POST /api/git/remote-branches - Get remote branches with merge status
router.post('/remote-branches', asyncHandler(async (req, res) => {
  const { path, force } = validateRequest(gitRemoteBranchesBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.getRemoteBranches(path, { force });
  res.json(result);
}));

// POST /api/git/merge - Merge a branch into the current branch
router.post('/merge', asyncHandler(async (req, res) => {
  const { path, branch } = validateRequest(gitBranchBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.mergeBranch(path, branch);
  res.json(result);
}));

// POST /api/git/checkout-remote - Checkout a remote branch locally
router.post('/checkout-remote', asyncHandler(async (req, res) => {
  const { path, branch } = validateRequest(gitBranchBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitSync.checkoutRemoteBranch(path, branch);
  res.json(result);
}));

// POST /api/git/reset-to-default - Discard local changes and match origin's
// default branch. Destructive on tracked files; untracked ones are kept, and
// the response carries the pre-reset HEAD so the caller can offer a recovery
// sha. See git.resetToDefaultBranch for the full contract.
router.post('/reset-to-default', asyncHandler(async (req, res) => {
  const { path } = validateRequest(gitPathBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const result = await gitCleanup.resetToDefaultBranch(path);
  res.json(result);
}));

// POST /api/git/cleanup-merged - Delete all merged branches (local + remote),
// including the worktrees pinning them. The service reaps a worktree only when
// it is clean and its branch is fully in origin/<default>; anything else comes
// back in `skipped` with the reason.
router.post('/cleanup-merged', asyncHandler(async (req, res) => {
  const { path, branches } = validateRequest(gitCleanupMergedBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const { excludeBranches, activeAgentIds } = await getAgentProtections();
  const result = await gitCleanup.deleteMergedBranches(path, { excludeBranches, activeAgentIds,
    ...(branches && { onlyBranches: new Set(branches) }) });
  res.json(result);
}));

// POST /api/git/delete-branch - Delete a branch locally and/or remotely
router.post('/delete-branch', asyncHandler(async (req, res) => {
  const { path, branch, local, remote, expectedHead } = validateRequest(gitDeleteBranchBodySchema, req.body);
  assertAllowedWorkspaceDir(path);
  const { excludeBranches } = await getAgentProtections();
  const result = await gitCleanup.deleteBranch(path, branch, { local, remote, excludeBranches, ...(expectedHead && { expectedHead }) });
  res.json(result);
}));

export default router;
