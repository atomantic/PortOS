/** Strict wire shapes for Music Video image treatment settings and live preview. */

import { z } from 'zod';
import { IMAGE_TREATMENT_PRESETS, IMAGE_TREATMENT_FORMATS, IMAGE_TREATMENT_POSITIONS,
  IMAGE_TREATMENT_RANGES, IMAGE_TREATMENT_LIMIT, isImageTreatmentDate } from './musicVideoImageTreatments.js';

const imageId = z.string().min(1).max(256).regex(/^[^/\\\\]+$/).refine(id => id !== '.' && id !== '..');
const boundedNumber = ([min, max]) => z.number().min(min).max(max);

export const musicVideoImageTreatmentSchema = z.object({
  imageId,
  type: z.enum(Object.keys(IMAGE_TREATMENT_PRESETS)),
  date: z.string().refine(isImageTreatmentDate, 'Enter a valid calendar date'),
  format: z.enum(Object.keys(IMAGE_TREATMENT_FORMATS)),
  position: z.enum(Object.keys(IMAGE_TREATMENT_POSITIONS)),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  size: boundedNumber(IMAGE_TREATMENT_RANGES.size),
  opacity: boundedNumber(IMAGE_TREATMENT_RANGES.opacity),
  intensity: boundedNumber(IMAGE_TREATMENT_RANGES.intensity),
}).strict().refine(({ type, format }) => type === 'print' || !['month-year', 'full-date'].includes(format), {
  message: 'Optical camera imprints display numeric dates', path: ['format'],
});

export const musicVideoImageTreatmentsSchema = z.array(musicVideoImageTreatmentSchema).max(IMAGE_TREATMENT_LIMIT)
  .refine(items => new Set(items.map(item => item.imageId)).size === items.length, 'Each image can have only one treatment');

export const musicVideoImageTreatmentQuerySchema = z.object({
  treatment: z.string().max(950).transform((value, ctx) => {
    try { return JSON.parse(value); }
    catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid image treatment' });
      return z.NEVER;
    }
  }).pipe(musicVideoImageTreatmentSchema),
}).strict();
