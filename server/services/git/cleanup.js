import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { execGit, execGitSafe } from '../../lib/execGit.js';
import { PROTECTED_BRANCHES } from '../../lib/gitArgs.js';
import { ServerError } from '../../lib/errorHandler.js';
import { claimCheckoutOwnerReason } from '../../lib/claimContinuation.js';
import { requireMergedBranchCleanup } from '../bootHookRegistry.js';
import { withCheckoutMutation, SEQUENCER_STATE } from './checkoutMutation.js';
import { getBranch, getDefaultBranch, getRepoBranches, getStatusPorcelain } from './status.js';
import { fetchOrigin } from './fetch.js';
import {
  readBranchLineage,
  readBranchAgeMs,
  readBranchPublished,
  hasBranchMergeEvidence
} from './branchEvidence.js';

export { readBranchLineage, readBranchAgeMs, readBranchPublished, hasBranchMergeEvidence };

/**
 * Get branch names that are checked out in git worktrees.
 * Delegates to worktreeManager's listWorktrees to avoid duplicating porcelain parsing.
 * @param {string} dir - Working directory (main repo root)
 * @returns {Promise<Set<string>>} Set of branch names in active worktrees
 */
export async function getWorktreeBranches(dir) {
  const { listWorktrees } = await import('../worktreeManager.js');
  const worktrees = await listWorktrees(dir).catch(() => []);
  return new Set(
    worktrees
      .filter(wt => wt.branch)
      .map(wt => wt.branch.replace(/^refs\/heads\//, ''))
  );
}

/**
 * Delete a branch locally, remotely, or both.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch name to delete
 * @param {object} options
 * @param {boolean} options.local - Delete local branch
 * @param {boolean} options.remote - Delete remote branch
 * @param {string} [options.expectedHead] - Exact caller-observed local ref (local-only operation)
 * @param {Set<string>} options.excludeBranches - Additional branches to protect (e.g., active agent branches)
 */
export async function deleteBranch(dir, branchName, options = {}) {
  return withCheckoutMutation(dir, () => deleteBranchAdmitted(dir, branchName, options));
}

async function deleteBranchAdmitted(dir, branchName, { local = false, remote = false, excludeBranches, expectedHead = null } = {}) {
  if (expectedHead && (!local || remote || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead))) {
    throw new ServerError('Expected head requires a valid local-only deletion', { status: 400, code: 'INVALID_BRANCH_DELETION' });
  }
  const { baseBranch } = await getRepoBranches(dir);
  const protectedSet = new Set(PROTECTED_BRANCHES);
  if (baseBranch) protectedSet.add(baseBranch);
  if (protectedSet.has(branchName)) {
    throw new Error(`Cannot delete protected branch: ${branchName}`);
  }

  // Safety: don't delete the current branch
  const currentBranch = await getBranch(dir);
  if (currentBranch === branchName && local) {
    throw new Error(`Cannot delete the currently checked-out branch: ${branchName}`);
  }

  // Safety: don't delete branches checked out in worktrees (active agent workspaces)
  if (local) {
    const worktreeBranches = await getWorktreeBranches(dir);
    if (worktreeBranches.has(branchName)) {
      throw new Error(`Cannot delete branch checked out in a worktree: ${branchName}`);
    }
  }

  // Safety: don't delete branches explicitly excluded (e.g., active CoS agent branches)
  if (excludeBranches?.has(branchName)) {
    throw new Error(`Cannot delete branch in active use by an agent: ${branchName}`);
  }

  const opts = { ignoreExitCode: true };
  const localResult = local ? await deletePinnedLocalBranch(dir, branchName, expectedHead) : null;
  // A local owner/ref refusal retains the whole branch, including its remote.
  const localRefused = localResult && localResult.exitCode !== 0 && !localResult.notFound;
  const remoteResult = remote && !localRefused
    ? await execGitSafe(['push', 'origin', '--delete', branchName], dir, opts) : null;

  const results = {};
  if (localResult) {
    results.local = localResult.exitCode === 0
      ? 'deleted'
      : localResult.stderr?.includes('not found') ? 'not found' : `failed: ${localResult.stderr?.trim()}`;
  }
  if (remote && localRefused) results.remote = 'retained: local branch deletion refused';
  if (remoteResult) {
    results.remote = remoteResult.exitCode === 0
      ? 'deleted'
      : remoteResult.stderr?.includes('not found') || remoteResult.stderr?.includes('does not exist')
        ? 'not found'
        : `failed: ${remoteResult.stderr?.trim()}`;
  }

  return { branch: branchName, results };
}

/** Operator-selected ref removal shares the existing receiver's holder check and
 * exact-head transaction. It never certifies a merge or removes a checkout. */
async function deletePinnedLocalBranch(dir, branch, expectedHead) {
  const ref = `refs/heads/${branch}`;
  const observed = await execGitSafe(['rev-parse', '--verify', `${ref}^{commit}`], dir, { ignoreExitCode: true });
  const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('../cos/cosClaimOwnershipState.js');
  const assertNoOwner = async () => {
    const agents = await readClaimOwnershipAgents();
    const hold = claimCheckoutOwnerReason({ branchName: branch, holderPath: null, sourceWorkspace: dir, agents });
    if (hold) throw new ServerError(`Branch retained: ${hold}`, { status: 409, code: 'BRANCH_OWNER_HELD' });
  };
  if (observed.exitCode !== 0) {
    // Only a confirmed absent ref is compatible with continuing a combined
    // remote deletion. A broken symbolic ref or an unreadable ref is a refusal.
    const { readLocalBranchPresence } = await import('../repoCleanupObservation.js');
    const notFound = await readLocalBranchPresence(dir, branch) === false;
    if (notFound) await withClaimOwnershipLock(assertNoOwner);
    return { exitCode: 1, stderr: notFound ? 'branch not found' : 'unable to resolve branch head', notFound };
  }
  const head = observed.stdout.trim();
  if (expectedHead && expectedHead !== head) throw new ServerError('Branch head changed', { status: 409, code: 'BRANCH_HEAD_CHANGED' });
  return withClaimOwnershipLock(async () => {
    const beforeMutation = async () => {
      await assertNoOwner();
      // Preserve squash-only or explicitly discarded source using the existing
      // private completed-ref namespace, never a repository archive.
      const backup = `refs/portos/completed/${head}`;
      const existing = await execGitSafe(['show-ref', '--verify', '--hash', backup], dir, { ignoreExitCode: true });
      if (existing.exitCode === 0 && existing.stdout.trim() !== head) throw new Error('Branch source preservation changed');
      if (existing.exitCode !== 0) await execGit(['update-ref', backup, head, '0'.repeat(head.length)], dir);
    };
    const { deleteCompletedLocalBranch } = await import('../worktreeManager.js');
    const deleted = await deleteCompletedLocalBranch(dir, branch, head, { beforeMutation });
    return { exitCode: deleted ? 0 : 1, stderr: deleted ? '' : 'branch head or holder changed' };
  });
}

/**
 * How many entries in raw `git status --porcelain` output a hard reset would
 * actually destroy — i.e. everything except untracked (`??`) files, which
 * survive because nothing here runs `git clean`.
 * @param {string} porcelain - Raw `git status --porcelain` stdout
 * @returns {number}
 */
export function countDiscardable(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('??'))
    .length;
}

