/** Request schemas owned by the catalog's greybox endpoints. */
import { z } from 'zod';
import { greyboxSceneSchema } from './greyboxScene.js';
import { GREYBOX_INSTRUCTION_MAX } from './greyboxVocabulary.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { emptyToNull } from './zodCompat.js';
import { REVISION_SOURCES } from './catalogValidation.js';

// Place greybox (docs/plans/2026-10-25-place-greybox.md). The draft body is the
// provider › model › effort pick plus the user's own instruction; the picker's
// "Default effort" submits '' which clears to undefined.
// Also the body of the prompt preview, which sends nothing to a provider: the
// pick fields are accepted and ignored there.
export const catalogGreyboxDraftSchema = z.object({
  // Sent as written: validated for content, never trimmed or otherwise rewritten.
  instruction: z.string().max(GREYBOX_INSTRUCTION_MAX).refine((v) => v.trim().length > 0, 'instruction is required'),
  providerId: z.string().trim().max(128).optional().default(''),
  model: z.string().trim().max(256).optional().default(''),
  effort: z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional()).transform((v) => v || ''),
  useCurrent: z.boolean().optional().default(true),
}).strict();

// `greybox: null` removes the place's greybox.
export const catalogGreyboxSaveSchema = z.object({
  greybox: greyboxSceneSchema.nullable(),
  source: z.enum(REVISION_SOURCES).optional(),
}).strict();

export const catalogGreyboxCaptureSchema = z.object({
  dataBase64: z.string().min(1).max(32 * 1024 * 1024),
}).strict();

// Scene, camera and output size always come from the saved record/contract.
export const catalogGreyboxRenderSchema = z.object({}).strict();
