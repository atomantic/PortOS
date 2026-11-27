// Shared production collection reads; safe to mount without generation routes.
import { galleryQuerySchema, galleryLookupSchema } from '../lib/imageGalleryReadValidation.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';

export function createImageGalleryHandlers(listGallery = async () => (await import('../services/imageGen/local.js')).listGallery()) {

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
    const { filenames } = validateRequest(galleryLookupSchema, req.body);
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