/**
 * Drop any half-finished rebase / cherry-pick / revert.
 *
 * @param {string} dir - Repo root
 * @param {string} gitDirPath - Absolute path to the repo's git dir
 * @returns {Promise<string[]>} - The operations that were cleared
 */
async function clearSequencerState(dir, gitDirPath) {
  const stuck = [...new Set(
    SEQUENCER_STATE
      .filter(([marker]) => existsSync(join(gitDirPath, marker)))
      .map(([, command]) => command)
  )];
  for (const command of stuck) {
    await execGitSafe([command, '--quit'], dir);
  }
  return stuck;
}

/**
 * The id of a running CoS agent whose workspace IS `dir`, or null when none is.
 * Paths are compared after `resolve` so a trailing slash or a `..` segment on
 * either side doesn't let a live run slip past the check.
 *
 * Imported lazily: `services/git` is on the boot path and the agent
 * lifecycle module is not, so a static import would drag agent state into
 * every consumer of a git helper.
 * @param {string} dir - Repo root to check
 * @returns {Promise<string|null>} - Agent id, or null
 */
export async function findActiveAgentInWorkspace(dir, { includePaused = false, failClosed = false, excludeAgentId = null } = {}) {
  const { getAgents } = await import('../cos/cosAgentLifecycle.js').catch((err) => {
    if (failClosed) throw err;
    return { getAgents: null };
  });
  if (!getAgents) {
    if (failClosed) throw new Error('could not load the CoS agent registry');
    return null;
  }
  const agents = await getAgents().catch((err) => {
    if (failClosed) throw err;
    return [];
  });
  const target = resolve(dir);
  const busy = agents.find(agent =>
    agent.id !== excludeAgentId
    && (agent.status === 'running' || (includePaused && agent.status === 'paused'))
    && agent.metadata?.workspacePath
    && resolve(agent.metadata.workspacePath) === target
  );
  return busy?.id || null;
}

