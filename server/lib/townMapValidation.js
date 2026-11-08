/** Save schema for an Environment's town map (lib/townMap.js), kept apart so the browser-safe half has no zod. */
import { z } from 'zod';
import { TOWN_LIMITS, TOWN_STREET_KINDS, TOWN_STREET_SIDES, TOWN_VERSION } from './townMap.js';

const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const coord = z.number().finite().min(-TOWN_LIMITS.COORD).max(TOWN_LIMITS.COORD);
const point = z.tuple([coord, coord]);

export const townMapSchema = z.object({
  version: z.literal(TOWN_VERSION),
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  sets: z.array(z.object({
    id,
    ingredientId: z.string().trim().min(1).max(128),
    position: point,
    rotationDegrees: z.number().finite().min(-360).max(360),
  }).strict()).max(TOWN_LIMITS.SETS),
  streets: z.array(z.object({
    id,
    kind: z.enum(TOWN_STREET_KINDS),
    sides: z.enum(TOWN_STREET_SIDES),
    width: z.number().finite().min(1).max(TOWN_LIMITS.WIDTH_MAX),
    points: z.array(point).min(2).max(TOWN_LIMITS.STREET_POINTS),
  }).strict()).max(TOWN_LIMITS.STREETS),
}).strict().superRefine((town, ctx) => {
  const seen = new Set();
  for (const entry of [...town.sets, ...town.streets]) {
    if (seen.has(entry.id)) ctx.addIssue({ code: 'custom', message: `Duplicate id ${entry.id}` });
    seen.add(entry.id);
  }
});
