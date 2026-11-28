// Zod request schemas for the system resources routes.

import { z } from 'zod';
import { EFFORT_LEVELS } from './provider/providerModels.js';

export const duplicatePairsSchema = z.object({
  pairs: z.array(z.object({
    sourcePath: z.string().min(1).max(4096).refine((path) => !path.includes('\0'), 'Invalid model path'),
    targetPath: z.string().min(1).max(4096).refine((path) => !path.includes('\0'), 'Invalid model path'),
  }).strict()).min(1).max(200),
  mode: z.enum(['hardlink', 'clone']).default('hardlink'),
}).strict();

export const emptyBodySchema = z.object({}).strict();

const blankToUndefined = (value) => {
  const trimmed = (value ?? '').trim();
  return trimmed || undefined;
};

export const systemResourceTriageSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().max(256).optional().transform(blankToUndefined),
  effort: z.string().max(64).optional().transform(blankToUndefined)
    .refine((value) => value === undefined || EFFORT_LEVELS.includes(value), 'Unsupported effort level'),
}).strict();