/**
 * Throw away every local change and put the checkout back on origin's default
 * branch, exactly as the remote has it. The escape hatch for a checkout that
 * has drifted — a lockfile a local toolchain keeps rewriting, a half-finished
 * edit, a branch left behind by an interrupted operation.
 *
 * @param {string} dir - Working directory (a repo root, not a linked worktree)
 * @returns {Promise<{success: boolean, branch: string, previousBranch: string|null,
 *   previousHead: string|null, discardedFiles: number, clearedOperations: string[],
 *   fetched: boolean}>}
 */
export async function resetToDefaultBranch(dir) {
  return withCheckoutMutation(dir, () => resetToDefaultBranchAdmitted(dir));
}

async function resetToDefaultBranchAdmitted(dir) {
  const dirs = await execGitSafe(['rev-parse', '--git-dir', '--git-common-dir'], dir);
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n').map(line => line.trim());
  if (gitDir && commonDir && gitDir !== commonDir) {
    throw new ServerError('cannot reset a linked worktree — run this on the main checkout', {
      status: 400,
      code: 'WORKTREE_RESET_REFUSED'
    });
  }

  const busyAgent = await findActiveAgentInWorkspace(dir);
  if (busyAgent) {
    throw new ServerError(
      `a CoS agent (${busyAgent}) is running in this checkout — stop it before resetting`,
      { status: 409, code: 'AGENT_RUNNING' }
    );
  }

  const fetched = await fetchOrigin(dir).then(() => true).catch(() => false);

  const branch = await getDefaultBranch(dir, { allowRemote: fetched });
  if (!branch) {
    throw new ServerError('could not determine the default branch', { status: 400, code: 'NO_DEFAULT_BRANCH' });
  }

  const target = `origin/${branch}`;
  const targetRef = await execGitSafe(['rev-parse', '--verify', `refs/remotes/${target}`], dir);
  if (targetRef.exitCode !== 0 || !targetRef.stdout.trim()) {
    throw new ServerError(`no ${target} ref to reset to`, { status: 400, code: 'NO_REMOTE_REF' });
  }

  const [headBefore, dirty] = await Promise.all([
    execGitSafe(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], dir),
    getStatusPorcelain(dir).catch(() => '')
  ]);
  const [head, branchName] = headBefore.stdout.trim().split('\n').map(line => line.trim());
  const previousHead = head || null;
  const previousBranch = branchName || null;

  const clearedOperations = await clearSequencerState(dir, resolve(dir, gitDir || '.git'));

  await execGit(['checkout', '--force', '-B', branch, target], dir);

  return {
    success: true,
    branch,
    previousBranch,
    previousHead,
    discardedFiles: countDiscardable(dirty),
    clearedOperations,
    fetched
  };
}

