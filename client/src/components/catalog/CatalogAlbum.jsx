/**
 * CatalogAlbum — a collapsible group section in the Catalog "Albums" view (#1762).
 *
 * One album per live universe, plus the pinned "Unsorted / Raw" and "Orphaned"
 * albums. Cards lazy-load via `loadItems()` the FIRST time the album is
 * expanded (album headers show the count from /facets up front, so an unexpanded
 * album costs nothing). Reuses <CatalogCard> so album cards match the flat grid.
 */

import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import CatalogCard from './CatalogCard';

export default function CatalogAlbum({
  title,
  subtitle,
  count,
  defaultExpanded = false,
  loadItems,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const ensureLoaded = useCallback(async () => {
    if (items !== null || loading) return;
    setLoading(true);
    setError('');
    const list = await loadItems().catch((err) => {
      setError(err?.message || 'Failed to load album');
      return null;
    });
    setLoading(false);
    if (Array.isArray(list)) setItems(list);
  }, [items, loading, loadItems]);

  // Load the first time the album is expanded — covers both an explicit toggle
  // and a `defaultExpanded` album that mounts already open (the pinned Raw album).
  useEffect(() => {
    if (expanded) ensureLoaded();
  }, [expanded, ensureLoaded]);

  const toggle = () => setExpanded((e) => !e);

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
          ) : (
            <div className="text-sm text-gray-500 py-3">No ingredients in this album.</div>
          )}
        </div>
      )}
    </section>
  );
}
