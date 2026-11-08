/** Save schema for an Environment's world map (lib/worldMap.js), kept apart so the browser-safe half has no zod. */
import { z } from 'zod';
import { WORLD_LIMITS, WORLD_PATH_KINDS, WORLD_PATH_SIDES, WORLD_POLE_SIDES, WORLD_POLE_SPACING, WORLD_ROAD_INFRASTRUCTURE, WORLD_SETTINGS, WORLD_VERSION } from './worldMap.js';

const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const coord = z.number().finite().min(-WORLD_LIMITS.COORD).max(WORLD_LIMITS.COORD);
const point = z.tuple([coord, coord]);

export const worldMapSchema = z.object({
  version: z.literal(WORLD_VERSION),
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  setting: z.enum(WORLD_SETTINGS).optional(),
  sets: z.array(z.object({
    id,
    ingredientId: z.string().trim().min(1).max(128),
    position: point,
    rotationDegrees: z.number().finite().min(-360).max(360),
  }).strict()).max(WORLD_LIMITS.SETS),
  paths: z.array(z.object({
    id,
    kind: z.enum(WORLD_PATH_KINDS),
    sides: z.enum(WORLD_PATH_SIDES),
    infrastructure: z.enum(WORLD_ROAD_INFRASTRUCTURE).optional(),
    poleSide: z.enum(WORLD_POLE_SIDES).optional(),
    poleSpacing: z.number().finite().min(WORLD_POLE_SPACING.min).max(WORLD_POLE_SPACING.max).optional(),
    width: z.number().finite().min(1).max(WORLD_LIMITS.WIDTH_MAX),
    points: z.array(point).min(2).max(WORLD_LIMITS.PATH_POINTS),
  }).strict()).max(WORLD_LIMITS.PATHS),
}).strict().superRefine((world, ctx) => {
  const seen = new Set();
  for (const entry of [...world.sets, ...world.paths]) {
    if (seen.has(entry.id)) ctx.addIssue({ code: 'custom', message: `Duplicate id ${entry.id}` });
    seen.add(entry.id);
  }
});
