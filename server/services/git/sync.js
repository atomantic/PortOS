import { existsSync } from 'fs';
import { realpath } from 'fs/promises';
import { join, resolve } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { execGit, execGitSafe } from '../../lib/execGit.js';
import { clearStaleGitLock } from '../../lib/gitStaleLock.js';
import { assertSafeRef } from '../../lib/gitArgs.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  withCheckoutMutation,
  SEQUENCER_STATE,
  SHARED_REBASE_RECOVERY,
  gitResultOutput,
  gitResultError,
  rebaseInProgress
} from './checkoutMutation.js';
import { getStatus, getBranch, getBranches, getDefaultBranch, getRemote } from './status.js';
import { recordFetchSuccess, isFetchFresh, clearFetchCache, fetchOrigin, getRemoteBranches } from './fetch.js';

export { recordFetchSuccess, isFetchFresh, clearFetchCache, fetchOrigin, getRemoteBranches };

const SUBMODULE_UPDATE_TIMEOUT_MS = 60000;

/**
 * Update all local branches that have remote tracking branches.
 * Uses fetch refspecs for non-current branches to avoid checkout (which
 * would swap files on disk and trigger HMR/server restarts).
 */
export async function updateBranches(dir) {
  return withCheckoutMutation(dir, () => updateBranchesAdmitted(dir));
}

