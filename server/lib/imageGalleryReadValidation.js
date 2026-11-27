// Zod request schemas for the image gallery read routes.

import { z } from 'zod';

export const galleryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  q: z.string().max(500).default(''),
  hidden: z.enum(['true', 'false']).optional().transform(v => v === undefined ? undefined : v === 'true'),
  starred: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  localOnly: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  rating: z.enum(['good', 'bad']).optional(),
  videoSizeOverBytes: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  summary: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  // Opt-in card projection for migrated consumers; omitted keeps full records.
  compact: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  filename: z.string().min(1).max(255).optional(),
  kind: z.enum(['image', 'video', 'all']).default('image'),
  media: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  collectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  universeId: z.string().min(1).max(255).optional(),
  entryCategory: z.string().min(1).max(255).optional(),
  entryKind: z.string().min(1).max(255).optional(),
});

export const galleryLookupSchema = z.object({ filenames: z.array(z.string().min(1).max(255)).max(200) });
