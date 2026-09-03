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
 * the following minutes. The page therefore polls the referenced projects while
 * any of them is still generating (#4149) so a freshly-fired render appears in
 * place; there is no server-side completion event to subscribe to today.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation, useSearchParams, Link } from 'react-router';
import { ArrowLeft, Sparkles, Clock, Cpu, Zap, Pause, Play, Trash2 } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { timeAgo } from '../utils/formatters';
import CommissionConfigForm from '../components/creative-commission/CommissionConfigForm.jsx';
import RenderHistory from '../components/creative-commission/RenderHistory.jsx';
import {
  toForm, toPayload, patchFormState, validateForm, describeSchedule, describeAssignment,
  COMMISSION_STOP_COPY,
} from '../components/creative-commission/commissionForm.js';
import {
  getCommission, updateCommission, deleteCommission,
  submitCommissionFeedback, runCommissionNow, getCreativeDirectorProjectsByIds,
} from '../services/api';

// A CD project's lifecycle status is the only completion signal this page can
// read (no socket channel, and a commission run row is written once and never
// updated). These are the statuses where more output can still show up.
//
// NOTE the difference from `CreativeDirectorDetail`'s terminal set, which counts
// 'draft' as settled: there, a draft is a project the user hasn't started. Here,
// a commission fire creates the project and advances it in the same breath, so a
// draft we observe is just the sliver before the planner's first status write.
const GENERATING_PROJECT_STATUSES = new Set(['draft', 'planning', 'rendering', 'stitching']);

// Hard ceiling on how long a `started` run is treated as still in flight. A run
// whose project stalled (crashed mid-plan) or was pruned would otherwise poll
// forever on a tab left open — bounding by run age stops that without needing a
// timer, and generously outlasts any real generation.
const IN_FLIGHT_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const PROJECT_POLL_MS = 5000;

