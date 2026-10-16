import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listImageGalleryPage, listMediaGalleryPage } from '../services/apiImageVideo';

/** Server-filtered gallery windows. Failed next pages keep the last good page. */
export function useGalleryPage(filters = {}, { enabled = true, media = false, revision = '', paused = false, preserveLoadedOnRefresh = false } = {}) {
  const [query, setQuery] = useState(filters.q || '');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filters.q || ''), 250);
    return () => clearTimeout(timer);
  }, [filters.q]);
  const scope = JSON.stringify({ ...filters, q: query });
  const resetScope = `${scope}:${revision}`;
  const [pageScope, setPageScope] = useState(resetScope);
  const [filterScope, setFilterScope] = useState(scope);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, image: 0, video: 0 });
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshLength = useRef(0);
  const loadedLength = useRef(0);
  const retainedItems = useRef([]);
  retainedItems.current = items;
  loadedLength.current = items.length;
  if (pageScope !== resetScope) {
    const retain = preserveLoadedOnRefresh && filterScope === scope;
    refreshLength.current = retain ? items.length : 0;
    setPageScope(resetScope); setFilterScope(scope); setOffset(0);
    if (!retain) { setItems([]); setNextOffset(null); }
  }
  const refresh = useCallback(() => {
    refreshLength.current = preserveLoadedOnRefresh ? loadedLength.current : 0;
    setOffset(0); setRefreshKey(n => n + 1);
  }, [preserveLoadedOnRefresh]);
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
    const read = async () => {
      let page = await fetchPage({ limit: 60, ...JSON.parse(scope), offset }, { silent: true });
      const combined = [...page.items];
      const rowKey = row => media ? `${row.kind}:${row.kind === 'video' ? row.data.id : row.data.filename}` : row.filename;
      const retained = new Set(retainedItems.current.map(rowKey));
      const tail = retainedItems.current.at(-1);
      const crossedBoundary = () => !tail || combined.some(row => rowKey(row) === rowKey(tail))
        || (combined.some(row => retained.has(rowKey(row))) && !page.items.some(row => retained.has(rowKey(row))));
      // Refresh the retained window in compact 60-record requests. Keep the old
      // cards mounted until the complete replacement is ready, including on error.
      while (!cancelled && offset === 0 && refreshLength.current > 0 && (combined.length < refreshLength.current || !crossedBoundary())
          && combined.length < page.total && page.items.length) {
        page = await fetchPage({ limit: 60, ...JSON.parse(scope), offset: combined.length }, { silent: true });
        combined.push(...page.items);
      }
      return { ...page, items: combined, offset };
    };
    read().then(page => {
      if (cancelled) return;
      refreshLength.current = 0;
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
    if (!loading && !paused && nextOffset !== null) setOffset(nextOffset);
  }, [loading, paused, nextOffset]);
  return useMemo(() => ({ items, setItems, total, setTotal, counts, loading, error,
    hasMore: nextOffset !== null, loadMore, refresh, retry }),
  [items, total, counts, loading, error, nextOffset, loadMore, refresh, retry]);
}
