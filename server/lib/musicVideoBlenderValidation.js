/**
 * Request schemas for the Music Video Blender film routes
 * (routes/musicVideoBlender.js). A leaf beside musicVideoValidation.js so the
 * ~450 suites reaching that module do not pay for these.
 */
import { z } from 'zod';
import {
  MUSIC_VIDEO_BLENDER_ENGINES, MUSIC_VIDEO_BLENDER_MAX_OPTIONS, MUSIC_VIDEO_BLENDER_NOTE_STATUSES, MUSIC_VIDEO_BLENDER_OPTION_KEY,
  MUSIC_VIDEO_BLENDER_OPTION_TEXT_MAX, MUSIC_VIDEO_BLENDER_QUALITIES,
  MUSIC_VIDEO_BLENDER_SETTING_LIMITS as LIMITS, MUSIC_VIDEO_BLENDER_SHOT_ID, MUSIC_VIDEO_BLENDER_SOURCE_PATH,
  MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES,
} from './musicVideoBlender.js';

const whole = ({ min, max }) => z.number().int().min(min).max(max);
const evenPixels = (limits) => whole(limits).refine((value) => value % 2 === 0, 'must be an even number of pixels');

// A partial save: only the fields sent change.
export const musicVideoBlenderSettingsSchema = z.object({
  engine: z.enum(MUSIC_VIDEO_BLENDER_ENGINES).optional(),
  width: evenPixels(LIMITS.width).optional(),
  height: evenPixels(LIMITS.height).optional(),
  fps: whole(LIMITS.fps).optional(),
  previewScale: z.number().min(LIMITS.previewScale.min).max(LIMITS.previewScale.max).optional(),
  previewSamples: whole(LIMITS.previewSamples).optional(),
  finalSamples: whole(LIMITS.finalSamples).optional(),
  concurrency: whole(LIMITS.concurrency).optional(),
  saveBlend: z.boolean().optional(),
  // Film option values, by the key the film declared. Only the keys sent change; null clears
  // a saved value back to the film's default. Each value is checked against the synced
  // declaration in the service (the film, not this schema, says what an option accepts).
  options: z.record(
    z.string().regex(MUSIC_VIDEO_BLENDER_OPTION_KEY, 'Invalid option key'),
    z.union([z.string().max(MUSIC_VIDEO_BLENDER_OPTION_TEXT_MAX), z.number(), z.boolean(), z.null()]),
  ).refine((options) => Object.keys(options).length <= MUSIC_VIDEO_BLENDER_MAX_OPTIONS, `At most ${MUSIC_VIDEO_BLENDER_MAX_OPTIONS} options`).optional(),
}).strict();

export const musicVideoBlenderWorkspaceSchema = z.object({
  template: z.literal('starter').optional(),
}).strict();

const sourcePath = z.string().min(1).max(400).regex(MUSIC_VIDEO_BLENDER_SOURCE_PATH, 'path must be a relative file path under src/');

export const musicVideoBlenderFileQuerySchema = z.object({ path: sourcePath }).strict();

// The byte cap is re-checked on the encoded text in the service; this bounds the JSON body.
export const musicVideoBlenderFileWriteSchema = z.object({
  path: sourcePath,
  content: z.string().max(MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES),
}).strict();

export const musicVideoBlenderSyncSchema = z.object({
  replaceScenes: z.boolean().optional(),
}).strict();

const shotId = z.string().regex(MUSIC_VIDEO_BLENDER_SHOT_ID, 'Invalid shot id');

export const musicVideoBlenderRenderSchema = z.object({
  shotIds: z.array(shotId).min(1).max(400).optional(),
  quality: z.enum(MUSIC_VIDEO_BLENDER_QUALITIES),
  // Stills only: song seconds. Omitted, each shot renders its midpoint.
  times: z.array(z.number().min(0).max(36000)).min(1).max(24).optional(),
  force: z.boolean().optional(),
  onlyStale: z.boolean().optional(),
}).strict().refine((input) => input.times == null || input.quality === 'still', { message: 'times applies to stills only', path: ['times'] });

export const musicVideoBlenderCutSchema = z.object({
  quality: z.enum(['preview', 'final']),
  animatic: z.boolean().optional(),
  filmLook: z.boolean().optional(),
}).strict();

export const musicVideoBlenderNoteSchema = z.object({
  text: z.string().max(4000).optional(),
  status: z.enum(MUSIC_VIDEO_BLENDER_NOTE_STATUSES).optional(),
}).strict().refine((input) => input.text !== undefined || input.status !== undefined, 'Send text, status or both');

// A file under renders/: shot videos, frames, stills, cuts and job logs. Not
// strict: a player may append its own cache-busting parameter, which is ignored.
export const musicVideoBlenderMediaQuerySchema = z.object({
  path: z.string().min(1).max(400).regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*){0,4}$/, 'path must be a relative file path under renders/'),
});
