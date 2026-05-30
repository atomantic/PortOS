/**
 * IngredientPicker — modal for attaching catalog ingredients to a parent
 * record (universe, series, issue, writers-room).
 *
 * Built on top of the shared `ui/Modal` chrome so Esc / backdrop / portal
 * stacking match every other modal in the app.
 *
 * Props:
 *   open         — visibility flag.
 *   onClose      — fires on Esc, backdrop click, or the X button.
 *   onSelect     — fires with the chosen ingredient when `multi` is false,
 *                  or with an array of chosen ingredients when `multi` is
 *                  true (user hit "Add Selected").
 *   type         — optional `'character' | 'place' | ...` to scope the search.
 *   multi        — checkbox-mode toggle; defaults to single-click select.
 *   excludeIds   — ids to hide from the result list (already-attached set).
 *   refKind/refId — currently unused by this component, but accepted so
 *                   callers can wire up an "Already attached" section without
 *                   the API surface changing later.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Plus, Loader2, X, Sparkles } from 'lucide-react';
import Modal from './ui/Modal';
import { listCatalogIngredients } from '../services/apiCatalog';

const TYPE_BADGE = {
  character: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  place:     'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  object:    'bg-amber-500/20 text-amber-300 border-amber-500/40',
  idea:      'bg-purple-500/20 text-purple-300 border-purple-500/40',
  scene:     'bg-pink-500/20 text-pink-300 border-pink-500/40',
  concept:   'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
};

function snippet(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const text = String(payload.description || payload.summary || payload.notes || '').trim().replace(/\s+/g, ' ');
  if (text.length <= 140) return text;
  return `${text.slice(0, 137)}…`;
}

export default function IngredientPicker({
  open,
  onClose,
  onSelect,
  type,
  multi = false,
  excludeIds = [],
}) {
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Track in-flight fetch generation so a late response from a stale query
  // can't overwrite the current results.
  const generationRef = useRef(0);

  // Debounce search input (300ms) before pinning to `q`.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => setQ(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput, open]);

  // Reset transient state every time the modal opens — single-shot pickers
  // should never inherit yesterday's checkboxes. Clear `items` too so the
  // first frame of a new open doesn't flash stale results before the fetch
  // resolves (especially visible when `type` changes between opens).
  useEffect(() => {
    if (!open) return;
    setSearchInput('');
    setQ('');
    setSelectedIds(new Set());
    setItems([]);
  }, [open]);

  // Fetch results. Refetch on q / type changes while open.
  useEffect(() => {
    if (!open) return undefined;
    const gen = ++generationRef.current;
    setLoading(true);
    listCatalogIngredients({
      type: type || undefined,
      q: q || undefined,
      limit: 50,
      silent: true,
    })
      .then((data) => {
        if (gen !== generationRef.current) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
        setLoading(false);
      })
      .catch(() => {
        if (gen !== generationRef.current) return;
        setItems([]);
        setLoading(false);
      });
    return undefined;
  }, [open, q, type]);

  // Exclusion set lookup — Set is O(1), array .includes is O(n) per row.
  const excludeSet = useMemo(() => new Set(excludeIds || []), [excludeIds]);
  const filtered = useMemo(
    () => items.filter((it) => !excludeSet.has(it.id)),
    [items, excludeSet],
  );

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSingleSelect = (it) => {
    onSelect?.(it);
    onClose?.();
  };

  const handleAddSelected = () => {
    const picked = filtered.filter((it) => selectedIds.has(it.id));
    if (picked.length === 0) return;
    onSelect?.(picked);
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      closeOnBackdrop
      panelClassName="bg-port-card border border-port-border rounded-xl max-h-[85vh] flex flex-col"
      ariaLabelledBy="ingredient-picker-title"
    >
      <div className="flex items-center justify-between p-4 border-b border-port-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-port-accent" aria-hidden="true" />
          <h2 id="ingredient-picker-title" className="text-lg font-bold text-white">
            {multi ? 'Pick ingredients' : 'Pick an ingredient'}
            {type ? <span className="text-sm font-normal text-gray-400 ml-2">({type})</span> : null}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close ingredient picker"
          className="p-2 text-gray-500 hover:text-white rounded"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="p-4 border-b border-port-border flex-shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
          <label htmlFor="ingredient-picker-search" className="sr-only">Search ingredients</label>
          <input
            id="ingredient-picker-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by name, tag, or text…"
            autoFocus
            className="w-full pl-9 pr-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            Searching…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-gray-400 space-y-2">
            <p>No matching ingredients.</p>
            <Link to="/catalog" onClick={onClose} className="inline-flex items-center gap-1 text-port-accent hover:underline">
              <Plus size={12} aria-hidden="true" />
              Create new in Catalog
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((it) => {
              const badge = TYPE_BADGE[it.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
              const checked = selectedIds.has(it.id);
              const rowBase = 'w-full text-left p-3 rounded border bg-port-bg/40 transition-colors';
              const rowClass = multi
                ? `${rowBase} ${checked ? 'border-port-accent' : 'border-port-border hover:border-gray-500'}`
                : `${rowBase} border-port-border hover:border-port-accent`;
              const inner = (
                <>
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {multi && (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelected(it.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="accent-port-accent"
                          aria-label={`Select ${it.name || it.id}`}
                        />
                      )}
                      <span className="text-sm font-medium text-white truncate">
                        {it.name || '(untitled)'}
                      </span>
                    </div>
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${badge} flex-shrink-0`}>
                      {it.type}
                    </span>
                  </div>
                  {snippet(it.payload) && (
                    <p className="text-xs text-gray-400 line-clamp-2">{snippet(it.payload)}</p>
                  )}
                  {Array.isArray(it.tags) && it.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {it.tags.slice(0, 5).map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-500">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              );
              return (
                <li key={it.id}>
                  {multi ? (
                    <div role="button" tabIndex={0} onClick={() => toggleSelected(it.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelected(it.id); } }}
                      className={`${rowClass} cursor-pointer`}>
                      {inner}
                    </div>
                  ) : (
                    <button type="button" onClick={() => handleSingleSelect(it)} className={rowClass}>
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {multi && (
        <div className="p-4 border-t border-port-border flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-gray-400">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAddSelected}
              disabled={selectedIds.size === 0}
              className="inline-flex items-center gap-2 px-3 py-2 rounded bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium"
            >
              <Plus size={14} aria-hidden="true" />
              Add Selected
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
