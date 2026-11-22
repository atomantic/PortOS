import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, KeyRound } from 'lucide-react';
import { getWebsiteLogins, deleteWebsiteLogin } from '../../services/apiPrivacy.js';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import useLatestRequest from '../../hooks/useLatestRequest';
import WebsiteLoginDrawer from './WebsiteLoginDrawer';

// Website Logins (#17397): origin-bound credentials the model-blind browser
// fill types into a matching tab. The list only ever holds metadata (label,
// exact origins, masked username, hasTotp, notes); there is no reveal. The
// parent keys this section by subject, so a subject switch starts fresh.
export default function WebsiteLoginsSection({ subjectId }) {
  const [logins, setLogins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  // A `?subject=` switch reuses this mounted section; drop a slower read for
  // the previous subject so its logins never show under the new one.
  const beginRequest = useLatestRequest();
  const load = useCallback(() => {
    const isCurrent = beginRequest();
    setLoading(true);
    getWebsiteLogins({ subjectId, silent: true })
      .then((rows) => { if (isCurrent()) { setLogins(rows ?? []); setLoadFailed(false); } })
      .catch(() => { if (isCurrent()) setLoadFailed(true); })
      .finally(() => { if (isCurrent()) setLoading(false); });
  }, [subjectId, beginRequest]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditing(null); setDrawerOpen(true); };
  const openEdit = (login) => { setEditing(login); setDrawerOpen(true); };

  const handleSaved = (saved, wasEditing) => {
    setDrawerOpen(false);
    setLogins((prev) => (wasEditing ? prev.map((row) => (row.id === saved.id ? saved : row)) : [saved, ...prev]));
  };

  // The confirm row stays up until the request settles; a repeat confirm while
  // one is in flight is ignored so a login is never deleted twice.
  const handleDelete = async (login) => {
    if (deletingId) return;
    setDeletingId(login.id);
    const ok = await deleteWebsiteLogin(login.id, { silent: true }).catch(() => null);
    setDeletingId(null);
    setConfirmDelete(null);
    if (ok) {
      setRemoving(login.id);
      toast.success('Website login deleted');
    } else {
      toast.error('Failed to delete website login');
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="website-logins-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 id="website-logins-heading" className="text-xs font-semibold uppercase tracking-wide text-gray-500">Website logins</h3>
          <p className="text-xs text-gray-500 mt-1">
            Filled into the managed browser only on an exact origin match. Passwords and 2FA keys are never shown again.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-port-border text-gray-200 hover:text-white hover:border-port-accent"
        >
          <Plus size={16} /> New login
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-4 text-center">Loading website logins…</div>
      ) : loadFailed ? (
        <div className="border border-port-error/40 rounded-lg p-4 text-sm text-port-error flex flex-wrap items-center justify-between gap-2">
          Website logins could not be loaded.
          <button type="button" onClick={load} className="px-3 py-1.5 text-sm rounded border border-port-border text-gray-200 hover:text-white">Retry</button>
        </div>
      ) : logins.length === 0 ? (
        <div className="border border-dashed border-port-border rounded-lg p-6 text-center text-gray-500 text-sm">
          No website logins yet. Save one so an authorized agent can sign in without ever seeing the password.
        </div>
      ) : (
        <div>
          {logins.map((login) => (
            <CollapsibleListItem
              key={login.id}
              removing={removing === login.id}
              onExited={() => { setLogins((prev) => prev.filter((row) => row.id !== login.id)); setRemoving(null); }}
            >
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <KeyRound size={14} className="text-gray-500 shrink-0" aria-hidden="true" />
                      <span className="text-sm font-medium text-white truncate">{login.label}</span>
                      {login.hasTotp && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-success/40 text-port-success">2FA Auto</span>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-sm text-gray-300 break-all">{login.maskedUsername}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {login.origins.map((origin) => (
                        <span key={origin} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-400 break-all">{origin}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEdit(login)}
                      title="Edit website login"
                      aria-label={`Edit ${login.label}`}
                      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(login.id)}
                      disabled={deletingId === login.id || removing === login.id}
                      title="Delete website login"
                      aria-label={`Delete ${login.label}`}
                      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded text-gray-400 hover:text-port-error hover:bg-port-border/50 disabled:opacity-40"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {confirmDelete === login.id && (
                  <InlineConfirmRow
                    className="mt-3"
                    question={`Delete "${login.label}"? This can't be undone.`}
                    onConfirm={() => handleDelete(login)}
                    onCancel={() => setConfirmDelete(null)}
                  />
                )}
              </div>
            </CollapsibleListItem>
          ))}
        </div>
      )}

      <WebsiteLoginDrawer
        open={drawerOpen}
        login={editing}
        subjectId={subjectId}
        onClose={() => setDrawerOpen(false)}
        onSaved={handleSaved}
      />
    </section>
  );
}
