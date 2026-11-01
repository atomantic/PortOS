import { z } from 'zod';
import { checkoutSeedSchema } from './checkoutSeed.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const isHistoricalReleaseReceipt = receipt => receipt?.status === 'verified'
  && /^[a-f0-9]{64}$/.test(receipt.identity || '')
  && (receipt.synchronizationHandoffVersion == null || receipt.synchronizationHandoffVersion === 1);
const releaseOwner = z.object({ agentId: z.string().min(1), taskId: z.string().min(1), startedAt: z.string().datetime() });
// Persisted service evidence, never accepted as request input.
export const releaseCandidateTransferSchema = z.object({
  version: z.literal(1), source: releaseOwner, successor: releaseOwner, origin: releaseOwner,
  transferredAt: z.string().datetime(), branch: z.string().min(1), path: z.string().min(1),
  lineage: z.object({ kind: z.enum(['seeded', 'contemporaneous-receipt']), seed: checkoutSeedSchema.optional(),
    receipt: z.object({ repoPath: z.string().min(1), branch: z.string().min(1), path: z.string().min(1),
      head: sha, incarnation: checkoutSeedSchema.shape.incarnation }) }),
  candidate: z.object({ cutoff: sha, pin: sha, releaseBase: sha, previousCommit: sha,
    previousTag: z.string().min(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), tree: sha }),
  review: z.object({ legacyPublished: z.boolean(), files: z.array(z.object({ name: z.string().min(1),
    bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) }),
  publication: z.object({ number: z.number().int().positive(), url: z.string().url(), head: sha,
    merged: z.boolean(), merge: sha.nullable() }).nullable(),
  settlement: z.object({ active: z.literal(0), settledAt: z.string().datetime(),
    owner: releaseOwner }),
});

export const releasePublicationRequestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  promotionPrNumber: z.number().int().positive().safe(),
  workflowRunId: z.number().int().positive().safe(),
  synchronizationMode: z.literal('inline').optional(),
}).strict();

export const releaseCandidateRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['reserve', 'capture', 'sync-reserve', 'sync-capture']) }).strict(),
  z.object({ action: z.literal('recover'), predecessorAgentId: z.string().regex(/^agent-[a-z0-9-]+$/) }).strict(),
]);
