import { describe, expect, it } from 'vitest';

import {
  PR_HANDBACK,
  PR_REVIEW_OUTCOME,
  PR_WRITE_ACCESS,
  resolveHandbackDisposition,
  resolvePullRequestWriteAccess,
} from './prHandbackPolicy.js';

const REQUEST_CHANGES = { reviewOutcome: PR_REVIEW_OUTCOME.REQUEST_CHANGES };

describe('resolvePullRequestWriteAccess', () => {
  it('treats a same-repo branch as writable', () => {
    expect(resolvePullRequestWriteAccess({ isCrossRepository: false })).toEqual({
      canEdit: true, reason: PR_WRITE_ACCESS.OWN_REPO,
    });
  });

  it('treats a fork branch as writable only when the contributor allowed maintainer edits', () => {
    expect(resolvePullRequestWriteAccess({ isCrossRepository: true, maintainerCanModify: true })).toEqual({
      canEdit: true, reason: PR_WRITE_ACCESS.FORK_MAINTAINER_MODIFIABLE,
    });
    expect(resolvePullRequestWriteAccess({ isCrossRepository: true, maintainerCanModify: false })).toEqual({
      canEdit: false, reason: PR_WRITE_ACCESS.FORK_LOCKED,
    });
  });

  // A forge read that answered without these fields must not be optimistically
  // read as writable: the remediation agent would only discover it at push time.
  it.each([
    ['no pull request', null],
    ['a non-object', 'PR #7'],
    ['a missing cross-repository flag', { maintainerCanModify: true }],
    ['a non-boolean cross-repository flag', { isCrossRepository: 'true', maintainerCanModify: true }],
    ['a non-boolean maintainer flag on a fork', { isCrossRepository: true, maintainerCanModify: 'true' }],
  ])('fails closed on %s', (_label, pullRequest) => {
    const access = resolvePullRequestWriteAccess(pullRequest);
    expect(access.canEdit).toBe(false);
  });
});

describe('resolveHandbackDisposition', () => {
  it('hands nothing back when the PR needs neither fixes nor merge work', () => {
    expect(resolveHandbackDisposition({ canEdit: true })).toBe(PR_HANDBACK.NONE);
  });

  it('remediates blocking findings on a writable branch', () => {
    expect(resolveHandbackDisposition({ ...REQUEST_CHANGES, canEdit: true })).toBe(PR_HANDBACK.REMEDIATE);
  });

  it('remediates an approved PR that cannot land as it stands', () => {
    expect(resolveHandbackDisposition({ notMergeReady: true, canEdit: true })).toBe(PR_HANDBACK.REMEDIATE);
  });

  it('assigns the opener when the branch is not writable', () => {
    expect(resolveHandbackDisposition({ ...REQUEST_CHANGES, canEdit: false })).toBe(PR_HANDBACK.ASSIGN_OPENER);
    expect(resolveHandbackDisposition({ notMergeReady: true, canEdit: false })).toBe(PR_HANDBACK.ASSIGN_OPENER);
  });

  // An agent told to "implement the feedback" needs feedback it can implement.
  it.each([
    ['findings that could not be anchored', { ...REQUEST_CHANGES, downgraded: true }],
    ['a reviewer that returned no verdict', { reviewOutcome: PR_REVIEW_OUTCOME.DEFER }],
  ])('assigns the opener rather than dispatching an agent for %s', (_label, review) => {
    expect(resolveHandbackDisposition({ ...review, canEdit: true })).toBe(PR_HANDBACK.ASSIGN_OPENER);
  });

  // A COMMENT review counts as a review on that head, so the coordinator will
  // never revisit the revision — leaving it unassigned strands it for good.
  it('hands a deferred review to its opener even with nothing else wrong', () => {
    expect(resolveHandbackDisposition({ reviewOutcome: PR_REVIEW_OUTCOME.DEFER, canEdit: true }))
      .toBe(PR_HANDBACK.ASSIGN_OPENER);
  });

  it('stops dispatching agents once the attempt budget is spent', () => {
    expect(resolveHandbackDisposition({ ...REQUEST_CHANGES, canEdit: true, remediationExhausted: true }))
      .toBe(PR_HANDBACK.ASSIGN_OPENER);
  });
});