async function updateBranchesAdmitted(dir) {
  await fetchOrigin(dir);

  const status = await getStatus(dir);
  const currentBranch = await getBranch(dir);
  const allBranches = await getBranches(dir);
  const trackBranches = allBranches.filter(b => b.tracking).map(b => b.name);

  const results = { currentBranch };

  // Update non-current branches via fetch refspec (no checkout needed)
  for (const branch of trackBranches.filter(b => b !== currentBranch)) {
    const r = await execGit(['fetch', 'origin', `${branch}:${branch}`], dir, { ignoreExitCode: true });
    results[branch] = (r.stderr?.includes('fatal') || r.stderr?.includes('rejected')) ? 'failed' : 'updated';
  }

  // Update current branch if it's one of the tracked branches — requires merge
  // Skip if working tree is dirty — other agents may own those uncommitted changes
  if (trackBranches.includes(currentBranch)) {
    if (!status.clean) {
      results[currentBranch] = 'skipped-dirty';
    } else {
      const r = await execGit(['merge', '--ff-only', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
      results[currentBranch] = r.stderr?.includes('fatal') ? 'failed' : 'updated';
    }
  }

  return results;
}

/**
 * Push to origin
 */
export async function push(dir, branch = null) {
  return withCheckoutMutation(dir, () => pushAdmitted(dir, branch));
}

async function pushAdmitted(dir, branch = null) {
  if (branch) assertSafeRef(branch);
  const args = branch ? ['push', 'origin', branch] : ['push'];
  const result = await execGit(args, dir);
  return { success: true, output: result.stdout + result.stderr };
}

/**
 * Push all local branches that are ahead of their remote tracking branch.
 * Never uses --force. Returns per-branch results.
 */
export async function pushAll(dir) {
  return withCheckoutMutation(dir, () => pushAllAdmitted(dir));
}

async function pushAllAdmitted(dir) {
  const allBranches = await getBranches(dir);
  const pushable = allBranches.filter(b => b.tracking && b.ahead > 0);

  if (pushable.length === 0) {
    return { success: true, pushed: 0, results: {}, message: 'Nothing to push' };
  }

  const results = {};
  let failed = 0;

  for (const branch of pushable) {
    const r = await execGit(['push', 'origin', branch.name], dir, { ignoreExitCode: true });
    const output = (r.stdout || '') + (r.stderr || '');
    const ok = r.exitCode === 0;
    results[branch.name] = { success: ok, output: output.trim() };
    if (!ok) failed++;
  }

  return {
    success: failed === 0,
    pushed: pushable.length - failed,
    failed,
    total: pushable.length,
    results
  };
}

/**
 * Create and switch to a new branch
 */
export async function createBranch(dir, branchName) {
  return withCheckoutMutation(dir, () => createBranchAdmitted(dir, branchName));
}

async function createBranchAdmitted(dir, branchName) {
  await execGit(['checkout', '-b', branchName], dir);
  return { success: true, branch: branchName };
}

/**
 * Switch to an existing branch
 */
export async function checkout(dir, branchName) {
  return withCheckoutMutation(dir, () => checkoutAdmitted(dir, branchName));
}

async function checkoutAdmitted(dir, branchName) {
  assertSafeRef(branchName);
  await execGit(['checkout', branchName], dir);
  return { success: true, branch: branchName };
}

/**
 * Merge a branch into the current branch.
 * Uses --no-ff to always create a merge commit for traceability.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch to merge into current
 * @returns {Promise<{success: boolean, output: string}>}
 */
export async function mergeBranch(dir, branchName) {
  return withCheckoutMutation(dir, () => mergeBranchAdmitted(dir, branchName));
}

async function mergeBranchAdmitted(dir, branchName) {
  assertSafeRef(branchName);
  const result = await execGit(['merge', '--no-ff', branchName], dir);
  return { success: true, output: (result.stdout + result.stderr).trim() };
}

/**
 * Checkout a remote branch that doesn't exist locally.
 * Creates a local tracking branch from the remote ref.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch name (without origin/ prefix)
 * @returns {Promise<{success: boolean, branch: string}>}
 */
export async function checkoutRemoteBranch(dir, branchName) {
  return withCheckoutMutation(dir, () => checkoutRemoteBranchAdmitted(dir, branchName));
}

async function checkoutRemoteBranchAdmitted(dir, branchName) {
  assertSafeRef(branchName);
  await execGit(['checkout', '-b', branchName, `origin/${branchName}`], dir);
  return { success: true, branch: branchName };
}

/**
 * Run a pinned-submodule command, retrying once when Git names an abandoned
 * lock. `git submodule update` is safe to retry after that specific rescue:
 * unlike a pull/rebase, it has no partially-applied history operation to stack
 * on top of.
 */
async function runPinnedSubmoduleCommand(args, dir) {
  let result = await execGitSafe(args, dir, { timeout: SUBMODULE_UPDATE_TIMEOUT_MS });
  if (result.exitCode === 0 || !clearStaleGitLock(result.stderr)) return result;
  result = await execGitSafe(args, dir, { timeout: SUBMODULE_UPDATE_TIMEOUT_MS });
  return result;
}

/**
 * Synchronize submodule URLs and check out the commits pinned by the parent.
 * The parent gitlink is the version contract; `--remote` is intentionally not
 * used because a managed-app update must not consume an unreviewed submodule
 * head. Kept private because callers need the parent update transaction, not
 * an independently exposed submodule workflow.
 */
async function updatePinnedSubmodules(dir) {
  const sync = await runPinnedSubmoduleCommand(['submodule', 'sync', '--recursive'], dir);
  if (sync.exitCode !== 0) {
    return {
      success: false,
      output: gitResultOutput(sync),
      error: gitResultError(sync, 'could not synchronize submodule metadata')
    };
  }

  const update = await runPinnedSubmoduleCommand(['submodule', 'update', '--init', '--recursive'], dir);
  return {
    success: update.exitCode === 0,
    output: gitResultOutput(update),
    ...(update.exitCode === 0
      ? {}
      : { error: gitResultError(update, 'could not update pinned submodules') })
  };
}

/**
 * Move a managed application's primary checkout onto origin's default branch
 * and bring it up to date. Non-destructive: nothing is discarded, and local
 * work is preserved either by carrying it across the checkout or by git's own
 * `--autostash` (which re-applies it after the rebase).
 *
 * @param {string} dir
 * @returns {Promise<{success: boolean, branch: string, output: string, conflict: boolean, rebased?: boolean, error?: string}>}
 */
export async function updateDefaultBranch(dir) {
  return withCheckoutMutation(dir, () => updateDefaultBranchAdmitted(dir));
}

async function updateDefaultBranchAdmitted(dir) {
  if (await rebaseInProgress(dir)) {
    return { success: false, branch: await getBranch(dir), output: '', conflict: true, error: `A rebase is already in progress. ${SHARED_REBASE_RECOVERY}` };
  }
  // Git splits a failed pull across both streams — fetch progress and rebase
  // instructions on stderr, the `CONFLICT (content): …` lines naming the files
  // on stdout — so an `stderr || stdout` pick would drop the colliding files.
  const bothStreams = (result, fallback) => gitResultError(result, fallback);

  // A killed `fetch` can leave a shared ref lock (`refs/remotes/origin/*.lock`,
  // `packed-refs.lock`) that every worktree of this repo shares. `fetch` is
  // idempotent, so this uses the same clear-and-retry-once shape as
  // `updateSubmodule` rather than surfacing a permanent, confusing failure.
  await execGit(['fetch', 'origin'], dir).catch(async (err) => {
    if (!clearStaleGitLock(err.message)) throw err;
    await execGit(['fetch', 'origin'], dir);
  });
  const runtimeBranch = await execGit(['config', '--get', 'portos.runtimeBranch'], dir, { ignoreExitCode: true });
  const branch = runtimeBranch.stdout.trim() || await getDefaultBranch(dir, { strict: true });
  if (!branch) throw new ServerError('could not determine origin default branch', { status: 400, code: 'NO_DEFAULT_BRANCH' });

  const currentBranch = await getBranch(dir);
  let output = '';
  const reconcileSubmodules = async () => {
    const submodules = await updatePinnedSubmodules(dir);
    output += submodules.output;
    return submodules.success ? null : {
      success: false,
      branch,
      output,
      conflict: true,
      error: `pinned submodule update failed: ${submodules.error}`
    };
  };

  const currentSubmoduleError = await reconcileSubmodules();
  if (currentSubmoduleError) return currentSubmoduleError;

  if (currentBranch !== branch) {
    const checkoutResult = await execGit(['checkout', branch], dir, { ignoreExitCode: true });
    output += checkoutResult.stdout + checkoutResult.stderr;
    if (checkoutResult.exitCode !== 0) {
      // Checkout can leave a partially-written index, so a lock found here is
      // cleared but NOT retried — the next explicit attempt starts lock-free.
      const clearedLock = clearStaleGitLock(checkoutResult.stderr);
      return {
        success: false,
        branch,
        output,
        conflict: true,
        error: clearedLock
          ? `Cleared an abandoned git lock (${clearedLock}) left by a killed git process. The checkout onto ${branch} did not run — retry the update now that the lock is clear.`
          : bothStreams(checkoutResult, `could not check out ${branch}`)
      };
    }

    const targetSubmoduleError = await reconcileSubmodules();
    if (targetSubmoduleError) return targetSubmoduleError;
  }

  const fastForward = await execGit(['pull', '--ff-only', 'origin', branch], dir, { ignoreExitCode: true });
  output += fastForward.stdout + fastForward.stderr;
  if (await rebaseInProgress(dir) || fastForward.terminated) {
    return { success: false, branch, output, conflict: true, error: `${bothStreams(fastForward, 'Pull did not complete.')} ${SHARED_REBASE_RECOVERY}` };
  }
  if (fastForward.exitCode === 0) {
    const submoduleError = await reconcileSubmodules();
    if (submoduleError) return submoduleError;
    return { success: true, branch, output, conflict: false };
  }

  const fastForwardLock = clearStaleGitLock(fastForward.stderr);
  if (fastForwardLock) {
    return {
      success: false,
      branch,
      output,
      conflict: true,
      error: `Cleared an abandoned git lock (${fastForwardLock}) left by a killed git process. The fast-forward pull did not run — retry the update now that the lock is clear.`
    };
  }

  const rebase = await execGit(['pull', '--rebase', '--autostash', 'origin', branch], dir, { ignoreExitCode: true });
  output += rebase.stdout + rebase.stderr;
  const activeRebase = await rebaseInProgress(dir);
  if (rebase.exitCode === 0 && !rebase.terminated && !activeRebase) {
    const unmerged = await execGit(['diff', '--name-only', '--diff-filter=U'], dir, { ignoreExitCode: true });
    const conflicted = unmerged.stdout.trim().split('\n').filter(Boolean);
    if (unmerged.exitCode === 0 && !unmerged.terminated && !conflicted.length) {
      const submoduleError = await reconcileSubmodules();
      if (submoduleError) return submoduleError;
      return { success: true, branch, output, conflict: false, rebased: true };
    }
    return {
      success: false,
      branch,
      output,
      conflict: true,
      error: conflicted.length
        ? `re-applying the autostashed local changes conflicted in: ${conflicted.join(', ')}`
        : bothStreams(unmerged, 'Could not verify local changes after rebasing.')
    };
  }

  const rebaseLock = Number.isInteger(rebase.exitCode) && !rebase.terminated && !activeRebase
    && clearStaleGitLock(rebase.stderr);
  return {
    success: false,
    branch,
    output,
    conflict: true,
    error: rebaseLock
      ? `Cleared an abandoned git lock (${rebaseLock}). The rebase did not complete; inspect the checkout before retrying. ${SHARED_REBASE_RECOVERY}`
      : `${bothStreams(rebase, `rebase onto origin/${branch} did not complete`)} ${SHARED_REBASE_RECOVERY}`
  };
}

/**
 * Sync branch - pull then push
 */
export async function syncBranch(dir, branch = null) {
  return withCheckoutMutation(dir, () => syncBranchAdmitted(dir, branch), { exclusive: true });
}

/** Reconcile local default-branch commits with origin without stashing or force-pushing. */
export async function rebaseAndPushDefaultBranch(dir) {
  return withCheckoutMutation(dir, () => rebaseAndPushDefaultBranchAdmitted(dir), { exclusive: true });
}

async function rebaseAndPushDefaultBranchAdmitted(dir) {
  const refused = (error) => ({ success: false, pulled: false, pushed: false, error });
  const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], dir)).stdout.trim();
  if ([...SEQUENCER_STATE.map(([marker]) => marker), 'MERGE_HEAD', 'sequencer']
    .some(marker => existsSync(join(gitDir, marker)))) {
    return refused('Finish the Git operation already in progress before rebasing and pushing.');
  }
  const branch = await getBranch(dir);
  const defaultBranch = await getDefaultBranch(dir, { strict: true });
  if (!defaultBranch || branch !== defaultBranch) {
    return refused('Check out the default branch before rebasing and pushing.');
  }
  assertSafeRef(branch);
  if (!(await getStatus(dir)).clean) {
    return refused('Commit or stash local changes before rebasing and pushing.');
  }
  await fetchOrigin(dir);
  if (await getBranch(dir) !== branch || !(await getStatus(dir)).clean) {
    return refused('The checkout changed while fetching. Check its branch and local changes before retrying.');
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  const counts = await execGit(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], dir);
  if (!(Number(counts.stdout.trim().split(/\s+/)[0]) > 0)) {
    return refused('The default branch has no local commits ahead of origin.');
  }
  const localMerges = await execGit(['rev-list', '--merges', `${remoteRef}..HEAD`], dir);
  if (localMerges.stdout.trim()) {
    return refused('Local history contains merge commits. Reconcile these with an agent or in the terminal to preserve merge resolutions; nothing was rebased or pushed.');
  }
  // Fetch + rebase is the explicit-origin equivalent of pull --rebase. Avoid
  // pull.ff / upstream configuration and never move dirty work via autostash.
  const rebased = await execGit(['rebase', '--no-autostash', remoteRef], dir, { ignoreExitCode: true });
  if (rebased.exitCode !== 0 || rebased.terminated || await rebaseInProgress(dir)) {
    return refused(`${gitResultError(rebased, 'Rebase did not complete.')} ${SHARED_REBASE_RECOVERY} Nothing was pushed.`);
  }
  if (await getBranch(dir) !== branch) return refused('The checked-out branch changed; nothing was pushed.');
  const verifiedHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], dir)).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(verifiedHead)) return refused('Could not verify the default-branch commit; nothing was pushed.');
  const pushed = await execGit(['push', 'origin', `${verifiedHead}:refs/heads/${branch}`], dir, { ignoreExitCode: true });
  return {
    success: pushed.exitCode === 0,
    branch,
    pulled: true,
    pushed: pushed.exitCode === 0,
    output: gitResultOutput(rebased) + gitResultOutput(pushed),
    error: pushed.exitCode === 0 ? null : gitResultError(pushed, 'Push failed; rebased commits remain local.'),
  };
}

