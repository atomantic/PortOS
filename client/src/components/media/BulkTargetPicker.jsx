import { useCallback } from 'react';
import CollectionPickerShell from './CollectionPickerShell';

// Single-target picker used by MediaCollectionDetail's bulk-action bar.
// AddToCollectionMenu toggles membership for one item across many collections;
// this picker is the inverse — one click picks a destination for many items.
//
// Both share the same popover/positioning/create-form shell — see
// CollectionPickerShell.jsx. The differences this caller layers on:
//   - rows render with an item-count badge instead of a membership checkmark
//   - clicking a row calls onPick(id, name) instead of toggling membership
//   - creating a new collection picks it as the destination
//
// `collections` (optional): the parent's already-fetched list, so the shell
// skips its own listMediaCollections() round-trip. MediaCollectionDetail
// passes this to dedupe the load it already performed.

export default function BulkTargetPicker({
  anchorRef,
  excludeId,
  busy,
  title = 'Pick a collection',
  collections,
  onPick,
  onClose,
}) {
  const renderItem = useCallback((c) => (
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
  ), [busy, onPick]);

  const handleCreated = useCallback((created) => {
    onPick(created.id, created.name);
  }, [onPick]);

  return (
    <CollectionPickerShell
      anchorRef={anchorRef}
      open
      onClose={onClose}
      title={title}
      excludeId={excludeId}
      busy={busy}
      emptyMessage="No collections yet — create one below."
      noMatchMessage={(q) => (q ? `No matches for "${q}"` : 'No other collections — create one below.')}
      newCollectionPlaceholder="New collection"
      createTitle="Create and pick"
      collections={collections}
      renderItem={renderItem}
      onCreated={handleCreated}
    />
  );
}
