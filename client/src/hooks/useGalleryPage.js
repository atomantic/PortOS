import { useCallback, useEffect, useMemo, useState } from 'react';
import { listImageGalleryPage, listMediaGalleryPage } from '../services/apiImageVideo';

/** Server-filtered gallery windows. Failed next pages keep the last good page. */
export function useGalleryPage(filters = {}, { enabled = true, media = false, revision = '', paused = false } = {}) {
  const [query, setQuery] = useState(filters.q || '');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filters.q || ''), 250);
    return () => clearTimeout(timer);
  }, [filters.q]);
  const scope = JSON.stringify({ ...filters, q: query });
  const resetScope = `${scope}:${revision}`;
  const [pageScope, setPageScope] = useState(resetScope);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, image: 0, video: 0 });
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  if (pageScope !== resetScope) {
    setPageScope(resetScope); setOffset(0); setItems([]); setNextOffset(null);
  }
  const refresh = useCallback(() => { setOffset(0); setRefreshKey(n => n + 1); }, []);
  const retry = useCallback(() => setRefreshKey(n => n + 1), []);
  useEffect(() => {
    if (!enabled) {
      setItems([]); setOffset(0); setNextOffset(null); setLoading(false);
      return;
    }
    if (paused) return;
    let cancelled = false;
    setLoading(true); setError(null);
    const fetchPage = media ? listMediaGalleryPage : listImageGalleryPage;
    fetchPage({ limit: 60, ...JSON.parse(scope), offset }, { silent: true }).then(page => {
      if (cancelled) return;
      setItems(previous => {
        const rows = offset === 0 ? [] : previous;
        const key = row => media ? `${row.kind}:${row.kind === 'video' ? row.data.id : row.data.filename}` : row.filename;
        const byKey = new Map(rows.map(row => [key(row), row]));
        for (const row of page.items) byKey.set(key(row), row);
        return [...byKey.values()];
      });
      setTotal(page.total);
      if (page.counts) setCounts(page.counts);
      const next = page.offset + page.items.length;
      setNextOffset(page.items.length && next < page.total ? next : null);
    }).catch(err => { if (!cancelled) setError(err.message || 'Could not load gallery'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, offset, enabled, media, revision, paused, refreshKey]);
  const loadMore = useCallback(() => {
    if (!loading && nextOffset !== null) setOffset(nextOffset);
  }, [loading, nextOffset]);
  return useMemo(() => ({ items, setItems, total, setTotal, counts, loading, error,
    hasMore: nextOffset !== null, loadMore, refresh, retry }),
  [items, total, counts, loading, error, nextOffset, loadMore, refresh, retry]);
}
