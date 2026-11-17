/**
 * Route schemas for selective character augmentation (#6415 / #6417).
 *
 * Zod schemas for selective character augmentation (#6417): `characterAugmentProposeSchema` and
 * `characterAugmentApplySchema`, both pinned to `AUGMENTABLE_FIELD_PATHS`. Shared by the Universe cast
 * routes and the Writers Room work-bible routes so the two surfaces cannot drift on which field paths
 * a proposal may name.
 *
 * `AUGMENTABLE_FIELD_PATHS` is deliberately the string-valued subset of the integrity
 * contract, so no request reaches the service or provider with a path the
 * before/after preview cannot render.
 */

import { z } from 'zod';
import { AUGMENTABLE_FIELD_PATHS } from './characterIntegrity.js';

/** Propose sharper values for the named populated fields. Writes nothing. */
export const characterAugmentProposeSchema = z.object({
  fields: z.array(z.enum(AUGMENTABLE_FIELD_PATHS)).min(1).max(AUGMENTABLE_FIELD_PATHS.length),
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(128).optional(),
});

/** Apply only accepted proposals; a `fingerprint` mismatch (character edited since preview) becomes a 409. */
export const characterAugmentApplySchema = z.object({
  fields: z.array(z.object({
    field: z.enum(AUGMENTABLE_FIELD_PATHS),
    value: z.string().trim().min(1).max(4000),
  })).min(1).max(AUGMENTABLE_FIELD_PATHS.length),
  fingerprint: z.string().max(20000).optional(),
});
