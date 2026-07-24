/**
 * The header of a sprite's detail view — its name, kind/status/chroma-key/
 * import meta, and inline rename/delete controls for the record you're looking
 * at. Rename/delete share the same `useSpriteRecordCrud` state machine the
 * Library catalog cards use, so the two surfaces behave identically. Deleting
 * the open record bubbles up through `onDeleted`, which the page uses to
 * navigate back to the Library.
 */

import { Pencil, Trash2, Check } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { groupIconForKind } from './spriteGroupIcons.js';
import useSpriteRecordCrud from '../../hooks/useSpriteRecordCrud.js';
import { timeAgo } from '../../utils/formatters.js';

export default function SpriteDetailHeader({ record, onRenamed, onDeleted }) {
  const {
    mode, name, setName, busy, error, cancel, startRename, startDelete, saveRename, runDelete,
  } = useSpriteRecordCrud(record, { onRenamed, onDeleted });
  const Icon = groupIconForKind(record.kind);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Icon className="w-5 h-5 mt-1 shrink-0 text-gray-300" />
        {mode === 'rename' ? (
          <div className="flex-1 min-w-0 space-y-1">
            <label htmlFor="sprite-detail-rename" className="sr-only">Rename {record.name}</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="sprite-detail-rename"
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') cancel(); }}
                disabled={busy}
                className="flex-1 min-w-0 bg-port-bg border border-port-accent rounded px-2 py-1 text-lg font-semibold text-white"
              />
              <button
                type="button"
                onClick={saveRename}
                disabled={busy}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-port-accent hover:bg-blue-600 text-white rounded disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={busy}
                className="px-2 py-1 text-xs bg-port-card border border-port-border text-gray-300 rounded hover:border-port-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            {error && <p className="text-xs text-port-error break-words">{error}</p>}
          </div>
        ) : (
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            <h2 className="text-lg font-semibold text-white truncate">{record.name}</h2>
            <button
              type="button"
              onClick={startRename}
              aria-label={`Rename ${record.name}`}
              className="shrink-0 p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={startDelete}
              aria-label={`Delete ${record.name}`}
              className="shrink-0 p-1 rounded text-gray-400 hover:text-port-error hover:bg-port-border/50"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-gray-500">
        {record.kind} · {record.status}
        {record.chromaKey && (
          <>
            {' · chroma key '}
            <span className="inline-block w-3 h-3 rounded-sm align-middle border border-port-border" style={{ backgroundColor: record.chromaKey }} />{' '}
            {record.chromaKey}
          </>
        )}
        {record.importedFrom?.importedAt && ` · imported ${timeAgo(record.importedFrom.importedAt)}`}
      </p>
      {record.spec?.archetype && (
        <p className="text-xs text-gray-500">archetype: {record.spec.archetype}</p>
      )}
      {mode === 'confirm' && (
        <div className="p-3 rounded-lg border border-port-error/50 bg-port-error/10 space-y-2 max-w-md">
          <p className="text-xs text-gray-200">
            Delete <span className="font-semibold break-words">{record.name}</span>? It leaves your
            library; the generated files stay on disk and its id stays reserved. This can’t be undone here.
          </p>
          {error && <p className="text-xs text-port-error break-words">{error}</p>}
          <ConfirmButtonPair
            confirmText="Delete"
            busyText="Deleting…"
            busy={busy}
            confirmIcon={Trash2}
            onConfirm={runDelete}
            onCancel={cancel}
            ariaLabel={`Confirm delete ${record.name}`}
          />
        </div>
      )}
    </div>
  );
}
