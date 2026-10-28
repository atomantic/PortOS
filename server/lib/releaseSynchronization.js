import { checkoutSeedSchema } from './checkoutSeed.js';
import { retirementCheckoutIdentityFromPointer } from './retirementCheckoutObservation.js';
import { matchingRetirementReceipts } from './reconcileRetirementEvidence.js';
import { isAbsolute, resolve } from 'node:path';

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

// A branch name alone is not ownership. Only a server-captured physical seed
// from the publisher's run can identify the checkout that produced the PR.
export function publisherCandidateSeed(entry) {
  const branch = entry?.publication?.candidateBranch;
  const owner = entry?.owner;
  if (typeof branch !== 'string' || !branch || !owner || !Array.isArray(entry.checkouts)) return null;
  const matches = entry.checkouts.filter(seed => checkoutSeedSchema.safeParse(seed).success
    && seed.agentId === owner.agentId && seed.startedAt === owner.startedAt && seed.branch === branch
    && isAbsolute(seed.repoPath) && isAbsolute(seed.path) && isAbsolute(seed.incarnation.gitdir.path)
    && resolve(seed.repoPath) !== resolve(seed.path) && Date.parse(seed.seededAt) >= Date.parse(seed.startedAt)
    && Date.parse(seed.seededAt) <= Date.now());
  return matches.length === 1 ? matches[0] : null;
}

function publisherReviewRetained(entry) {
  const seed = publisherCandidateSeed(entry);
  const review = entry?.obligations?.retirement?.evidence?.publisherReview;
  if (!seed || !review) return false;
  const prUrl = `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`;
  return review.branch === seed.branch && review.path === seed.path && review.head === entry.publication.candidateHead
    && review.checkoutIdentity === retirementCheckoutIdentityFromPointer(seed.incarnation.pointer)
    && review.prUrl === prUrl && Array.isArray(review.models)
    && (review.receipt === null || (review.receipt && review.receipt.prUrl === prUrl));
}

function publisherRetirementRetained(entry) {
  const seed = publisherCandidateSeed(entry);
  const evidence = entry?.obligations?.retirement?.evidence;
  if (!seed || !Array.isArray(evidence?.checkouts) || !Array.isArray(evidence?.receipts)) return false;
  const identity = retirementCheckoutIdentityFromPointer(seed.incarnation.pointer);
  const row = evidence.checkouts.find(target => target.agentId === seed.agentId && target.repoPath === seed.repoPath
    && target.branch === seed.branch && target.path === seed.path && target.head === entry.publication.candidateHead
    && target.checkoutIdentity === identity && target.createdAt === seed.seededAt);
  return Boolean(row && matchingRetirementReceipts({ retired: evidence.receipts }, row).some(receipt => receipt.archiveDir === null
    && receipt.checkoutIdentity === identity && Date.parse(receipt.retiredAt) >= Date.parse(seed.seededAt)
    && Date.parse(receipt.retiredAt) <= Date.now()));
}

// Old outboxes may already say verified despite never capturing the publisher's
// checkout. Never project or use that verdict to admit another release.
export function effectiveReleaseSynchronization(entry) {
  const synchronization = entry?.synchronization;
  if (synchronization?.status === 'verified' && !publisherCandidateSeed(entry)) {
    return { ...synchronization, status: 'blocked', blocker: 'publisher-candidate-checkout-unverified',
      verifiedAt: null, retryAt: null };
  }
  if (synchronization?.status === 'verified' && !publisherReviewRetained(entry)) {
    return { ...synchronization, status: 'blocked', blocker: 'publisher-private-review-unretained',
      verifiedAt: null, retryAt: null };
  }
  if (synchronization?.status === 'verified' && !publisherRetirementRetained(entry)) {
    return { ...synchronization, status: 'blocked', blocker: 'publisher-retirement-receipt-unverified',
      verifiedAt: null, retryAt: null };
  }
  return synchronization;
}
