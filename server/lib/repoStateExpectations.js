/**
  * Post-completion repo-state expectations for CoS worktree agents, the pure half: "what should the repo look like now" and "which observed facts contradict that".
  *
  * Cleanup (`services/agentWorktreeCleanup.js`) reports only steps it TRIED and failed, so an agent owning its own PR workflow (cleanup stands down: `skipMerge`, `PR_CREATION.NEVER`) can leave debris with zero warnings. No I/O (probing and remediation: `services/agentRepoStateVerification.js`). Deliberately narrow: ONE agent's branch right after it completed; the periodic whole-repo sweep is `services/branchReconcile.js`.
 */

import { PR_COMPLETIONS } from './prDisposition.js';

/**
 * Divergences worth reporting, in order. There is no "the agent never opened a PR" code: `verifyPrClaim` (services/agentFinalization.js) owns that on every path, is forge-agnostic, and carries the
 * `branchProvenEmpty` carve-out (#3358: a run that found the work done must not be told to open a PR for an empty branch).
 */
export const REPO_STATE_ISSUES = Object.freeze({
  WORKTREE_PRESENT: 'worktree-present',
  LOCAL_BRANCH_PRESENT: 'local-branch-present',
  REMOTE_BRANCH_PRESENT: 'remote-branch-present',
  BRANCH_UNMERGED: 'branch-unmerged',
  PR_UNMERGED: 'pr-unmerged',
});

/** Why a run was not audited, returned rather than logged so "checked and clean" is never ambiguous with "never checked". */
export const REPO_STATE_SKIPS = Object.freeze({
  DISABLED: 'verification-disabled',
  NOT_WORKTREE: 'not-a-worktree-run',
  PERSISTENT_WORKTREE: 'persistent-worktree',
  DISCARDED_WORKTREE: 'discarded-worktree',
  FAILED_RUN: 'failed-run',
  CLEANUP_WARNED: 'cleanup-already-warned',
  FOLLOW_UP_PENDING: 'follow-up-pending',
  MISSING_CONTEXT: 'missing-branch-or-workspace',
  // Set by the service half: a gate this audit depends on (app record, task queue) could not be read. Fail CLOSED: reading "could not ask" as "nobody owns this branch" or "audit on" would file recovery work against a follow-up's branch or an app that opted out.
  GATE_UNREADABLE: 'gate-unreadable',
  // A probe that could have produced a finding was unreadable and nothing diverged in what WAS readable: not clean (a firewalled host must not log as a verified repo).
  PROBE_INCOMPLETE: 'probe-incomplete',
});

/**
 * Should this run be audited, and under which end-state shape? Returns `staysOpen` (the PR is a human's to land, so its branch survives) and `prExpected`; every check derives from those in `classifyRepoStateIssues`.
 * A failed run is never audited (its branch/worktree are PRESERVED by merge-evidence retention and `resolveResumePointer` so a retry resumes). A pending owner (review-loop follow-up, pr-watcher pending merge) defers the audit:
 * `FOLLOW_UP_PENDING` is tested last because answering costs two file reads.
 *
 * @param {object} params
 * @param {boolean} params.enabled - the app's `verifyRepoStateOnCompletion` setting
 * @param {boolean} params.success - the run's effective success
 * @param {boolean} params.isWorktree
 * @param {boolean} [params.isPersistentWorktree] - long-lived feature worktree
 * @param {boolean} [params.discardWorktree] - reasoning agent whose tree is thrown away
 * @param {boolean} [params.followUpPending] - something is already queued to land this branch
 * @param {number} [params.cleanupWarningCount] - warning persistence precedes the durable completion retry
 * @param {string} [params.prCompletion] - resolved `PR_COMPLETIONS` policy
 * @param {boolean} [params.leaveOpen] - the PR is a human's to land (JIRA hand-off)
 * @param {boolean} [params.prExpected] - the task asked for a PR
 * @param {string|null} [params.branchName]
 * @param {string|null} [params.sourceWorkspace]
 * @returns {{verify: boolean, skipReason: string|null, staysOpen: boolean, prExpected: boolean}}
 */
