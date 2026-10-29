import { useCallback, useEffect, useRef, useState } from 'react';

const emptyPage = () => ({ items: [], total: null, meta: null, nextCursor: null, loaded: false, loading: false, error: null });

// fetchPage({ cursor, signal }) returns { items, total?, meta?, nextCursor }.
// `meta` is the latest page's response-level data (e.g. a day summary); it is
// replaced by each page and shares the items' stale-query protection.
// Its identity is the query key: memoize it over the collection's filters.
export function usePagedCollection(fetchPage, { enabled = true } = {}) {
  const [page, setPage] = useState(emptyPage);
  const state = useRef(page);
  const generation = useRef(0);
  const pending = useRef(null);
  const restartPending = useRef(null);
  const currentRead = useRef(null);
  const refreshQueued = useRef(false);
  const retryRefresh = useRef(false);
  const commit = useCallback(next => { state.current = next; setPage(next); }, []);

  const read = useCallback(async function readPage(refresh = false) {
    if (!enabled || (!refresh && state.current.loaded && state.current.nextCursor == null)) return;
    if (pending.current) { if (refresh) refreshQueued.current = true; return; }
    const epoch = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    restartPending.current = () => readPage(refresh);
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
      commit({ items: [...items.values()], total: result.total ?? state.current.total, meta: result.meta ?? state.current.meta,
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

  useEffect(() => { currentRead.current = read; }, [read]);

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

  // Confirmed local changes supersede reads already in flight. Replay the
  // interrupted cursor/refresh without dropping loaded pages or queued events.
  const setItems = useCallback(update => {
    const interrupted = pending.current;
    const restart = restartPending.current;
    generation.current += 1;
    interrupted?.abort();
    pending.current = null;
    const previous = state.current;
    const items = typeof update === 'function' ? update(previous.items) : update;
    commit({ ...previous, items, loading: false });
    return interrupted ? restart() : undefined;
  }, [commit]);

  const removeItem = useCallback(id => {
    // A response may already include the deletion in its total while the
    // additive history merge retained the row. Reconcile instead of subtracting
    // twice; ordinary setItems calls need no new read when none was interrupted.
    return setItems(items => items.filter(item => item.id !== id)) ?? currentRead.current(true);
  }, [setItems]);

  return { ...page, setItems, removeItem, hasMore: !page.loaded || page.nextCursor != null, loadMore, reload, refreshFirst };
}