export default function CreativeCommissionDetail() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  // The run this page was deep-linked to (a scheduled-run notification carries
  // `?run=<runId>`), so the gallery can focus that render rather than whatever is
  // newest by the time the user opens it.
  const focusRunId = searchParams.get('run');
  const [commission, setCommission] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [form, setForm] = useState(() => toForm({}));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [projectsById, setProjectsById] = useState(() => new Map());
  const [projectsLoading, setProjectsLoading] = useState(false);
  // When the project batch was last ATTEMPTED — the clock the in-flight run
  // check reads, so it re-evaluates on every poll tick rather than freezing at
  // whatever `Date.now()` was during the last render.
  const [projectsFetchedAt, setProjectsFetchedAt] = useState(0);
  // The id set the batch last resolved SUCCESSFULLY. Distinct from the
  // attempted-key ref below: a failed fetch is an attempt but not a load, and
  // the in-flight check has to keep the two apart — an id missing from a
  // successful batch is a pruned project (settled), while the same id missing
  // because the request failed is simply not known yet (retry).
  const [projectsLoadedKey, setProjectsLoadedKey] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  // Load (and refresh) the deep-linked commission. `location.key` is a dep so a
  // notification deep link to THIS already-open page (a same-path push) still
  // refetches and pulls in a just-fired run. `reloadNonce` lets the error-state
  // Retry button re-run the load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCommission(id, { silent: true })
      .then((fresh) => {
        if (cancelled) return;
        setCommission(fresh);
        setNotFound(false);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Only a real 404 means the commission is gone. A transient failure
        // (network, 5xx, auth) must NOT be misreported as "deleted" — surface it
        // as a retryable error instead (absent-vs-unreachable, per AGENTS.md).
        if (err?.status === 404) { setNotFound(true); setLoadError(null); }
        else setLoadError(err?.message || 'Failed to load commission');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, location.key, reloadNonce]);

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

  // ONE fetch path, shared by the id-set change and the generation poll below
  // (#4149). `seq` supersedes an in-flight response another call has already
  // replaced — a poll tick that resolves after the id set changed must not
  // reinstate the previous set's projects.
  const projectsFetchSeqRef = useRef(0);
  const projectsAttemptedKeyRef = useRef(null);
  const fetchProjects = useCallback(async () => {
    const seq = (projectsFetchSeqRef.current += 1);
    if (!projectIdsKey) {
      setProjectsById(new Map());
      setProjectsLoading(false);
      projectsAttemptedKeyRef.current = '';
      setProjectsLoadedKey('');
      return null;
    }
    // Only the FIRST attempt at a given id set shows "loading…" — a poll tick
    // must not flash an already-resolved (or known-pruned) card back to the
    // loading placeholder every few seconds.
    if (projectsAttemptedKeyRef.current !== projectIdsKey) setProjectsLoading(true);
    const projects = await getCreativeDirectorProjectsByIds(projectIdsKey.split(','), { silent: true })
      .catch(() => null); // null = fetch failed; [] = resolved-but-empty (keep the two apart)
    if (seq !== projectsFetchSeqRef.current) return null;
    // Index by id, not position: an id that no longer resolves (pruned project)
    // is absent from the response, and its card degrades to the status-only
    // placeholder. A FAILED fetch keeps the last good map instead of blanking it.
    if (Array.isArray(projects)) {
      setProjectsById(new Map(projects.map((p) => [p.id, p])));
      setProjectsLoadedKey(projectIdsKey);
    }
    projectsAttemptedKeyRef.current = projectIdsKey;
    setProjectsLoading(false);
    // Stamped on every ATTEMPT, not just a successful one, so the in-flight age
    // bound below keeps re-evaluating even while the endpoint is failing.
    setProjectsFetchedAt(Date.now());
    return null;
  }, [projectIdsKey]);

  // Is any run still producing? A run row is written once with status 'started'
  // and never revisited, so "still generating" has to come from the project it
  // points at, in a non-terminal CD status.
  const hasGeneratingRun = useMemo(() => {
    // The freshness of the data we're judging, not wall-clock render time.
    const now = projectsFetchedAt || Date.now();
    // Has the CURRENT id set come back from a successful batch? Until it has, an
    // unresolved id means "not known yet" (initial load, or a failed attempt
    // worth retrying) — after it has, the same id means the project was pruned,
    // and no amount of polling brings it back.
    const batchIsAuthoritative = projectsLoadedKey === projectIdsKey;
    return (commission?.runs || []).some((r) => {
      if (r?.status !== 'started' || !r.projectId) return false;
      const ranAt = Date.parse(r.ranAt);
      if (!Number.isFinite(ranAt) || now - ranAt > IN_FLIGHT_RUN_MAX_AGE_MS) return false;
      const project = projectsById.get(r.projectId);
      if (!project) return !batchIsAuthoritative;
      return GENERATING_PROJECT_STATUSES.has(project.status);
    });
  }, [commission, projectsById, projectsFetchedAt, projectsLoadedKey, projectIdsKey]);

  // Poll only while something is actually generating; the hook also pauses while
  // the tab is hidden and re-fires on return. `immediate: false` because the
  // id-set effect below already owns the first fetch.
  const { refetch: refetchProjects } = useAutoRefetch(fetchProjects, PROJECT_POLL_MS, {
    enabled: hasGeneratingRun,
    immediate: false,
    pollOnly: true,
  });

  // Fetch whenever the referenced id set changes (including the initial load and
  // a Run Now appending a render) — the poll is gated on in-flight work, so it
  // can't be responsible for the first read. The newest run id is a dep too: a
  // fire always mints a NEW project today, so the id set moves on its own, but a
  // run that ever REUSED a project id would otherwise be judged against the
  // cached 'complete' snapshot and never start polling.
  const latestRunId = commission?.runs?.length ? commission.runs[commission.runs.length - 1].id : null;
  useEffect(() => { refetchProjects(); }, [projectIdsKey, latestRunId, refetchProjects]);

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
      if (result?.status === 'started') toast.success('Run started — its render appears below once generation finishes');
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
        <p className="text-gray-500 text-sm mb-4">{loadError || 'Please try again.'}</p>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setReloadNonce((n) => n + 1)}
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
