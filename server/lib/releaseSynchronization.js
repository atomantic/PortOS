import { releaseCandidateTransferSchema } from './releasePublication.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

// An operator can retire a stale synchronization checkpoint without claiming
// that its missing historical evidence was verified. `checkouts` stays readable
// on resets recorded while synchronization also retired checkouts; new resets
// record none.
const releaseSynchronizationResetCheckoutSchema = z.object({ path: z.string().refine(isAbsolute), branch: z.string().min(1),
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

// Synchronization verifies only that the published release landed on the
// default branch: the back-merge PR merged, and the candidate head, published
// promotion and version floor are on the development head. Review, CI and merge
// admission belong to the forge; checkout cleanup belongs to ordinary worktree
// cleanup. Outboxes written before #16017 carry eight more obligation names;
// they stay readable and are dropped at the next inspection.
export const RELEASE_SYNC_OBLIGATIONS = ['synchronizationPr', 'releaseAncestry'];

export const RELEASE_SYNC_POLICY_KEYS = ['app', 'provider', 'model', 'effort', 'reviewers', 'usernames', 'optionalReviewers',
  'reviewerModels', 'reviewerEfforts', 'reviewerMaxRounds', 'reviewStopMode', 'prCompletion', 'reviewLoop', 'reviewLoopLeaveOpen'];

export const RELEASE_SYNC_FROZEN_METADATA_KEYS = [...RELEASE_SYNC_POLICY_KEYS,
  'releaseSynchronization', 'idempotencyKey', 'targetInstanceId', 'prompt', 'analysisType',
  'useWorktree', 'openPR', 'worktreeChangesExpected', 'readOnly', 'discardWorktree',
  'forkHead', 'reviewerApplies', 'noCodeOutput',
  'noChangeSuccess', 'slashdoCommand'];

// Version 1 belongs to a separate historical task. Version 2 keeps the
// publication and synchronization on the original release task.
export const isInlineReleaseSynchronization = entry => entry?.version === 2;

/** The branch an inline release reserves for its synchronization checkout. */
export const inlineSynchronizationBranch = identity => `codex/release-sync-${identity}`;

export function isInlineReleaseOwner(entry, agent) {
  if (!isInlineReleaseSynchronization(entry) || agent?.taskId !== entry.owner.taskId) return false;
  if (agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt) return true;
  // Publication receipts are server-written after independent Git/GitHub verification.
  if (agent.metadata?.releasePublication?.status === 'verified'
    && agent.metadata.releasePublication.identity === entry.identity) return true;
  const transfer = agent.metadata?.releaseCandidateRecovery?.status === 'transferred'
    ? agent.metadata.releaseCandidateRecovery.transfer : null;
  return releaseCandidateTransferSchema.safeParse(transfer).success
    && transfer.origin.agentId === entry.owner.agentId && transfer.origin.taskId === entry.owner.taskId
    && transfer.origin.startedAt === entry.owner.startedAt && transfer.successor.agentId === agent.id
    && transfer.successor.taskId === agent.taskId && transfer.successor.startedAt === agent.startedAt;
}

export function effectiveReleaseSynchronization(entry) {
  return entry?.synchronization;
}
