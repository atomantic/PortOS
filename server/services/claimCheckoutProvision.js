/**
 * Server-provisioned claim checkout for a pinned forge claim (#15517).
 *
 * A manual `/do:next` claim pinned to one GitHub/GitLab issue used to make the
 * agent run the whole checkout phase itself: fetch, bind, `git worktree add`,
 * link dependencies, set markers. That is mechanical work local models get
 * wrong, so PortOS does it at spawn and the prompt starts in the checkout.
 *
 * The checkout keeps the agent-cut shape exactly: a `claim-<app>-issue-<n>`
 * directory under the worktrees root on `claim/issue-<n>`. The run is
 * registered as a claim run that owns that branch (not as a CoS `agent-*`
 * worktree), so claim cleanup, continuation and branch-reconcile treat it the
 * same as a tree the agent cut. Binding needs the agent record, which only
 * exists after registration, so the dispatch binds once the run is registered;
 * until then git's branch uniqueness and the dispatching mark hold the tree.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { appWorktreeSlug } from '../lib/worktreeOwnership.js';

/** The claim branch PortOS cuts for this task at spawn, or null when the agent cuts its own. */
export function serverClaimCheckoutBranch(task) {
  const meta = task?.metadata;
  if (!isTruthyMeta(meta?.claimServerCheckout) || !hasClaimFlowContract(task)) return null;
  const target = String(meta.claimTarget ?? '').trim();
  return /^\d+$/.test(target) ? `claim/issue-${target}` : null;
}

/** Where the claim prompt has always put this checkout, so both producers agree. */
function claimCheckoutPath(app, issueNumber, worktreesRoot = PATHS.worktrees) {
  return join(worktreesRoot, `claim-${appWorktreeSlug(app)}-issue-${issueNumber}`);
}

/**
 * Fetch the default branch and cut `branch` from it into the claim directory.
 * Refuses, touching nothing, when the branch or directory already exists here
 * or on origin: an existing claim branch is another run's claim.
 *
 * @returns {Promise<{ claimCheckout: { repoPath: string, worktreePath: string, branchName: string, baseBranch: string } }|{ refused: string }>}
 */
export async function provisionClaimCheckout({ app, sourceWorkspace, branch, worktreesRoot = PATHS.worktrees }) {
  const [{ getDefaultBranch }, { linkWorktreeDependencies }] = await Promise.all([
    import('./git.js'), import('./worktreeManager.js'),
  ]);
  const issueNumber = branch.replace(/^claim\/issue-/, '');
  const worktreePath = claimCheckoutPath(app, issueNumber, worktreesRoot);
  const baseBranch = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
  if (!baseBranch) return { refused: 'the default branch could not be resolved' };
  const fetched = await execGit(['fetch', 'origin', baseBranch], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  if (fetched?.exitCode !== 0) return { refused: `fetching origin/${baseBranch} failed` };

  if (existsSync(worktreePath)) return { refused: `${worktreePath} already exists` };
  const local = await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  if (local?.exitCode === 0) return { refused: `${branch} already exists locally` };
  if (local?.exitCode !== 1) return { refused: `the local ${branch} ref could not be read` };
  // `--exit-code` answers 2 only for "no such ref"; any other failure proves nothing.
  const remote = await execGit(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], sourceWorkspace,
    { ignoreExitCode: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).catch(() => null);
  if (remote?.exitCode === 0) return { refused: `${branch} already exists on origin` };
  if (remote?.exitCode !== 2) return { refused: `origin's ${branch} ref could not be read` };

  await ensureDir(worktreesRoot);
  const added = await execGit(['worktree', 'add', '--no-track', '-b', branch, worktreePath, `origin/${baseBranch}`],
    sourceWorkspace, { ignoreExitCode: true }).catch(error => ({ exitCode: -1, stderr: error.message }));
  if (added.exitCode !== 0) return { refused: `git worktree add failed: ${String(added.stderr || '').trim().split('\n')[0]}` };

  // Without the links the agent cannot run tests, but the checkout is still
  // the right place to work, so a link failure is reported rather than fatal.
  await linkWorktreeDependencies(sourceWorkspace, worktreePath).catch(error => {
    console.error(`❌ Linking dependencies into ${worktreePath} failed: ${error.message}`);
  });
  return { claimCheckout: { repoPath: sourceWorkspace, worktreePath, branchName: branch, baseBranch } };
}
