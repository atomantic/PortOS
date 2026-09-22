import { useCallback, useEffect, useRef, useState } from 'react';

const emptyPage = () => ({ items: [], total: null, nextCursor: null, loaded: false, loading: false, error: null });

// fetchPage({ cursor, signal }) returns { items, total?, nextCursor }.
// Its identity is the query key: memoize it over the collection's filters.
export function usePagedCollection(fetchPage, { enabled = true } = {}) {
  const [page, setPage] = useState(emptyPage);
  const state = useRef(page);
  const generation = useRef(0);
  const pending = useRef(null);
  const refreshQueued = useRef(false);
  const retryRefresh = useRef(false);
  const commit = useCallback(next => { state.current = next; setPage(next); }, []);

  const read = useCallback(async function readPage(refresh = false) {
    if (!enabled || (!refresh && state.current.loaded && state.current.nextCursor == null)) return;
    if (pending.current) { if (refresh) refreshQueued.current = true; return; }
    const epoch = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    commit({ ...state.current, loading: true, error: null });
    try {
      const result = await fetchPage({ cursor: refresh ? null : state.current.nextCursor, signal: controller.signal });
      if (generation.current !== epoch) return;
      const existingIds = new Set(state.current.items.map(item => item.id));
      const overlaps = result.items.some(item => existingIds.has(item.id));
      // Preserve encounter order; domains with a chronological display sort
      // their records after merging, including gaps backfilled after reconnect.
      const items = new Map((refresh ? result.items : state.current.items).map(item => [item.id, item]));
      for (const item of refresh ? state.current.items : result.items) if (!refresh || !items.has(item.id)) items.set(item.id, item);
      commit({ items: [...items.values()], total: result.total ?? state.current.total,
        nextCursor: refresh && overlaps ? state.current.nextCursor : result.nextCursor ?? null, loaded: true, loading: false, error: null });
    } catch (error) {
      if (generation.current === epoch) {
        retryRefresh.current = refresh;
        commit({ ...state.current, loading: false, error });
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (refreshQueued.current && generation.current === epoch) {
          refreshQueued.current = false;
          readPage(true);
        }
      }
    }
  }, [enabled, fetchPage, commit]);

  const loadMore = useCallback(() => read(Boolean(state.current.error && retryRefresh.current)), [read]);
  const refreshFirst = useCallback(() => read(true), [read]);

  const reset = useCallback(() => {
    generation.current += 1;
    refreshQueued.current = false;
    retryRefresh.current = false;
    pending.current?.abort();
    pending.current = null;
    commit(emptyPage());
  }, [commit]);
  const reload = useCallback(() => { reset(); return loadMore(); }, [reset, loadMore]);
  useEffect(() => {
    reload();
    return () => { generation.current += 1; refreshQueued.current = false; pending.current?.abort(); pending.current = null; };
  }, [reload]);

  return { ...page, hasMore: !page.loaded || page.nextCursor != null, loadMore, reload, refreshFirst };
}
