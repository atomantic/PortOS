import { z } from 'zod';
import { FILM_LOOK_CONTROLS, FILM_LOOK_PRESET_IDS, FILM_LOOK_VERSION } from './filmLook.js';

/**
 * The film-look record a project stores and a gallery bake receives, derived
 * from the one control table so a new control is validated the moment it is
 * declared. Every field is optional (the normalizer fills defaults); unknown
 * keys are refused so a typo never silently becomes "no effect".
 */
const controlShape = {};
for (const control of FILM_LOOK_CONTROLS) {
  if (control.type === 'color') controlShape[control.id] = z.string().regex(/^#[0-9a-f]{6}$/i, `${control.id} is #rrggbb`).optional();
  else if (control.type === 'toggle') controlShape[control.id] = z.boolean().optional();
  else controlShape[control.id] = z.number().min(control.min).max(control.max).optional();
}

export const filmLookSchema = z.object({
  version: z.literal(FILM_LOOK_VERSION).optional(),
  preset: z.enum([...FILM_LOOK_PRESET_IDS, 'custom']).optional(),
  ...controlShape,
}).strict();

/** Body of `POST /api/image-gen/:filename/film-look`: the look to bake into a new copy. */
export const filmLookBakeSchema = z.object({
  look: filmLookSchema,
}).strict();
