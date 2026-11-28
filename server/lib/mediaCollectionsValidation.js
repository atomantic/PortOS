// Zod request schemas for the media collections routes.

import { z } from 'zod';
import * as limits from './mediaCollectionConstraints.js';

const nameSchema = z.string().trim().min(1).max(limits.NAME_MAX_LENGTH);

const descriptionSchema = z.string().trim().max(limits.DESCRIPTION_MAX_LENGTH);

// `:` is the API key separator (`<kind>:<ref>` is split on first `:`), so a
// ref containing one would be unaddressable for DELETE/coverKey lookups.
const refSchema = z.string().trim().min(1).max(limits.REF_MAX_LENGTH).refine((s) => !s.includes(':'), { message: 'ref may not contain ":"' });

const kindSchema = z.enum(['image', 'video']);

export const createSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional().default(''),
});

export const patchSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  // coverKey: null clears it (auto = newest); a string pins a specific item.
  coverKey: z.union([z.string().trim().min(1).max(limits.REF_MAX_LENGTH + 8), z.null()]).optional(),
  // Provenance override (#3311) — lets the user correct a collection the
  // migration's marker classification stamped wrong. Deliberately absent from
  // `createSchema`: a POST is a person creating a collection, which the service
  // stamps 'user' on its own, so accepting the field there would only let a
  // client mislabel its own new collection.
  source: z.enum(limits.COLLECTION_SOURCES).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

export const itemSchema = z.object({
  kind: kindSchema,
  ref: refSchema,
});

export const localizeSchema = z.object({ keys: z.array(z.string().min(1).max(limits.REF_MAX_LENGTH + 8)).max(limits.ITEMS_MAX).optional() });