async function syncBranchAdmitted(dir, branch = null) {
  if (branch) assertSafeRef(branch);
  const refused = error => ({ success: false, pulled: false, pushed: false, error });
  const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], dir)).stdout.trim();
  const operationInProgress = () => [...SEQUENCER_STATE.map(([marker]) => marker), 'MERGE_HEAD', 'sequencer']
    .some(marker => existsSync(join(gitDir, marker)));
  if (operationInProgress()) {
    return refused('Finish the Git operation already in progress before syncing.');
  }
  const currentBranch = branch || await getBranch(dir);
  const pullResult = await execGit(['pull', '--rebase', '--autostash', 'origin', currentBranch], dir, { ignoreExitCode: true });
  if (pullResult.exitCode !== 0 || pullResult.terminated) {
    // Preserve shared-checkout recovery: git has no generation-conditioned abort.
    const settled = Number.isInteger(pullResult.exitCode) && !pullResult.terminated;
    const activeOperation = operationInProgress();
    const clearedLock = settled && !activeOperation && clearStaleGitLock(pullResult.stderr);
    const recovery = activeOperation
      ? ' Git operation state and any autostash were preserved. Inspect git status and save any conflict-resolution edits before explicitly continuing or aborting the operation; nothing was pushed.' : '';
    const error = clearedLock
      ? `Cleared an abandoned git lock (${clearedLock}) left by a killed git process. The pull did not complete — inspect the checkout before retrying the sync.`
      : gitResultError(pullResult, 'Pull failed; nothing was pushed.');
    return refused(`${error}${recovery}`);
  }

  // A separate actor can start an operation during pull, including one with
  // staged resolutions that lets pull exit zero. It still must not be pushed.
  if (operationInProgress()) {
    return refused('A Git operation is in progress after pulling. Its state and edits were preserved; inspect git status and finish that operation before syncing again. Nothing was pushed.');
  }

  // Autostash reapplication can conflict after Git has exited successfully.
  const unmerged = await execGit(['diff', '--name-only', '--diff-filter=U'], dir, { ignoreExitCode: true });
  if (unmerged.exitCode !== 0) {
    return refused(gitResultError(unmerged, 'Could not verify local changes after pulling; nothing was pushed.'));
  }
  if (unmerged.stdout.trim()) {
    return refused(`Re-applying autostashed local changes conflicted in: ${unmerged.stdout.trim()}. Resolve the conflicts before syncing again; nothing was pushed.`);
  }

  const pushResult = await execGit(['push', 'origin', currentBranch], dir, { ignoreExitCode: true });
  const pushSuccess = pushResult.exitCode === 0 && !pushResult.terminated;
  return {
    success: pushSuccess,
    pulled: true,
    pushed: pushSuccess,
    output: gitResultOutput(pullResult) + gitResultOutput(pushResult),
    error: pushSuccess ? null : gitResultError(pushResult, 'Push failed; local commits remain in the checkout.')
  };
}

