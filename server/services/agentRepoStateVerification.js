/**
 * Agent Repo-State Verification
 *
 * The programmatic audit that runs after `cleanupAgentWorktree` and asks the
 * question cleanup cannot: is the repository actually in the state this task
 * asked for?
 *
 * Cleanup reports only what it TRIED and failed to do. The case this exists for
 * is an agent that owns its own PR workflow (`ownsPrWorkflow`), merges the PR
 * itself, and exits before deleting the branch — or exits with the PR still open.
 * Cleanup stands down for exactly those runs, so nothing checked, and the branch
 * plus its worktree persist through every later sweep that treats "an agent owns
 * it" as a reason to skip. (`removeWorktree` also only `console.log`s a failed
 * `git branch -D`, so even the attempted delete can fail silently.)
 *
 * What it does NOT do: touch anything. It probes, classifies (via the pure
 * `lib/repoStateExpectations.js`), and files ONE recovery task. Deleting a branch
 * from here would be a destructive action on the basis of a heuristic, which is
 * what `branchReconcile.js` is careful not to do either.
 *
 * Detection is what this adds over `branchReconcile.js`: that reconciler is an
 * opt-in scheduled task on a recheck cadence, and it parks on no-progress. This
 * is immediate, per-agent, and attributed to the run that caused it.
 *
 * Gated per managed app by `verifyRepoStateOnCompletion` (default ON).
 *
 * Concurrency: other agents legitimately hold their own worktrees and branches at
 * the same time. Every probe is scoped to ONE branch — the one this agent owned —
 * so a live sibling agent is structurally invisible to it.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { emitLog } from './cosEvents.js';
import { addTask } from './cos.js';
import * as git from './git.js';
import { listWorktrees } from './worktreeManager.js';
import { listRemoteHeads, driveToMerge } from './branchReconcile.js';
import { readAllTasksFlat } from './investigationTaskProducer.js';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/fileUtils.js';
import { isTruthyMeta } from './agentState.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { resolveTaskTargetBranch } from '../lib/taskTargetBranch.js';
import { leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';
import {
  REPO_STATE_ISSUES,
  REPO_STATE_SKIPS,
  classifyRepoStateIssues,
  repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from '../lib/repoStateExpectations.js';

// `resolveForgeForRepo` spawns `git remote get-url` + `gh auth status` + `gh auth
// token` with no internal timeout; git.js races the same call on the agent-SPAWN
// path for exactly this reason. The completion path has the same property — a
// stalled gh (network / keychain hang) must not hold an agent lane open.
const FORGE_RESOLVE_TIMEOUT_MS = 10000;

// A task in any of these still HOLDS its branch and will resume on it, so a
// branch one of them targets is owned, not leaked. `challenged` is the easy one
// to miss: it is a parked-for-dispute status, not a terminal one, and its task
// keeps its resume pointer (`cosTaskStore.js` `challengeTask`).
const PENDING_OWNER_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'challenged']);

const withTimeout = (promise, ms, fallback) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
]);

/**
 * Is something ALREADY queued to land this branch?
 *
 * Two owners can hold a branch after cleanup returns, and neither is a leak:
 *
 *   1. a review-loop / merge follow-up TASK, which checks the branch out, drives
 *      the reviewers, and merges; and
 *   2. a pr-watcher PENDING MERGE (`pendingMergePrs` on the app record) — the
 *      model-free path a merge-on-green GitHub PR takes, merged by the next
 *      watcher tick once CI is green.
 *
 * In both cases the branch is *supposed* to still exist right now, so auditing it
 * would report the thing about to land it as debris. The follow-up is itself a
 * worktree agent, so its own completion gets audited; a pr-watcher merge is
 * audited by nothing here, deliberately — pr-watcher owns that PR end to end.
 *
 * @param {string} branchName
 * @param {object|null} app - the managed app record (carries `pendingMergePrs`)
 * @returns {Promise<boolean>}
 */
