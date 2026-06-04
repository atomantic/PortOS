import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Search } from 'lucide-react';
import toast from '../ui/Toast';
import { listMediaCollections, createMediaCollection } from '../../services/api';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../hooks/usePopoverPosition.js';

// Shared popover shell for the two collection pickers:
//
//   - AddToCollectionMenu (one item → many collections, toggles membership)
//   - BulkTargetPicker     (many items → one destination, pick + dispatch)
//
// Both portal a fixed-position popover into <body>, compute placement relative
// to a trigger element, ship a search input above a threshold, and end with a
// "create new" inline form. This shell owns all of that plumbing; the caller
// provides `renderItem` for the per-row UI and `onCreated`/`onPickCreated` for
// what to do after the inline create succeeds.
//
// Collections data flow (per PLAN.md item 2):
//   - If `collections` is provided by the parent, we never call
//     `listMediaCollections()` ourselves — this lets MediaCollectionDetail
//     reuse its already-fetched list instead of paying a per-mount round-trip.
//   - If `collections` is `null`/omitted, the shell auto-loads on mount (old
//     AddToCollectionMenu behavior). Use `onCollectionsLoaded` if the parent
//     wants to learn the fetched list (e.g. for membership rendering).
//
// `excludeId` is a single-item allow-list filter so BulkTargetPicker can hide
// the current collection from its move/copy target list.

const DEFAULT_MENU_WIDTH = 260;
const MENU_GAP = 6;
const SEARCH_THRESHOLD = 6;

export default function CollectionPickerShell({
  anchorRef,
  open = true,
  title,
  emptyMessage = 'No collections yet — create one below.',
  noMatchMessage = (query) => `No matches for "${query}"`,
  excludeId,
  busy = false,
  width = DEFAULT_MENU_WIDTH,
  minWidth = 200,
  newCollectionPlaceholder = 'New collection',
  createTitle = 'Create and pick',
  // The caller renders each collection row — keeps the per-row UI flexible
  // (membership checkmarks vs item counts vs anything else) without dragging
  // every prop combination through the shell.
  renderItem,
  collections: collectionsProp,
  onCollectionsLoaded,
  onCollectionsChange,
  onCreated,
  onClose,
}) {
  const [collectionsState, setCollectionsState] = useState(collectionsProp ?? null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const {
    popoverRef: menuRef,
    style,
  } = usePopoverPosition({
    open,
    width,
    minWidth,
    gap: MENU_GAP,
    position: 'above',
    anchorRef,
    // The popover height changes as the user filters/searches or the list loads;
    // the hook re-measures synchronously (pre-paint) when these change. `filtered`
    // is a pure function of these plus `excludeId`, so they cover its height
    // effect without forward-referencing it.
    contentDeps: [collectionsState, query, excludeId],
  });

  // Parents may pass inline arrow handlers — read through a ref so the
  // event-listener effect doesn't tear down on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // When the parent owns `collections`, mirror it into local state on each
  // change so the same render path works for both modes.
  useEffect(() => {
    if (collectionsProp !== undefined) setCollectionsState(collectionsProp);
  }, [collectionsProp]);

  // Auto-load only when uncontrolled (no `collections` prop). Mirrors the old
  // AddToCollectionMenu behavior of fetching when the popover opens.
  useEffect(() => {
    if (collectionsProp !== undefined) return undefined;
    if (!open) return undefined;
    let cancelled = false;
    listMediaCollections().then(
      (data) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setCollectionsState(list);
        onCollectionsLoaded?.(list);
      },
      (err) => {
        if (cancelled) return;
        toast.error(err?.message || 'Failed to load collections');
        setCollectionsState([]);
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collectionsProp]);

  const filtered = useMemo(() => {
    if (!collectionsState) return null;
    const base = excludeId ? collectionsState.filter((c) => c.id !== excludeId) : collectionsState;
    const q = query.trim().toLowerCase();
    return q ? base.filter((c) => c.name.toLowerCase().includes(q)) : base;
  }, [collectionsState, query, excludeId]);

  // Close on outside-click / Escape — placement and scroll/resize reflow are
  // owned by usePopoverPosition; this effect only handles dismissal.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => onCloseRef.current?.();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const onAway = (e) => {
      const onTrigger = anchorRef?.current?.contains(e.target);
      const onMenu = menuRef.current?.contains(e.target);
      if (!onTrigger && !onMenu) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onAway);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onAway);
    };
  }, [open, anchorRef, menuRef]);

  const updateCollections = useCallback((updater) => {
    setCollectionsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      onCollectionsChange?.(next);
      return next;
    });
  }, [onCollectionsChange]);

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
    // Parent decides what happens next — AddToCollectionMenu wants to also add
    // the item to the new collection, BulkTargetPicker just picks it as the
    // destination. The shell tells the parent which collection was created
    // and how the parent should merge it back into the local list.
    onCreated?.(created, { addToCollectionsState: (mergeFn) => updateCollections(mergeFn) });
  };

  if (!open) return null;

  const showSearch = (collectionsState?.length || 0) >= SEARCH_THRESHOLD;
  const list = filtered ?? collectionsState;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed bg-port-card border border-port-border rounded-lg shadow-xl z-[100] p-1.5 flex flex-col"
      style={{
        left: style?.left ?? `${VIEWPORT_PADDING}px`,
        top: style?.top ?? `${VIEWPORT_PADDING}px`,
        width: style?.width ?? `${width}px`,
        maxHeight: 'min(360px, calc(100vh - 16px))',
        visibility: style ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {title && (
        <div className="text-[10px] text-gray-500 uppercase tracking-wide px-1 pt-1 pb-1.5 shrink-0">{title}</div>
      )}
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
        {collectionsState == null && (
          <div className="text-[11px] text-gray-500 px-2 py-2">Loading…</div>
        )}
        {collectionsState != null && collectionsState.length === 0 && (
          <div className="text-[11px] text-gray-500 px-2 py-2">{emptyMessage}</div>
        )}
        {list != null && collectionsState?.length > 0 && list.length === 0 && (
          <div className="text-[11px] text-gray-500 px-2 py-2">{noMatchMessage(query)}</div>
        )}
        {list != null && list.map((c) => renderItem(c, { updateCollections }))}
      </div>
      <form onSubmit={handleCreate} className="mt-1.5 pt-1.5 border-t border-port-border flex gap-1 shrink-0">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={newCollectionPlaceholder}
          maxLength={80}
          disabled={busy}
          className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={creating || busy || !newName.trim()}
          className="px-2 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[11px] rounded disabled:opacity-40 flex items-center gap-1"
          title={createTitle}
        >
          <Plus className="w-3 h-3" />
        </button>
      </form>
    </div>,
    document.body,
  );
}
