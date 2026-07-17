/**
 * Creative Commission detail page (#2657) — the routed replacement for the old
 * edit Drawer.
 *
 *   /creative-commission/:id → this page (editable config + render history)
 *
 * Clicking a commission on the index no longer pops a sidebar edit form; it
 * navigates here, where the user sees EVERY render the commission has produced
 * (video/image thumbnails, newest first) alongside the editable brief/schedule/
 * generation config. The URL is the source of truth for what's open (the
 * ID-based deep-linking rule), so a render or its detail page is directly
 * shareable, bookmarkable, and reachable from ⌘K / voice / notification links.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import { ArrowLeft, Sparkles, Clock, Cpu, Zap, Pause, Play, Trash2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { timeAgo } from '../utils/formatters';
import CommissionConfigForm from '../components/creative-commission/CommissionConfigForm.jsx';
import RenderHistory from '../components/creative-commission/RenderHistory.jsx';
import {
  toForm, toPayload, patchFormState, validateForm, describeSchedule, describeAssignment,
} from '../components/creative-commission/commissionForm.js';
import {
  getCommission, updateCommission, deleteCommission,
  submitCommissionFeedback, runCommissionNow, listCreativeDirectorProjects,
} from '../services/api';

export default function CreativeCommissionDetail() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const [commission, setCommission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [form, setForm] = useState(() => toForm({}));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [projectsById, setProjectsById] = useState(() => new Map());
  const [projectsLoading, setProjectsLoading] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  // Load (and refresh) the deep-linked commission. `location.key` is a dep so a
  // notification deep link to THIS already-open page (a same-path push) still
  // refetches and pulls in a just-fired run.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCommission(id, { silent: true })
      .then((fresh) => {
        if (cancelled) return;
        setCommission(fresh);
        setNotFound(false);
      })
      .catch(() => { if (!cancelled) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, location.key]);

  // Sync the form to the loaded record ONLY when the target id first resolves —
  // never on the in-place record swaps that rating / Run Now / save trigger, or
  // they'd silently discard unsaved field edits. Keying on the last-synced id
  // makes an in-place update of the same id a no-op here.
  const syncedIdRef = useRef(null);
  useEffect(() => {
    if (commission && syncedIdRef.current !== commission.id) {
      setForm(toForm(commission));
      syncedIdRef.current = commission.id;
    }
  }, [commission]);

  // The set of CD projects referenced by this commission's runs. Fetch the full
  // project list once (the list route returns non-slim payloads, so previews
  // compute with no per-card fetch) and index the referenced ones. Re-runs when
  // the projectId set changes (e.g. a Run Now appends a new render).
  const projectIdsKey = useMemo(() => {
    const ids = (commission?.runs || []).map((r) => r.projectId).filter(Boolean);
    return [...new Set(ids)].sort().join(',');
  }, [commission]);

  useEffect(() => {
    if (!projectIdsKey) { setProjectsById(new Map()); setProjectsLoading(false); return; }
    const wanted = new Set(projectIdsKey.split(','));
    let cancelled = false;
    setProjectsLoading(true);
    listCreativeDirectorProjects()
      .then((projects) => {
        if (cancelled) return;
        const map = new Map();
        for (const p of Array.isArray(projects) ? projects : []) {
          if (wanted.has(p.id)) map.set(p.id, p);
        }
        setProjectsById(map);
      })
      .catch(() => { /* status-only cards degrade gracefully */ })
      .finally(() => { if (!cancelled) setProjectsLoading(false); });
    return () => { cancelled = true; };
  }, [projectIdsKey]);

  const patchForm = useCallback((path, value) => setForm((prev) => patchFormState(prev, path, value)), []);

  const handleSave = async () => {
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const updated = await updateCommission(id, toPayload(form), { silent: true });
      setCommission((prev) => ({ ...updated, feedback: prev?.feedback ?? updated.feedback }));
      toast.success('Commission updated');
    } catch (e) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCommission(id, { silent: true });
      toast.success('Commission deleted');
      navigate('/creative-commission');
    } catch (e) {
      toast.error(e?.message || 'Delete failed');
    }
  };

  // Rate/annotate a run's output — folds into the next scheduled run's directive.
  const handleRate = useCallback(async (runId, rating, note) => {
    try {
      const updated = await submitCommissionFeedback(id, { runId, rating, note: note || '' }, { silent: true });
      setCommission(updated);
      toast.success('Feedback saved — it steers the next run');
    } catch (e) {
      toast.error(e?.message || 'Failed to save feedback');
    }
  }, [id]);

  // Fire immediately, outside the schedule — the "does this actually work" test.
  // Runs the same gated path as a cron tick, so a skip (autonomy off, over
  // budget) is itself the result and is toasted with its reason.
  const handleRunNow = async () => {
    setRunning(true);
    try {
      const result = await runCommissionNow(id, { silent: true });
      // Merge only the run-history fields the response is authoritative for, so a
      // concurrent optimistic local change (e.g. a Pause toggle) isn't clobbered.
      if (result?.commission?.id) {
        const fresh = result.commission;
        setCommission((prev) => (prev ? { ...prev, runs: fresh.runs, feedback: fresh.feedback } : fresh));
      }
      if (result?.status === 'started') toast.success('Run started — its render appears below once generation finishes (reload to refresh)');
      else if (result?.status === 'skipped') toast.error(`Run skipped: ${result.reason}`);
      else toast.error(`Run failed: ${result?.error || 'unknown error'}`);
    } catch (e) {
      toast.error(e?.message || 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async () => {
    if (!commission) return;
    const next = !commission.enabled;
    setCommission((prev) => ({ ...prev, enabled: next }));
    setForm((prev) => ({ ...prev, enabled: next }));
    try {
      await updateCommission(id, { enabled: next }, { silent: true });
    } catch (e) {
      setCommission((prev) => ({ ...prev, enabled: !next }));
      setForm((prev) => ({ ...prev, enabled: !next }));
      toast.error(e?.message || 'Update failed');
    }
  };

  if (loading) {
    return <div className="max-w-6xl mx-auto text-gray-500 text-sm">Loading…</div>;
  }

  if (notFound || !commission) {
    return (
      <div className="max-w-6xl mx-auto text-center py-16">
        <p className="text-gray-300 mb-3">That commission no longer exists.</p>
        <Link to="/creative-commission" className="inline-flex items-center gap-2 bg-port-accent text-white px-3 py-1.5 rounded text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to commissions
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link to="/creative-commission" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 mb-3">
          <ArrowLeft className="w-4 h-4" /> Commissions
        </Link>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <Sparkles className="w-6 h-6 text-port-accent shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold text-gray-100 truncate">{commission.name}</h1>
                <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${commission.enabled ? 'bg-port-success/20 text-port-success' : 'bg-gray-700 text-gray-400'}`}>
                  {commission.enabled ? 'Active' : 'Paused'}
                </span>
                <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent">{commission.targetAbility}</span>
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {describeSchedule(commission.schedule)}</span>
                <span className="flex items-center gap-1" title="AI provider that writes the treatment & plan">
                  <Cpu className="w-3 h-3" /> {describeAssignment(commission.assignment)}
                </span>
                {Array.isArray(commission.runs) && commission.runs.length > 0 && (
                  <span>Last run {timeAgo(commission.runs[commission.runs.length - 1].ranAt)}</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRunNow}
              disabled={running}
              title="Run now (ignores schedule)"
              aria-label={`Run commission ${commission.name} now`}
              className="flex items-center gap-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white px-3 py-2 rounded text-sm font-medium"
            >
              <Zap className={`w-4 h-4 ${running ? 'animate-pulse' : ''}`} /> Run now
            </button>
            <button
              onClick={toggleEnabled}
              title={commission.enabled ? 'Pause' : 'Resume'}
              aria-label={commission.enabled ? 'Pause commission' : 'Resume commission'}
              className="p-2 text-gray-400 hover:text-gray-100"
            >
              {commission.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            {isConfirming(commission.id) ? (
              <ConfirmButtonPair
                prompt="Delete?"
                ariaLabel={`Confirm delete commission ${commission.name}`}
                onConfirm={() => confirmDelete(handleDelete)}
                onCancel={cancelDelete}
              />
            ) : (
              <button
                type="button"
                onClick={() => requestDelete(commission.id)}
                title="Delete commission"
                aria-label={`Delete commission ${commission.name}`}
                className="p-2 text-gray-400 hover:text-port-error"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Renders — the headline: what this commission has actually produced. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Renders</h2>
        <RenderHistory
          runs={commission.runs}
          feedback={commission.feedback}
          projectsById={projectsById}
          projectsLoading={projectsLoading}
          onRate={handleRate}
        />
      </section>

      {/* Configuration — the editable brief/schedule/generation. */}
      <section className="space-y-3 border-t border-port-border pt-6">
        <h2 className="text-sm font-semibold text-gray-200">Configuration</h2>
        <div className="bg-port-card border border-port-border rounded-lg p-4 max-w-2xl">
          <CommissionConfigForm
            form={form}
            patchForm={patchForm}
            saving={saving}
            onSave={handleSave}
            saveLabel="Save changes"
          />
        </div>
      </section>
    </div>
  );
}
