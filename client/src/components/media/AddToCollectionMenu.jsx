import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { FolderPlus, Check, Plus, Search } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listMediaCollections, createMediaCollection,
  addMediaCollectionItem, removeMediaCollectionItem,
} from '../../services/api';

// Self-contained popover button used by MediaCard. The popover is portalled
// into <body> with fixed positioning so it escapes the parent grid's
// `overflow-auto` clip and stacks above the sidebar (which is z-50).
//
// `itemKey` is "<kind>:<ref>" — the same format the server uses for
// coverKey and for the DELETE /items/:key route.

const MENU_WIDTH = 240;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;
// Show search affordance only when the list could meaningfully scroll.
const SEARCH_THRESHOLD = 6;

export default function AddToCollectionMenu({ item }) {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState(null); // null = not loaded
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [query, setQuery] = useState('');
  const [menuStyle, setMenuStyle] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const itemKey = `${item.kind}:${item.kind === 'video' ? item.id : item.filename}`;
  const itemRef = item.kind === 'video' ? item.id : item.filename;

  const filtered = useMemo(() => {
    if (!collections) return null;
    const q = query.trim().toLowerCase();
    if (!q) return collections;
    return collections.filter((c) => c.name.toLowerCase().includes(q));
  }, [collections, query]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(MENU_WIDTH, Math.max(180, viewportWidth - VIEWPORT_PADDING * 2));
    menu.style.width = `${width}px`;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    const maxLeft = viewportWidth - width - VIEWPORT_PADDING;
    const left = Math.min(
      Math.max(triggerRect.right - width, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, maxLeft),
    );

    const aboveTop = triggerRect.top - menuRect.height - MENU_GAP;
    const belowTop = triggerRect.bottom + MENU_GAP;
    const wouldOverflowTop = aboveTop < VIEWPORT_PADDING;
    let top = wouldOverflowTop ? belowTop : aboveTop;
    const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - menuRect.height - VIEWPORT_PADDING);
    top = Math.min(Math.max(top, VIEWPORT_PADDING), maxTop);

    setMenuStyle((prev) => {
      const next = { left: `${left}px`, top: `${top}px`, width: `${width}px` };
      if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width) return prev;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onClickAway = (e) => {
      const onTrigger = triggerRef.current?.contains(e.target);
      const onMenu = menuRef.current?.contains(e.target);
      if (!onTrigger && !onMenu) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    let rafId = null;
    const onReposition = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateMenuPosition();
      });
    };
    document.addEventListener('mousedown', onClickAway);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', onClickAway);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    updateMenuPosition();
  }, [open, updateMenuPosition, collections, filtered, query]);

  const ensureLoaded = async () => {
    if (collections != null) return;
    const data = await listMediaCollections().catch((err) => {
      toast.error(err.message || 'Failed to load collections');
      return [];
    });
    setCollections(Array.isArray(data) ? data : []);
  };

  const handleToggleOpen = async (e) => {
    e.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next) {
      setQuery('');
      await ensureLoaded();
    }
  };

  const handleToggleMembership = async (collection) => {
    const inIt = collection.items.some((it) => `${it.kind}:${it.ref}` === itemKey);
    setBusyId(collection.id);
    const updated = inIt
      ? await removeMediaCollectionItem(collection.id, itemKey).catch((err) => {
        toast.error(err.message || 'Remove failed');
        return null;
      })
      : await addMediaCollectionItem(collection.id, { kind: item.kind, ref: itemRef }).catch((err) => {
        toast.error(err.message || 'Add failed');
        return null;
      });
    setBusyId(null);
    if (!updated) return;
    setCollections((prev) => (prev || []).map((c) => (c.id === collection.id ? updated : c)));
    toast.success(inIt ? `Removed from ${collection.name}` : `Added to ${collection.name}`);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const created = await createMediaCollection({ name }).catch((err) => {
      toast.error(err.message || 'Create failed');
      return null;
    });
    if (!created) { setCreating(false); return; }
    let addError = null;
    const withItem = await addMediaCollectionItem(created.id, { kind: item.kind, ref: itemRef }).catch((err) => {
      addError = err;
      return created;
    });
    setCollections((prev) => ([...(prev || []), withItem]));
    setNewName('');
    setCreating(false);
    if (addError) {
      toast.error(`Created "${created.name}" but failed to add: ${addError.message}`);
    } else {
      toast.success(`Added to ${created.name}`);
    }
  };

  const showSearch = (collections?.length || 0) >= SEARCH_THRESHOLD;
  const list = filtered ?? collections;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggleOpen}
        className="shrink-0 px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
        title="Add to collection"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderPlus className="w-3 h-3" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed bg-port-card border border-port-border rounded-lg shadow-xl z-[100] p-1.5 flex flex-col"
          style={{
            left: menuStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: menuStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: menuStyle?.width ?? `${MENU_WIDTH}px`,
            maxHeight: 'min(360px, calc(100vh - 16px))',
            visibility: menuStyle ? 'visible' : 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <div className="text-[10px] text-gray-500 uppercase tracking-wide px-1 pt-1 pb-1.5 shrink-0">Collections</div>
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
            {collections == null && (
              <div className="text-[11px] text-gray-500 px-2 py-2">Loading…</div>
            )}
            {collections != null && collections.length === 0 && (
              <div className="text-[11px] text-gray-500 px-2 py-2">No collections yet — create one below.</div>
            )}
            {list != null && collections?.length > 0 && list.length === 0 && (
              <div className="text-[11px] text-gray-500 px-2 py-2">No matches for &ldquo;{query}&rdquo;</div>
            )}
            {list != null && list.map((c) => {
              const inIt = c.items.some((it) => `${it.kind}:${it.ref}` === itemKey);
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={busyId === c.id}
                  onClick={() => handleToggleMembership(c)}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] text-gray-200 hover:bg-port-border rounded disabled:opacity-50"
                  role="menuitemcheckbox"
                  aria-checked={inIt}
                >
                  <span className="truncate">{c.name}</span>
                  {inIt && <Check className="w-3.5 h-3.5 text-port-success shrink-0" />}
                </button>
              );
            })}
          </div>
          <form onSubmit={handleCreate} className="mt-1.5 pt-1.5 border-t border-port-border flex gap-1 shrink-0">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New collection name"
              maxLength={80}
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-port-accent"
            />
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="px-2 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[11px] rounded disabled:opacity-40 flex items-center gap-1"
              title="Create and add"
            >
              <Plus className="w-3 h-3" />
            </button>
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}
