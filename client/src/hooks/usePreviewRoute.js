import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import useGalleryPreviewResolver from './useGalleryPreviewResolver';

// URL-driven MediaPreview state. Returns `[preview, setPreview]` with the same
// shape every MediaPreview host already expects, but the source of truth is a
// `?preview=<filename>` query param so previews are deep-linkable, reload-safe,
// and shareable. setPreview(null) drops the param; setPreview(item) writes the
// item's key (falling back to its filename). Pages that mix multiple static
// prefixes in the same items list — UniverseBuilder hosts gallery images
// (/data/images) AND character reference sheets (/data/image-refs) under the
// same modal — rely on the key prefix (`canon-sheet:foo.png` vs `image:foo.png`)
// to disambiguate basename collisions; without the prefix in the URL the
// resolver's filename-match below picks the first hit (typically the gallery
// image) and the wrong asset opens.
//
// Match strategy against the host's items list (in order):
//   1. exact filename match
//   2. exact key match (so callers can deep-link by `key` when filenames collide
//      across different static prefixes — e.g. `canon-sheet:foo.png`)
//   3. key suffix `:<filename>` (so the bare-filename URL still resolves to
//      keys like `image:foo.png` / `canon:foo.png`)
//
// Push vs replace: the first transition closed→open pushes a history entry so
// the browser back button closes the modal. Subsequent prev/next navigation
// and the open→closed transition use replace so the gallery doesn't pollute
// the history stack.
// `resolveItem` defaults to a gallery lookup rather than being per-host wiring:
// the lightbox can navigate to an item the host never listed — picking the other
// entry in the original-vs-cleaned toggle is exactly that, since a cleaned copy
// is auto-filed into the source's media COLLECTIONS and never onto a deck card
// or scene ref. Left opt-in, a host that forgot it would render the toggle and
// then close the lightbox on the click. Pass one only to narrow the lookup
// (MediaCollectionDetail scopes it to its collection).
export default function usePreviewRoute(items, { paramName = 'preview', resolveItem } = {}) {
  const galleryResolver = useGalleryPreviewResolver();
  const resolver = resolveItem || galleryResolver;
  const [searchParams, setSearchParams] = useSearchParams();
  // React Router may replace both values after navigation. Refs let callers
  // keep one action identity (important for memoized gallery cards) while the
  // action still reads and invokes the latest router state.
  const searchParamsRef = useRef(searchParams);
  const setSearchParamsRef = useRef(setSearchParams);
  searchParamsRef.current = searchParams;
  setSearchParamsRef.current = setSearchParams;
  const previewParam = searchParams.get(paramName);

  const localPreview = useMemo(() => {
    if (!previewParam) return null;
    const list = Array.isArray(items) ? items : [];
    return (
      list.find((i) => i?.filename === previewParam)
      || list.find((i) => i?.key === previewParam)
      || list.find((i) => typeof i?.key === 'string' && i.key.endsWith(`:${previewParam}`))
      || null
    );
  }, [items, previewParam]);

  const [resolved, setResolved] = useState(null);
  // Read by setPreview's stable callback without making the resolver its dep.
  const resolverRef = useRef(resolver);
  resolverRef.current = resolver;
  const alreadyResolved = resolved?.param === previewParam && resolved.resolver === resolver;
  useEffect(() => {
    if (!previewParam || localPreview || alreadyResolved) return;
    let cancelled = false;
    resolver(previewParam).then(item => { if (!cancelled) setResolved({ param: previewParam, item, resolver }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [previewParam, localPreview, alreadyResolved, resolver]);
  const preview = localPreview || (alreadyResolved ? resolved.item : null);

  const setPreview = useCallback((item) => {
    const currentSearchParams = searchParamsRef.current;
    const wasOpen = !!currentSearchParams.get(paramName);
    const isOpen = !!item;
    const next = new URLSearchParams(currentSearchParams);
    if (!item) next.delete(paramName);
    else {
      const param = item.key || item.filename || '';
      next.set(paramName, param);
      // Seed the resolver with the item the caller already handed us, so an
      // opened item the host does not list (a variant picked from the toggle)
      // renders immediately instead of round-tripping to fetch what we hold.
      setResolved({ param, item, resolver: resolverRef.current });
    }
    setSearchParamsRef.current(next, { replace: wasOpen || !isOpen });
  }, [paramName]);

  return [preview, setPreview];
}
