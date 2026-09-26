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
 *
 * A run's render materializes ASYNCHRONOUSLY — the fire creates the Creative
 * Director project and returns, then the planner/render loop fills it in over
 * the following minutes. Project-change events refresh only the referenced batch.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation, useSearchParams, Link } from 'react-router';
import { ArrowLeft, Sparkles, Clock, Cpu, Zap, Pause, Play, Trash2 } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { useSocketResource } from '../hooks/useSocketResource';
import { timeAgo } from '../utils/formatters';
import CommissionConfigForm from '../components/creative-commission/CommissionConfigForm.jsx';
import RenderHistory from '../components/creative-commission/RenderHistory.jsx';
import { toastRunOutcome } from '../components/creative-commission/runOutcomeToast.jsx';
import {
  toForm, toPayload, patchFormState, validateForm, describeSchedule, describeAssignment,
  COMMISSION_STOP_COPY,
} from '../components/creative-commission/commissionForm.js';
import {
  getCommission, updateCommission, deleteCommission,
  submitCommissionFeedback, runCommissionNow, getCreativeDirectorProjectsByIds,
} from '../services/api';

const PROJECT_EVENTS = ['creative-director:project:changed'];
const COMMISSION_EVENTS = ['commission:changed'];

export default function CreativeCommissionDetail() {
  const { id } = useParams();
  return <CommissionDetail key={id} id={id} />;
}

function CommissionDetail({ id }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // The run this page was deep-linked to (a scheduled-run notification carries
  // `?run=<runId>`), so the gallery can focus that render rather than whatever is
  // newest by the time the user opens it.
  const focusRunId = searchParams.get('run');
  const { data: commission, loading, error: loadError, refetch: reloadCommission, updateData: setCommission } = useSocketResource(
    () => getCommission(id, { silent: true }),
    { events: COMMISSION_EVENTS, resourceKey: `${id}:${location.key}`, matchesEvent: event => !event?.id || event.id === id },
  );
  const notFound = loadError?.status === 404;
  const [form, setForm] = useState(() => toForm({}));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

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

  // The set of CD projects referenced by this commission's runs. Fetch ONLY
  // those (#4148) — the batch `?ids=` filter costs one round trip sized to this
  // commission's ≤50 persisted runs rather than to the install's total project
  // count, and still returns the full non-slim payload previews compute from.
  // Re-runs when the projectId set changes (e.g. a Run Now appends a render).
  const projectIdsKey = useMemo(() => {
    const ids = (commission?.runs || []).map((r) => r.projectId).filter(Boolean);
    return [...new Set(ids)].sort().join(',');
  }, [commission]);

  const latestRunId = commission?.runs?.at(-1)?.id || '';
  const { data: projects, loading: projectsLoading } = useSocketResource(
    () => projectIdsKey ? getCreativeDirectorProjectsByIds(projectIdsKey.split(','), { silent: true }) : [],
    {
      events: PROJECT_EVENTS,
      resourceKey: `${id}:${projectIdsKey}:${latestRunId}`,
      matchesEvent: event => projectIdsKey.split(',').includes(event?.id),
    },
  );
  const projectsById = useMemo(() => new Map((projects || []).map(project => [project.id, project])), [projects]);

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
      toast.success(COMMISSION_STOP_COPY.deletedToast);
      navigate('/creative-commission');
    } catch (e) {
      toast.error(e?.message || 'Delete failed');
    }
  };

  // Rate/annotate a run's output — folds into the next scheduled run's directive.
  const handleRate = useCallback(async (runId, rating, note, tags = []) => {
    try {
      const updated = await submitCommissionFeedback(id, { runId, rating, note: note || '', tags }, { silent: true });
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
      toastRunOutcome(result, 'Run started — its render appears below once generation finishes');
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
      toast.success(next ? COMMISSION_STOP_COPY.resumedToast : COMMISSION_STOP_COPY.pausedToast);
    } catch (e) {
      setCommission((prev) => ({ ...prev, enabled: !next }));
      setForm((prev) => ({ ...prev, enabled: !next }));
      toast.error(e?.message || 'Update failed');
    }
  };

  if (loading && !commission) {
    return (
      <div className="max-w-6xl mx-auto">
        <PageSkeleton label="Loading commission" titleWidthClass="w-56" cards={2} sidebar={false} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-6xl mx-auto text-center py-16">
        <p className="text-gray-300 mb-3">That commission no longer exists.</p>
        <Link to="/creative-commission" className="inline-flex items-center gap-2 bg-port-accent text-white px-3 py-1.5 rounded text-sm">
          <ArrowLeft className="w-4 h-4" /> Back to commissions
        </Link>
      </div>
    );
  }

  // A transient load failure (network / 5xx / auth) with no cached record — offer
  // a retry rather than claiming the commission was deleted.
  if (!commission) {
    return (
      <div className="max-w-6xl mx-auto text-center py-16">
        <p className="text-gray-300 mb-1">Couldn’t load this commission.</p>
        <p className="text-gray-500 text-sm mb-4">{loadError?.message || 'Please try again.'}</p>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => reloadCommission()}
            className="inline-flex items-center gap-2 bg-port-accent text-white px-3 py-1.5 rounded text-sm"
          >
            Retry
          </button>
          <Link to="/creative-commission" className="inline-flex items-center gap-2 text-gray-400 hover:text-gray-200 px-3 py-1.5 text-sm">
            <ArrowLeft className="w-4 h-4" /> Back to commissions
          </Link>
        </div>
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
                <h1
                  className="min-w-0 line-clamp-2 break-words text-xl font-semibold text-gray-100"
                  title={commission.name}
                >
                  {commission.name}
                </h1>
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
              title={commission.enabled ? COMMISSION_STOP_COPY.pauseTitle : COMMISSION_STOP_COPY.resumeTitle}
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
                title={COMMISSION_STOP_COPY.deleteTitle}
                aria-label={`Delete commission ${commission.name}`}
                className="p-2 text-gray-400 hover:text-port-error"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Renders + Config — side-by-side on desktop, stacked on mobile. */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Renders — the headline: what this commission has actually produced. */}
        <section className="flex-1 space-y-3 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200">Renders</h2>
          <RenderHistory
            runs={commission.runs}
            feedback={commission.feedback}
            projectsById={projectsById}
            projectsLoading={projectsLoading}
            focusRunId={focusRunId}
            onRate={handleRate}
          />
        </section>

        {/* Configuration — the editable brief/schedule/generation. */}
        <aside className="w-full lg:w-[380px] shrink-0 space-y-3">
          <h2 className="text-sm font-semibold text-gray-200">Configuration</h2>
          <div className="bg-port-card border border-port-border rounded-lg p-4 max-w-none">
            <CommissionConfigForm
              form={form}
              patchForm={patchForm}
              saving={saving}
              onSave={handleSave}
              saveLabel="Save changes"
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
