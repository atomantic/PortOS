import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Search } from 'lucide-react';
import toast from '../ui/Toast';
import { listMediaCollections, createMediaCollection } from '../../services/api';

// Single-target picker used by MediaCollectionDetail's bulk-action bar.
// AddToCollectionMenu toggles membership for one item across many collections;
// this picker is the inverse — one click picks a destination for many items.
//
// Sibling-component prior art (AddToCollectionMenu) handles popover positioning
// the same way: portal into body, fixed coords, recompute on scroll/resize.

const MENU_WIDTH = 260;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
const SEARCH_THRESHOLD = 6;

export default function BulkTargetPicker({
  anchorRef,
  excludeId,
  busy,
  title = 'Pick a collection',
  onPick,
  onClose,
}) {
  const [collections, setCollections] = useState(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [style, setStyle] = useState(null);
  const menuRef = useRef(null);
  // Parent passes inline arrows for onClose; reading it through a ref keeps
  // the listener effect from tearing down + re-attaching every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  const filtered = useMemo(() => {
    if (!collections) return null;
    const base = excludeId ? collections.filter((c) => c.id !== excludeId) : collections;
    const q = query.trim().toLowerCase();
    return q ? base.filter((c) => c.name.toLowerCase().includes(q)) : base;
  }, [collections, query, excludeId]);

  useEffect(() => {
    listMediaCollections().then(
      (data) => setCollections(Array.isArray(data) ? data : []),
      (err) => { toast.error(err?.message || 'Failed to load collections'); setCollections([]); },
    );
  }, []);

  const reposition = () => {
    const trigger = anchorRef?.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MENU_WIDTH, Math.max(200, vw - VIEWPORT_PADDING * 2));
    menu.style.width = `${width}px`;
    const tr = trigger.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    const maxLeft = vw - width - VIEWPORT_PADDING;
    const left = Math.min(Math.max(tr.right - width, VIEWPORT_PADDING), Math.max(VIEWPORT_PADDING, maxLeft));
    const above = tr.top - mr.height - MENU_GAP;
    const below = tr.bottom + MENU_GAP;
    const top = above < VIEWPORT_PADDING ? below : above;
    const maxTop = Math.max(VIEWPORT_PADDING, vh - mr.height - VIEWPORT_PADDING);
    const clampedTop = Math.min(Math.max(top, VIEWPORT_PADDING), maxTop);
    setStyle({ left: `${left}px`, top: `${clampedTop}px`, width: `${width}px` });
  };

  useLayoutEffect(reposition, [filtered, excludeId]);
  useEffect(() => {
    const close = () => onCloseRef.current?.();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onAway = (e) => {
      const onTrigger = anchorRef?.current?.contains(e.target);
      const onMenu = menuRef.current?.contains(e.target);
      if (!onTrigger && !onMenu) close();
    };
    let raf = null;
    const onScroll = () => { if (raf !== null) return; raf = requestAnimationFrame(() => { raf = null; reposition(); }); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onAway);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onAway);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const created = await createMediaCollection({ name }).catch((err) => {
      toast.error(err?.message || 'Create failed');
      return null;
    });
    setCreating(false);
    if (!created) return;
    setNewName('');
    onPick(created.id, created.name);
  };

  const showSearch = (collections?.length || 0) >= SEARCH_THRESHOLD;
  const list = filtered ?? collections;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed bg-port-card border border-port-border rounded-lg shadow-xl z-[100] p-1.5 flex flex-col"
      style={{
        left: style?.left ?? `${VIEWPORT_PADDING}px`,
        top: style?.top ?? `${VIEWPORT_PADDING}px`,
        width: style?.width ?? `${MENU_WIDTH}px`,
        maxHeight: 'min(360px, calc(100vh - 16px))',
        visibility: style ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-[10px] text-gray-500 uppercase tracking-wide px-1 pt-1 pb-1.5 shrink-0">{title}</div>
      {showSearch && (
        <div className="relative shrink-0 mb-1.5">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search collections…"
            className="w-full bg-port-bg border border-port-border rounded pl-7 pr-2 py-1 text-[11px] text-white focus:outline-none focus:border-port-accent"
            autoFocus
          />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {collections == null && <div className="text-[11px] text-gray-500 px-2 py-2">Loading…</div>}
        {collections != null && list?.length === 0 && (
          <div className="text-[11px] text-gray-500 px-2 py-2">
            {query ? `No matches for "${query}"` : 'No other collections — create one below.'}
          </div>
        )}
        {list?.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={busy}
            onClick={() => onPick(c.id, c.name)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[12px] text-gray-200 hover:bg-port-border rounded disabled:opacity-50"
            role="menuitem"
          >
            <span className="break-words min-w-0 flex-1">{c.name}</span>
            <span className="text-[10px] text-gray-500 shrink-0">{c.items?.length ?? 0}</span>
          </button>
        ))}
      </div>
      <form onSubmit={handleCreate} className="mt-1.5 pt-1.5 border-t border-port-border flex gap-1 shrink-0">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New collection"
          maxLength={80}
          disabled={busy}
          className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={creating || busy || !newName.trim()}
          className="px-2 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[11px] rounded disabled:opacity-40 flex items-center gap-1"
          title="Create and pick"
        >
          <Plus className="w-3 h-3" />
        </button>
      </form>
    </div>,
    document.body,
  );
}
