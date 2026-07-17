/**
 * Creative Commissions page — the Autonomous Creation Engine index (#2657).
 *
 * A Creative Commission is a standing, recurring creative brief the server fires
 * on a schedule through the Creative Director directive pipeline. This page lists
 * every commission and hosts the deep-linked create Drawer:
 *   /creative-commission        → index (list)
 *   /creative-commission/new    → create drawer
 *   /creative-commission/:id     → routed detail page (CreativeCommissionDetail.jsx)
 *
 * EDITING a commission is no longer a sidebar drawer — clicking a card navigates
 * to the routed detail page, which shows the render history + editable config.
 * The URL is the source of truth for what's open, per the ID-based deep-linking
 * rule. Mutations update local state directly (no full refetch).
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Plus, Sparkles, Trash2, Clock, Cpu, Pause, Play, Zap } from 'lucide-react';
import toast from '../components/ui/Toast';
import Drawer from '../components/Drawer';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { timeAgo } from '../utils/formatters';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import CommissionConfigForm from '../components/creative-commission/CommissionConfigForm.jsx';
import {
  blankForm, toPayload, patchFormState, validateForm, describeSchedule, describeAssignment,
} from '../components/creative-commission/commissionForm.js';
import {
  listCommissions, createCommission, updateCommission, deleteCommission, runCommissionNow,
} from '../services/api';

export default function CreativeCommissions() {
  const navigate = useNavigate();
  const location = useLocation();
  const [commissions, setCommissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(blankForm());
  const [saving, setSaving] = useState(false);
  const [runningIds, setRunningIds] = useState(() => new Set()); // per-card "Run Now" in flight
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  // The create drawer is driven by the /creative-commission/new route (a static
  // segment, not an :id param — the :id route now renders the detail page).
  const creating = location.pathname.replace(/\/+$/, '').endsWith('/creative-commission/new');

  useEffect(() => {
    let cancelled = false;
    listCommissions({ silent: true })
      .then((data) => { if (!cancelled) setCommissions(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) toast.error('Failed to load commissions'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Reset the form to blank each time the create drawer opens.
  useEffect(() => { if (creating) setForm(blankForm()); }, [creating]);

  const closeDrawer = useCallback(() => navigate('/creative-commission'), [navigate]);
  const patchForm = useCallback((path, value) => setForm((prev) => patchFormState(prev, path, value)), []);

  const handleCreate = async () => {
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const created = await createCommission(toPayload(form), { silent: true });
      setCommissions((prev) => [...prev, created]);
      toast.success('Commission created');
      navigate('/creative-commission');
    } catch (e) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (commission) => {
    const prev = commissions;
    setCommissions((cur) => cur.filter((c) => c.id !== commission.id));
    try {
      await deleteCommission(commission.id, { silent: true });
      toast.success('Commission deleted');
    } catch (err) {
      setCommissions(prev); // rollback
      toast.error(err?.message || 'Delete failed');
    }
  };

  // Fire a commission immediately, outside its schedule — the "does this actually
  // work" test button. Runs the same gated path as a cron tick, so a skip
  // (autonomy off, over budget) is itself the test result and is toasted.
  const handleRunNow = async (commission) => {
    setRunningIds((prev) => new Set(prev).add(commission.id));
    try {
      const result = await runCommissionNow(commission.id, { silent: true });
      if (result?.commission?.id) {
        const fresh = result.commission;
        setCommissions((prev) => prev.map((c) => (c.id === fresh.id ? { ...c, runs: fresh.runs, feedback: fresh.feedback } : c)));
      }
      if (result?.status === 'started') toast.success('Run started — open the commission to watch the render');
      else if (result?.status === 'skipped') toast.error(`Run skipped: ${result.reason}`);
      else toast.error(`Run failed: ${result?.error || 'unknown error'}`);
    } catch (err) {
      toast.error(err?.message || 'Run failed');
    } finally {
      setRunningIds((prev) => { const next = new Set(prev); next.delete(commission.id); return next; });
    }
  };

  const toggleEnabled = async (commission) => {
    const next = !commission.enabled;
    setCommissions((prev) => prev.map((c) => (c.id === commission.id ? { ...c, enabled: next } : c)));
    try {
      await updateCommission(commission.id, { enabled: next }, { silent: true });
    } catch (err) {
      setCommissions((prev) => prev.map((c) => (c.id === commission.id ? { ...c, enabled: commission.enabled } : c)));
      toast.error(err?.message || 'Update failed');
    }
  };

  const sorted = useMemo(
    () => [...commissions].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [commissions],
  );

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-port-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-100">Creative Commissions</h1>
            <p className="text-sm text-gray-500">Standing briefs that create on a schedule and steer by your taste</p>
          </div>
        </div>
        <button
          onClick={() => navigate('/creative-commission/new')}
          className="flex items-center gap-2 bg-port-accent hover:bg-blue-600 text-white px-3 py-2 rounded text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> New Commission
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="border border-dashed border-port-border rounded-lg p-10 text-center">
          <Sparkles className="w-8 h-8 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 mb-1">No commissions yet</p>
          <p className="text-gray-600 text-sm mb-4">
            Create a standing brief like “every night at 2am, make me something surreal” and it runs unattended.
          </p>
          <button
            onClick={() => navigate('/creative-commission/new')}
            className="inline-flex items-center gap-2 bg-port-accent hover:bg-blue-600 text-white px-3 py-2 rounded text-sm font-medium"
          >
            <Plus className="w-4 h-4" /> New Commission
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 bg-port-card border border-port-border rounded-lg p-3 hover:border-port-accent/50 transition-colors"
            >
              <button
                className="flex-1 text-left min-w-0"
                onClick={() => navigate(`/creative-commission/${encodeURIComponent(c.id)}`)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-100 font-medium truncate">{c.name}</span>
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${c.enabled ? 'bg-port-success/20 text-port-success' : 'bg-gray-700 text-gray-400'}`}>
                    {c.enabled ? 'Active' : 'Paused'}
                  </span>
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent">{c.targetAbility}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {describeSchedule(c.schedule)}</span>
                  <span className="flex items-center gap-1" title="AI provider that writes the treatment & plan">
                    <Cpu className="w-3 h-3" /> {describeAssignment(c.assignment)}
                  </span>
                  {Array.isArray(c.runs) && c.runs.length > 0 && (
                    <span>Last run {timeAgo(c.runs[c.runs.length - 1].ranAt)}</span>
                  )}
                </div>
              </button>
              <button
                onClick={() => handleRunNow(c)}
                disabled={runningIds.has(c.id)}
                title="Run now (ignores schedule)"
                aria-label={`Run commission ${c.name} now`}
                className="p-2 text-gray-400 hover:text-port-accent disabled:opacity-50"
              >
                <Zap className={`w-4 h-4 ${runningIds.has(c.id) ? 'animate-pulse text-port-accent' : ''}`} />
              </button>
              <button
                onClick={() => toggleEnabled(c)}
                title={c.enabled ? 'Pause' : 'Resume'}
                className="p-2 text-gray-400 hover:text-gray-100"
              >
                {c.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              {isConfirming(c.id) ? (
                <ConfirmButtonPair
                  prompt="Delete?"
                  ariaLabel={`Confirm delete commission ${c.name}`}
                  onConfirm={() => confirmDelete(() => handleDelete(c))}
                  onCancel={cancelDelete}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => requestDelete(c.id)}
                  title="Delete commission"
                  aria-label={`Delete commission ${c.name}`}
                  className="p-2 text-gray-400 hover:text-port-error"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <Drawer
        open={creating}
        onClose={closeDrawer}
        title="New Commission"
        size="md"
        closeOnEsc={false}
        closeOnBackdrop={false}
      >
        <CommissionConfigForm
          form={form}
          patchForm={patchForm}
          saving={saving}
          onSave={handleCreate}
          onCancel={closeDrawer}
          saveLabel="Create"
        />
      </Drawer>
    </div>
  );
}