export function resolveRepoStateExpectation({
  enabled,
  success,
  isWorktree,
  isPersistentWorktree = false,
  discardWorktree = false,
  followUpPending = false,
  cleanupWarningCount = 0,
  prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN,
  leaveOpen = false,
  prExpected = false,
  branchName = null,
  sourceWorkspace = null,
} = {}) {
  const skip = (skipReason) => ({ verify: false, skipReason, staysOpen: false, prExpected: false });

  if (enabled === false) return skip(REPO_STATE_SKIPS.DISABLED);
  if (!isWorktree) return skip(REPO_STATE_SKIPS.NOT_WORKTREE);
  if (isPersistentWorktree) return skip(REPO_STATE_SKIPS.PERSISTENT_WORKTREE);
  if (discardWorktree) return skip(REPO_STATE_SKIPS.DISCARDED_WORKTREE);
  if (!success) return skip(REPO_STATE_SKIPS.FAILED_RUN);
  if (cleanupWarningCount > 0) return skip(REPO_STATE_SKIPS.CLEANUP_WARNED);
  if (!branchName || !sourceWorkspace) return skip(REPO_STATE_SKIPS.MISSING_CONTEXT);
  if (followUpPending) return skip(REPO_STATE_SKIPS.FOLLOW_UP_PENDING);

  return {
    verify: true,
    skipReason: null,
    // `leave-open` is a deliberate hand-off: the PR and its branch (local and remote) stay; the worktree is still expected gone.
    staysOpen: leaveOpen || prCompletion === PR_COMPLETIONS.LEAVE_OPEN,
    prExpected,
  };
}

/**
 * Which observed facts contradict the expectation. Every observation is tri-state (`true` / `false` / `null`): `null` (git unreachable, `gh` firewalled, non-GitHub forge) NEVER produces an issue,
 * since reading "could not ask" as "still there" would file a recovery task on every network hiccup.
 *
 * @param {ReturnType<typeof resolveRepoStateExpectation>} expectation
 * @param {object} observed
 * @param {boolean|null} [observed.worktreePresent]
 * @param {boolean|null} [observed.localBranchPresent]
 * @param {boolean|null} [observed.remoteBranchPresent]
 * @param {boolean|null} [observed.branchMerged]
 * @param {string|null} [observed.prState] - upper-cased `MERGED` / `OPEN` / `CLOSED`
 * @param {string|null} [observed.branchName]
 * @returns {Array<{code: string, message: string}>}
 */
export function classifyRepoStateIssues(expectation, observed = {}) {
  if (!expectation?.verify) return [];
  const branch = observed.branchName || 'the agent branch';
  // Forge auto-merge does not own failure recovery or local cleanup; explicit server receipts are checked by the caller's pending-owner gate.
  const branchShouldBeGone = !expectation.staysOpen;
  const issues = [];

  if (observed.worktreePresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.WORKTREE_PRESENT,
      message: `Worktree for ${branch} still exists after cleanup reported success`,
    });
  }
  if (branchShouldBeGone && observed.localBranchPresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      message: `Local branch ${branch} still exists after the run completed`,
    });
  }
  if (branchShouldBeGone && observed.remoteBranchPresent === true) {
    issues.push({
      code: REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      message: `Remote branch origin/${branch} was never deleted`,
    });
  }
  if (branchShouldBeGone && observed.branchMerged === false) {
    issues.push({
      code: REPO_STATE_ISSUES.BRANCH_UNMERGED,
      message: `Branch ${branch} carries commits that are not on the default branch`,
    });
  }
  if (branchShouldBeGone && expectation.prExpected && observed.prState && observed.prState !== 'MERGED') {
    issues.push({
      code: REPO_STATE_ISSUES.PR_UNMERGED,
      message: `Pull request for ${branch} is ${observed.prState}, not MERGED`,
    });
  }

  return issues;
}

/**
 * True when the app's per-app setting leaves the audit on. Unset means ON: the audit only reports on a run already believed finished, and an install never hearing about leaked branches accumulates them.
 *
 *
 * @param {object|null} app - managed app record (null for a task with no app)
 * @returns {boolean}
 */
export function repoStateVerificationEnabled(app) {
  return app?.verifyRepoStateOnCompletion !== false;
}
