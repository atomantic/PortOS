import { checkoutSeedSchema } from './checkoutSeed.js';
import { retirementCheckoutIdentityFromPointer } from './retirementCheckoutObservation.js';
import { matchingRetirementReceipts } from './reconcileRetirementEvidence.js';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const physicalIdentity = value => value && /^(0|[1-9]\d*)$/.test(value.dev || '') && /^[1-9]\d*$/.test(value.ino || '')
  && /^[1-9]\d*$/.test(value.birthtimeNs || '');
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
// PostgreSQL jsonb may reorder keys at every depth. The review digest binds
// values rather than JavaScript insertion order so it survives a restart.
const canonicalLegacyEvidence = value => Array.isArray(value) ? value.map(canonicalLegacyEvidence)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalLegacyEvidence(value[key])]))
    : value;
export const legacyRecoveryDigest = evidence => createHash('sha256').update(JSON.stringify(canonicalLegacyEvidence(evidence))).digest('hex');

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

/** The durable receipt is a new observation, never a backdated seed. */
export function legacyPublisherRecovery(entry) {
  const recovery = entry?.legacyRecovery;
  const proof = recovery?.evidence;
  const capture = proof?.capture;
  const expectedPr = `https://github.com/${entry?.publication?.repository}/pull/${entry?.publication?.promotionPrNumber}`;
  if (!proof || !entry?.owner || publisherCandidateSeed(entry) || recovery?.version !== 1 || recovery.kind !== 'legacy-publisher' || !Number.isFinite(Date.parse(recovery.acceptedAt))
    || Date.parse(recovery.acceptedAt) > Date.now() || recovery.digest !== legacyRecoveryDigest(proof)
    || proof?.identity !== entry.identity || !isDeepStrictEqual(proof.owner, entry.owner)
    || !capture || capture.version !== 1 || capture.agentId !== entry.owner.agentId || capture.startedAt !== entry.owner.startedAt
    || typeof capture.branch !== 'string' || !capture.branch || capture.head !== entry.publication.candidateHead || (entry.publication.candidateBranch && capture.branch !== entry.publication.candidateBranch)
    || !isAbsolute(entry.owner.workspace || '') || !isAbsolute(capture.repoPath || '') || !isAbsolute(capture.path || '') || !samePath(capture.repoPath, entry.owner.workspace)
    || samePath(capture.repoPath, capture.path) || !checkoutSeedSchema.shape.incarnation.safeParse(capture.incarnation).success
    || !isAbsolute(capture.incarnation.gitdir.path) || !physicalIdentity(capture.incarnation.pointer)
    || !physicalIdentity(capture.incarnation.gitdir) || !Number.isFinite(Date.parse(capture.capturedAt))
    || Date.parse(capture.capturedAt) < Date.parse(entry.owner.startedAt) || Date.parse(capture.capturedAt) > Date.parse(recovery.acceptedAt)
    || proof.prUrl !== expectedPr || proof.forge?.prHead !== capture.head || proof.forge?.mergeCommit !== entry.publication.promotionMerge
    || proof.forge?.repository !== `github.com/${entry.publication.repository}` || proof.forge?.prUrl !== expectedPr
    || ![1, 2].includes(proof.review?.version) || proof.review?.prUrl !== expectedPr || proof.review?.base !== 'release' || proof.review?.branch !== capture.branch
    || !(proof.review?.version === 1 ? /^[a-f0-9]{40}$/.test(proof.review?.reviewedHead || '')
      : /^[a-f0-9]{40}$/.test(proof.review?.completedHead || '') && ((proof.review?.inspectionProvenance === 'recorded' && /^[a-f0-9]{40}$/.test(proof.review?.reviewedHead || ''))
        || (proof.review?.inspectionProvenance === 'unavailable' && proof.review?.reviewedHead === null))) || !['clean', 'partial'].includes(proof.review?.status)
    || proof.candidateInspection !== 'unverified'
    || !isAbsolute(proof.archive?.archiveDir || '') || !/^[a-f0-9]{64}$/.test(proof.archive?.evidenceDigest || '')
    || Date.parse(proof.archive?.archivedAt) < Date.parse(capture.capturedAt)
    || !Number.isFinite(Date.parse(proof.archive?.archivedAt)) || Date.parse(proof.archive.archivedAt) > Date.parse(recovery.acceptedAt)
    || !['present', 'retired'].includes(proof.mode)
    || (proof.mode === 'present' && (proof.preservation?.receipt?.status !== 'preserved'
      || proof.preservation.receipt.archiveDir !== proof.archive.archiveDir
      || !isDeepStrictEqual(proof.preservation.receipt.incarnation, capture.incarnation)
      || !Number.isFinite(Date.parse(proof.preservation.createdAt))
      || Date.parse(proof.preservation.createdAt) < Date.parse(capture.capturedAt)
      || !Number.isFinite(Date.parse(proof.preservation.receipt.preparedAt))
      || Date.parse(proof.preservation.receipt.preparedAt) < Date.parse(proof.archive.archivedAt)
      || Date.parse(proof.preservation.receipt.preparedAt) > Date.parse(recovery.acceptedAt)
      || typeof proof.preservation.lock?.locked !== 'boolean'
      || !(proof.preservation.lock.lockReason === null || typeof proof.preservation.lock.lockReason === 'string')))
    || (proof.mode === 'retired' && (proof.retirement?.branchDeleted !== true || proof.retirement?.archiveDir !== proof.archive.archiveDir
      || proof.retirement?.path !== capture.path || proof.retirement?.branch !== capture.branch || proof.retirement?.head !== capture.head
      || proof.retirement?.checkoutIdentity !== retirementCheckoutIdentityFromPointer(capture.incarnation.pointer)
      || !Number.isFinite(Date.parse(proof.retirement?.retiredAt)) || Date.parse(proof.retirement.retiredAt) < Date.parse(proof.archive.archivedAt)
      || Date.parse(proof.retirement.retiredAt) > Date.parse(recovery.acceptedAt)))) return null;
  return recovery;
}


