import { useRef, useState } from 'react';
import { Copy, FolderInput, ShieldCheck, Star, StarOff, Trash2, X } from 'lucide-react';
import ShareToButton from '../sharing/ShareToButton';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import BulkTargetPicker from './BulkTargetPicker';

export default function CollectionSelectToolbar({
  items, hasMore, selected, setSelected, selectedItems, isUnsorted, collectionId,
  pickerMode, setPickerMode, collections, collectionsError, retryCollections,
  bulkBusy, bulkStar, bulkRemove, bulkVerify, bulkMoveOrCopy, exitSelectMode,
}) {
  const moveBtnRef = useRef(null);
  const copyBtnRef = useRef(null);
  const [removalSelection, setRemovalSelection] = useState(null);
  const togglePicker = (mode) => {
    setRemovalSelection(null);
    setPickerMode(current => current === mode ? null : mode);
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg px-3 py-2 flex flex-wrap items-center gap-2 sticky top-0 z-30">
      <span className="text-xs text-gray-300">
        <span className="text-white font-medium">{selected.size}</span> of {items.length} selected
      </span>
      <button
        type="button"
        onClick={() => setSelected(new Map(items.map((it) => [it.key, it])))}
        disabled={bulkBusy || items.every(item => selected.has(item.key))}
        className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-border hover:bg-port-border/70 text-white rounded disabled:opacity-40"
      >
        {hasMore ? 'Select loaded' : 'Select all'}
      </button>
      <button
        type="button"
        onClick={() => setSelected(new Map())}
        disabled={bulkBusy || selected.size === 0}
        className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-border hover:bg-port-border/70 text-white rounded disabled:opacity-40"
      >
        Clear
      </button>
      <div className="flex flex-wrap items-center gap-1.5 ml-auto">
        <button
          type="button"
          onClick={() => bulkStar(true)}
          disabled={bulkBusy || selected.size === 0}
          className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-warning/20 hover:bg-port-warning/40 text-port-warning rounded flex items-center gap-1 disabled:opacity-40"
          title="Favorite selected"
        >
          <Star className="w-3 h-3" /> Star
        </button>
        <button
          type="button"
          onClick={() => bulkStar(false)}
          disabled={bulkBusy || selected.size === 0}
          className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-border hover:bg-port-border/70 text-white rounded flex items-center gap-1 disabled:opacity-40"
          title="Unfavorite selected"
        >
          <StarOff className="w-3 h-3" /> Unstar
        </button>
        <ShareToButton
          kind="media"
          items={selectedItems.map((it) => ({ kind: it.kind, ref: it.ref }))}
          label="Share…"
        />
        <button
          ref={moveBtnRef}
          type="button"
          onClick={() => togglePicker('move')}
          disabled={bulkBusy || selected.size === 0}
          className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded flex items-center gap-1 disabled:opacity-40"
          title={isUnsorted ? 'File selected into a collection' : 'Move selected to another collection'}
        >
          <FolderInput className="w-3 h-3" /> {isUnsorted ? 'File…' : 'Move…'}
        </button>
        {!isUnsorted && (
          <>
            <button
              ref={copyBtnRef}
              type="button"
              onClick={() => togglePicker('copy')}
              disabled={bulkBusy || selected.size === 0}
              className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded flex items-center gap-1 disabled:opacity-40"
              title="Copy selected to another collection"
            >
              <Copy className="w-3 h-3" /> Copy…
            </button>
            {removalSelection === selected ? (
              <ConfirmButtonPair
                prompt={`Remove ${selected.size} selected?`}
                confirmText="Remove"
                busy={bulkBusy}
                busyText="Removing…"
                onConfirm={bulkRemove}
                onCancel={() => setRemovalSelection(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setPickerMode(null);
                  setRemovalSelection(selected);
                }}
                disabled={bulkBusy || selected.size === 0}
                className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-error/20 hover:bg-port-error/40 text-port-error rounded flex items-center gap-1 disabled:opacity-40"
                title="Remove selected from this collection"
              >
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            )}
          </>
        )}
        {selectedItems.some((it) => it.kind === 'image') && (
          <button
            type="button"
            onClick={bulkVerify}
            disabled={bulkBusy || selected.size === 0}
            className="px-2 py-1 text-[11px] pointer-coarse:min-h-11 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded flex items-center gap-1 disabled:opacity-40"
            title="Verify anatomy and quality of selected images"
          >
            <ShieldCheck className="w-3 h-3" /> Verify
          </button>
        )}
        <button
          type="button"
          onClick={exitSelectMode}
          disabled={bulkBusy}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white disabled:opacity-40"
          title="Exit select mode"
          aria-label="Exit select mode"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      {pickerMode && (
        <BulkTargetPicker
          anchorRef={pickerMode === 'move' ? moveBtnRef : copyBtnRef}
          excludeId={collectionId}
          busy={bulkBusy}
          title={`${pickerMode === 'move' ? 'Move' : 'Copy'} ${selected.size} to…`}
          collections={collections}
          error={collectionsError}
          onRetry={retryCollections}
          onPick={bulkMoveOrCopy}
          onClose={() => setPickerMode(null)}
        />
      )}
    </div>
  );
}
