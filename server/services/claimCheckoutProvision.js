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
import { lstat, rm } from 'fs/promises';
import { join } from 'path';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { execGit } from '../lib/execGit.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { hasClaimFlowContract } from '../lib/claimFlowTaskTypes.js';
import { claimIssueNumber } from '../lib/issueClaimEvidence.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { appWorktreeSlug } from '../lib/worktreeOwnership.js';
import { queueWorktreeCreate } from './worktree/mutationQueue.js';

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
 * Undo a failed add so the refusal's "nothing was claimed" holds. A killed or
 * failed `-b` add can leave the new branch, a partial directory and a
 * registration; the next attempt then refused on "already exists" and
 * branch-reconcile kept the empty branch, so the issue could not be claimed
 * here again. The directory was proven absent before the add, so whatever is
 * there now is this add's debris. Best-effort: each step swallows its error.
 */
async function rollBackClaimCheckout(sourceWorkspace, worktreePath, branch, addError) {
  const [{ listWorktrees, WORKTREE_ADD_TIMEOUT_MS }, { cleanupOrphanBranch }, { pathsEqual }] = await Promise.all([
    import('./worktreeManager.js'), import('./worktree/create.js'), import('./worktree/paths.js'),
  ]);
  // Forced twice: a killed add leaves its registration locked as "initializing".
  await execGit(['worktree', 'remove', '--force', '--force', worktreePath], sourceWorkspace,
    { ignoreExitCode: true, timeout: WORKTREE_ADD_TIMEOUT_MS }).catch(() => null);
  const registered = await listWorktrees(sourceWorkspace).then(
    entries => entries.some(wt => pathsEqual(wt.path, worktreePath)), () => null);
  // Git cannot remove a directory it no longer registers.
  if (registered === false && existsSync(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true })
      .catch(error => console.log(`⚠️ Removing partial claim checkout ${worktreePath} failed: ${error.message}`));
  }
  await cleanupOrphanBranch(sourceWorkspace, branch, addError);
}

/**
 * Fetch the default branch and cut `branch` from it into the claim directory.
 * An existing claim ref or a checkout at the claim path blocks provisioning.
 * A Git-free residue directory can be removed before a new checkout is cut.
 *
 * @returns {Promise<{ claimCheckout: { repoPath: string, worktreePath: string, branchName: string, baseBranch: string } }|{ refused: string }>}
 */
export async function provisionClaimCheckout({ app, sourceWorkspace, branch, worktreesRoot = PATHS.worktrees }) {
  const [{ getDefaultBranch }, { addWorktreeWithRetry, linkWorktreeDependencies }, { removeUnregisteredWorktreeResidue }] = await Promise.all([
    import('./git/status.js'), import('./worktreeManager.js'), import('./worktree/remove.js'),
  ]);
  const issueNumber = branch.replace(/^claim\/issue-/, '');
  const worktreePath = claimCheckoutPath(app, issueNumber, worktreesRoot);
  const baseBranch = await getDefaultBranch(sourceWorkspace, { strict: true }).catch(() => null);
  if (!baseBranch) return { refused: 'the default branch could not be resolved' };
  const fetched = await execGit(['fetch', 'origin', baseBranch], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  if (fetched?.exitCode !== 0) return { refused: `fetching origin/${baseBranch} failed` };

  const targetNum = Number(issueNumber);
  // Check every documented claim ref pattern (claim/issue-<n>, next/issue-<n>,
  // cos/<task>/issue-<n>/<agent>) locally and on origin so the agent does not
  // have to repeat `git branch -a` / `git ls-remote` in Phase 1.
  const localRefs = await execGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], sourceWorkspace, { ignoreExitCode: true }).catch(() => null);
  if (localRefs?.exitCode !== 0) return { refused: `the local ${branch} ref could not be read` };
  const localCollision = String(localRefs.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
    .find(ref => ref === branch || claimIssueNumber(ref) === targetNum);
  if (localCollision) return { refused: `${localCollision} already exists locally` };

  const remoteRefs = await execGit(['ls-remote', '--heads', 'origin'], sourceWorkspace,
    { ignoreExitCode: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).catch(() => null);
  if (remoteRefs?.exitCode !== 0) return { refused: `origin's ${branch} ref could not be read` };
  const remoteCollision = String(remoteRefs.stdout || '').split('\n')
    .map(line => line.split('\t')[1]?.trim().replace(/^refs\/heads\//, '') || '')
    .filter(Boolean)
    .find(ref => ref === branch || claimIssueNumber(ref) === targetNum);
  if (remoteCollision) return { refused: `${remoteCollision} already exists on origin` };

  const refused = await queueWorktreeCreate(sourceWorkspace, async () => {
    const absent = await lstat(worktreePath).then(() => false, error => error.code === 'ENOENT');
    if (!absent && !await removeUnregisteredWorktreeResidue(sourceWorkspace, worktreePath, { worktreesRoot })) {
      return `${worktreePath} already exists or could not be cleared`;
    }
    await ensureDir(worktreesRoot);
    // The shared add carries the long worktree timeout and lock retry: a large
    // repository's checkout outlasts execGit's 30s default under load.
    const addError = await addWorktreeWithRetry(['worktree', 'add', '--no-track', '-b', branch, worktreePath, `origin/${baseBranch}`],
      sourceWorkspace).then(() => null, error => error);
    if (!addError) return null;
    await rollBackClaimCheckout(sourceWorkspace, worktreePath, branch, addError);
    return `git worktree add failed: ${String(addError.message || '').trim().split('\n')[0]}`;
  });
  if (refused) return { refused };

  const dependencies = await linkWorktreeDependencies(sourceWorkspace, worktreePath, {
    verifyRootLockfile: app.id !== PORTOS_APP_ID,
  }).catch(error => {
    console.error(`❌ Provisioning dependencies into ${worktreePath} failed: ${error.message}`);
    return null;
  });
  return { claimCheckout: { repoPath: sourceWorkspace, worktreePath, branchName: branch, baseBranch, dependencies } };
}
