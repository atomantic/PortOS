// Picker over sprites that already have a locked main reference (#sprite-i2i):
// the "select an existing reference sprite" source for seeding a new main via
// image+text→image. Fetches GET /sprites/reference-sources on open, shows a
// searchable grid of reference thumbnails, and calls onSelect({ id, name, path })
// then closes. `excludeId` drops the sprite being edited (seeding a main from
// its own — not-yet-locked — reference is nonsensical, and once locked it can't
// be regenerated anyway).

import { useEffect, useMemo, useState } from 'react';
import { Search, X, RefreshCw } from 'lucide-react';
import Modal from '../ui/Modal';
import SpritePreview from './SpritePreview.jsx';
import { listSpriteReferenceSources } from '../../services/apiSprites.js';

export default function SpriteReferencePicker({ open, onClose, onSelect, excludeId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  // Refetch each open so a sprite whose main was just locked shows up; reset the
  // search on close so a re-open starts clean.
  useEffect(() => {
    if (!open) { setQuery(''); return undefined; }
    let cancelled = false;
    setLoading(true);
    listSpriteReferenceSources({ silent: true })
      .then((list) => { if (!cancelled) setItems(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const filtered = useMemo(() => {
    const pool = items.filter((it) => it.id !== excludeId);
    const q = query.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((it) => `${it.name} ${it.id}`.toLowerCase().includes(q));
  }, [items, query, excludeId]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="3xl"
      usePortal
      panelClassName="bg-port-card border border-port-border rounded-xl max-h-[85vh] flex flex-col"
      ariaLabel="Pick a reference sprite"
    >
      <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
        <h2 className="text-sm font-medium text-white shrink-0">Pick a reference sprite</h2>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or id…"
            aria-label="Search reference sprites"
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 p-1.5 text-gray-400 hover:text-white rounded"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading reference sprites…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {items.length === 0
              ? 'No sprites with a locked main reference yet — lock one first.'
              : 'No reference sprites match your search.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filtered.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => { onSelect?.(it); onClose?.(); }}
                className="text-left bg-port-bg border border-port-border rounded-lg p-2 hover:border-port-accent"
              >
                <SpritePreview recordId={it.id} path={it.path} className="w-full h-28 object-contain mb-1.5" />
                <span className="block text-xs font-medium text-white truncate">{it.name}</span>
                <span className="block text-[10px] text-gray-500 truncate">{it.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
