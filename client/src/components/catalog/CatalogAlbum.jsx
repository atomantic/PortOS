/**
 * CatalogAlbum — a collapsible group section in the Catalog "Albums" view (#1762).
 *
 * One album per live universe, plus the pinned "Unsorted / Raw" and "Orphaned"
 * albums. Cards lazy-load via `loadPage(offset)` the FIRST time the album is
 * expanded (album headers show the count from /facets up front, so an unexpanded
 * album costs nothing), and paginate with "Load more" so an album with more than
 * one page's worth of ingredients is never silently truncated. Reuses
 * <CatalogCard> so album cards match the flat grid.
 */

import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import CatalogCard from './CatalogCard';

export default function CatalogAlbum({
  title,
  subtitle,
  count,
  pageSize,
  defaultExpanded = false,
  loadPage,
  getType,
  selectedIds,
  onToggleSelect,
  armedId,
  onArm,
  onCancelArm,
  onConfirmDelete,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // `null` = not yet loaded (distinct from `[]` = loaded-and-empty), so an
  // empty album doesn't re-fetch on every expand toggle.
  const [items, setItems] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const fetchPage = useCallback(async (offset) => {
    const list = await loadPage(offset).catch((err) => {
      setError(err?.message || 'Failed to load album');
      return null;
    });
    if (!Array.isArray(list)) return null;
    setHasMore(list.length === pageSize);
    return list;
  }, [loadPage, pageSize]);

  const ensureLoaded = useCallback(async () => {
    if (items !== null || loading) return;
    setLoading(true);
    setError('');
    const list = await fetchPage(0);
    setLoading(false);
    if (list) setItems(list);
  }, [items, loading, fetchPage]);

  // Load the first time the album is expanded — covers both an explicit toggle
  // and a `defaultExpanded` album that mounts already open (the pinned Raw album).
  useEffect(() => {
    if (expanded) ensureLoaded();
  }, [expanded, ensureLoaded]);

  const toggle = () => setExpanded((e) => !e);

  const loadMore = async () => {
    setLoadingMore(true);
    const list = await fetchPage((items || []).length);
    setLoadingMore(false);
    if (list) setItems((prev) => [...(prev || []), ...list]);
  };

  // Album-local optimistic delete: remove the card immediately, restore it if
  // the parent's delete handler reports failure (it owns the toast + rollback
  // of shared state like selection + facet counts).
  const handleDelete = async (it) => {
    const idx = (items || []).findIndex((x) => x.id === it.id);
    setItems((prev) => (prev || []).filter((x) => x.id !== it.id));
    const ok = await onConfirmDelete(it);
    if (!ok) {
      setItems((prev) => {
        if ((prev || []).some((x) => x.id === it.id)) return prev;
        const next = [...(prev || [])];
        next.splice(Math.max(0, idx), 0, it);
        return next;
      });
    }
  };

  return (
    <section className="border border-port-border rounded-lg overflow-hidden bg-port-card/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-port-bg/40"
      >
        {expanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
        <span className="text-white font-medium">{title}</span>
        {subtitle ? <span className="text-xs text-gray-500">{subtitle}</span> : null}
        <span className="ml-auto text-xs text-gray-400 px-2 py-0.5 rounded-full border border-port-border">
          {count}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-3">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="text-sm text-port-error py-3">{error}</div>
          ) : (items && items.length > 0) ? (
            <>
              <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((it) => (
                  <CatalogCard
                    key={it.id}
                    ingredient={it}
                    getType={getType}
                    selected={selectedIds.has(it.id)}
                    onToggleSelect={onToggleSelect}
                    armed={armedId === it.id}
                    onArm={onArm}
                    onCancelArm={onCancelArm}
                    onConfirmDelete={handleDelete}
                  />
                ))}
              </ul>
              {hasMore && (
                <div className="flex justify-center mt-3">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-port-border bg-port-card hover:bg-port-bg text-white text-sm font-medium disabled:opacity-50"
                  >
                    {loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
                    Load more
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-gray-500 py-3">No ingredients in this album.</div>
          )}
        </div>
      )}
    </section>
  );
}
