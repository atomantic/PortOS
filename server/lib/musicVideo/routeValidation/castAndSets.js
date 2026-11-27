/** Request schemas for Music Video cast and sets check-in, image edits, and feedback. */

import { z } from 'zod';
import { EFFORT_LEVELS } from '../../provider/providerModels.js';
import { CAST_SETS_IMAGE_EDIT_MAX } from '../musicVideoCastSetsImageEdit.js';
import { castSetsText } from '../musicVideoValidation.js';
import { devArtifactNoteTarget, devArtifactNoteText } from './shared.js';

export { musicVideoCastAndSetsStartSchema } from './shared.js';
export { musicVideoCastAndSetsDirectionEditSchema } from '../musicVideoValidation.js';

export const musicVideoShotReferenceRepairSchema = z.object({ problemId: z.string().regex(/^[a-f0-9]{64}$/) });

export const musicVideoCastSetsUseImageSchema = z.object({
  key: z.string().min(1).max(80),
  imageId: z.string().min(1).max(500),
}).strict();

export const musicVideoCastSetsImageEditSchema = z.object({
  key: z.string().min(1).max(80),
  imageId: z.string().min(1).max(500),
  revision: z.number().int().min(1),
  instruction: z.string().min(1).max(CAST_SETS_IMAGE_EDIT_MAX).refine((text) => !!text.trim(), 'Write an image edit instruction'),
}).strict();

export const musicVideoCastSetsImageEditDecisionSchema = z.object({
  key: z.string().min(1).max(80), requestId: z.string().uuid(),
}).strict();

// Regenerate with notes. Omitted notes = the open notes on the sheet. A
// `target` names an image (`character`, `expressions`, `looks`, `form:<id>`, `cast:<id>`, `set:<id>`,
// `test:<n>`); any other note revises the direction. `keys` re-renders just
// those images (and what depends on them), leaving open sheet notes open.
export const musicVideoCastAndSetsRegenerateSchema = z.object({
  notes: z.array(z.object({
    text: devArtifactNoteText,
    target: devArtifactNoteTarget,
  }).strict()).min(1).max(50).optional(),
  keys: z.array(z.string().min(1).max(80)).min(1).max(40).optional(),
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

// Plain-text feedback on a Cast & Sets sheet. No target = the whole sheet
// (standing feedback the direction keeps honoring); a target names one image.
export const musicVideoCastAndSetsFeedbackSchema = z.object({
  text: devArtifactNoteText,
  target: devArtifactNoteTarget,
  providerId: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();

export const musicVideoCastAndSetsFeedbackPlanSchema = z.object({
  revision: z.number().int().positive(),
}).strict();

export const musicVideoCastAndSetsFeedbackRenderSchema = musicVideoCastAndSetsFeedbackPlanSchema.extend({
  count: z.number().int().nonnegative(),
}).strict();

export const musicVideoCastAndSetsImageNoteRemovalSchema = z.object({
  key: z.string().min(1).max(80),
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(2000),
}).strict();

// Text-only edits to a catalog check-in's stored direction (no render, no image
// roles). Same present-replaces / absent-keeps rule; caps mirror CAST_SETS_LIMITS.
export const musicVideoCastAndSetsDirectionTextEditSchema = z.object({
  look: castSetsText(500).optional(),
  protagonist: z.object({
    signature: castSetsText(1000).optional(),
    rules: z.array(castSetsText(300)).max(6).optional(),
    expressions: z.array(castSetsText(300)).max(8).optional(),
  }).strict().optional(),
  props: z.array(z.object({
    id: z.string().max(64).optional(),
    name: castSetsText(120).min(1),
    owner: castSetsText(120).optional(),
    description: castSetsText(1000).min(1),
  }).strict()).max(6).optional(),
  overlayConcept: z.object({
    summary: castSetsText(1000).optional(),
    elements: z.array(z.object({
      name: castSetsText(120).min(1),
      description: castSetsText(1000).min(1),
    }).strict()).max(4).optional(),
  }).strict().optional(),
}).strict();