// Prose for each `reapMergedWorktrees` skip slug, so `skipped` says WHY a merged
// branch survived rather than only that it did. An unlisted slug falls back to
// the plain "it's in a worktree" phrasing.
const WORKTREE_HOLD_REASONS = {
  uncommitted: 'worktree has uncommitted changes',
  unmerged: 'worktree has unmerged commits',
  'status-failed': 'worktree status could not be read',
  'worktree-locked': 'worktree is locked',
  'worktree-active-agent': 'worktree is in use by a running agent',
  'worktree-agent-liveness-unknown': 'agent liveness unknown',
  'worktree-human-claim': 'worktree is a claimed session',
  'remove-failed': 'worktree removal failed and the checkout is still present'
};
const worktreeHoldReason = (reason) => WORKTREE_HOLD_REASONS[reason] || reason || 'checked out in a worktree';

async function prepareRemoteRetirement(dir, defaultBranch) {
  // A remote name resolves differently for fetch and push (and can change
  // while cleanup awaits). Require one identical endpoint and use its captured
  // URL for every read/write. Equivalent-looking aliases need explicit review.
  const [fetchUrls, pushUrls] = await Promise.all([
    execGitSafe(['remote', 'get-url', '--all', 'origin'], dir),
    execGitSafe(['remote', 'get-url', '--push', '--all', 'origin'], dir),
  ]);
  const fetchEndpoints = fetchUrls.stdout.trim().split(/\r?\n/).filter(Boolean);
  const pushEndpoints = pushUrls.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (fetchUrls.exitCode !== 0 || pushUrls.exitCode !== 0
      || fetchEndpoints.length !== 1 || pushEndpoints.length !== 1
      || fetchEndpoints[0] !== pushEndpoints[0]) {
    return { reason: 'fetch and push must identify one identical remote endpoint' };
  }
  const remoteUrl = fetchEndpoints[0];
  // origin/HEAD and a caller's remembered default can outlive a forge default
  // change. Establish the advertised default before any refresh or retirement.
  const advertised = await execGitSafe(['ls-remote', '--symref', '--', remoteUrl, 'HEAD'], dir);
  const symrefs = advertised.stdout.split(/\r?\n/).filter(line => line.startsWith('ref: '));
  const defaultMatch = symrefs.length === 1 ? /^ref: (refs\/heads\/.+)\tHEAD$/.exec(symrefs[0]) : null;
  if (advertised.exitCode !== 0 || !defaultMatch) return { reason: 'default-branch-unverified' };
  if (defaultMatch[1] !== `refs/heads/${defaultBranch}`) return { reason: 'default-branch-changed' };
  // A stale local default or an unsuccessful fetch never authorizes deletion.
  const fetched = await execGitSafe(['fetch', '--prune', '--', remoteUrl, '+refs/heads/*:refs/remotes/origin/*'], dir, { ignoreExitCode: true });
  if (fetched.exitCode !== 0) return { reason: 'remote default could not be refreshed' };
  const targetRef = `refs/heads/${defaultBranch}`;
  const targetHead = await execGitSafe(['ls-remote', '--heads', '--', remoteUrl, targetRef], dir);
  const targetMatch = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(targetHead.stdout.trim());
  const targetSha = targetMatch?.[1];
  if (targetHead.exitCode !== 0 || targetMatch?.[2] !== targetRef
      || (await execGitSafe(['rev-parse', '--verify', `${targetSha}^{commit}`], dir)).exitCode !== 0) {
    return { reason: 'remote default head unavailable' };
  }
  return { remoteUrl, targetSha, defaultBranch };
}

