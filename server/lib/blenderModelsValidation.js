/**
 * Request schemas for the Blender Models routes (routes/blenderModels.js): records, source files, builds and publishing.
 *
 * Source paths follow the Blender workspace rules shared with films (`MUSIC_VIDEO_BLENDER_SOURCE_PATH`); the
 * text byte cap is re-checked on the encoded text in the service, so the schema only bounds the JSON body.
 */
import { z } from 'zod';
import { MUSIC_VIDEO_BLENDER_SOURCE_PATH, MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES } from './musicVideo/musicVideoBlender.js';

const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(300).regex(/^[^\r\n]*$/, 'description must be one line');
const sourcePath = z.string().min(1).max(400).regex(MUSIC_VIDEO_BLENDER_SOURCE_PATH, 'path must be a relative file path under src/');
const buildId = z.string().regex(/^build-\d{8}T\d{6}Z-[0-9a-f]{8}$/, 'buildId must name a build');

export const createBlenderModelSchema = z.object({ name, description: description.optional() }).strict();

export const patchBlenderModelSchema = z.object({ name: name.optional(), description: description.optional() }).strict()
  .refine((patch) => patch.name !== undefined || patch.description !== undefined, 'name or description is required');

export const blenderModelWorkspaceSchema = z.object({ template: z.literal('starter').optional() }).strict();

export const blenderModelFileQuerySchema = z.object({ path: sourcePath }).strict();

export const blenderModelFileWriteSchema = z.object({
  path: sourcePath,
  content: z.string().max(MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES),
}).strict();

export const blenderModelBuildSchema = z.object({ quality: z.enum(['draft', 'full']).optional() }).strict();

export const blenderModelPublishSchema = z.object({ buildId }).strict();

const imageFilename = z.string().min(1).max(256).regex(/^(?![.])[^/\\]+\.(png|jpe?g|webp)$/i, 'must be an image filename');
const referenceWords = z.string().max(4000);

export const blenderModelReferenceSourceSchema = z.object({
  ingredientId: z.string().min(1).max(128).nullable().optional(),
  images: z.array(z.object({ filename: imageFilename, label: z.string().max(200).optional() }).strict()).max(32).optional(),
  size: z.string().max(200).regex(/^[^\r\n]*$/, 'size must be one line').optional(),
  imageMode: z.string().max(32).nullable().optional(),
  imageModelId: z.string().max(64).nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'nothing to change');

export const blenderModelCloseupSchema = z.object({ mechanism: z.string().trim().min(1).max(80).regex(/^[^\r\n]*$/, 'mechanism must be one line') }).strict();

export const blenderModelReferenceWordsSchema = z.object({ words: referenceWords.optional() }).strict();

export const blenderModelReferenceImageSchema = z.object({ filename: imageFilename }).strict();

export const blenderModelReferenceReviewSchema = z.object({ decision: z.enum(['approve', 'redo']), note: z.string().max(2000).optional() }).strict();

export const blenderModelPartsBriefSchema = z.object({}).strict();
