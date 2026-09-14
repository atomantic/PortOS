import { useEffect, useState } from 'react';
import { listImageVariants } from '../services/apiImageVideo';
import { normalizeImage } from '../components/media/normalize';

/**
 * Fetch the original-vs-cleaned variant set for the ONE image the lightbox has
 * open, so the toggle is built from real lineage rather than from whatever list
 * the host page happens to hold.
 *
 * A host list can't answer this, for two separate reasons. A page whose list is
 * a projection of its own refs (a deck's card `imageRefs`, a pipeline or
 * music-video scene) never contains the copy at all: cleaning auto-files it
 * into the source's media COLLECTIONS, not onto the card. And a gallery page
 * only holds a window — 60 rows, newest first — while a clean stamps the copy
 * with a fresh `createdAt`, so cleaning anything older than that window
 * separates the pair there too. Hydrating the whole list to find out would be
 * the whole-list POST #7343 removed.
 *
 * Returns `null` while unfetched or after a failed lookup, so the caller keeps
 * its own list as the answer. `[]` means the image is not indexed.
 *
 * @param {object|null} item - the open preview item; non-image items fetch nothing
 * @returns {object[]|null} normalized image records, or null when not fetched
 */
export default function useImageVariants(item) {
  const filename = item?.kind === 'image' && item.filename ? item.filename : null;
  const [fetched, setFetched] = useState(null);
  // A group is closed under the toggle, so switching to a variant we already
  // hold would re-request an identical set and blank the toggle for the round
  // trip. Also true for a filename a lookup already failed on, so one failure
  // doesn't retry forever.
  const holds = !!filename
    && (fetched?.filename === filename || !!fetched?.items?.some((variant) => variant.filename === filename));
  useEffect(() => {
    if (!filename || holds) return undefined;
    // Abort saves the server the work; `cancelled` guards the state write,
    // because `request()` reports an abort as an ordinary failure and a late
    // rejection would otherwise overwrite the next image's result.
    let cancelled = false;
    const controller = new AbortController();
    listImageVariants(filename, { signal: controller.signal })
      .then((result) => {
        if (!cancelled) setFetched({ filename, items: Array.isArray(result?.items) ? result.items.map(normalizeImage) : null });
      })
      // Non-fatal: `items: null` hands the answer back to the caller's list.
      .catch(() => { if (!cancelled) setFetched({ filename, items: null }); });
    return () => { cancelled = true; controller.abort(); };
  }, [filename, holds]);
  return holds ? fetched.items : null;
}