// One pre-task pull per checkout at a time. Several agents for the same app
// prep concurrently; serialize them so a later request sees any stopped
// operation at preflight instead of launching Git on top of it.
const ensureLatestTails = new Map();

/**
 * Ensure workspace has the latest code from origin before agent work begins.
 * Scripted pull: fetch + fast-forward merge on the dev/default branch.
 * If the working tree is dirty, skips the pull — other agents may own those
 * uncommitted changes and stashing could interfere with their work.
 *
 * @param {string} dir - Git repository directory
 * @returns {{ success: boolean, branch: string, conflict: boolean, error: string|null }}
 */
export async function ensureLatest(dir) {
  const gitCheck = await execGit(['rev-parse', '--is-inside-work-tree'], dir, { ignoreExitCode: true });
  if (gitCheck.exitCode === 128
    && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)/im.test(gitCheck.stderr || '')) {
    return { success: true, branch: null, conflict: false, error: null, skipped: 'not-a-repo' };
  }
  if (gitCheck.exitCode !== 0 || gitCheck.stdout.trim() !== 'true') {
    throw new Error(gitCheck.stderr?.trim() || 'Could not verify Git working tree');
  }
  return withCheckoutMutation(dir, () => ensureLatestAdmitted(dir));
}

function ensureLatestAdmitted(dir) {
  const key = resolve(dir);
  const prev = ensureLatestTails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => ensureLatestUnserialized(dir));
  const tail = run.catch(() => {});
  ensureLatestTails.set(key, tail);
  tail.then(() => { if (ensureLatestTails.get(key) === tail) ensureLatestTails.delete(key); });
  return run;
}

