// Zod request schemas for the history routes.

import { z } from 'zod';

export const historyQuerySchema = z.object({
  limit: z.preprocess(v => (v !== undefined ? Number(v) : undefined), z.number().int().min(1).max(1000).optional()),
  offset: z.preprocess(v => (v !== undefined ? Number(v) : undefined), z.number().int().min(0).optional()),
  action: z.string().optional(),
  target: z.string().optional(),
  success: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
});

export const historyClearQuerySchema = z.object({
  olderThanDays: z.preprocess(v => (v !== undefined ? Number(v) : undefined), z.number().int().min(1).max(36500).optional()),
});
