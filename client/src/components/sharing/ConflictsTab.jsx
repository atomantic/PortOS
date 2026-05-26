/**
 * Sharing → Conflicts. Lists versions the non-blocking conflict journal
 * preserved when a cross-install LWW merge would have silently overwritten a
 * locally-diverged edit. The user can restore their whole version, merge back
 * specific fields, or discard (keep what synced in).
 */

import { useEffect, useState, useCallback } from 'react';
import { Loader2, GitMerge, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import toast from '../ui/Toast';
import InlineDiff from '../ui/InlineDiff';
import { listConflicts, resolveConflict, deleteConflict } from '../../services/api';

const asText = (v) => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

export default function ConflictsTab() {
  const [loading, setLoading] = useState(true);
  const [conflicts, setConflicts] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listConflicts('pending', { silent: true }).catch(() => ({ conflicts: [] }));
    setConflicts(res.conflicts || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-400 text-sm py-8"><Loader2 className="animate-spin" size={16} /> Loading conflicts…</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        When two machines edited the same record, sync keeps the newest by timestamp — but the overwritten version is
        archived here so nothing is lost. Restore yours, merge back specific fields, or discard.
      </p>
      {conflicts.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center border border-port-border rounded-lg">✓ No pending conflicts.</div>
      ) : (
        conflicts.map((c) => <ConflictEntry key={c.id} entry={c} onResolved={load} />)
      )}
    </div>
  );
}

function ConflictEntry({ entry, onResolved }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedFields, setSelectedFields] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const fields = (entry.diffSummary || []).map((d) => d.field);

  const resolve = async (action, fieldList) => {
    setBusy(true);
    const ok = await resolveConflict(entry.id, { action, ...(fieldList ? { fields: fieldList } : {}) }, { silent: true })
      .then(() => true).catch((err) => { toast.error(`Resolve failed: ${err.message}`); return false; });
    setBusy(false);
    if (ok) {
      const msg = action === 'discard' ? 'Discarded — kept the synced version.'
        : action === 'merge-fields' ? 'Merged selected fields.'
          : 'Restored your version.';
      toast.success(msg);
      onResolved();
    }
  };

  const remove = async () => {
    setBusy(true);
    const ok = await deleteConflict(entry.id, { silent: true }).then(() => true)
      .catch((err) => { toast.error(`Delete failed: ${err.message}`); return false; });
    setBusy(false);
    if (ok) onResolved();
  };

  const toggleField = (f) => setSelectedFields((s) => {
    const next = new Set(s);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  return (
    <div className="border border-port-border rounded-lg bg-port-card">
      <div className="flex items-center justify-between gap-3 p-3">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-2 min-w-0 text-left">
          {expanded ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
          <span className="text-sm text-white truncate">
            {entry.recordKind} <span className="font-mono text-[11px] text-gray-500">{entry.recordId?.slice(0, 14)}</span>
          </span>
          <span className="text-[11px] text-gray-500 shrink-0">
            {fields.length} field(s) · via {entry.source?.via || 'sync'}{entry.source?.peerId ? ` (${entry.source.peerId.slice(0, 8)})` : ''} · {entry.detectedAt?.slice(0, 16).replace('T', ' ')}
          </span>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={() => resolve('restore-all')} disabled={busy}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-accent hover:bg-port-accent/90 text-white text-[11px]" title="Restore your overwritten version">
            <RotateCcw size={12} /> Restore mine
          </button>
          <button type="button" onClick={() => resolve('discard')} disabled={busy}
            className="px-2 py-1 rounded border border-port-border text-gray-400 hover:text-white text-[11px]">
            Discard
          </button>
          <button type="button" onClick={remove} disabled={busy} className="p-1 text-gray-500 hover:text-port-error" title="Remove entry">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-port-border p-3 space-y-3">
          {(entry.diffSummary || []).map((d) => (
            <div key={d.field} className="border border-port-border rounded p-2">
              <label className="flex items-center gap-2 text-xs text-white mb-1.5">
                <input type="checkbox" checked={selectedFields.has(d.field)} onChange={() => toggleField(d.field)} />
                {d.field} <span className="text-[10px] text-gray-500">({d.changed})</span>
              </label>
              {/* old = your archived local value, new = the version that synced in */}
              <InlineDiff oldText={asText(d.localValue)} newText={asText(d.remoteValue)} />
            </div>
          ))}
          <div className="flex justify-end">
            <button type="button" disabled={busy || selectedFields.size === 0}
              onClick={() => resolve('merge-fields', [...selectedFields])}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent hover:bg-port-accent/90 text-white text-xs disabled:opacity-50">
              <GitMerge size={13} /> Merge {selectedFields.size || ''} selected field{selectedFields.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
