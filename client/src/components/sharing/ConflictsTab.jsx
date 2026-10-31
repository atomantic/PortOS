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
import { listConflicts, getConflict, resolveConflict, deleteConflict } from '../../services/api';
import LoadFailedState from '../ui/LoadFailedState';
import { formatDateTime } from '../../utils/formatters';

const asText = (v) => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

export default function ConflictsTab() {
  const [loading, setLoading] = useState(true);
  const [conflicts, setConflicts] = useState(null);
  // #7260 — when the server reports the sync base-hash store as unreadable,
  // detection is running fail-closed (every overwrite journals) but nothing
  // persists. Show it so an empty list can't read as "no conflicts".
  const [degraded, setDegraded] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listConflicts('pending', { silent: true })
      .then((res) => ({ res: Array.isArray(res?.conflicts) ? res : null }))
      .catch(() => ({ res: null }));
    setConflicts(result.res?.conflicts ?? null);
    setDegraded(result.res?.conflictDetection?.degraded ? result.res.conflictDetection : null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Resolved/removed rows leave local state; re-downloading the list is unnecessary.
  const removeEntry = useCallback((id) => setConflicts((cs) => cs?.filter((c) => c.id !== id) ?? cs), []);

  if (loading) {
    return <div className="flex items-center gap-2 text-gray-400 text-sm py-8"><Loader2 className="animate-spin" size={16} /> Loading conflicts…</div>;
  }

  return (
    <div className="space-y-4">
      {conflicts === null && <LoadFailedState title="Could not load pending conflicts." hint="Retry to try again." onRetry={load} />}
      {degraded && (
        <div className="bg-port-warning/10 border border-port-warning/40 rounded-lg px-3 py-2 text-sm text-port-warning">
          ⚠️ Conflict detection is degraded — {degraded.reason || 'the sync base-hash store is unreadable'}. Overwrites are still archived here fail-closed.
        </div>
      )}
      <p className="text-sm text-gray-400">
        When two machines edited the same record, sync keeps the newest by timestamp — but the overwritten version is
        archived here so nothing is lost. Restore yours, merge back specific fields, or discard.
      </p>
      {conflicts?.length === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center border border-port-border rounded-lg">✓ No pending conflicts.</div>
      ) : (
        conflicts?.map((c) => <ConflictEntry key={c.id} entry={c} onResolved={removeEntry} />)
      )}
    </div>
  );
}

function ConflictEntry({ entry, onResolved }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedFields, setSelectedFields] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  // Full entry (diff values) loads the first time the row expands; the list is a compact projection.
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fields = (entry.diffSummary || []).map((d) => d.field);

  const loadDetail = async () => {
    setDetailLoading(true);
    setDetailError(null);
    await getConflict(entry.id, { silent: true })
      .then(setDetail)
      .catch((err) => setDetailError(err.message || 'Failed to load'));
    setDetailLoading(false);
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !detailLoading) loadDetail();
  };

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
      onResolved(entry.id);
    }
  };

  const remove = async () => {
    setBusy(true);
    const ok = await deleteConflict(entry.id, { silent: true }).then(() => true)
      .catch((err) => { toast.error(`Delete failed: ${err.message}`); return false; });
    setBusy(false);
    if (ok) onResolved(entry.id);
  };

  const toggleField = (f) => setSelectedFields((s) => {
    const next = new Set(s);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  return (
    <div className="border border-port-border rounded-lg bg-port-card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-3">
        <button type="button" onClick={toggleExpanded} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 flex-1 min-h-[44px] sm:min-h-0 text-left">
          {expanded ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
          <span className="text-sm text-white truncate">
            {entry.recordKind} <span className="font-mono text-[11px] text-gray-500">{entry.recordId?.slice(0, 14)}</span>
          </span>
          <span className="text-[11px] text-gray-500 min-w-0">
            {fields.length} field(s) · via {entry.source?.via || 'sync'}{entry.source?.peerId ? ` (${entry.source.peerId.slice(0, 8)})` : ''} · {formatDateTime(entry.detectedAt, '')}
          </span>
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={() => resolve('restore-all')} disabled={busy}
            className="inline-flex items-center gap-1 min-h-[44px] sm:min-h-0 px-2 py-1 rounded bg-port-accent hover:bg-port-accent/90 text-white text-[11px]" title="Restore your overwritten version">
            <RotateCcw size={12} /> Restore mine
          </button>
          <button type="button" onClick={() => resolve('discard')} disabled={busy}
            className="min-h-[44px] sm:min-h-0 px-2 py-1 rounded border border-port-border text-gray-400 hover:text-white text-[11px]">
            Discard
          </button>
          <button type="button" onClick={remove} disabled={busy} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error" title="Remove entry" aria-label="Remove entry">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-port-border p-3 space-y-3">
          {detailLoading && <div className="flex items-center gap-2 text-gray-400 text-xs"><Loader2 className="animate-spin" size={14} /> Loading diff…</div>}
          {detailError && (
            <div role="alert" className="text-xs text-port-error flex items-center gap-2">
              Could not load the diff: {detailError}
              <button type="button" onClick={loadDetail} className="underline">Retry</button>
            </div>
          )}
          {(detail?.diffSummary || []).map((d) => (
            <div key={d.field} className="border border-port-border rounded p-2">
              <label className="flex items-center gap-2 text-xs text-white mb-1.5">
                <input type="checkbox" checked={selectedFields.has(d.field)} onChange={() => toggleField(d.field)} />
                {d.field} <span className="text-[10px] text-gray-500">({d.changed})</span>
              </label>
              {/* old = your archived local value, new = the version that synced in.
                  A deep-diffable field (object map / array of canon entries) carries
                  `parts` — one focused diff per changed sub-entry, labelled by its
                  key/name — instead of one giant JSON blob. */}
              {Array.isArray(d.parts) ? (
                <div className="space-y-2">
                  {d.parts.map((p) => (
                    <div key={p.path} className="pl-2 border-l-2 border-port-border">
                      <div className="font-mono text-[10px] text-gray-400 mb-1">
                        {p.label ?? p.path} <span className="text-gray-600">({p.changed})</span>
                      </div>
                      <InlineDiff oldText={asText(p.localValue)} newText={asText(p.remoteValue)} />
                    </div>
                  ))}
                </div>
              ) : (
                <InlineDiff oldText={asText(d.localValue)} newText={asText(d.remoteValue)} />
              )}
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
