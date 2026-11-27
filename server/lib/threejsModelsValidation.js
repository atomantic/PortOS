// Zod request schemas for the threejs models routes.

import { z } from 'zod';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { GENERAL_FAMILY_ID, THREEJS_MODEL_FAMILY_IDS } from './threejsModelFamilies.js';
import { THREEJS_REFERENCE_ROLES, MAX_THREEJS_REFERENCE_IMAGES } from './threejsModelReferenceLimits.js';
import { emptyToNull } from './zodCompat.js';

const galleryFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+\.png$/i, 'filename must be a gallery PNG basename');

// Reasoning-effort override. The picker's "Default effort" choice submits `''`,
// which maps to an explicit `null` CLEAR — distinct from the key being absent,
// which leaves the record's stored effort alone (see startGeneration).
const effortSchema = z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional());

// Subject-family checklist. Unlike `effort` there is no "clear" state — the
// picker's General choice submits the real `general` id, so an empty string is
// normalized to it rather than to `null`.
//
// A family id this install does not ship gets the same treatment rather than a
// 400. The picker can only offer ids the server served, so an unrecognized
// STRING is never fresh user intent — it is a record written by a build with a
// larger taxonomy (a downgrade, or a backup restored from a machine ahead of
// this one), which the detail page reads straight back into its refine request.
// Rejecting it would make that record permanently un-refinable; coercing it
// degrades to "no checklist" exactly like every other layer and self-heals the
// record on the next generate. A non-string is a malformed body, not a stale
// value, and still falls through to the enum and a 400.
const familySchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value === '') return GENERAL_FAMILY_ID;
  return THREEJS_MODEL_FAMILY_IDS.includes(value) ? value : GENERAL_FAMILY_ID;
}, z.enum(THREEJS_MODEL_FAMILY_IDS).optional());

// Absent keeps the record's references on refine; an empty array clears them.
const referenceImagesSchema = z.array(z.object({
  filename: galleryFilenameSchema,
  role: z.enum(THREEJS_REFERENCE_ROLES),
  label: z.string().trim().max(120).default(''),
})).max(MAX_THREEJS_REFERENCE_IMAGES).optional();

export const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  filename: galleryFilenameSchema,
  prompt: z.string().trim().max(2_000).default(''),
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(256).optional(),
  effort: effortSchema,
  family: familySchema,
  referenceImages: referenceImagesSchema,
});

export const generateSchema = z.object({
  providerId: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().max(256).optional(),
  effort: effortSchema,
  prompt: z.string().trim().max(2_000).optional(),
  family: familySchema,
  referenceImages: referenceImagesSchema,
  feedback: z.string().trim().max(2_000).default(''),
});

export const productSheetQuerySchema = z.object({ filename: galleryFilenameSchema });
