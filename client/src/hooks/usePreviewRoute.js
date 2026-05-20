import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// URL-driven MediaPreview state. Returns `[preview, setPreview]` with the same
// shape every MediaPreview host already expects, but the source of truth is a
// `?preview=<filename>` query param so previews are deep-linkable, reload-safe,
// and shareable. setPreview(null) drops the param; setPreview(item) writes the
// item's filename (falling back to its key).
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
export default function usePreviewRoute(items, { paramName = 'preview' } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const previewParam = searchParams.get(paramName);

  const preview = useMemo(() => {
    if (!previewParam) return null;
    const list = Array.isArray(items) ? items : [];
    return (
      list.find((i) => i?.filename === previewParam)
      || list.find((i) => i?.key === previewParam)
      || list.find((i) => typeof i?.key === 'string' && i.key.endsWith(`:${previewParam}`))
      || null
    );
  }, [items, previewParam]);

  const setPreview = useCallback((item) => {
    const wasOpen = !!searchParams.get(paramName);
    const isOpen = !!item;
    const next = new URLSearchParams(searchParams);
    if (!item) next.delete(paramName);
    else next.set(paramName, item.filename || item.key || '');
    setSearchParams(next, { replace: wasOpen || !isOpen });
  }, [searchParams, setSearchParams, paramName]);

  return [preview, setPreview];
}
