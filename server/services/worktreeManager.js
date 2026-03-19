/**
 * Git Worktree Manager
 *
 * Creates and cleans up git worktrees for CoS agents that need isolated
 * workspaces to avoid file conflicts with concurrent agents.
 *
 * Worktrees are created under data/cos/worktrees/<agentId>/ with a
 * unique branch name. On agent completion, the worktree is removed
 * and the branch cleaned up.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../lib/fileUtils.js';

const WORKTREES_DIR = PATHS.worktrees;

/**
 * Execute a git command and return stdout
 */
function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || `git exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
    child.on('error', reject);
  });
}

/**
 * Create a git worktree for an agent.
 *
 * Creates a new branch and worktree directory that the agent can work in
 * without disturbing the main workspace.
 *
 * For managed apps, the worktree is based on the latest remote default branch
 * (main/master) to ensure a clean starting point free from other agents' changes.
 *
 * @param {string} agentId - The agent identifier (used for branch/directory naming)
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} taskId - Task identifier (included in branch name for traceability)
 * @param {object} options - Optional configuration
 * @param {string} options.baseBranch - Branch to base the worktree on (auto-detected if omitted)
 * @returns {{ worktreePath: string, branchName: string, baseBranch: string }} paths for the new worktree
 */
export async function createWorktree(agentId, sourceWorkspace, taskId, options = {}) {
  if (!existsSync(WORKTREES_DIR)) {
    await ensureDir(WORKTREES_DIR);
  }

  const branchName = `cos/${taskId}/${agentId}`;
  const worktreePath = join(WORKTREES_DIR, agentId);

  // Fetch latest from origin so we base off up-to-date refs
  await execGit(['fetch', 'origin'], sourceWorkspace).catch(err => {
    console.log(`⚠️ Worktree fetch failed (will use local refs): ${err.message}`);
  });

  // Determine the base: explicit option > detected default branch > current HEAD
  let baseBranch = options.baseBranch;
  if (!baseBranch) {
    const mainExists = (await execGit(['branch', '--list', 'main'], sourceWorkspace)).trim();
    const masterExists = (await execGit(['branch', '--list', 'master'], sourceWorkspace)).trim();
    if (mainExists) baseBranch = 'main';
    else if (masterExists) baseBranch = 'master';
    else baseBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace)).trim();
  }

  // Prefer the remote ref (freshest state) if available
  const baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
    .then(() => `origin/${baseBranch}`)
    .catch(() => baseBranch);

  // Create worktree with a new branch based on the latest default branch
  await execGit(
    ['worktree', 'add', '-b', branchName, worktreePath, baseRef],
    sourceWorkspace
  );

  console.log(`🌳 Created worktree for ${agentId} at ${worktreePath} (branch: ${branchName}, base: ${baseRef})`);

  return { worktreePath, branchName, baseBranch };
}

/**
 * Remove a git worktree and its associated branch.
 *
 * Called during agent cleanup. Merges the worktree branch back
 * to the source branch if the agent made commits, then prunes.
 *
 * @param {string} agentId - The agent identifier
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} branchName - The worktree branch to clean up
 * @param {object} options - { merge: boolean } whether to attempt merge back
 */
export async function removeWorktree(agentId, sourceWorkspace, branchName, options = {}) {
  const worktreePath = join(WORKTREES_DIR, agentId);

  if (!existsSync(worktreePath)) {
    console.log(`🌳 Worktree already removed for ${agentId}`);
    return { merged: false, removed: true };
  }

  let merged = false;

  // If merge requested, check if there are commits to merge
  if (options.merge) {
    const currentBranch = (await execGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      sourceWorkspace
    )).trim();

    // Check if worktree branch has commits ahead of the source branch
    const aheadCount = (await execGit(
      ['rev-list', '--count', `${currentBranch}..${branchName}`],
      sourceWorkspace
    ).catch(() => '0')).trim();

    if (parseInt(aheadCount, 10) > 0) {
      // Merge worktree branch back to the source branch
      await execGit(['merge', branchName, '--no-edit'], sourceWorkspace)
        .then(() => { merged = true; })
        .catch(err => {
          console.log(`⚠️ Could not auto-merge ${branchName}: ${err.message}`);
        });
    }
  }

  // Remove the worktree
  await execGit(['worktree', 'remove', worktreePath, '--force'], sourceWorkspace)
    .catch(async (err) => {
      console.log(`⚠️ Worktree remove failed for ${agentId}, falling back to manual cleanup: ${err.message}`);
      await rm(worktreePath, { recursive: true, force: true }).catch(rmErr => {
        console.log(`⚠️ Manual rm failed for worktree ${agentId}: ${rmErr.message}`);
      });
      await execGit(['worktree', 'prune'], sourceWorkspace).catch(pruneErr => {
        console.log(`⚠️ Worktree prune failed for ${agentId}: ${pruneErr.message}`);
      });
    });

  // Delete the branch if we merged or if it was never used
  await execGit(['branch', '-D', branchName], sourceWorkspace)
    .catch(err => {
      console.log(`⚠️ Branch delete failed for ${branchName}: ${err.message}`);
    });

  console.log(`🌳 Removed worktree for ${agentId}${merged ? ' (merged)' : ''}`);

  return { merged, removed: true };
}

/**
 * Create a persistent worktree for a feature agent.
 * Unlike regular worktrees, these persist across runs.
 */
export async function createPersistentWorktree(featureAgentId, sourceWorkspace, branchName, baseBranch = 'main') {
  const FA_WORKTREES = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  await ensureDir(join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId));

  await execGit(['fetch', 'origin'], sourceWorkspace).catch(err => {
    console.log(`⚠️ Persistent worktree fetch failed: ${err.message}`);
  });

  const baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
    .then(() => `origin/${baseBranch}`)
    .catch(() => baseBranch);

  // Check if branch already exists (local or remote)
  const localBranchExists = (await execGit(['branch', '--list', branchName], sourceWorkspace)).trim();
  const remoteBranchExists = (await execGit(['branch', '-r', '--list', `origin/${branchName}`], sourceWorkspace)).trim();

  if (localBranchExists) {
    // Local branch exists - create worktree from existing branch
    await execGit(['worktree', 'add', FA_WORKTREES, branchName], sourceWorkspace);
  } else if (remoteBranchExists) {
    // Remote branch exists but no local - track it
    await execGit(['worktree', 'add', '--track', '-b', branchName, FA_WORKTREES, `origin/${branchName}`], sourceWorkspace);
  } else {
    // New branch - create from base
    await execGit(['worktree', 'add', '-b', branchName, FA_WORKTREES, baseRef], sourceWorkspace);
  }

  console.log(`🌳 Created persistent worktree for feature agent ${featureAgentId} at ${FA_WORKTREES} (branch: ${branchName})`);
  return { worktreePath: FA_WORKTREES, branchName, baseBranch };
}

/**
 * Remove a persistent feature agent worktree
 */
export async function removePersistentWorktree(featureAgentId, sourceWorkspace, branchName) {
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  if (!existsSync(worktreePath)) return { removed: false };

  await execGit(['worktree', 'remove', worktreePath, '--force'], sourceWorkspace).catch(async (err) => {
    console.log(`⚠️ Persistent worktree remove failed for ${featureAgentId}, falling back: ${err.message}`);
    await rm(worktreePath, { recursive: true, force: true }).catch(rmErr => {
      console.log(`⚠️ Manual rm failed for persistent worktree ${featureAgentId}: ${rmErr.message}`);
    });
    await execGit(['worktree', 'prune'], sourceWorkspace).catch(pruneErr => {
      console.log(`⚠️ Worktree prune failed for ${featureAgentId}: ${pruneErr.message}`);
    });
  });

  await execGit(['branch', '-D', branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Branch delete failed for ${branchName}: ${err.message}`);
  });

  console.log(`🌳 Removed persistent worktree for feature agent ${featureAgentId}`);
  return { removed: true };
}

