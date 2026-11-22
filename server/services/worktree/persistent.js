/** Worktree lifecycle for persistent feature agents. */

import { existsSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../../lib/fileUtils.js';
import { execGit } from '../../lib/execGit.js';
import { withGitMutationLifetime } from '../../lib/gitMutationLifetime.js';
import { WORKTREES_DIR } from './paths.js';
import { addWorktreeWithRetry } from './gitErrors.js';
import { queueWorktreeCreate } from './mutationQueue.js';
import { cleanupOrphanBranch, enforceUpstreamOrUndoAdd } from './create.js';
import { forceRemoveWorktreeDir } from './remove.js';

/**
 * Create a persistent worktree for a feature agent.
 * Unlike regular worktrees, these persist across runs.
 */
export async function createPersistentWorktree(featureAgentId, sourceWorkspace, branchName, baseBranch) {
  // Share the per-repo serialization tail with createWorktree so a persistent
  // feature-agent add and a CoS agent add in the same tick can't race git's
  // per-repo worktree lock (#2193).
  return queueWorktreeCreate(sourceWorkspace, () => createPersistentWorktreeUnlocked(featureAgentId, sourceWorkspace, branchName, baseBranch));
}

async function createPersistentWorktreeUnlocked(featureAgentId, sourceWorkspace, branchName, baseBranch) {
  const FA_WORKTREES = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  await ensureDir(join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId));

  const fetchOk = await execGit(['fetch', 'origin'], sourceWorkspace)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Persistent worktree fetch failed: ${err.message}`);
      return false;
    });

  if (!baseBranch) {
    const { getDefaultBranch } = await import('../git.js');
    baseBranch = await getDefaultBranch(sourceWorkspace, { allowRemote: fetchOk }).catch(() => null) || 'main';
  }

  // Verify the base branch exists locally or on the remote; re-detect if stale
  const baseRef = await execGit(['rev-parse', `origin/${baseBranch}`], sourceWorkspace)
    .then(() => `origin/${baseBranch}`)
    .catch(async () => {
      const localExists = (await execGit(['branch', '--list', baseBranch], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
      if (localExists) return baseBranch;
      // Provided baseBranch doesn't exist — re-detect the actual default
      const { getDefaultBranch } = await import('../git.js');
      const detected = await getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null);
      if (detected && detected !== baseBranch) {
        baseBranch = detected;
        const remoteOk = await execGit(['rev-parse', `origin/${detected}`], sourceWorkspace, { ignoreExitCode: true })
          .then(r => r.exitCode === 0).catch(() => false);
        if (remoteOk) return `origin/${detected}`;
        const localOk = (await execGit(['branch', '--list', detected], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
        if (localOk) return detected;
      }
      // All detection failed — use HEAD and update baseBranch to reflect reality
      const headBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], sourceWorkspace, { ignoreExitCode: true })).stdout.trim();
      baseBranch = headBranch && headBranch !== 'HEAD' ? headBranch : baseBranch;
      return 'HEAD';
    });

  // Check if branch already exists (local or remote)
  const localBranchExists = (await execGit(['branch', '--list', branchName], sourceWorkspace)).stdout.trim();
  const remoteBranchExists = (await execGit(['branch', '-r', '--list', `origin/${branchName}`], sourceWorkspace)).stdout.trim();

  if (localBranchExists) {
    // Local branch exists - create worktree from existing branch (no orphan
    // cleanup: the branch pre-dates this add).
    await addWorktreeWithRetry(['worktree', 'add', FA_WORKTREES, branchName], sourceWorkspace);
  } else if (remoteBranchExists) {
    // Remote branch exists but no local - track it. On final failure, drop the
    // partially-created local tracking branch (it re-creates from origin next run).
    await addWorktreeWithRetry(['worktree', 'add', '--track', '-b', branchName, FA_WORKTREES, `origin/${branchName}`], sourceWorkspace)
      .catch(async (err) => { await cleanupOrphanBranch(sourceWorkspace, branchName, err); throw err; });
  } else {
    // New branch - create from base. `--no-track` for the same reason as createWorktree:
    // `baseRef` is usually `origin/<default>`, and an auto-configured
    // `branch.<name>.merge = refs/heads/main` turns a config-derived push into a push
    // onto the default branch (#4172). Clean up the orphan branch on final failure (#2193).
    await addWorktreeWithRetry(['worktree', 'add', '--no-track', '-b', branchName, FA_WORKTREES, baseRef], sourceWorkspace)
      .catch(async (err) => { await cleanupOrphanBranch(sourceWorkspace, branchName, err); throw err; });
  }

  // Covers all three arms above, including a branch a prior run left mis-tracked.
  await enforceUpstreamOrUndoAdd(sourceWorkspace, branchName, FA_WORKTREES, { deleteBranch: !localBranchExists });

  console.log(`🌳 Created persistent worktree for feature agent ${featureAgentId} at ${FA_WORKTREES} (branch: ${branchName})`);
  return { worktreePath: FA_WORKTREES, branchName, baseBranch };
}

/**
 * Remove a persistent feature agent worktree
 */
export async function removePersistentWorktree(featureAgentId, sourceWorkspace, branchName) {
  return withGitMutationLifetime(() => removePersistentWorktreeAdmitted(featureAgentId, sourceWorkspace, branchName));
}

async function removePersistentWorktreeAdmitted(featureAgentId, sourceWorkspace, branchName) {
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');

  if (!existsSync(worktreePath)) return { removed: false };

  const removal = await forceRemoveWorktreeDir(sourceWorkspace, worktreePath, {
    label: `Persistent worktree remove failed for ${featureAgentId}, falling back`,
    log: 'all',
    subject: featureAgentId,
  });
  if (!removal.removed) return { removed: false, cleanupIncomplete: true, warnings: [removal.warning] };

  await execGit(['branch', '-D', branchName], sourceWorkspace).catch(err => {
    console.log(`⚠️ Branch delete failed for ${branchName}: ${err.message}`);
  });

  console.log(`🌳 Removed persistent worktree for feature agent ${featureAgentId}`);
  return { removed: true, warnings: [] };
}

/**
 * Merge base branch into a persistent feature agent worktree before a run
 */
export async function mergeBaseIntoFeatureWorktree(featureAgentId, baseBranch) {
  const worktreePath = join(WORKTREES_DIR, '..', 'feature-agents', featureAgentId, 'worktree');
  if (!existsSync(worktreePath)) return { merged: false, reason: 'worktree-missing' };

  const fetchOk = await execGit(['fetch', 'origin'], worktreePath)
    .then(() => true)
    .catch(err => {
      console.log(`⚠️ Fetch failed for feature agent ${featureAgentId}: ${err.message}`);
      return false;
    });

  if (!baseBranch) {
    const { getDefaultBranch } = await import('../git.js');
    baseBranch = await getDefaultBranch(worktreePath, { allowRemote: fetchOk }).catch(() => null) || 'main';
  }

  // Verify origin/<baseBranch> exists; if not, re-detect before giving up
  let remoteBranchValid = await execGit(['rev-parse', `origin/${baseBranch}`], worktreePath, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  if (!remoteBranchValid) {
    const { getDefaultBranch } = await import('../git.js');
    const detected = await getDefaultBranch(worktreePath, { allowRemote: false }).catch(() => null);
    if (detected && detected !== baseBranch) {
      remoteBranchValid = await execGit(['rev-parse', `origin/${detected}`], worktreePath, { ignoreExitCode: true })
        .then(r => r.exitCode === 0).catch(() => false);
      if (remoteBranchValid) {
        baseBranch = detected;
      }
    }
    if (!remoteBranchValid) {
      return { merged: false, reason: `origin/${baseBranch} not found` };
    }
  }
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
