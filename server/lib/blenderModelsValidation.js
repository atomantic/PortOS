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