// Fresh local refs, upstream aliases and actual holders all retain the remote
// recovery ref. Re-read immediately before the leased push, inside the same
// ownership fence used to register managed claims.
async function remoteRetirementLocalHold(dir, name) {
  const { listWorktrees } = await import('../worktreeManager.js');
  const [refs, trees] = await Promise.all([
    execGitSafe(['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads/'], dir),
    listWorktrees(dir).catch(() => null),
  ]);
  if (refs.exitCode !== 0 || !Array.isArray(trees)) return 'local ownership unavailable';
  if (refs.stdout.split(/\r?\n/).some(line => {
    const [branch, upstream] = line.split('\t');
    return branch === name || upstream === `origin/${name}`;
  })) return 'local branch or upstream still exists';
  if (trees.some(tree => tree.branch === `refs/heads/${name}` || tree.branch === name)) return 'checked out in a worktree';
  return null;
}

async function retireMergedRemoteHead(dir, name, context, { excludeBranches } = {}) {
  const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('../cos/cosClaimOwnershipState.js');
  const { readBranchCompletionHold } = await import('../branchCompletionPolicy.js');
  if (PROTECTED_BRANCHES.includes(name) || name === context.defaultBranch || name === 'HEAD') return { reason: 'protected branch' };
  const ref = `refs/heads/${name}`;
  if ((await execGitSafe(['check-ref-format', ref], dir)).exitCode !== 0) return { reason: 'invalid branch name' };
  return withClaimOwnershipLock(async () => {
    const hold = async tip => {
      const exclusions = typeof excludeBranches === 'function' ? await excludeBranches() : excludeBranches;
      if (exclusions?.has(name)) return 'used by an active agent';
      const agents = await readClaimOwnershipAgents();
      const owner = claimCheckoutOwnerReason({ branchName: name, holderPath: null, sourceWorkspace: dir, agents });
      if (owner) return owner;
      if (tip) {
        const policy = await readBranchCompletionHold({ repoPath: dir, branch: name, tip, retirement: true });
        if (policy) return policy;
      }
      return remoteRetirementLocalHold(dir, name);
    };
    const initialHold = await hold();
    if (initialHold) return { reason: initialHold };
    const head = await execGitSafe(['ls-remote', '--heads', '--', context.remoteUrl, ref], dir);
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(head.stdout.trim());
    if (head.exitCode !== 0 || !match || match[2] !== ref) return { reason: 'head unavailable or already removed' };
    if (!await hasBranchMergeEvidence(dir, match[1], context.targetSha)) return { reason: 'current head is not merged' };
    const finalHold = await hold(match[1]);
    if (finalHold) return { reason: finalHold };
    const removed = await execGitSafe(['push', `--force-with-lease=${ref}:${match[1]}`, '--', context.remoteUrl, `:${ref}`], dir, { ignoreExitCode: true });
    return removed.exitCode === 0 ? { deleted: true } : { reason: 'head changed or deletion failed', failed: true };
  });
}

/** Retire only explicitly selected remote candidates, preserving any fresh local
 * ownership. The candidate scan grants no deletion authority: endpoint, default,
 * current head, merge proof and claim/completion gates are established here.
 */
export async function deleteMergedRemoteBranches(dir, names, { defaultBranch, excludeBranches } = {}) {
  const selected = [...new Set(names)];
  if (!selected.length) return { deleted: [], skipped: [] };
  const base = defaultBranch || (await getRepoBranches(dir)).baseBranch || 'main';
  const context = await prepareRemoteRetirement(dir, base);
  if (context.reason) return { deleted: [], skipped: selected.map(branch => ({ branch, reason: context.reason })) };
  const deleted = [];
  const skipped = [];
  for (const branch of selected) {
    const result = await retireMergedRemoteHead(dir, branch, context, { excludeBranches });
    if (result.deleted) deleted.push(branch);
    else skipped.push({ branch, reason: result.reason });
  }
  return { deleted, skipped };
}

