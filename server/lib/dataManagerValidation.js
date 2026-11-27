// Zod request schemas for the data manager routes.

import { z } from 'zod';

export const recordingLocator = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), id: z.string().regex(/^[a-zA-Z0-9_-]+$/) });

export const recordingOffsetQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(10000000).default(0) });

export const recordingPurgeSchema = z.object({ token: z.string().uuid(), confirmation: z.literal('PURGE RAW RECORDINGS').optional() }).strict();

export const recordingPinSchema = recordingLocator.extend({ pinned: z.boolean() }).strict();

export const storageMeasureQuerySchema = z.object({ measure: z.literal('1').optional() });
