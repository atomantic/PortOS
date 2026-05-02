import { useEffect, useRef, useState } from 'react';
import { FolderPlus, Check, Plus } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listMediaCollections, createMediaCollection,
  addMediaCollectionItem, removeMediaCollectionItem,
} from '../../services/api';

// Self-contained popover button used by MediaCard. Fetches collections
// lazily on first open so an empty-state grid doesn't slam the API once
// per card. Toggling membership both adds and removes the item, so the
// menu doubles as a "what collections is this in" indicator.
//
// `itemKey` is "<kind>:<ref>" — the same format the server uses for
// coverKey and for the DELETE /items/:key route.
export default function AddToCollectionMenu({ item }) {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState(null); // null = not loaded
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState(null);
  const wrapperRef = useRef(null);

  const itemKey = `${item.kind}:${item.kind === 'video' ? item.id : item.filename}`;
  const itemRef = item.kind === 'video' ? item.id : item.filename;

  useEffect(() => {
    if (!open) return undefined;
    const onClickAway = (e) => {
      if (!wrapperRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClickAway);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickAway);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

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
    if (next) await ensureLoaded();
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
    // Auto-add the current item so the user doesn't have to click twice
    // after creating a brand-new collection for it. Track the add result
    // separately so a failure here doesn't masquerade as success.
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

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={handleToggleOpen}
        className="px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
        title="Add to collection"
      >
        <FolderPlus className="w-3 h-3" />
      </button>
      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 w-56 max-h-72 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-lg z-20 p-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] text-gray-500 uppercase tracking-wide px-1 pt-1 pb-1.5">Collections</div>
          {collections == null && (
            <div className="text-[11px] text-gray-500 px-2 py-2">Loading…</div>
          )}
          {collections != null && collections.length === 0 && (
            <div className="text-[11px] text-gray-500 px-2 py-2">No collections yet — create one below.</div>
          )}
          {collections != null && collections.map((c) => {
            const inIt = c.items.some((it) => `${it.kind}:${it.ref}` === itemKey);
            return (
              <button
                key={c.id}
                type="button"
                disabled={busyId === c.id}
                onClick={() => handleToggleMembership(c)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] text-gray-200 hover:bg-port-border rounded disabled:opacity-50"
              >
                <span className="truncate">{c.name}</span>
                {inIt && <Check className="w-3.5 h-3.5 text-port-success shrink-0" />}
              </button>
            );
          })}
          <form onSubmit={handleCreate} className="mt-1.5 pt-1.5 border-t border-port-border flex gap-1">
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
        </div>
      )}
    </div>
  );
}
