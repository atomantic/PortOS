/**
 * Validated request for forge-verified release publication milestones.
 */

import { z } from 'zod';

export const isHistoricalReleaseReceipt = receipt => receipt?.status === 'verified'
  && /^[a-f0-9]{64}$/.test(receipt.identity || '')
  && (receipt.synchronizationHandoffVersion == null || receipt.synchronizationHandoffVersion === 1);

export const releasePublicationRequestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  promotionPrNumber: z.number().int().positive().safe(),
  workflowRunId: z.number().int().positive().safe(),
  synchronizationMode: z.literal('inline').optional(),
}).strict();

export const releaseCandidateRequestSchema = z.object({
  action: z.enum(['reserve', 'capture', 'sync-reserve', 'sync-capture']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
}).strict();
