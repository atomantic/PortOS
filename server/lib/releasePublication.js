import { z } from 'zod';

export const releasePublicationRequestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  promotionPrNumber: z.number().int().positive().safe(),
  workflowRunId: z.number().int().positive().safe(),
}).strict();

export const releaseCandidateRequestSchema = z.object({ action: z.enum(['reserve', 'capture']) }).strict();
