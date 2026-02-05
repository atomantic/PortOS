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
import { mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKTREES_DIR = join(__dirname, '../../data/cos/worktrees');

/**
 * Execute a git command and return stdout
 */
function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
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
 * @param {string} agentId - The agent identifier (used for branch/directory naming)
 * @param {string} sourceWorkspace - The original git repository path
 * @param {string} taskId - Task identifier (included in branch name for traceability)
 * @returns {{ worktreePath: string, branchName: string }} paths for the new worktree
 */
export async function createWorktree(agentId, sourceWorkspace, taskId) {
  if (!existsSync(WORKTREES_DIR)) {
    await mkdir(WORKTREES_DIR, { recursive: true });
  }

  const branchName = `cos/${taskId}/${agentId}`;
  const worktreePath = join(WORKTREES_DIR, agentId);

  // Get the current branch to base the worktree on
  const currentBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace)).trim();

  // Create worktree with a new branch based on current HEAD
  await execGit(
    ['worktree', 'add', '-b', branchName, worktreePath, currentBranch],
    sourceWorkspace
  );

  console.log(`🌳 Created worktree for ${agentId} at ${worktreePath} (branch: ${branchName})`);

  return { worktreePath, branchName };
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
    .catch(async () => {
      // Fallback: manually remove the directory and prune
      await rm(worktreePath, { recursive: true, force: true });
      await execGit(['worktree', 'prune'], sourceWorkspace).catch(() => {});
    });

  // Delete the branch if we merged or if it was never used
  await execGit(['branch', '-D', branchName], sourceWorkspace)
    .catch(() => {
      // Branch may already be deleted or never created
    });

  console.log(`🌳 Removed worktree for ${agentId}${merged ? ' (merged)' : ''}`);

  return { merged, removed: true };
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
