import { z } from 'zod';
import { filmLookSchema } from './filmLookValidation.js';
import { PHOTOGRAPHY_FIELDS, VISUAL_PROFILE_TEXT_MAX } from './universeVisualProfile.js';

const text = z.string().max(VISUAL_PROFILE_TEXT_MAX).refine(value => !value.includes('\0'), 'Photography direction cannot contain NUL').optional();
export const universeVisualProfileSchema = z.object({
  version: z.literal(1),
  generation: z.object({
    enabled: z.boolean().optional(),
    ...Object.fromEntries(PHOTOGRAPHY_FIELDS.map(field => [field.id, text])),
    avoid: text,
  }).strict().optional(),
  finishing: z.object({
    mode: z.enum(['off', 'preview', 'save']).optional(),
    look: filmLookSchema.nullable().optional(),
    colorAmount: z.number().min(0).max(1).optional(),
    textureAmount: z.number().min(0).max(1).optional(),
  }).strict().optional(),
}).strict();