async function branchHasPendingOwner(branchName, app) {
  // `resolveTaskTargetBranch` is the canonical "which branch does this task own"
  // reader — matching `reviewLoopPRBranch` by hand here would miss a retry holding
  // the same branch through `existingBranch`.
  //
  // `null` on an unreadable queue, never `false`: the caller fails closed on it.
  // Collapsing "we could not read the task file" into "nobody owns this branch" is
  // how a transient read failure files recovery work against a branch a follow-up
  // is queued to land.
  const tasks = await readAllTasksFlat().catch(() => null);
  if (!tasks) return null;
  const claimedByTask = tasks.some(t =>
    PENDING_OWNER_STATUSES.has(t.status) && resolveTaskTargetBranch(t.metadata) === branchName
  );
  if (claimedByTask) return true;

  if (!app) return false;
  const { readPendingMergePrs } = await import('./prWatcher.js');
  const pending = readPendingMergePrs(app);
  if (!Array.isArray(pending)) return null;
  return pending.some(entry => entry?.prBranch === branchName);
}

/**
 * Is `branch` already on `target`? Tri-state, unlike `isBranchMergedInto`, which
 * answers `false` both for "not merged" and for "could not tell".
 *
 * @returns {Promise<boolean|null>} null when either ref could not be resolved
 */
