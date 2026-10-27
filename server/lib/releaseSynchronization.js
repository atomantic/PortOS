// A continuation keeps the delivery policy enrolled at publication time.
// Runtime retry/claim state and delivery evidence remain independently mutable.
export const RELEASE_SYNC_OBLIGATIONS = ['candidateFixes', 'releaseAncestry', 'synchronizationPr', 'localReview',
  'hostedReview', 'requiredCi', 'mergeAdmission', 'qualitySnapshot', 'processSettlement', 'retirement'];

export const RELEASE_SYNC_POLICY_KEYS = ['app', 'provider', 'model', 'effort', 'reviewers', 'usernames', 'optionalReviewers',
  'reviewerModels', 'reviewerEfforts', 'reviewerMaxRounds', 'reviewStopMode', 'prCompletion'];

export const RELEASE_SYNC_FROZEN_METADATA_KEYS = [...RELEASE_SYNC_POLICY_KEYS,
  'releaseSynchronization', 'idempotencyKey', 'targetInstanceId', 'prompt', 'analysisType',
  'useWorktree', 'openPR', 'worktreeChangesExpected', 'readOnly', 'discardWorktree',
  'forkHead', 'reviewLoop', 'reviewLoopLeaveOpen', 'reviewerApplies', 'noCodeOutput',
  'noChangeSuccess', 'slashdoCommand'];
