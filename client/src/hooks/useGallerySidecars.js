import { useCallback, useEffect, useMemo, useState } from 'react';
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
 * `filenames` may be a fresh array each render — the fetch is keyed on the
 * sorted, de-duplicated contents, not on array identity. `refreshKey` re-runs
 * the lookup once a new render has landed on disk.
 *
 * Returns `{ byFilename, setSidecar }`; `setSidecar(record)` splices one
 * freshly written record in (e.g. after a clean) without a refetch.
 */
export default function useGallerySidecars(filenames, refreshKey = 0) {
  const lookupKey = useMemo(
    () => JSON.stringify([...new Set((Array.isArray(filenames) ? filenames : []).filter(Boolean))].sort()),
    [filenames],
  );
  const [byFilename, setByFilename] = useState(() => new Map());
  useEffect(() => {
    const wanted = JSON.parse(lookupKey);
    if (!wanted.length) { setByFilename(new Map()); return undefined; }
    let cancelled = false;
    getGalleryImages(wanted, { silent: true }).then((list) => {
      if (cancelled) return;
      const map = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        if (item?.filename) map.set(item.filename, item);
      }
      setByFilename(map);
    }).catch(() => { /* non-fatal; callers fall back to their own labels */ });
    return () => { cancelled = true; };
  }, [lookupKey, refreshKey]);
  const setSidecar = useCallback((record) => {
    if (!record?.filename) return;
    setByFilename((prev) => new Map(prev).set(record.filename, record));
  }, []);
  return { byFilename, setSidecar };
}
