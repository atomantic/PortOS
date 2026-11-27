/** Request schemas for Music Video cameo rosters, references, and variants. */

import { z } from 'zod';
import {
  MUSIC_VIDEO_CAMEO_MAX_REFERENCES,
  MUSIC_VIDEO_CAMEO_MAX_SOURCES,
  MUSIC_VIDEO_CAMEO_REFERENCE_SOURCES,
  MUSIC_VIDEO_CAMEO_RESEARCH_STATUSES,
  MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN,
  MUSIC_VIDEO_MAX_CAMEOS,
} from '../musicVideoCameos.js';

// Music Video cameo roster (#14821, lib/musicVideo/musicVideoCameos.js).
const cameoImageIdSchema = z.string().max(256).regex(/^[^/\\]+\.(png|jpe?g|webp)$/i, 'Image must be a gallery basename ending in png/jpg/webp');

const cameoUrlSchema = z.string().trim().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links');

const cameoTextFields = {
  name: z.string().trim().min(1).max(120),
  // What the video shows on screen; empty means the name.
  label: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
};

const musicVideoCameoResearchSchema = z.object({
  status: z.enum(MUSIC_VIDEO_CAMEO_RESEARCH_STATUSES).optional(),
  notes: z.string().trim().max(8000).optional(),
  sources: z.array(z.object({ url: cameoUrlSchema, title: z.string().trim().max(300).optional() }).strict())
    .max(MUSIC_VIDEO_CAMEO_MAX_SOURCES).optional(),
}).strict();

const musicVideoCameoReferenceInputSchema = z.object({
  imageId: cameoImageIdSchema,
  source: z.enum(MUSIC_VIDEO_CAMEO_REFERENCE_SOURCES).optional(),
  // The image file a researched photo came from, and the page it was found on.
  sourceUrl: cameoUrlSchema.optional(),
  pageUrl: cameoUrlSchema.optional(),
}).strict();

export const musicVideoCameoCreateSchema = z.object({
  cameos: z.array(z.object(cameoTextFields).strict()).min(1).max(MUSIC_VIDEO_MAX_CAMEOS),
}).strict();

export const musicVideoCameoUpdateSchema = z.object({
  name: cameoTextFields.name.optional(),
  label: cameoTextFields.label,
  description: cameoTextFields.description,
  research: musicVideoCameoResearchSchema.optional(),
  stillImageId: cameoImageIdSchema.nullable().optional(),
}).strict();

export const musicVideoCameoReferencesAddSchema = z.object({
  references: z.array(musicVideoCameoReferenceInputSchema).min(1).max(MUSIC_VIDEO_CAMEO_MAX_REFERENCES),
}).strict();

export const musicVideoCameoReferenceRemoveSchema = z.object({ imageId: cameoImageIdSchema }).strict();

export const musicVideoCameoVariantCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  // How the variant differs from the chosen still (the instruction a shot's Refine renders it with).
  prompt: z.string().max(2000).optional(),
  imageId: cameoImageIdSchema.nullable().optional(),
}).strict();

export const musicVideoCameoVariantUpdateSchema = musicVideoCameoVariantCreateSchema.partial().strict();

export const musicVideoCameoLinkSchema = z.object({
  sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  variantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN).nullable().optional(),
}).strict();

export const musicVideoCameoUnlinkSchema = z.object({ sceneIds: z.array(z.string().min(1).max(64)).min(1).max(500) }).strict();

// Use a linked shot's selected still as the cameo's still, or one variant's.
export const musicVideoCameoStillFromShotSchema = z.object({
  sceneId: z.string().min(1).max(64),
  variantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN).nullable().optional(),
}).strict();
