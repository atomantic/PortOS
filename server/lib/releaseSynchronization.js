import { checkoutSeedSchema } from './checkoutSeed.js';
import { retirementCheckoutIdentityFromPointer } from './retirementCheckoutObservation.js';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

// An operator can retire a stale synchronization checkpoint without claiming
// that its missing historical evidence was verified.
export const releaseSynchronizationResetCheckoutSchema = z.object({ path: z.string().refine(isAbsolute), branch: z.string().min(1),
  head: z.string().regex(/^[a-f0-9]{40}$/), checkoutIdentity: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const releaseSynchronizationResetSchema = z.object({
  version: z.literal(1), identity: z.string().regex(/^[a-f0-9]{64}$/),
  resetAt: z.string().datetime(), actor: z.enum(['operator-session', 'local-operator']),
  reason: z.string().trim().min(1).max(1000),
  previousStatus: z.enum(['pending', 'running', 'blocked']), previousBlocker: z.string().nullable(),
  checkouts: z.array(releaseSynchronizationResetCheckoutSchema).max(10),
}).strict();

export function releaseSynchronizationReset(entry) {
  const parsed = releaseSynchronizationResetSchema.safeParse(entry?.operatorReset);
  return parsed.success && parsed.data.identity === entry.identity ? parsed.data : null;
}

export function resetReleasesCheckout(entry, checkout) {
  return releaseSynchronizationReset(entry)?.checkouts.some(row => row.path === checkout.path && row.branch === checkout.branch
    && row.head === checkout.head && row.checkoutIdentity === checkout.checkoutIdentity) === true;
}

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

export function publisherCandidateTarget(entry) {
  const seed = publisherCandidateSeed(entry);
  if (!seed) return null;
  return { agentId: seed.agentId, repoPath: seed.repoPath, branch: seed.branch, path: seed.path,
    head: entry.publication.candidateHead, checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation.pointer),
    createdAt: seed.seededAt };
}

export function effectiveReleaseSynchronization(entry) {
  return entry?.synchronization;
}
