import { useState } from 'react';
import { Check, Loader2, Undo2 } from 'lucide-react';
import toast from '../ui/Toast';

/**
 * Success toast for a structural Music Video board edit (merge, split, delete,
 * reorder, cut) carrying an immediate inline Undo button. Keeps a finite 10s
 * window (which pauses on hover/focus in Toast.jsx) so an accidental merge can
 * be reversed in one click without closing the shot drawer.
 */
export function BoardUndoToast({ t, message, onUndo }) {
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  return (
    <span className="flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-gray-200">
        <Check size={14} className="shrink-0 text-port-success" aria-hidden="true" />
        {undone ? 'Undone' : message}
      </span>
      {!undone && (
        <button
          type="button"
          disabled={undoing}
          onClick={async () => {
            setUndoing(true);
            const ok = await onUndo({ silentSuccess: true });
            setUndoing(false);
            if (ok) {
              setUndone(true);
              setTimeout(() => toast.dismiss(t.id), 1200);
            }
          }}
          className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-0.5 text-xs text-port-accent hover:border-port-accent/50 disabled:opacity-40 pointer-fine:sm:min-h-0"
        >
          {undoing ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Undo2 size={12} aria-hidden="true" />} Undo
        </button>
      )}
    </span>
  );
}

/** Show a finite-duration toast with an inline Undo action when the board edit is undoable. */
export function showBoardUndoToast(message, onUndo, undoable = true) {
  if (!undoable || !onUndo) {
    toast.success(message);
    return;
  }
  toast((t) => <BoardUndoToast t={t} message={message} onUndo={onUndo} />, {
    duration: 10000,
    label: message,
  });
}