async function probeBranchMerged(repoPath, branch, target) {
  const resolvable = async (ref) => execGit(['rev-parse', '--verify', `${ref}^{commit}`], repoPath, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  const [hasBranch, hasTarget] = await Promise.all([resolvable(branch), resolvable(target)]);
  if (!hasBranch || !hasTarget) return null;
  return git.isBranchMergedInto(repoPath, branch, target).catch(() => null);
}

/**
 * Probe the repository for the facts the expectation is judged against.
 *
 * Every field is tri-state: `true` / `false` / `null` for "could not determine".
 * A probe that throws yields `null`, never `false` — see `classifyRepoStateIssues`
 * for why collapsing the two would file a recovery task on every network hiccup.
 *
 * The four probe groups are independent and run concurrently, so latency is the
 * slowest one rather than their sum; only `branchMerged` (needs the local branch
 * and the default branch) is sequenced after its inputs.
 *
 * @param {object} params
 * @param {string} params.sourceWorkspace - the parent repository
 * @param {string} params.branchName
 * @param {string} params.worktreePath
 * @param {boolean} params.branchShouldBeGone - gates the remote + merged probes
 * @param {boolean} params.prExpected - gates the forge lookup
 * @returns {Promise<{worktreePresent: boolean|null, localBranchPresent: boolean|null, remoteBranchPresent: boolean|null, branchMerged: boolean|null, prState: string|null, prUrl: string|null, defaultBranch: string|null}>}
 */
async function probeRepoState({ sourceWorkspace, branchName, worktreePath, branchShouldBeGone, prExpected }) {
  // A worktree counts as present if the directory survived on disk OR git still
  // tracks it. Either alone is a leak: an unregistered directory is the full
  // checkout `removeWorktree` believed it deleted, and a registered-but-deleted
  // tree wedges the next `git worktree add` for that path. The cheap disk check
  // first, so the common leaked-directory case skips the `git worktree list` spawn.
  const probeWorktree = async () => {
    if (existsSync(worktreePath)) return true;
    const worktrees = await listWorktrees(sourceWorkspace).catch(() => null);
    if (!worktrees) return null;
    return worktrees.some(wt =>
      wt.branch?.replace(/^refs\/heads\//, '') === branchName || wt.path === worktreePath
    );
  };

  const probeLocalBranch = () => execGit(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    sourceWorkspace,
    { ignoreExitCode: true }
  ).then(r => r.exitCode === 0).catch(() => null);

  // `listRemoteHeads` is branch-reconcile's single answer to "what is on origin
  // right now", already carrying the null-means-could-not-ask contract. It reads
  // `ls-remote` rather than the `refs/remotes/*` mirror, which nothing here fetches.
  const probeRemoteBranch = async () => {
    if (!branchShouldBeGone) return null;
    const heads = await listRemoteHeads(sourceWorkspace).catch(() => null);
    return heads ? heads.has(branchName) : null;
  };

  // Ask whichever forge this remote actually lives on. Both lookups share the
  // same tri-state contract and both return the change request's state in
  // `detail`, so no second round trip is needed to read it.
  const probePr = async () => {
    if (!prExpected || !branchShouldBeGone) return { prState: null, prUrl: null, prNumber: null, cli: null, readable: true };
    const forge = await withTimeout(
      git.resolveForgeForRepo(sourceWorkspace).catch(() => null),
      FORGE_RESOLVE_TIMEOUT_MS,
      null
    );
    if (!forge?.cli) return { prState: null, prUrl: null, prNumber: null, cli: null, readable: false };
    const { cli, env } = forge;
    const found = cli === 'glab'
      ? await (await import('./gitlab.js')).findMergeRequestForBranch(branchName, sourceWorkspace)
        .catch(() => ({ status: 'unavailable' }))
      : await (await import('./github.js')).findPullRequestForBranch(branchName, { cwd: sourceWorkspace, env: env || null })
        .catch(() => ({ status: 'unavailable' }));
    if (found.status === 'unavailable') return { prState: null, prUrl: null, prNumber: null, cli, readable: false };
    // `none` is a real answer, not a gap — `verifyPrClaim` already owns "the agent
    // never opened one", so there is nothing here to report and nothing missing.
    if (found.status !== 'found') return { prState: null, prUrl: null, prNumber: null, cli, readable: true };
    return {
      prState: found.detail ? String(found.detail).toUpperCase() : null,
      prUrl: found.url || null,
      // The forge's own identifier for the change request — a GitLab `glab mr
      // merge` line needs the IID, and emitting a literal `<iid>` placeholder
      // hands the recovery agent a command it cannot run.
      prNumber: found.number ?? null,
      cli,
      readable: !!found.detail,
    };
  };

  // `allowRemote: false` — a bookkeeping question must not block on `git remote
  // set-head origin --auto`, the network call the default path can trigger.
  const probeDefaultBranch = () => (branchShouldBeGone
    ? git.getDefaultBranch(sourceWorkspace, { allowRemote: false }).catch(() => null)
    : Promise.resolve(null));

  const [worktreePresent, localBranchPresent, remoteBranchPresent, defaultBranch, pr] = await Promise.all([
    probeWorktree().catch(() => null),
    probeLocalBranch(),
    probeRemoteBranch(),
    probeDefaultBranch(),
    probePr().catch(() => ({ prState: null, prUrl: null, prNumber: null, cli: null, readable: false })),
  ]);

  // Only meaningful while the branch still exists locally.
  //
  // `isBranchMergedInto` fails CLOSED — it returns `false`, not a throw, when it
  // cannot resolve either ref (git.js). That polarity is right for its original
  // caller, which preserves a branch on doubt; here it inverts into a FINDING, so
  // an unreadable repo would file a recovery task claiming unmerged work. Resolve
  // both refs first: if either cannot be read, the answer is `null` (unknown), and
  // only a `false` backed by two resolvable refs is reported.
  const branchMerged = localBranchPresent === true && defaultBranch
    ? await probeBranchMerged(sourceWorkspace, branchName, defaultBranch)
    : null;

  // Which probes that COULD have produced a finding came back unreadable. The
  // caller reports a run with any of these as `probe-incomplete` rather than
  // clean — a probe we never got an answer from has not verified anything, and
  // logging it as a verified repo is the absent-vs-empty conflation this module
  // exists to avoid. A probe that was deliberately skipped (not applicable to
  // this run's end-state shape) is NOT unreadable.
  const unreadable = [];
  if (worktreePresent === null) unreadable.push('worktree');
  if (localBranchPresent === null) unreadable.push('local-branch');
  if (branchShouldBeGone) {
    if (remoteBranchPresent === null) unreadable.push('remote-branch');
    // Merge state is only in question while the branch is still there; once it is
    // gone there is nothing left to be unmerged.
    if (localBranchPresent === true && branchMerged === null) unreadable.push('branch-merged');
    if (prExpected && !pr.readable) unreadable.push('pull-request');
  }

  return {
    worktreePresent,
    localBranchPresent,
    remoteBranchPresent,
    branchMerged,
    prState: pr.prState,
    prUrl: pr.prUrl,
    prNumber: pr.prNumber,
    forgeCli: pr.cli,
    defaultBranch,
    unreadable,
  };
}

/**
 * Verify one completed worktree agent left the repository as its task asked, and
 * file a recovery task when it did not.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {object} params.task - the CoS task
 * @param {object|null} params.agentState - persisted agent record (worktree metadata)
 * @param {boolean} params.success - effective success of the run
 * @param {boolean} [params.prExpected] - the task asked for a PR (`openPR`)
 * @param {string[]} [params.cleanupWarnings] - warnings cleanup already raised
 * @returns {Promise<{verified: boolean, skipReason: string|null, issues: Array<{code: string, message: string}>, observed: object|null, recoveryTaskId: string|null}>}
 */
export async function verifyAgentRepoState({ agentId, task, agentState, success, prExpected = false, cleanupWarnings = [] }) {
  const metadata = agentState?.metadata || {};
  const branchName = metadata.worktreeBranch || null;
  const sourceWorkspace = metadata.sourceWorkspace || null;
  const appId = task?.metadata?.app || null;
  const skipped = (skipReason) => ({ verified: false, skipReason, issues: [], observed: null, recoveryTaskId: null });

  // Resolved twice on purpose. The first pass applies every FREE gate; only a run
  // that survives all of them pays for the pending-owner answer (two task-file
  // reads plus the app record) that the second pass needs. One gate ladder, in
  // one place, still decides.
  const structural = {
    enabled: true,
    success,
    isWorktree: metadata.isWorktree === true,
    isPersistentWorktree: metadata.isPersistentWorktree === true,
    discardWorktree: isTruthyMeta(task?.metadata?.discardWorktree),
    cleanupWarningCount: cleanupWarnings?.length || 0,
    prCompletion: resolvePrCompletion(task?.metadata),
    leaveOpen: leavesPrForHuman(task),
    prExpected,
    branchName,
    sourceWorkspace,
  };
  const preflight = resolveRepoStateExpectation(structural);
  if (!preflight.verify) return skipped(preflight.skipReason);

  // Both reads below fail CLOSED. `getAppById` answers `null` for "no such app"
  // AND throws for "could not read apps.json", and collapsing those would let a
  // transient read failure override an explicit per-app opt-out; likewise an
  // unreadable task queue must not read as "nobody owns this branch".
  const UNREADABLE = Symbol('unreadable');
  const app = appId
    ? await (await import('./apps.js')).getAppById(appId).catch(() => UNREADABLE)
    : null;
  if (app === UNREADABLE) return skipped(REPO_STATE_SKIPS.GATE_UNREADABLE);

  const enabled = repoStateVerificationEnabled(app);
  const owned = enabled ? await branchHasPendingOwner(branchName, app).catch(() => null) : false;
  if (owned === null) return skipped(REPO_STATE_SKIPS.GATE_UNREADABLE);

  const expectation = resolveRepoStateExpectation({ ...structural, enabled, followUpPending: owned });
  if (!expectation.verify) return skipped(expectation.skipReason);

  const worktreePath = metadata.workspacePath || join(PATHS.worktrees, agentId);
  const observed = await probeRepoState({
    sourceWorkspace,
    branchName,
    worktreePath,
    branchShouldBeGone: !expectation.staysOpen,
    prExpected: expectation.prExpected,
  }).catch(err => {
    emitLog('warn', `🔎 Repo-state probe failed for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  if (!observed) return skipped(REPO_STATE_SKIPS.PROBE_INCOMPLETE);

  const issues = classifyRepoStateIssues(expectation, { ...observed, branchName });
  if (issues.length === 0) {
    // A run where some probe could not be read has not been verified — it has been
    // partially checked. Say so rather than logging a firewalled host as a clean
    // repo. Findings still stand on their own: what WAS readable is fact, so a
    // divergence below is reported even alongside an unreadable probe.
    if (observed.unreadable.length > 0) {
      emitLog('info', `🔎 Repo state only partly readable for ${agentId} (${branchName}) — could not check: ${observed.unreadable.join(', ')}`, { agentId, branchName });
      return { verified: false, skipReason: REPO_STATE_SKIPS.PROBE_INCOMPLETE, issues: [], observed, recoveryTaskId: null };
    }
    emitLog('info', `🔎 Repo state verified clean for ${agentId} (${branchName})`, { agentId, branchName });
    return { verified: true, skipReason: null, issues: [], observed, recoveryTaskId: null };
  }

  emitLog('warn', `🔎 Repo state diverged after ${agentId}: ${issues.map(i => i.code).join(', ')}`, { agentId, branchName, taskId: task?.id });

  const recoveryTaskId = await fileRepoStateRecoveryTask({
    agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId,
  }).catch(err => {
    emitLog('warn', `Failed to file repo-state recovery task for ${agentId}: ${err.message}`, { agentId, branchName });
    return null;
  });

  await notifyRepoStateDivergence({ agentId, task, branchName, issues, appId }).catch(() => {});

  return { verified: false, skipReason: null, issues, observed, recoveryTaskId };
}

/**
 * The remediation step for each issue code, as an instruction the recovery agent
 * can follow without re-deriving the diagnosis.
 *
 * A map rather than a switch with a `default`, so a new code cannot ship without
 * one — `repoStateExpectations.test.js` asserts the two key sets match.
 * `PR_UNMERGED` delegates to branch-reconcile's `driveToMerge`, which carries the
 * caveats a hand-written line loses: merge from the repo ROOT (gh cannot delete a
 * branch checked out elsewhere), retry `--squash`/`--rebase` on "not allowed",
 * never `--auto`, and remove the worktree before deleting the branch.
 */
export const REPO_STATE_REMEDIATIONS = Object.freeze({
  [REPO_STATE_ISSUES.WORKTREE_PRESENT]: ({ worktreePath }) =>
    `Remove the leftover worktree: confirm it is clean ("git -C ${worktreePath} status --porcelain"), commit or discard anything found, then "git worktree remove ${worktreePath}" and "git worktree prune".`,
  [REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT]: ({ branchName, base }) =>
    `Delete the local branch once its work is on ${base}: "git branch -d ${branchName}" (use -D only after confirming the commits landed). Remove its worktree first — the delete fails while a worktree still has it checked out.`,
  [REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT]: ({ branchName }) =>
    `Delete the remote branch after confirming its work merged: "git push origin --delete ${branchName}".`,
  [REPO_STATE_ISSUES.BRANCH_UNMERGED]: ({ base }) =>
    `The branch has commits that are NOT on ${base}. Decide whether they are still wanted: land them (open or merge a PR, or merge locally and resolve conflicts) before deleting anything. Do NOT delete this branch until its work is on ${base}.`,
  // Forge-aware: `driveToMerge` emits a `gh pr merge` procedure, which a GitLab
  // recovery agent cannot run. Its non-gh caveats still apply on either forge —
  // merge from the repo ROOT, and remove the worktree before deleting the branch.
  [REPO_STATE_ISSUES.PR_UNMERGED]: ({ prUrl, prNumber, forgeCli }) => (forgeCli === 'glab'
    ? `Finish the merge request${prUrl ? ` ${prUrl}` : ''}: fix failing pipeline jobs, resolve threads, then merge it from the repo ROOT (not inside the branch's worktree) with "glab mr merge ${prNumber ?? '<iid>'} --yes --remove-source-branch". Remove the worktree before deleting the local branch — the delete fails while a worktree still has it checked out.`
    : `Finish the pull request${prUrl ? ` ${prUrl}` : ''}. ${driveToMerge(prUrl || '<num>')}`),
});

/**
 * File ONE recovery task covering every issue found for this branch.
 *
 * Dedup rides on `addTask`'s first-line + app matching: the description names the
 * branch, so a re-run of the same audit joins the existing task rather than
 * stacking a second one.
 *
 * @returns {Promise<string|null>} the task id, or null when it was a duplicate
 */
async function fileRepoStateRecoveryTask({ agentId, task, branchName, sourceWorkspace, worktreePath, issues, observed, appId }) {
  const appName = task?.metadata?.appName || appId || 'PortOS';
  const base = observed.defaultBranch || 'the default branch';
  const ctx = { branchName, base, prUrl: observed.prUrl, prNumber: observed.prNumber, worktreePath, forgeCli: observed.forgeCli };

  const context = [
    'An agent finished successfully but the repository did not end up in the expected state.',
    '',
    `Repository: ${sourceWorkspace}`,
    `Branch: ${branchName}`,
    `Worktree: ${worktreePath}`,
    `Default branch: ${base}`,
    observed.prUrl ? `Change request: ${observed.prUrl} (${observed.prState || 'state unknown'})` : 'Change request: none found',
    `Original agent: ${agentId}`,
    `Original task: ${task?.description || 'unknown'}`,
    '',
    'What diverged:',
    ...issues.map((i, n) => `${n + 1}. ${i.message}`),
    '',
    'Finish the work, in this order:',
    ...issues.map((i, n) => `${n + 1}. ${REPO_STATE_REMEDIATIONS[i.code](ctx)}`),
    '',
    `Rules: never delete a branch whose commits are not already on ${base} — land the work first. `
      + `Other agents are running concurrently with their own worktrees and branches; touch ONLY ${branchName} and its worktree. `
      + `Do not switch branches in ${sourceWorkspace} itself.`,
  ].join('\n');

  const created = await addTask({
    description: `${RECOVERY_TASK_PREFIX} Finish incomplete cleanup for branch ${branchName} in ${appName}`,
    priority: 'HIGH',
    app: appId || undefined,
    isRecovery: true,
    context,
    useWorktree: false,
  }, 'user');

  if (created?.duplicate) {
    emitLog('info', `🔎 Repo-state recovery for ${branchName} already queued as ${created.id}`, { agentId, branchName });
    return null;
  }
  emitLog('info', `🔧 Filed repo-state recovery task for ${branchName} (${issues.length} issue(s))`, { agentId, branchName, appName });
  return created?.id || null;
}

/**
 * Surface the divergence alongside the auto-filed task, so a repeatedly-diverging
 * app is visible rather than only inferable from a growing recovery queue.
 *
 * Deduped on the branch (the way `orphanedPrNotifier` dedupes on the PR url) —
 * `addTask` collapses repeats on its side, and a notification card per audit
 * would otherwise stack for a branch nothing manages to fix.
 */
async function notifyRepoStateDivergence({ agentId, task, branchName, issues, appId }) {
  const { addNotification, exists, NOTIFICATION_TYPES, PRIORITY_LEVELS } = await import('./notifications.js');
  if (await exists(NOTIFICATION_TYPES.AGENT_WARNING, 'branchName', branchName)) return;
  const appName = task?.metadata?.appName || appId || 'PortOS';
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: `Repo state not clean after agent: ${appName}`,
    description: `Branch ${branchName}\n${issues.map(i => `• ${i.message}`).join('\n')}`,
    priority: PRIORITY_LEVELS.HIGH,
    link: '/cos/agents',
    metadata: { agentId, taskId: task?.id, branchName, issues: issues.map(i => i.code) },
  });
}
