import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGalleryImages } from '../services/apiImageVideo';

/**
 * Hydrate a known set of gallery filenames into their image-metadata sidecars
 * (`prompt`, `negativePrompt`, `modelId`, `seed`, size, …).
 *
 * Every page that shows renders it *owns* the references for — a universe
 * draft, a deck's cards — needs the same thing: the record of what was
 * ACTUALLY sent to the renderer, which is the sidecar, not the page's own
 * label or the card's subject prompt. Without it a lightbox opened from such
 * a page shows the row's display text and Refine / Remix / Send to Video open
 * with the wrong prompt.
 *
 * `filenames` may be a fresh array each render — the lookup is keyed on the
 * sorted, de-duplicated contents, not on array identity. A changed list fetches
 * only what is not already held and merges it in: a render completing appends
 * ONE filename to its record, and re-fetching the whole set each time turned
 * rendering a 78-card deck into 78 lookups carrying 3,081 filenames between
 * them. A filename that comes back empty stays unresolved and is retried by the
 * next lookup.
 *
 * A changed `refreshKey` means the sidecars themselves may have changed on
 * disk, which a list comparison cannot see — so it re-reads every filename,
 * including ones already held. Pass one only when that can happen; a caller
 * whose renders always arrive under new filenames (a deck) needs none.
 *
 * Returns `{ byFilename, setSidecar }`; `setSidecar(record)` splices one
 * freshly written record in (e.g. after a clean) without a refetch.
 */
export default function useGallerySidecars(filenames, refreshKey = 0) {
  const { wanted, lookupKey } = useMemo(() => {
    const unique = [...new Set((Array.isArray(filenames) ? filenames : []).filter(Boolean))].sort();
    return { wanted: unique, lookupKey: unique.join('\n') };
  }, [filenames]);
  const [byFilename, setByFilename] = useState(() => new Map());
  // What the map already holds, readable from the effect without making the
  // map its own dependency (which would re-run the effect on its own result).
  const loadedRef = useRef(new Set());
  const refreshedAtRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshedAtRef.current !== refreshKey) {
      refreshedAtRef.current = refreshKey;
      loadedRef.current = new Set();
    }
    const missing = wanted.filter((f) => !loadedRef.current.has(f));
    if (!missing.length) return undefined;
    let cancelled = false;
    getGalleryImages(missing, { silent: true }).then((list) => {
      if (cancelled) return;
      const found = (Array.isArray(list) ? list : []).filter((item) => item?.filename);
      if (!found.length) return;
      for (const item of found) loadedRef.current.add(item.filename);
      setByFilename((prev) => {
        const next = new Map(prev);
        for (const item of found) next.set(item.filename, item);
        return next;
      });
    }).catch(() => { /* non-fatal; callers fall back to their own labels */ });
    return () => { cancelled = true; };
    // `lookupKey` stands in for `wanted`, which is rebuilt on every change to
    // the caller's (memoized) list even when its contents are identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupKey, refreshKey]);
  const setSidecar = useCallback((record) => {
    if (!record?.filename) return;
    loadedRef.current.add(record.filename);
    setByFilename((prev) => new Map(prev).set(record.filename, record));
  }, []);
  return { byFilename, setSidecar };
}
