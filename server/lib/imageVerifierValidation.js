// Zod request schemas for the image verifier routes.

import { z } from 'zod';

export const verifyRequestSchema = z.object({
  filename: z.string().min(1),
  profileId: z.string().optional(),
  prompt: z.string().optional(),
  isImport: z.boolean().optional(),
  reviewerModel: z.string().optional(),
  reviewer: z.object({
    providerId: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
});

export const overrideRequestSchema = z.object({
  filename: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'unreviewed']),
  notes: z.string().max(1000).optional(),
});
