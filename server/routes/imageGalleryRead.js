// Shared production collection reads; safe to mount without generation routes.
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

export function createImageGalleryHandlers(listGallery = async () => (await import('../services/imageGen/local.js')).listGallery()) {
  const galleryQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(60),
    offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    q: z.string().max(500).default(''),
    hidden: z.enum(['true', 'false']).optional().transform(v => v === undefined ? undefined : v === 'true'),
    starred: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
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

  const collections = asyncHandler(async (_req, res) => {
    const { listGalleryCollectionSummaries } = await import('../services/mediaAssetIndex/gallery.js');
    res.json(await listGalleryCollectionSummaries(listGallery));
  });

  const facets = asyncHandler(async (_req, res) => {
    const { listGalleryFacets } = await import('../services/mediaAssetIndex/gallery.js');
    res.json(await listGalleryFacets(listGallery));
  });

  // Reference hydration is bounded independently of browsing; callers send only
  // filenames actually attached to their universe, project or export.
  const lookup = asyncHandler(async (req, res) => {
    const { filenames } = validateRequest(z.object({ filenames: z.array(z.string().min(1).max(255)).max(200) }), req.body);
    const { listGalleryPage } = await import('../services/mediaAssetIndex/gallery.js');
    res.json((await listGalleryPage({ limit: 200, mediaKeys: filenames.map(f => `image:${f}`) }, listGallery)).items);
  });

  const list = asyncHandler(async (req, res) => {
    // No paging keys preserves the full legacy array for callers not migrated yet.
    // New callers use ?limit=5 (recent strip) or ?limit=60&offset=0&q=...
    const paginated = Object.keys(galleryQuerySchema.shape).some(key => req.query[key] !== undefined);
    if (!paginated) return res.json(await listGallery());
    const options = validateRequest(galleryQuerySchema, req.query);
    const { listGalleryPage } = await import('../services/mediaAssetIndex/gallery.js');
    res.json(await listGalleryPage(options, listGallery));
  });

  return { collections, facets, lookup, list };
}
