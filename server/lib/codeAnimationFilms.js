/** Public input for standalone films; authored sources use the shared film contract. */
import { z } from 'zod';
import { musicVideoBlenderSettingsSchema } from './musicVideoBlenderValidation.js';

const filmTimelineSchema = z.object({
  durationSec: z.number().min(1).max(3600),
  fps: musicVideoBlenderSettingsSchema.shape.fps.unwrap(),
}).strict();
export const createFilmSchema = z.object({
  title: z.string().trim().min(1).max(200),
  timeline: filmTimelineSchema,
}).strict();
export const patchFilmSchema = createFilmSchema.partial();
export const filmAudioSchema = z.union([
  z.object({ source: z.literal('track'), trackId: z.string().min(1).max(128) }).strict(),
  z.object({ source: z.literal('upload'), filename: z.string().min(1).max(256).regex(/^[^/\\]+$/) }).strict(),
  z.object({ source: z.literal('none') }).strict(),
]);
