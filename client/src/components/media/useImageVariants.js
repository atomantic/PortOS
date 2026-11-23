/**
 * Fetches the original-vs-cleaned variant set for the one open image (`GET
 * /api/image-gen/:filename/variants`), normalized.
 *
 * Reuses the held group across toggle clicks and aborts a superseded lookup. `null` while unfetched or failed, `[]` when the image is not indexed. Used by `MediaPreview` for every image preview.
 */

import { useEffect, useState } from 'react';
import { fetchImageVariantGroup } from './mediaDetail';
import { normalizeImage } from './normalize';

/**
 * Fetch the original-vs-cleaned variant set for the ONE image the lightbox has open, so the toggle is built from real lineage, not whatever list the host page holds: a projection of refs (a deck's `imageRefs`, a pipeline or music-video scene)
 * never contains the copy (cleaning auto-files it into the source's media COLLECTIONS), and a gallery only holds a 60-row window while a clean stamps a fresh `createdAt`. Hydrating the whole list would be the whole-list POST #7343 removed.
 * Returns `null` while unfetched or after a failed lookup (the caller keeps its own list); `[]` means the image is not indexed.
 * @param {object|null} item - the open preview item; non-image items fetch nothing
 * @returns {object[]|null} normalized image records, or null when not fetched
 */
export default function useImageVariants(item) {
  const filename = item?.kind === 'image' && item.filename ? item.filename : null;
  const [fetched, setFetched] = useState(null);
  // A group is closed under the toggle, so switching to a variant we already hold would re-request an identical set and blank the toggle; also true for a filename that already failed, so one failure doesn't retry forever.
  const holds = !!filename
    && (fetched?.filename === filename || !!fetched?.items?.some((variant) => variant.filename === filename));
  useEffect(() => {
    if (!filename || holds) return undefined;
    // `fetchImageVariantGroup` (mediaDetail.js) de-dupes this read against `useHydratedPreviewRoute` hydrating the SAME filename (#8341), so no AbortController (it would cancel the other caller's share); `cancelled` guards the state write.
    let cancelled = false;
    fetchImageVariantGroup(filename)
      .then((items) => {
        if (!cancelled) setFetched({ filename, items: Array.isArray(items) ? items.map(normalizeImage) : null });
      })
      // Non-fatal: `items: null` hands the answer back to the caller's list.
      .catch(() => { if (!cancelled) setFetched({ filename, items: null }); });
    return () => { cancelled = true; };
  }, [filename, holds]);
  return holds ? fetched.items : null;
}
