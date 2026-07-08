import { useState, useEffect, useCallback } from 'react';
import { Plus, Eye, EyeOff, Pencil, Trash2, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  getVaultRecords, deleteVaultRecord, revealVaultRecord, updateVaultRecord, getPrivacyStatus,
} from '../../services/api';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import VaultRecordDrawer from './VaultRecordDrawer';
import { VAULT_TYPES, SENSITIVE_TYPES } from './constants';

// Toggle switch for share_with_twin / use_for_scans — optimistic PATCH, reverts
// on failure. Disabled + off for the toggle when the type forbids it.
function Toggle({ checked, disabled, onChange, label }) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs cursor-pointer ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-port-accent" />
      <span className="text-gray-400">{label}</span>
    </label>
  );
}

export default function PrivacyVaultTab() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [revealed, setRevealed] = useState({}); // id -> plaintext (never persisted)
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [keyConfigured, setKeyConfigured] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([getVaultRecords(), getPrivacyStatus()]).then(([recs, status]) => {
      setRecords(recs.status === 'fulfilled' ? recs.value : []);
      if (status.status === 'fulfilled') setKeyConfigured(status.value.keyConfigured !== false);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit = (rec) => { setEditing(rec); setDrawerOpen(true); };

  const handleSaved = (saved, wasEditing) => {
    setDrawerOpen(false);
    setRecords((prev) => (wasEditing
      ? prev.map((r) => (r.id === saved.id ? saved : r))
      : [saved, ...prev]));
    // A replaced value invalidates any revealed plaintext.
    setRevealed((prev) => { const next = { ...prev }; delete next[saved.id]; return next; });
  };

  const handleReveal = async (rec) => {
    if (revealed[rec.id]) {
      setRevealed((prev) => { const next = { ...prev }; delete next[rec.id]; return next; });
      return;
    }
    const res = await revealVaultRecord(rec.id).catch(() => null);
    if (res) setRevealed((prev) => ({ ...prev, [rec.id]: res.value }));
  };

  const handleDelete = async (rec) => {
    setConfirmDelete(null);
    const ok = await deleteVaultRecord(rec.id, { silent: true }).catch(() => null);
    if (ok) {
      setRecords((prev) => prev.filter((r) => r.id !== rec.id));
      toast.success('Vault record deleted');
    } else {
      toast.error('Failed to delete record');
    }
  };

  const handleToggle = async (rec, field, value) => {
    const prevVal = rec[field];
    setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, [field]: value } : r)));
    const res = await updateVaultRecord(rec.id, { [field]: value }, { silent: true }).catch(() => null);
    if (!res) {
      setRecords((prev) => prev.map((r) => (r.id === rec.id ? { ...r, [field]: prevVal } : r)));
      toast.error('Failed to update record');
    } else {
      // The server may coerce (e.g. useForScans forced false for sensitive types).
      setRecords((prev) => prev.map((r) => (r.id === rec.id ? res : r)));
    }
  };

  // Group records by type for a scannable table.
  const groups = VAULT_TYPES
    .map((t) => ({ ...t, rows: records.filter((r) => r.type === t.id) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          {keyConfigured ? (
            <span className="inline-flex items-center gap-1.5 text-port-success">
              <ShieldCheck size={16} /> Encryption engaged
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-port-warning">
              <ShieldAlert size={16} /> Encryption key not yet configured
            </span>
          )}
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80"
        >
          <Plus size={16} /> New record
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading vault…</div>
      ) : records.length === 0 ? (
        <div className="border border-dashed border-port-border rounded-lg p-8 text-center text-gray-500 text-sm">
          No vault records yet. Add your identity facts (name, addresses, phones, emails) — each is encrypted at rest.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.id}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{g.label}</h3>
              <div className="space-y-2">
                {g.rows.map((rec) => {
                  const sensitive = SENSITIVE_TYPES.includes(rec.type);
                  return (
                    <div key={rec.id} className="bg-port-card border border-port-border rounded-lg p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-white truncate">{rec.label}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${rec.status === 'previous' ? 'border-gray-600 text-gray-400' : 'border-port-accent/40 text-port-accent'}`}>
                              {rec.status}
                            </span>
                          </div>
                          <div className="mt-1 font-mono text-sm text-gray-300 break-all">
                            {revealed[rec.id] ?? rec.maskedValue}
                          </div>
                          {(rec.validFrom || rec.validTo) && (
                            <div className="mt-1 text-[11px] text-gray-500">
                              {rec.validFrom || '…'} → {rec.validTo || 'present'}
                            </div>
                          )}
                          <div className="mt-2 flex items-center gap-4">
                            <Toggle
                              label="Twin"
                              checked={!!rec.shareWithTwin}
                              onChange={(v) => handleToggle(rec, 'shareWithTwin', v)}
                            />
                            <Toggle
                              label="Scans"
                              checked={!!rec.useForScans}
                              disabled={sensitive}
                              onChange={(v) => handleToggle(rec, 'useForScans', v)}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleReveal(rec)}
                            title={revealed[rec.id] ? 'Hide value' : 'Reveal value'}
                            aria-label={revealed[rec.id] ? 'Hide value' : 'Reveal value'}
                            className="p-2 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                          >
                            {revealed[rec.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                          <button
                            onClick={() => openEdit(rec)}
                            title="Edit record"
                            aria-label="Edit record"
                            className="p-2 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            onClick={() => setConfirmDelete(rec.id)}
                            title="Delete record"
                            aria-label="Delete record"
                            className="p-2 rounded text-gray-400 hover:text-port-error hover:bg-port-border/50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                      {confirmDelete === rec.id && (
                        <InlineConfirmRow
                          className="mt-3"
                          question={`Delete "${rec.label}"? This can't be undone.`}
                          onConfirm={() => handleDelete(rec)}
                          onCancel={() => setConfirmDelete(null)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <VaultRecordDrawer
        open={drawerOpen}
        record={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={handleSaved}
      />
    </div>
  );
}