// git's rebase failure output is a multi-line block of `hint:` advice with a
// `\r`-overwritten progress line glued in front — the part worth logging is
// the error plus the CONFLICT lines naming the files.
function summarizeRebaseConflict({ stdout = '', stderr = '' } = {}) {
  const lines = `${stdout}\n${stderr}`.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const keep = lines.filter(l => /^(CONFLICT|error:|fatal:)/.test(l));
  return (keep.length ? keep : lines.filter(l => !l.startsWith('hint:')).slice(0, 3)).join('; ') || 'rebase failed';
}

async function ensureLatestUnserialized(dir) {
  // A rebase left in progress is someone's (a person's, or an agent resolving a
  // conflict) — never start a second one on top of it, and never abort it.
  if (await rebaseInProgress(dir)) {
    const branch = await getBranch(dir).catch(() => null);
    return {
      success: false,
      branch,
      conflict: true,
      error: 'a rebase is already in progress in this checkout; finish it (git rebase --continue) or abort it (git rebase --abort)'
    };
  }

  const currentBranch = await getBranch(dir).catch(() => null);
  if (!currentBranch) return { success: true, branch: null, conflict: false, error: null, skipped: 'no-branch' };

  // Check for remote — no remote means nothing to pull
  const remote = await getRemote(dir).catch(() => null);
  if (!remote?.origin) return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'no-remote' };

  // Fetch latest refs from origin. Idempotent, so an abandoned lock (left by a
  // killed git process, shared by every worktree of this repo) is cleared and
  // retried once rather than reported as a permanent failure.
  let fetchResult = await execGit(['fetch', 'origin'], dir, { ignoreExitCode: true });
  if (fetchResult.stderr?.includes('fatal') && clearStaleGitLock(fetchResult.stderr)) {
    fetchResult = await execGit(['fetch', 'origin'], dir, { ignoreExitCode: true });
  }
  if (fetchResult.stderr?.includes('fatal')) {
    return { success: false, branch: currentBranch, conflict: false, error: `fetch failed: ${fetchResult.stderr}` };
  }
  recordFetchSuccess(dir);

  // Check if remote tracking branch exists
  const remoteRef = await execGit(['rev-parse', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  if (remoteRef.stderr?.includes('unknown revision')) {
    return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'no-remote-tracking' };
  }

  // Check if already up to date
  const localHead = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  const remoteHead = remoteRef.stdout.trim();
  if (localHead === remoteHead) {
    return { success: true, branch: currentBranch, conflict: false, error: null, upToDate: true };
  }

  // Skip pull if working tree is dirty — other agents may own those changes
  const status = await getStatus(dir).catch(() => ({ clean: true }));
  if (!status.clean) {
    return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'dirty-working-tree' };
  }

  // Try fast-forward merge first (safest — no rewrite)
  const mergeResult = await execGit(['merge', '--ff-only', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  if (await rebaseInProgress(dir) || mergeResult.terminated) {
    return { success: false, branch: currentBranch, conflict: true, error: `${summarizeRebaseConflict(mergeResult)} ${SHARED_REBASE_RECOVERY}` };
  }
  const mergeOk = mergeResult.exitCode === 0;

  if (mergeOk) {
    await noteLockfileChanges(dir, localHead);
    return { success: true, branch: currentBranch, conflict: false, error: null };
  }

  // A lock found here is cleared but NOT retried — a blind retry could race a
  // still-write-in-progress index. Surface it so the next explicit attempt
  // starts from a lock-free repo.
  const mergeLock = clearStaleGitLock(mergeResult.stderr);
  if (mergeLock) {
    return {
      success: false,
      branch: currentBranch,
      conflict: true,
      error: `Cleared an abandoned git lock (${mergeLock}) left by a killed git process. The fast-forward merge did not complete — retry now that the lock is clear.`
    };
  }

  // Fast-forward failed — local branch has diverged. Try rebase.
  const rebaseResult = await execGit(['rebase', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  const activeRebase = await rebaseInProgress(dir);
  if (rebaseResult.exitCode !== 0 || rebaseResult.terminated || activeRebase) {
    const rebaseLock = Number.isInteger(rebaseResult.exitCode) && !rebaseResult.terminated && !activeRebase
      && clearStaleGitLock(rebaseResult.stderr);
    return {
      success: false,
      branch: currentBranch,
      conflict: true,
      error: rebaseLock
        ? `Cleared an abandoned git lock (${rebaseLock}). The rebase did not complete; inspect the checkout before retrying. ${SHARED_REBASE_RECOVERY}`
        : `branch ${currentBranch} has diverged from origin and rebase did not complete: ${summarizeRebaseConflict(rebaseResult)} ${SHARED_REBASE_RECOVERY}`
    };
  }

  await noteLockfileChanges(dir, localHead);
  return { success: true, branch: currentBranch, conflict: false, error: null };
}

// Advancing the PortOS source checkout never reinstalls, so a range that changes
// a workspace lockfile leaves node_modules stale for every linked claim. Record
// it for the idle updater (#17511); managed apps' checkouts are not ours to reconcile.
async function noteLockfileChanges(dir, before) {
  if (await realpath(dir).catch(() => resolve(dir)) !== await realpath(PATHS.root).catch(() => resolve(PATHS.root))) return;
  // Deferred: the boot import closure is capped (lib/importScoping.test.js).
  const { changedDependencyLockfiles, markDependencyReconcilePending } = await import('../../../scripts/lib/dependencyReconcile.js');
  const diff = await execGit(['diff', '--name-only', before, 'HEAD'], dir, { ignoreExitCode: true });
  const lockfiles = diff.exitCode === 0 ? changedDependencyLockfiles(diff.stdout.split(/\r?\n/)) : [];
  if (!lockfiles.length) return;
  markDependencyReconcilePending(PATHS.data, lockfiles);
  console.log(`📦 Source checkout lockfiles changed (${lockfiles.join(', ')}) — dependency reconcile queued for the next idle update`);
}
