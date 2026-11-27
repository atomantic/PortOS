// Zod request schemas for the media annotations routes.

import { z } from 'zod';
import * as limits from './mediaAnnotationConstraints.js';

export const patchSchema = z.object({
  starred: z.boolean().optional(),
  rating: z.enum(limits.MEDIA_RATINGS).nullable().optional(),
  note: z.string().max(limits.NOTE_MAX_LENGTH).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include starred, rating and/or note' });
