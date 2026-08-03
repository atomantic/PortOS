/**
 * Manual "Add <kind>" mini-form for a canon trunk in `UniverseCanonSection`.
 *
 * Collects a name + optional description and hands them to `onAddEntry`, which
 * owns persistence (optimistic append → `updateUniverse` → revert on failure).
 * Mirrors CategoryEditor's `adding`/`newLabel` bucket-add shape.
 *
 * The `{ name, description }` draft is CONTROLLED by the owner rather than held
 * here, because the owner's toolbar "Add" button is a toggle: collapsing the
 * form and reopening it must bring the typed draft back. Only Cancel and a
 * successful Save clear it (both route through `onClose`).
 */
import { Loader2 } from 'lucide-react';
import { BIBLE_LIMITS } from '../../lib/bibleLimits';

export default function CanonAddEntryForm({ kind, creating = false, draft, onDraftChange, onAddEntry = null, onClose }) {
  const newName = draft?.name || '';
  const newDesc = draft?.description || '';

  const submitAdd = async () => {
    if (!newName.trim() || !onAddEntry || creating) return;
    // `onAddEntry` resolves false on a duplicate name or a failed save — keep
    // the form open in that case so the typed draft isn't thrown away.
    const ok = await onAddEntry({ name: newName, description: newDesc });
    if (ok) onClose();
  };

  return (
    <div className="bg-port-bg border border-port-border rounded p-2 mb-2 flex flex-col gap-2">
      <input
        value={newName}
        onChange={(e) => onDraftChange({ name: e.target.value, description: newDesc })}
        onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }}
        placeholder={`${kind.singular[0].toUpperCase()}${kind.singular.slice(1)} name`}
        className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
        maxLength={BIBLE_LIMITS.NAME_MAX}
        autoFocus
        aria-label={`New ${kind.singular} name`}
      />
      <textarea
        value={newDesc}
        onChange={(e) => onDraftChange({ name: newName, description: e.target.value })}
        placeholder={`Describe this ${kind.singular} (optional — image-gen-ready prose)`}
        className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
        rows={2}
        maxLength={kind.descFieldMax}
        aria-label={`New ${kind.singular} description`}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submitAdd}
          disabled={!newName.trim() || creating}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded"
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : null}
          Save
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