/**
 * Merge base branch into a persistent feature agent worktree before a run
 */
export async function mergeBaseIntoFeatureWorktree(featureAgentId, baseBranch = 'main') {
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');
  if (!existsSync(worktreePath)) return { merged: false, reason: 'worktree-missing' };

  await execGit(['fetch', 'origin'], worktreePath).catch(err => {
    console.log(`⚠️ Fetch failed for feature agent ${featureAgentId}: ${err.message}`);
  });
  const result = await execGit(['merge', `origin/${baseBranch}`, '--no-edit'], worktreePath)
    .then(() => ({ merged: true }))
    .catch(async (err) => {
      // Abort failed merge
      await execGit(['merge', '--abort'], worktreePath).catch(abortErr => {
        console.log(`⚠️ Merge abort failed for ${featureAgentId}: ${abortErr.message}`);
      });
      return { merged: false, reason: err.message };
    });

  if (result.merged) {
    console.log(`🌳 Merged origin/${baseBranch} into feature agent ${featureAgentId}`);
  }
  return result;
}

/**
 * List all active worktrees for the repository
 */
export async function listWorktrees(sourceWorkspace) {
  const stdout = await execGit(['worktree', 'list', '--porcelain'], sourceWorkspace);
  const worktrees = [];
  let current = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}

/**
 * Clean up any orphaned worktrees (worktrees whose agent no longer exists)
 *
 * @param {string} sourceWorkspace - The original git repository path
 * @param {Set<string>} activeAgentIds - Set of currently active agent IDs
 */
export async function cleanupOrphanedWorktrees(sourceWorkspace, activeAgentIds) {
  if (!existsSync(WORKTREES_DIR)) return 0;

  const worktrees = await listWorktrees(sourceWorkspace).catch(() => []);
  let cleaned = 0;

  for (const wt of worktrees) {
    // Only clean up worktrees under our managed directory
    if (!wt.path.startsWith(WORKTREES_DIR)) continue;

    // Extract agent ID from the worktree path
    const agentId = wt.path.split('/').pop();
    if (!activeAgentIds.has(agentId)) {
      const branchName = wt.branch?.replace('refs/heads/', '') || '';
      await removeWorktree(agentId, sourceWorkspace, branchName, { merge: false })
        .catch(err => {
          console.log(`⚠️ Failed to clean orphaned worktree ${agentId}: ${err.message}`);
        });
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🌳 Cleaned ${cleaned} orphaned worktree(s)`);
  }

  return cleaned;
}
