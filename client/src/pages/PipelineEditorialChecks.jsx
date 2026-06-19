/**
 * Editorial Checks (#1285) — the catalog / config / run / triage surface for the
 * registry-driven editorial-review system (epic #1283, backbone #1284).
 *
 * The check CATALOG (enable + per-check config) is global (settings-backed), so
 * it loads independent of any series. RUNS and FINDINGS are per-series: pick a
 * series, run the enabled checks (or a selected subset) with SSE progress, then
 * triage the findings — which are seeded into the manuscript review store and
 * deep-link into the manuscript editor's existing Accept/Dismiss/fix flow.
 *
 * Deep-linkable at /pipeline/editorial-checks (optionally ?series=<id> to
 * preselect a series, e.g. from a series page).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ListChecks, Loader2, Play, Plus, Square } from 'lucide-react';
import toast from '../components/ui/Toast';
import EditorialCheckCard from '../components/pipeline/editorial/EditorialCheckCard';
import EditorialCustomCheckForm from '../components/pipeline/editorial/EditorialCustomCheckForm';
import EditorialFindingsTriage from '../components/pipeline/editorial/EditorialFindingsTriage';
import EditorialHealthPanel from '../components/pipeline/editorial/EditorialHealthPanel';
import { groupChecksByScope } from '../lib/editorialChecks';
import { usePipelineProgress } from '../hooks/usePipelineProgress';
import {
  listPipelineSeries,
  getEditorialChecks,
  patchEditorialCheck,
  createEditorialCustomCheck,
  updateEditorialCustomCheck,
  deleteEditorialCustomCheck,
  startEditorialChecksRun,
  cancelEditorialChecksRun,
  getEditorialChecksRunStatus,
  editorialChecksRunSseUrl,
  getPipelineManuscriptReview,
} from '../services/api';

export default function PipelineEditorialChecks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [checks, setChecks] = useState([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const [series, setSeries] = useState([]);
  const seriesId = searchParams.get('series') || '';
  const [comments, setComments] = useState([]);
  const [loadingFindings, setLoadingFindings] = useState(false);
  // Bumped whenever the findings are (re)loaded so the health panel refetches
  // its score/trend in lockstep — a run that seeds new findings also moves the
  // health score + records a trend snapshot server-side.
  const [healthRefresh, setHealthRefresh] = useState(0);

  const [runActive, setRunActive] = useState(false);
  const [runStarting, setRunStarting] = useState(false);

  const checksById = useMemo(
    () => Object.fromEntries(checks.map((c) => [c.id, c])),
    [checks],
  );
  const enabledCount = useMemo(() => checks.filter((c) => c.enabled).length, [checks]);
  const scopeGroups = useMemo(() => groupChecksByScope(checks), [checks]);
  // Config saves read server settings, so a run that fires before a save lands
  // would use stale config — gate the run buttons while any save is in flight.
  const anySaving = savingIds.size > 0;

  // ---- Load the global catalog + series list once. ----
  useEffect(() => {
    let canceled = false;
    Promise.all([
      getEditorialChecks().catch(() => ({ checks: [] })),
      listPipelineSeries().catch(() => []),
    ]).then(([catalog, list]) => {
      if (canceled) return;
      setChecks(Array.isArray(catalog?.checks) ? catalog.checks : []);
      setSeries(Array.isArray(list) ? list : []);
      setLoadingCatalog(false);
    });
    return () => { canceled = true; };
  }, []);

  // ---- Load findings + re-attach to an in-flight run when the series changes. ----
  // Tracks the currently-selected series so a slow findings fetch for a series
  // the user has since navigated away from can't overwrite the new series'
  // comments (which would also point the deep-links at the wrong series).
  const activeSeriesRef = useRef(seriesId);
  useEffect(() => { activeSeriesRef.current = seriesId; }, [seriesId]);

  const loadFindings = useCallback((id) => {
    if (!id) { setComments([]); return; }
    setLoadingFindings(true);
    // getPipelineManuscriptReview has no silent option, so request() already
    // toasts on failure — just clear + swallow here (single-layer toast). Guard
    // every state write on the series still being current (stale-response race).
    getPipelineManuscriptReview(id)
      .then((review) => { if (activeSeriesRef.current === id) setComments(Array.isArray(review?.comments) ? review.comments : []); })
      .catch(() => { if (activeSeriesRef.current === id) setComments([]); })
      .finally(() => {
        if (activeSeriesRef.current === id) {
          setLoadingFindings(false);
          setHealthRefresh((n) => n + 1); // re-pull the health score/trend in lockstep
        }
      });
  }, []);

  useEffect(() => {
    setRunActive(false);
    if (!seriesId) { setComments([]); return; }
    loadFindings(seriesId);
    let canceled = false;
    getEditorialChecksRunStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) setRunActive(true); })
      .catch(() => {});
    return () => { canceled = true; };
  }, [seriesId, loadFindings]);

  // ---- SSE progress for the active run (mirrors the manuscript editor). ----
  const { latest: runLatest, closed: runClosed } = usePipelineProgress(
    editorialChecksRunSseUrl, [seriesId], { enabled: runActive && !!seriesId },
  );

  // The run's stage label, derived from the latest `check:start` frame — no
  // state to keep in sync (the banner only renders while runActive).
  const runStageLabel = runActive && runLatest?.type === 'check:start' && runLatest.label
    ? `Running: ${runLatest.label}` : '';

  // Terminal frame: refresh findings + tear down. Gate on `runClosed` so a stale
  // terminal frame from a prior run can't kill a freshly-started one.
  useEffect(() => {
    if (!runActive || !runClosed || !runLatest) return;
    const type = runLatest.type;
    if (type !== 'complete' && type !== 'canceled' && type !== 'error') return;
    setRunActive(false);
    if (type === 'complete') { loadFindings(seriesId); toast.success('Editorial checks complete'); }
    else if (type === 'canceled') toast.success('Editorial checks canceled');
    else toast.error(runLatest.error || 'Editorial checks failed');
  }, [runActive, runClosed, runLatest, seriesId]);

  // Recovery: the stream died WITHOUT a terminal frame — don't strand the UI;
  // drop the active flag and re-fetch (the runner may have seeded server-side).
  useEffect(() => {
    if (!runActive || !runClosed) return;
    const t = runLatest?.type;
    if (t === 'complete' || t === 'canceled' || t === 'error') return; // handled above
    setRunActive(false);
    loadFindings(seriesId);
  }, [runActive, runClosed, runLatest, seriesId]);

  // ---- Catalog mutations (reactive local updates; the API owns the toast).
  // Stable identities (useCallback) so React.memo'd cards only re-render when
  // their own row changes — not on every unrelated run/selection state tick.
  // Rollback flips only the one check (functional update) so a concurrent
  // toggle of a different check can't be clobbered. ----
  const handleToggle = useCallback((checkId, nextEnabled) => {
    const apply = (val) => setChecks((rows) => rows.map((r) => (r.id === checkId ? { ...r, enabled: val } : r)));
    apply(nextEnabled);
    // Drop a now-disabled check from the targeted-run selection so "Run selected"
    // can't carry an id the server will silently filter out.
    if (!nextEnabled) setSelectedIds((s) => { if (!s.has(checkId)) return s; const n = new Set(s); n.delete(checkId); return n; });
    // Track in savingIds like config saves — the run endpoint reads persisted
    // settings, so the run buttons must gate on this PATCH landing (and the card
    // shows its saving spinner for the toggle too).
    setSavingIds((s) => new Set(s).add(checkId));
    patchEditorialCheck(checkId, { enabled: nextEnabled }, { silent: true })
      .then((row) => { if (row) setChecks((rows) => rows.map((r) => (r.id === checkId ? row : r))); })
      .catch((err) => { apply(!nextEnabled); toast.error(err.message || 'Failed to update check'); })
      .finally(() => setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  const handleConfigSave = useCallback((checkId, nextConfig) => {
    setSavingIds((s) => new Set(s).add(checkId));
    patchEditorialCheck(checkId, { config: nextConfig }, { silent: true })
      .then((row) => { if (row) setChecks((rows) => rows.map((r) => (r.id === checkId ? row : r))); })
      .catch((err) => toast.error(err.message || 'Failed to save config'))
      .finally(() => setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  // ---- Custom-check authoring (#1346). The form is URL-driven (?custom=new |
  // ?custom=<checkId>) so it's deep-linkable, not a stateful modal. ----
  const customParam = searchParams.get('custom') || '';
  const editingCheck = customParam && customParam !== 'new'
    ? checks.find((c) => c.id === customParam && c.isCustom) || null
    : null;
  // Form is open for 'new', or for a custom id that resolves to a check.
  const formOpen = customParam === 'new' || !!editingCheck;
  const [formSaving, setFormSaving] = useState(false);

  // useCallback so the memo'd custom cards (which take onEdit) only re-render on
  // an actual param change, not every parent run/selection state tick.
  const openCustomForm = useCallback((id) => {
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('custom', id); return next; }, { replace: true });
  }, [setSearchParams]);
  const closeCustomForm = useCallback(() => {
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('custom'); return next; }, { replace: true });
  }, [setSearchParams]);

  const handleSaveCustom = (values) => {
    setFormSaving(true);
    const editingId = editingCheck?.id;
    const req = editingId
      ? updateEditorialCustomCheck(editingId, values, { silent: true })
      : createEditorialCustomCheck(values, { silent: true });
    req
      .then((row) => {
        if (!row) return;
        setChecks((rows) => (editingId
          ? rows.map((r) => (r.id === editingId ? row : r))
          : [...rows, row]));
        toast.success(editingId ? 'Custom check saved' : 'Custom check created');
        closeCustomForm();
      })
      .catch((err) => toast.error(err.message || 'Failed to save custom check'))
      .finally(() => setFormSaving(false));
  };

  const handleDeleteCustom = useCallback((checkId) => {
    setSavingIds((s) => new Set(s).add(checkId));
    // Drop from the targeted-run selection so a deleted id can't ride a run.
    setSelectedIds((s) => { if (!s.has(checkId)) return s; const n = new Set(s); n.delete(checkId); return n; });
    deleteEditorialCustomCheck(checkId, { silent: true })
      .then(() => { setChecks((rows) => rows.filter((r) => r.id !== checkId)); toast.success('Custom check deleted'); })
      .catch((err) => toast.error(err.message || 'Failed to delete custom check'))
      .finally(() => setSavingIds((s) => { const n = new Set(s); n.delete(checkId); return n; }));
  }, []);

  const toggleSelected = (checkId) => setSelectedIds((s) => {
    const n = new Set(s);
    if (n.has(checkId)) n.delete(checkId); else n.add(checkId);
    return n;
  });

  // ---- Run / cancel. ----
  const runChecks = (subsetIds = null) => {
    if (!seriesId) { toast.error('Pick a series to run checks against'); return; }
    // The server runs only ENABLED checks even from a named subset, so drop any
    // disabled ids up front — otherwise a selection of disabled checks completes
    // as a silent no-op the user reads as "0 findings".
    let ids = subsetIds;
    if (ids) {
      const enabledIds = ids.filter((id) => checksById[id]?.enabled);
      if (!enabledIds.length) { toast.error('Those checks are disabled — enable them or pick others'); return; }
      if (enabledIds.length < ids.length) toast('Skipped disabled checks from your selection');
      ids = enabledIds;
    }
    setRunStarting(true);
    startEditorialChecksRun(seriesId, ids ? { checkIds: ids } : {}, { silent: true })
      .then((res) => {
        if (res?.alreadyRunning) toast('A run is already in progress for this series');
        setRunActive(true);
      })
      .catch((err) => toast.error(err.message || 'Failed to start checks'))
      .finally(() => setRunStarting(false));
  };

  const cancelRun = () => {
    cancelEditorialChecksRun(seriesId, { silent: true })
      .catch((err) => toast.error(err.message || 'Failed to cancel'));
  };

  const onSeriesChange = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('series', id); else next.delete('series');
    setSearchParams(next, { replace: true });
  };

  // Gate runs on formSaving too: a run reads server-side settings, so starting
  // one while a custom-check create/edit PATCH is in flight would run the stale
  // (pre-save) definition. Mirrors the savingIds gate for per-check config saves.
  const runDisabled = !seriesId || runActive || runStarting || anySaving || formSaving;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      {/* Header */}
      <div className="space-y-2">
        <Link to="/pipeline" className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
          <ArrowLeft size={13} /> Series Pipeline
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-xl font-semibold text-gray-100">
            <ListChecks size={20} className="text-port-accent" /> Editorial Checks
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="ec-series" className="sr-only">Series</label>
            <select
              id="ec-series"
              value={seriesId}
              onChange={(e) => onSeriesChange(e.target.value)}
              className="rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-gray-100 focus:border-port-accent focus:outline-none"
            >
              <option value="">Select a series…</option>
              {series.map((s) => (
                <option key={s.id} value={s.id}>{s.title || s.name || s.id}</option>
              ))}
            </select>
            {runActive ? (
              <button
                type="button"
                onClick={cancelRun}
                className="inline-flex items-center gap-1.5 rounded bg-port-error/20 px-3 py-1.5 text-sm text-rose-300 hover:bg-port-error/30"
              >
                <Square size={14} /> Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={() => runChecks(null)}
                disabled={runDisabled || enabledCount === 0}
                title={enabledCount === 0 ? 'No checks enabled' : undefined}
                className="inline-flex items-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-sm text-white hover:bg-port-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {runStarting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Run all enabled ({enabledCount})
              </button>
            )}
            {!runActive && selectedIds.size > 0 ? (
              <button
                type="button"
                onClick={() => runChecks([...selectedIds])}
                disabled={runDisabled}
                className="inline-flex items-center gap-1.5 rounded border border-port-accent px-3 py-1.5 text-sm text-port-accent hover:bg-port-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play size={14} /> Run selected ({selectedIds.size})
              </button>
            ) : null}
          </div>
        </div>
        {runActive ? (
          <p className="flex items-center gap-2 text-xs text-port-accent">
            <Loader2 size={13} className="animate-spin" /> {runStageLabel || 'Running editorial checks…'}
          </p>
        ) : null}
        {!seriesId ? (
          <p className="text-xs text-gray-500">Pick a series to run checks and triage findings. The catalog below applies to every series.</p>
        ) : null}
      </div>

      {loadingCatalog ? (
        <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Loading checks…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Catalog */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Catalog</h2>
              {!formOpen ? (
                <button
                  type="button"
                  onClick={() => openCustomForm('new')}
                  className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:bg-port-border/40"
                >
                  <Plus size={13} /> New custom check
                </button>
              ) : null}
            </div>
            {formOpen ? (
              // Key on the target so switching new↔edit (or check A→B) while the
              // form stays mounted remounts it with a fresh draft — otherwise the
              // mount-only useState initializer would save the previous draft.
              <EditorialCustomCheckForm
                key={editingCheck?.id || 'new'}
                check={editingCheck}
                saving={formSaving}
                onSave={handleSaveCustom}
                onCancel={closeCustomForm}
              />
            ) : null}
            {checks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">No editorial checks are registered.</p>
            ) : scopeGroups.map((group) => (
              <div key={group.scope} className="space-y-2">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-gray-500">{group.label}</h3>
                {group.checks.map((check) => (
                  <div key={check.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`sel-${check.id}`}
                      checked={selectedIds.has(check.id)}
                      disabled={!check.enabled}
                      onChange={() => toggleSelected(check.id)}
                      title={check.enabled ? 'Select for a targeted run' : 'Enable this check to include it in a run'}
                      aria-label={`Select ${check.label} for a targeted run`}
                      className="mt-3.5 shrink-0 accent-port-accent disabled:opacity-40"
                    />
                    <div className="min-w-0 flex-1">
                      <EditorialCheckCard
                        check={check}
                        saving={savingIds.has(check.id)}
                        onToggle={handleToggle}
                        onConfigSave={handleConfigSave}
                        onEdit={check.isCustom ? openCustomForm : undefined}
                        onDelete={check.isCustom ? handleDeleteCustom : undefined}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>

          {/* Findings */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Findings</h2>
            {!seriesId ? (
              <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">Select a series to view its findings.</p>
            ) : (
              <>
                <EditorialHealthPanel seriesId={seriesId} refreshKey={healthRefresh} />
                {loadingFindings ? (
                  <p className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" /> Loading findings…</p>
                ) : (
                  <EditorialFindingsTriage seriesId={seriesId} comments={comments} checksById={checksById} />
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
