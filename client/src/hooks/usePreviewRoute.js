import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

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
export default function usePreviewRoute(items, { paramName = 'preview', resolveItem } = {}) {
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
  useEffect(() => {
    if (!previewParam || localPreview || !resolveItem) return;
    let cancelled = false;
    resolveItem(previewParam).then(item => { if (!cancelled) setResolved({ param: previewParam, item, resolver: resolveItem }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [previewParam, localPreview, resolveItem]);
  const preview = localPreview || (resolved?.param === previewParam && resolved.resolver === resolveItem ? resolved.item : null);

  const setPreview = useCallback((item) => {
    const currentSearchParams = searchParamsRef.current;
    const wasOpen = !!currentSearchParams.get(paramName);
    const isOpen = !!item;
    const next = new URLSearchParams(currentSearchParams);
    if (!item) next.delete(paramName);
    else next.set(paramName, item.key || item.filename || '');
    setSearchParamsRef.current(next, { replace: wasOpen || !isOpen });
  }, [paramName]);

  return [preview, setPreview];
}