export function publisherCandidateTarget(entry) {
  const seed = publisherCandidateSeed(entry);
  const capture = legacyPublisherRecovery(entry)?.evidence.capture;
  const source = seed || capture;
  if (!source) return null;
  return { agentId: source.agentId, repoPath: source.repoPath, branch: source.branch, path: source.path,
    head: entry.publication.candidateHead, checkoutIdentity: retirementCheckoutIdentityFromPointer(source.incarnation.pointer),
    createdAt: seed ? seed.seededAt : capture.capturedAt };
}

function publisherReviewRetained(entry) {
  const legacy = legacyPublisherRecovery(entry);
  if (legacy) return isDeepStrictEqual(entry?.obligations?.retirement?.evidence?.legacyRecovery, legacy);

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
  const legacy = legacyPublisherRecovery(entry);
  if (legacy) {
    const target = publisherCandidateTarget(entry);
    const evidence = entry?.obligations?.retirement?.evidence;
    return Array.isArray(evidence?.checkouts) && evidence.checkouts.some(row => isDeepStrictEqual(row, target))
      && Array.isArray(evidence?.receipts) && matchingRetirementReceipts({ retired: evidence.receipts }, target).some(row =>
        row.checkoutIdentity === target.checkoutIdentity && Date.parse(row.retiredAt) >= Date.parse(target.createdAt)
        && Date.parse(row.retiredAt) <= Date.now()
        && (legacy.evidence.mode === 'retired' ? isDeepStrictEqual(row, legacy.evidence.retirement)
          : row.archiveDir == null || row.archiveDir === legacy.evidence.archive.archiveDir))
      && isDeepStrictEqual(evidence.legacyRecovery, legacy);
  }
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
  if (synchronization?.status === 'verified' && !publisherCandidateTarget(entry)) {
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
