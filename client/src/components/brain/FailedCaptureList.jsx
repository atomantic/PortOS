import { useState } from 'react';
import { AlertCircle, Pencil, RotateCcw, Trash2 } from 'lucide-react';

/**
 * Persistent "Not saved" rows for rejected Brain captures. The text shown is
 * the submitted text, never the composer's current draft. Edit changes the
 * retained text in place (so a newer draft in the composer is untouched) and
 * Retry sends whatever the row currently says. The row only leaves when the
 * host discards it or a retry is acknowledged.
 *
 * `failures` come from `useFailedCaptures`; `getText(failure)` / `getNote(failure)`
 * project the payload so each surface keeps its own payload shape.
 */
export default function FailedCaptureList({ failures, getText, getNote, onRetry, onDiscard, retryDisabled = false, idPrefix = 'failed-capture' }) {
  // `edits` keeps the user's changed text per row; `editingIds` only says which
  // rows currently show the textarea, so closing it never drops an edit.
  const [edits, setEdits] = useState({});
  const [editingIds, setEditingIds] = useState({});

  if (!failures.length) return null;

  const setEditing = (id, on) => setEditingIds((prev) => ({ ...prev, [id]: on }));
  const forget = (id) => {
    const without = (prev) => {
      const { [id]: _removed, ...rest } = prev;
      return rest;
    };
    setEdits(without);
    setEditingIds(without);
  };

  return (
    <ul className="mt-3 space-y-2 min-w-0" aria-label="Captures not saved">
      {failures.map((f) => {
        const editing = !!editingIds[f.id];
        const text = edits[f.id] ?? getText(f);
        const note = getNote?.(f);
        return (
          <li key={f.id} className="min-w-0 p-3 bg-port-error/10 border border-port-error/40 rounded-lg" role="group" aria-label="Not saved capture">
            <div className="flex items-start gap-2 min-w-0">
              <AlertCircle size={14} className="text-port-error shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-port-error">Not saved</p>
                <p className="text-xs text-gray-400 break-words [overflow-wrap:anywhere]">{f.error}</p>
                {editing ? (
                  <>
                    <label htmlFor={`${idPrefix}-${f.id}`} className="sr-only">Edit unsaved capture</label>
                    <textarea
                      id={`${idPrefix}-${f.id}`}
                      rows={3}
                      value={text}
                      onChange={(e) => setEdits((prev) => ({ ...prev, [f.id]: e.target.value }))}
                      className="mt-2 w-full min-w-0 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm resize-y"
                    />
                  </>
                ) : (
                  <p className="mt-1 text-sm text-white whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</p>
                )}
                {note ? <p className="mt-1 text-xs text-gray-500 break-words [overflow-wrap:anywhere]">Note: {note}</p> : null}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setEditing(f.id, !editing)}
                aria-pressed={editing}
                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-border text-xs text-gray-300 hover:text-white transition-colors"
              >
                <Pencil size={12} aria-hidden="true" /> {editing ? 'Done editing' : 'Edit'}
              </button>
              <button
                type="button"
                disabled={f.retrying || retryDisabled || !text.trim()}
                onClick={() => onRetry(f, text.trim())}
                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-accent/40 bg-port-accent/20 text-xs text-port-accent hover:bg-port-accent/30 transition-colors disabled:opacity-50"
              >
                <RotateCcw size={12} aria-hidden="true" /> {f.retrying ? 'Retrying…' : 'Retry'}
              </button>
              <button
                type="button"
                disabled={f.retrying}
                onClick={() => { forget(f.id); onDiscard(f.id); }}
                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-port-border text-xs text-gray-400 hover:text-port-error transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} aria-hidden="true" /> Discard
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
