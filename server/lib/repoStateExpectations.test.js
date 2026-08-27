import { describe, it, expect } from 'vitest';
import {
  REPO_STATE_ISSUES,
  REPO_STATE_SKIPS,
  classifyRepoStateIssues,
  repoStateVerificationEnabled,
  resolveRepoStateExpectation,
} from './repoStateExpectations.js';
import { PR_COMPLETIONS } from './prDisposition.js';

// The shape a run that SHOULD be audited has: a successful worktree agent whose
// cleanup reported nothing and whose branch nothing else owns.
const auditable = {
  enabled: true,
  success: true,
  isWorktree: true,
  branchName: 'cos/task-abc/agent-1',
  sourceWorkspace: '/repo',
};

describe('resolveRepoStateExpectation', () => {
  it('audits a successful worktree run and expects a fully cleaned repo', () => {
    const e = resolveRepoStateExpectation({ ...auditable, prExpected: true });
    expect(e).toEqual({ verify: true, skipReason: null, staysOpen: false, prExpected: true });
  });

  it.each([
    ['leave-open policy', { prCompletion: PR_COMPLETIONS.LEAVE_OPEN }],
    ['human hand-off', { leaveOpen: true }],
  ])('marks the branch as staying with its PR (%s)', (_label, override) => {
    const e = resolveRepoStateExpectation({ ...auditable, prExpected: true, ...override });
    expect(e.verify).toBe(true);
    expect(e.staysOpen).toBe(true);
  });

  it.each([
    [REPO_STATE_SKIPS.DISABLED, { enabled: false }],
    [REPO_STATE_SKIPS.NOT_WORKTREE, { isWorktree: false }],
    [REPO_STATE_SKIPS.PERSISTENT_WORKTREE, { isPersistentWorktree: true }],
    [REPO_STATE_SKIPS.DISCARDED_WORKTREE, { discardWorktree: true }],
    [REPO_STATE_SKIPS.FAILED_RUN, { success: false }],
    [REPO_STATE_SKIPS.CLEANUP_WARNED, { cleanupWarningCount: 1 }],
    [REPO_STATE_SKIPS.FOLLOW_UP_PENDING, { followUpPending: true }],
    [REPO_STATE_SKIPS.MISSING_CONTEXT, { branchName: null }],
    [REPO_STATE_SKIPS.MISSING_CONTEXT, { sourceWorkspace: null }],
  ])('skips with reason %s', (reason, override) => {
    const e = resolveRepoStateExpectation({ ...auditable, ...override });
    expect(e.verify).toBe(false);
    expect(e.skipReason).toBe(reason);
  });

  it('reports the app switch ahead of the other gates', () => {
    // A disabled app on a run that would ALSO skip for another reason must still
    // report `verification-disabled` — that is the answer an operator is looking
    // for when they turned it off and want to confirm it took effect.
    const e = resolveRepoStateExpectation({ ...auditable, enabled: false, success: false, isWorktree: false });
    expect(e.skipReason).toBe(REPO_STATE_SKIPS.DISABLED);
  });

  it('answers every free gate before the one the caller pays for', () => {
    // `followUpPending` costs two task-file reads plus the app record, so the
    // service resolves once WITHOUT it to short-circuit. That only works while
    // every other skip outranks it. Assert the EXACT reason each gate gives, not
    // merely that it isn't FOLLOW_UP_PENDING — a regression returning
    // `verify: true`, or the wrong reason, would sail past the weaker check.
    const cases = [
      [{ isWorktree: false }, REPO_STATE_SKIPS.NOT_WORKTREE],
      [{ isPersistentWorktree: true }, REPO_STATE_SKIPS.PERSISTENT_WORKTREE],
      [{ discardWorktree: true }, REPO_STATE_SKIPS.DISCARDED_WORKTREE],
      [{ success: false }, REPO_STATE_SKIPS.FAILED_RUN],
      [{ cleanupWarningCount: 1 }, REPO_STATE_SKIPS.CLEANUP_WARNED],
      [{ branchName: null }, REPO_STATE_SKIPS.MISSING_CONTEXT],
      [{ sourceWorkspace: null }, REPO_STATE_SKIPS.MISSING_CONTEXT],
    ];
    for (const [override, reason] of cases) {
      const e = resolveRepoStateExpectation({ ...auditable, ...override, followUpPending: true });
      expect(e.verify, JSON.stringify(override)).toBe(false);
      expect(e.skipReason, JSON.stringify(override)).toBe(reason);
    }
  });
});

