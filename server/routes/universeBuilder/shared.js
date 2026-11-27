/**
 * Shared plumbing for the universe-builder sub-routers: the service-error →
 * HTTP status map and the two gallery/upload image resolvers the vision +
 * style-reference routes both need.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { ServerError, createServiceErrorMapper } from '../../lib/errorHandler.js';
import { PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import { sanitizeFilename } from '../../lib/mimeTypes.js';
import * as svc from '../../services/universeBuilder.js';
import { buildCascadeContext } from '../../services/recordMerge.js';

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_VALIDATION]: 400,
  // Block-until-empty: deleting a universe with live series → 409 (the
  // lock-conflict idiom) so the client can show "move these N series first".
  [svc.ERR_HAS_LIVE_SERIES]: 409,
  // recordMerge validation (unresolved conflicts, bad ids).
  MERGE_VALIDATION: 400,
  // recordMerge cascade partially completed (a child re-point failed) → 409 so
  // the client can surface "merge incomplete, re-run to finish".
  MERGE_CASCADE_INCOMPLETE: 409,
};

// Propagate diagnostic context onto the response body via `context`: the
// blocking-series list for a delete-guard 409, or the survivor/loser ids +
// which children failed to re-point for an incomplete merge cascade.
export const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS, (err) =>
  err?.blockingSeries ? { blockingSeries: err.blockingSeries } : buildCascadeContext(err),
);

// Resolve a mixed `[{ source, filename }]` list into runner-loadable paths,
// failing loudly per the source's rules. The runner silently DROPS a missing
// image and still sends the text prompt, so a stale/never-uploaded reference
// would let the model describe with fewer references — or hallucinate from the
// prompt alone if all are missing. Reject up front instead.
export function resolveImageSources(images) {
  return images.map(({ source, filename }) => {
    if (source === 'gallery') {
      const abs = resolveGalleryImage(filename);
      if (!abs) {
        throw new ServerError(`Gallery image not found: ${filename} — pick another and retry.`, { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
      }
      return abs;
    }
    // 'upload' — the upload route already sanitizes on write, so a legitimately
    // uploaded name round-trips unchanged. A hand-crafted name with path
    // components is rejected outright (a 400, not a silent rewrite to a name
    // that won't exist), keeping a traversal attempt distinguishable from a
    // deleted/never-uploaded file.
    const safe = sanitizeFilename(filename);
    if (safe !== filename) {
      throw new ServerError(`Invalid screenshot filename: ${filename}`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    if (!existsSync(join(PATHS.screenshots, safe))) {
      throw new ServerError(`Screenshot not found: ${safe} — re-upload the image and retry.`, { status: 400, code: 'SCREENSHOT_NOT_FOUND' });
    }
    return safe;
  });
}

// Resolve a SINGLE gallery filename to an absolute path, rejecting a
// traversal attempt or an unknown file up front. Shared by the two
// single-gallery-image vision routes (`analyze-style-reference`,
// `correct-from-image`) that resolve one reference image rather than the
// mixed upload/gallery list `resolveImageSources` handles.
export function resolveGalleryImageOrThrow(filename) {
  const imageFilename = sanitizeFilename(filename);
  if (imageFilename !== filename) {
    throw new ServerError(`Invalid gallery image filename: ${filename}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const imagePath = resolveGalleryImage(imageFilename);
  if (!imagePath) {
    throw new ServerError(`Gallery image not found: ${imageFilename} — upload it again and retry.`, {
      status: 400,
      code: 'GALLERY_IMAGE_NOT_FOUND',
    });
  }
  return { imageFilename, imagePath };
}
