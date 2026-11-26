/** Zod schemas for X accounts, local drafts, reviews, and browser handoff destinations. */

import { z } from 'zod';

export const xIdSchema = z.string().uuid();
const username = z.preprocess((value) => typeof value === 'string' ? value.trim().replace(/^@/, '') : value, z.string().regex(/^[A-Za-z0-9_]{1,15}$/, 'must be an X username'));
export const xAccountSchema = z.object({
  label: z.string().trim().min(1).max(120),
  username,
  enabled: z.boolean().optional(),
  notes: z.string().max(4_000).optional(),
}).strict();
export const xAccountUpdateSchema = xAccountSchema.partial();

export const xDraftUpdateSchema = z.object({
  body: z.string().trim().min(1).max(4_000).refine((body) => !body.includes('\0'), 'must not contain null characters'),
}).strict();
export const xDraftCreateSchema = xDraftUpdateSchema.extend({ accountId: xIdSchema });
export const xReviewSchema = z.object({ state: z.enum(['pending_review', 'approved', 'rejected']), reviewNote: z.string().max(2_000).optional() }).strict();
export const xHandoffSchema = z.object({ kind: z.enum(['profile', 'latest', 'people', 'settings']) }).strict();