describe('classifyRepoStateIssues', () => {
  const expectation = resolveRepoStateExpectation({ ...auditable, prExpected: true });

  it('reports nothing when the repo is clean', () => {
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: false,
      localBranchPresent: false,
      remoteBranchPresent: false,
      branchMerged: null,
      prState: 'MERGED',
    });
    expect(issues).toEqual([]);
  });

  it('reports the leftover worktree, branch, remote branch and open PR', () => {
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: true,
      localBranchPresent: true,
      remoteBranchPresent: true,
      branchMerged: false,
      prState: 'OPEN',
      branchName: 'cos/task-abc/agent-1',
    });
    expect(issues.map(i => i.code)).toEqual([
      REPO_STATE_ISSUES.WORKTREE_PRESENT,
      REPO_STATE_ISSUES.LOCAL_BRANCH_PRESENT,
      REPO_STATE_ISSUES.REMOTE_BRANCH_PRESENT,
      REPO_STATE_ISSUES.BRANCH_UNMERGED,
      REPO_STATE_ISSUES.PR_UNMERGED,
    ]);
    expect(issues[0].message).toContain('cos/task-abc/agent-1');
  });

  it('treats every unknown observation as no issue', () => {
    // This is the whole point of the tri-state: a firewalled `gh` or an
    // unreachable git must not file a recovery task.
    const issues = classifyRepoStateIssues(expectation, {
      worktreePresent: null,
      localBranchPresent: null,
      remoteBranchPresent: null,
      branchMerged: null,
      prState: null,
    });
    expect(issues).toEqual([]);
  });

  it('reports nothing for an expectation that was skipped', () => {
    const skipped = resolveRepoStateExpectation({ ...auditable, success: false });
    const issues = classifyRepoStateIssues(skipped, {
      worktreePresent: true,
      localBranchPresent: true,
      remoteBranchPresent: true,
      branchMerged: false,
    });
    expect(issues).toEqual([]);
  });

  it('leaves a deliberately-open PR and its branch alone, but not its worktree', () => {
    const staysOpen = resolveRepoStateExpectation({ ...auditable, prExpected: true, leaveOpen: true });
    const observed = { localBranchPresent: true, remoteBranchPresent: true, branchMerged: false, prState: 'OPEN' };
    expect(classifyRepoStateIssues(staysOpen, { ...observed, worktreePresent: false })).toEqual([]);
    expect(classifyRepoStateIssues(staysOpen, { ...observed, worktreePresent: true }).map(i => i.code))
      .toEqual([REPO_STATE_ISSUES.WORKTREE_PRESENT]);
  });

  it('does not report an unmerged PR for a task that never asked for one', () => {
    // `openPR: false` runs merge into the source workspace directly. A PR the
    // forge happens to know about is not this run's to land.
    const noPr = resolveRepoStateExpectation({ ...auditable, prExpected: false });
    expect(classifyRepoStateIssues(noPr, { prState: 'OPEN' })).toEqual([]);
  });
});

describe('repoStateVerificationEnabled', () => {
  it('defaults to on for an unset app and for a task with no app', () => {
    expect(repoStateVerificationEnabled(null)).toBe(true);
    expect(repoStateVerificationEnabled({})).toBe(true);
    expect(repoStateVerificationEnabled({ verifyRepoStateOnCompletion: true })).toBe(true);
  });

  it('is off only for an explicit false', () => {
    expect(repoStateVerificationEnabled({ verifyRepoStateOnCompletion: false })).toBe(false);
  });
});