/**
 * Delete all merged branches (local and remote) in one operation.
 * Skips the `PROTECTED_BRANCHES` set (see `../../lib/gitArgs.js`), the current branch,
 * and any explicitly excluded branches.
 *
 * Shares the reconciler's fresh ownership, merge, archival and retirement gates.
 * Local and remote deletion are pinned to observed heads. Retained work is
 * returned with its specific reason; the UI's merged flag is never authority.
 *
 * @param {string} dir - Working directory
 * @param {object} options
 * @param {Set<string>} options.excludeBranches - Additional branches to protect (e.g., active agent branches)
 * @param {Set<string>} [options.activeAgentIds] - CoS agent ids whose worktrees must survive. Anything
 *   but a Set (the default) reads as "liveness unknown" and holds every `agent-*` worktree.
 * @param {Set<string>} [options.onlyBranches] Limit candidates without bypassing any retirement guard.
 * @returns {Promise<{deleted: Array<{name: string, local: string, remote: string, worktree?: string}>, skipped: string[], defaultBranch: string}>}
 */
export async function deleteMergedBranches(dir, { excludeBranches, activeAgentIds = null, onlyBranches } = {}) {
  if (onlyBranches !== undefined && !(onlyBranches instanceof Set)) throw new Error('Cleanup branch selector must be a Set');
  const cleanupMerged = requireMergedBranchCleanup();
  const { baseBranch } = await getRepoBranches(dir);
  const defaultBranch = baseBranch || 'main';
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);
  const skipped = [];
  const records = new Map();
  const context = await prepareRemoteRetirement(dir, defaultBranch);
  if (context.reason) return { deleted: [], skipped: [`cleanup (${context.reason})`], defaultBranch };
  const { resolveRetirementApp } = await import('../retirementAppScope.js');
  const scope = await resolveRetirementApp(dir);
  if (!scope.app) return { deleted: [], skipped: [`cleanup (${scope.reason})`], defaultBranch };
  const { targetSha } = context;
  const branches = await execGitSafe(['branch', '--format=%(refname:short)'], dir, { ignoreExitCode: true });
  if (branches.exitCode !== 0) return { deleted: [], skipped: ['cleanup (local branches unavailable)'], defaultBranch };
  const local = new Set(branches.stdout.trim().split('\n').filter(Boolean));
  const remote = await execGitSafe(['branch', '-r', '--format=%(refname:short)'], dir, { ignoreExitCode: true });
  if (remote.exitCode !== 0) return { deleted: [], skipped: ['cleanup (remote merge evidence unavailable)'], defaultBranch };
  const remoteNames = remote.stdout.trim().split('\n').filter(ref => ref.startsWith('origin/')).map(ref => ref.slice(7));
  const names = new Set([...local, ...remoteNames]);
  for (const name of names) {
    if (onlyBranches && !onlyBranches.has(name)) continue;
    if (protectedSet.has(name) || name === 'HEAD') continue;
    const exclusions = typeof excludeBranches === 'function' ? await excludeBranches() : excludeBranches;
    if (exclusions?.has(name)) { skipped.push(`${name} (used by an active agent)`); continue; }
    const record = { name, local: null, remote: null };
    records.set(name, record);
    if (local.has(name)) {
      const retired = await cleanupMerged(scope.app.repoPath, targetSha, [{ branch: name }], {
        activeAgentIds, appId: scope.app.id, forgeAccount: scope.app.forgeAccount ?? null,
      });
      if (retired.cleaned.includes(name)) record.local = 'deleted';
      else {
        for (const hold of retired.skipped) skipped.push(`${name} (local: ${worktreeHoldReason(hold.reason)}${hold.detail ? `: ${hold.detail}` : ''})`);
        // Retention is a whole-branch outcome. In particular, archive failure
        // must leave both the checkout and its remote recovery ref intact.
        continue;
      }
    }
    if (!remoteNames.includes(name)) continue;
    const removed = await retireMergedRemoteHead(dir, name, context, { excludeBranches });
    if (removed.deleted) record.remote = 'deleted';
    else {
      if (removed.failed) record.remote = 'failed';
      skipped.push(`${name} (remote: ${removed.reason})`);
    }
  }
  return { deleted: [...records.values()].filter(row => row.local === 'deleted' || row.remote === 'deleted'), skipped, defaultBranch };
}
