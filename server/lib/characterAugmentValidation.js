/**
 * Route schemas for selective character augmentation (#6415 / #6417).
 *
 * The Universe cast editor and the Writers Room work bible expose the same two
 * endpoints over the same field contract, so they validate against the same two
 * schemas — a second hand-written copy is how one surface ends up accepting a
 * path the other rejects.
 *
 * Both are pinned to `AUGMENTABLE_FIELD_PATHS`, which is the string-valued
 * subset of the integrity contract. That is deliberately narrower than "any
 * character field": it keeps a request from reaching the service (and the
 * provider) with a path the before/after preview cannot render.
 */

import { z } from 'zod';
import { AUGMENTABLE_FIELD_PATHS } from './characterIntegrity.js';

/** Propose sharper values for the named populated fields. Writes nothing. */
export const characterAugmentProposeSchema = z.object({
  fields: z.array(z.enum(AUGMENTABLE_FIELD_PATHS)).min(1).max(AUGMENTABLE_FIELD_PATHS.length),
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(128).optional(),
});

/**
 * Apply only the proposals the author accepted. `fingerprint` is the character
 * state the preview was reviewed against — the service turns a mismatch into a
 * 409 rather than overwriting whatever was edited in the meantime.
 */
export const characterAugmentApplySchema = z.object({
  fields: z.array(z.object({
    field: z.enum(AUGMENTABLE_FIELD_PATHS),
    value: z.string().trim().min(1).max(4000),
  })).min(1).max(AUGMENTABLE_FIELD_PATHS.length),
  fingerprint: z.string().max(20000).optional(),
});
