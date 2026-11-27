// Zod request schemas for the autobiography routes.

import { z } from 'zod';
import { HHMM_STRICT_RE } from './timezone.js';

// Validation schemas
export const CUSTOM_PROMPT_ID = 'custom';

export const saveStorySchema = z.object({
  // Either a bank prompt id, `followup-<id>`, or the `custom` sentinel when the
  // user wrote their own question — in which case `customPromptText` carries it.
  promptId: z.string().min(1),
  content: z.string().min(1).max(50000),
  parentStoryId: z.string().optional(),
  customPromptText: z.string().max(500).optional()
}).refine(
  (v) => v.promptId !== CUSTOM_PROMPT_ID || !!v.customPromptText?.trim(),
  { message: 'customPromptText is required when promptId is "custom"', path: ['customPromptText'] }
);

export const generateFollowUpsSchema = z.object({
  providerId: z.string().optional()
});

export const weaveNarrativeSchema = z.object({
  providerId: z.string().optional()
});

export const updateStorySchema = z.object({
  content: z.string().min(1).max(50000)
});

export const evaluateStorySchema = z.object({
  providerId: z.string().optional()
});

export const nextPromptQuerySchema = z.object({ exclude: z.string().min(1).max(200).optional() });

export const storiesQuerySchema = z.object({ theme: z.string().min(1).max(100).optional() });

export const updateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().min(1).max(168).optional(),
  reminder: z.object({
    enabled: z.boolean().optional(),
    // Strict "HH:MM" — the scheduler refuses to register anything else, so a
    // malformed time has to fail here rather than silently disable the cron.
    time: z.string().regex(HHMM_STRICT_RE, 'Expected a 24-hour HH:MM time').optional()
  }).optional()
});

// The promptId stories written against the user's own question carry. Not a
// bank id, so getPromptById() returns null for it and the story's own
// promptText is the only question of record.
