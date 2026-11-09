/** Request schemas owned by the catalog's greybox endpoints. */
import { z } from 'zod';
import { GREYBOX_LIMITS, greyboxSceneSchema } from './greyboxScene.js';
import { GREYBOX_INSTRUCTION_MAX, GREYBOX_SHOT_ID_MAX } from './greyboxVocabulary.js';
import { PHOTOREAL_ENGINES, PHOTOREAL_FLYTHROUGH_SECONDS, PHOTOREAL_MAX_SAMPLES } from './greyboxBlender.js';
import { PHOTOREAL_TEXTURE_ID, PHOTOREAL_TEXTURED_PRESETS, photorealLookSchema } from './photorealLook.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { worldMapSchema } from './worldMapValidation.js';
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

// World map (lib/worldMap.js): the sets it places and the paths between them; `world: null` removes it.
export const catalogWorldSaveSchema = z.object({
  world: worldMapSchema.nullable(),
  source: z.enum(REVISION_SOURCES).optional(),
}).strict();

export const catalogGreyboxCaptureSchema = z.object({
  dataBase64: z.string().min(1).max(32 * 1024 * 1024),
}).strict();

// Scene, camera and output size always come from the saved record/contract.
export const catalogGreyboxRenderSchema = z.object({}).strict();

// Photoreal (Blender) render of saved cameras. Samples default per engine.
export const catalogPhotorealRenderSchema = z.object({
  shotIds: z.array(z.string().trim().min(1).max(GREYBOX_SHOT_ID_MAX)).min(1).max(GREYBOX_LIMITS.SHOTS)
    .refine((ids) => new Set(ids).size === ids.length, 'each camera once'),
  engine: z.enum(PHOTOREAL_ENGINES),
  samples: z.number().int().min(1).max(PHOTOREAL_MAX_SAMPLES).optional(),
  // A fly-through glides through shotIds in order and saves an MP4 to Media History.
  flythroughSeconds: z.number().finite().min(PHOTOREAL_FLYTHROUGH_SECONDS.MIN).max(PHOTOREAL_FLYTHROUGH_SECONDS.MAX).optional(),
}).strict().refine((body) => !body.flythroughSeconds || body.shotIds.length >= 2, { message: 'a fly-through needs at least two cameras', path: ['shotIds'] });

// Opening or building the scene takes no input: the data and executable are fixed.
export const catalogPhotorealOpenSchema = z.object({}).strict();

// Photoreal look: AI draft/preview reuse the greybox draft body; `look: null` clears it.
export const catalogPhotorealLookDraftSchema = catalogGreyboxDraftSchema;
export const catalogPhotorealLookSaveSchema = z.object({
  look: photorealLookSchema.nullable(),
  source: z.enum(REVISION_SOURCES).optional(),
}).strict();

// CC0 photo textures (Poly Haven): search when the picker opens, download on a tap.
export const catalogPhotorealTextureSearchSchema = z.object({
  preset: z.enum(PHOTOREAL_TEXTURED_PRESETS),
  q: z.string().max(80).optional().default(''),
}).strict();
export const catalogPhotorealTextureIdSchema = z.string().regex(PHOTOREAL_TEXTURE_ID);

// The Previz page reports a browser-side build or sync as a tracked job so other tabs show it.
export const previzBuildJobStartSchema = z.object({
  projectId: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(80).default('Previz build'),
});
export const previzBuildJobFinishSchema = z.object({
  ok: z.boolean().default(true),
  summary: z.string().trim().max(300).nullish(),
});
