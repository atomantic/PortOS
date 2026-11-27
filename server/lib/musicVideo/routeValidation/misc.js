/** Request schemas for Music Video character styles, reference research, and spend adjustments. */

import { z } from 'zod';
import { executionOptionsSchema } from '../../aiToolkit/internal/executionOptionsValidation.js';
import { MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT } from '../../referenceLimits.js';
import { MUSIC_VIDEO_CHARACTER_STYLE_IDS } from '../musicVideoCharacterStyles.js';
import { SPEND_ADJUSTMENT_LANES } from '../musicVideoSpend.js';
import { galleryImageName } from '../musicVideoValidation.js';

// Built-in character style routes (routes/musicVideoCharacterStyles.js).
export const musicVideoCharacterStyleParamsSchema = z.object({ id: z.enum(MUSIC_VIDEO_CHARACTER_STYLE_IDS) }).strict();

// null clears this install's character sheet for the style.
export const musicVideoCharacterStyleReferenceSchema = z.object({ imageId: galleryImageName.nullable() }).strict();

// Start Research and seed for one shot: the subject to photograph and the agent that searches.
export const musicVideoResearchSeedSchema = z.object({
  subject: z.string().trim().min(2).max(200),
  count: z.number().int().min(1).max(MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT).optional(),
  providerId: z.string().trim().min(1).max(256),
  model: z.string().trim().max(256).optional(),
  effort: z.string().trim().max(32).optional(),
  executionOptions: executionOptionsSchema.optional(),
  preview: z.boolean().optional(),
}).strict();

/**
 * A manual spend adjustment (#16506): `actualUsd` states what the lane really cost (the
 * adjustment is the difference from what the project shows), `usd` adds a signed amount.
 * Exactly one of the two.
 */
export const musicVideoSpendAdjustmentSchema = z.object({
  lane: z.enum(SPEND_ADJUSTMENT_LANES),
  actualUsd: z.number().finite().min(0).max(1_000_000).optional(),
  usd: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  note: z.string().trim().max(500).optional(),
}).strict().refine((input) => (input.actualUsd == null) !== (input.usd == null), {
  message: 'Give either actualUsd (what the lane really cost) or usd (an amount to add), not both',
});
