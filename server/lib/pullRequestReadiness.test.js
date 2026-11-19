import { describe, expect, it } from 'vitest';
import { awaitsRequiredHumanReview, classifyChecks } from './pullRequestReadiness.js';

const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', state: 'SUCCESS' }];
const view = (overrides = {}) => ({ state: 'OPEN', isDraft: false, isCrossRepository: false, mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: green, ...overrides });

describe('classifyChecks', () => {
  it('keeps failed, pending, and green check states distinct', () => {
    expect(classifyChecks([{ conclusion: 'FAILURE' }])).toBe('failed');
    expect(classifyChecks([{ state: 'ERROR' }])).toBe('failed');
    expect(classifyChecks([{ conclusion: 'STARTUP_FAILURE' }])).toBe('failed');
    expect(classifyChecks([])).toBe('pending');
    expect(classifyChecks([{ status: 'IN_PROGRESS' }])).toBe('pending');
    expect(classifyChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('green');
  });
});

describe('awaitsRequiredHumanReview', () => {
  it('recognizes a green PR held only by a required approving review', () => {
    expect(awaitsRequiredHumanReview(view())).toBe(true);
    // GitHub reports UNKNOWN while it computes mergeability; that is not a conflict.
    expect(awaitsRequiredHumanReview(view({ mergeable: 'UNKNOWN' }))).toBe(true);
  });

  // Each of these leaves work an agent (or its CI wait) still owns, so the run must not be settled as a handoff.
  it.each([
    ['approved', { reviewDecision: 'APPROVED' }],
    ['changes requested', { reviewDecision: 'CHANGES_REQUESTED' }],
    ['no review rule', { reviewDecision: '' }],
    ['red CI', { statusCheckRollup: [...green, { conclusion: 'FAILURE' }] }],
    ['running CI', { statusCheckRollup: [...green, { status: 'IN_PROGRESS', conclusion: '' }] }],
    ['no checks attached', { statusCheckRollup: [] }],
    ['conflicts', { mergeable: 'CONFLICTING' }],
    ['draft', { isDraft: true }],
    ['fork', { isCrossRepository: true }],
    ['merged', { state: 'MERGED' }],
    ['unread draft flag', { isDraft: undefined }],
  ])('refuses %s', (_label, overrides) => {
    expect(awaitsRequiredHumanReview(view(overrides))).toBe(false);
  });

  it('refuses a missing view', () => {
    expect(awaitsRequiredHumanReview(null)).toBe(false);
  });
});
