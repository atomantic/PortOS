import { useCallback, useRef, useState } from 'react';
import { FolderPlus, Check } from 'lucide-react';
import toast from '../ui/Toast';
import CollectionPickerShell from './CollectionPickerShell';
import { addMediaCollectionItem, removeMediaCollectionItem } from '../../services/api';

// Self-contained popover button used by MediaCard. The popover is portalled
// into <body> by CollectionPickerShell with fixed positioning so it escapes
// the parent grid's `overflow-auto` clip and stacks above the sidebar.
//
// `itemKey` is "<kind>:<ref>" — the same format the server uses for coverKey
// and for the DELETE /items/:key route.
//
// The shell is now shared with BulkTargetPicker (see CollectionPickerShell.jsx).

// Only the trigger button varies by size — popover styling is fixed.
const SIZES = {
  sm: { button: 'px-1.5 py-1 text-[10px]', icon: 'w-3 h-3' },
  md: { button: 'px-2 py-1.5 text-xs', icon: 'w-3.5 h-3.5' },
};

export default function AddToCollectionMenu({ item, size = 'sm' }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const triggerRef = useRef(null);

  const itemKey = item.key;
  const itemRef = item.kind === 'video' ? item.id : item.filename;

  const handleToggleOpen = (e) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  };

  const handleToggleMembership = useCallback(async (collection, updateCollections) => {
    const inIt = collection.items.some((it) => `${it.kind}:${it.ref}` === itemKey);
    setBusyId(collection.id);
    const updated = inIt
      ? await removeMediaCollectionItem(collection.id, itemKey, { silent: true }).catch((err) => {
        toast.error(err.message || 'Remove failed');
        return null;
      })
      : await addMediaCollectionItem(collection.id, { kind: item.kind, ref: itemRef }, { silent: true }).catch((err) => {
        toast.error(err.message || 'Add failed');
        return null;
      });
    setBusyId(null);
    if (!updated) return;
    updateCollections((prev) => (prev || []).map((c) => (c.id === collection.id ? updated : c)));
    toast.success(inIt ? `Removed from ${collection.name}` : `Added to ${collection.name}`);
  }, [itemKey, itemRef, item.kind]);

  const renderItem = (c, { updateCollections }) => {
    const inIt = c.items.some((it) => `${it.kind}:${it.ref}` === itemKey);
    return (
      <button
        key={c.id}
        type="button"
        disabled={busyId === c.id}
        onClick={() => handleToggleMembership(c, updateCollections)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] text-gray-200 hover:bg-port-border rounded disabled:opacity-50"
        role="menuitemcheckbox"
        aria-checked={inIt}
      >
        <span className="break-words min-w-0 flex-1">{c.name}</span>
        {inIt && <Check className="w-3.5 h-3.5 text-port-success shrink-0" />}
      </button>
    );
  };

  const handleCreated = useCallback(async (created, { addToCollectionsState }) => {
    // For this variant of the picker, creating a collection means "add the
    // current item to the new collection." Surface the underlying-add failure
    // separately from the create itself so the user knows the collection
    // exists even if the auto-add failed.
    let addError = null;
    const withItem = await addMediaCollectionItem(created.id, { kind: item.kind, ref: itemRef }, { silent: true }).catch((err) => {
      addError = err;
      return created;
    });
    addToCollectionsState((prev) => ([...(prev || []), withItem]));
    if (addError) {
      toast.error(`Created "${created.name}" but failed to add: ${addError.message}`);
    } else {
      toast.success(`Added to ${created.name}`);
    }
  }, [item.kind, itemRef]);

  const sizeCls = SIZES[size] || SIZES.sm;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggleOpen}
        className={`shrink-0 ${sizeCls.button} bg-port-border hover:bg-port-border/70 text-white rounded flex items-center justify-center`}
        title="Add to collection"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderPlus className={sizeCls.icon} />
      </button>
      <CollectionPickerShell
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        title="Collections"
        width={240}
        minWidth={180}
        newCollectionPlaceholder="New collection name"
        createTitle="Create and add"
        renderItem={renderItem}
        onCreated={handleCreated}
      />
    </>
  );
}
