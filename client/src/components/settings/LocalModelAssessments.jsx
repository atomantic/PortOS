/**
 * Measured local-model assessments.
 *
 * The catalog's fit badge is a size estimate that never runs the model. This
 * panel shows what a model ACTUALLY did on this machine — throughput, TTFT, the
 * largest context it managed, and how much of its peak speed survived to that
 * context — and ranks the assessed models for one of four intents.
 *
 * ## Two rules this panel exists to honour
 *
 * 1. **No cold-bootstrap LLM calls** (root AGENTS.md). Reading assessments hits
 *    disk only, so it loads with the tab. Running one calls a provider, so it
 *    fires only from an explicit click AND a consent modal that names the
 *    backend, the model, and how many generations are about to happen. The
 *    batch run (`AssessmentSweepPanel`) is held to exactly the same gate.
 * 2. **Unknown is not bad.** A model with no evidence is listed under "Not yet
 *    measured" with a Measure button — never ranked last, never shown as a poor
 *    choice. Same for an axis that wasn't measured: it is omitted, not zeroed.
 *
 * Throughput is reported in tokens/s wherever the runtime reported token counts,
 * with chars/s as the universal fallback — `ModelThroughputReport` is the full
 * per-context table. PortOS never derives one unit from the other.
 */

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Activity, BarChart3, Gauge, Play, AlertTriangle, SlidersHorizontal, Terminal, FlaskConical } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import TabPills from '../ui/TabPills';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useUrlParams from '../../hooks/useUrlParams';
import { lazyWithReload } from '../../utils/lazyWithReload';
import ModelThroughputReport from './ModelThroughputReport';
import { tuningNoticeChip } from '../../lib/assessmentTuningNotice';
import { decodeLocalModelAssessmentKey, localModelAssessmentPath } from '../../lib/localModelAssessmentKey';
import {
  getLocalLlmAssessments,
  runLocalLlmAssessment,
  deleteLocalLlmAssessment,
  getModelCapabilityTests,
} from '../../services/apiLocalLlm.js';
import AssessmentDrawer from './assessments/AssessmentDrawer';
import AgentBenchmarkPanel from './assessments/AgentBenchmarkPanel';
import RankedAssessmentRow from './assessments/RankedAssessmentRow';
import RuntimeRoster from './assessments/RuntimeRoster';
import SelectedEvidence from './assessments/SelectedEvidence';
import TuningComparison from './assessments/TuningComparison';
import { VerdictPill } from './assessments/AssessmentBadges';
import { backendLabel, compactTuning, entryKey, modelKey, PERFORMANCE_PATH, VERDICT_META } from './assessments/assessmentDetails';

// Load benchmark and assessment panels only when their tab opens.
const PortosModelBenchmarkPanel = lazyWithReload(() => import('./PortosModelBenchmarkPanel'));
const ModelCapabilityTests = lazyWithReload(() => import('./ModelCapabilityTests.jsx'));
const AssessmentSweepPanel = lazyWithReload(() => import('./AssessmentSweepPanel'));
const LocalBenchmarkPanel = lazyWithReload(() => import('./LocalBenchmarkPanel'));
const PANEL_FALLBACK = <BrailleSpinner text="Loading panel" />;

const INTENTS = [
  { id: 'balanced', label: 'Balanced', blurb: 'Even weight on capability, speed, context stability, and memory headroom.' },
  { id: 'smartest', label: 'Smartest', blurb: 'Favors the largest model that actually ran here.' },
  { id: 'fastest', label: 'Fastest', blurb: 'Favors measured throughput above all else.' },
  { id: 'lightweight', label: 'Lightweight', blurb: 'Favors the smallest resident footprint — room left for other work.' },
];

export const PERFORMANCE_VIEWS = [
  { id: 'results', label: 'Results', icon: BarChart3 },
  { id: 'portos-benchmark', label: 'PortOS bench', icon: Activity },
  { id: 'capabilities', label: 'Capabilities', icon: FlaskConical },
  { id: 'agent-checks', label: 'Agent checks', icon: Terminal },
  { id: 'tuning', label: 'Tuning', icon: SlidersHorizontal },
];

const specsFor = (report, id) => report?.runtimes?.find((r) => r.id === id)?.tuningSpecs || [];

// The tuning grid a sweep of this runtime would run, straight from the server —
// so the consent gate's count is the count that executes. Fewer than two entries
// means a sweep is not on offer: either the runtime declares no sweepable knob,
// or PortOS cannot reset it and put it back afterwards, and the server says so
// by shipping an empty grid. Either way the button stays off rather than
// advertising a comparison that would not be valid.
const gridFor = (report, id) => report?.runtimes?.find((r) => r.id === id)?.tuningGrid || [];

// Which model the measure drawer has open lives in the URL, not in local state,
// so the gate is shareable, bookmarkable and reload-safe — the same rule the
// AI-provider editor follows at /ai/edit/:providerId. Search params rather than
// a path segment because a model id is not one: it carries `/` and `:`
// (`hf.co/org/repo:Q4_K_M`), and the drawer is an overlay on an already-routed
// tab. `measureTuning` is the tuning key of the record being re-measured, so a
// deep link reopens the configuration it describes rather than the defaults.
const CLOSED_MEASURE_PARAMS = { measureBackend: null, measureModel: null, measureTuning: null };

// Its neighbour on the same row — the per-model "Sweep tunings" gate — is
// routable for the same reasons and by the same mechanism. It names no tuning:
// the sweep is what measures the tunings, so the model is the whole target, and
// everything else the gate shows (the runtime label, the grid it will run) is
// derivable from that pair plus the report.
const CLOSED_SWEEP_PARAMS = { sweepBackend: null, sweepModel: null };

// Dismissing either gate clears BOTH targets. Only a hand-edited link can name
// both at once, and having one gate close straight into the other would read as
// the dismissal not having worked.
const CLOSED_GATE_PARAMS = { ...CLOSED_MEASURE_PARAMS, ...CLOSED_SWEEP_PARAMS };

export function LocalModelAssessments({ view, taskView, assessmentKey } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const pathSegments = location.pathname.split('/').filter(Boolean);
  const pathnameView = pathSegments[0] === 'models' && pathSegments[1] === 'performance'
    ? pathSegments[2]
    : null;
  const pathnameAssessmentKey = pathnameView === 'results' ? pathSegments[3] : null;
  const requestedView = taskView || view || pathnameView || 'results';
  const selectedKey = assessmentKey || pathnameAssessmentKey;
  const validView = PERFORMANCE_VIEWS.some((item) => item.id === requestedView);
  const activeView = validView ? requestedView : 'results';
  const [portosBenchmarkVisited, setPortosBenchmarkVisited] = useState(() => activeView === 'portos-benchmark');

  useEffect(() => {
    if (activeView === 'portos-benchmark') setPortosBenchmarkVisited(true);
  }, [activeView]);

  useEffect(() => {
    if (!validView) navigate({ pathname: `${PERFORMANCE_PATH}/results`, search: location.search }, { replace: true });
  }, [location.search, navigate, validView]);

  const openView = useCallback((nextView) => {
    navigate({ pathname: `${PERFORMANCE_PATH}/${nextView}`, search: location.search });
  }, [location.search, navigate]);

  const [intent, setIntent] = useState('balanced');
  const [report, setReport] = useState(null);
  const runtimes = report?.runtimes;
  const runtimeLabelFor = useCallback((id) => backendLabel(runtimes, id), [runtimes]);
  const [loading, setLoading] = useState(true);
  // The knobs the user has typed, or `null` while they have typed nothing — in
  // which case the form shows the tuning of the record the URL names, so
  // re-measuring reproduces that configuration and adjusting one knob is a
  // one-field edit. Deriving it (rather than seeding a state copy) is what lets
  // a cold deep link pick the record up the moment the report lands, while a
  // background refresh can never overwrite a half-typed value.
  const [tuningEdits, setTuningEdits] = useState(null);
  // Whether the server-side sweep is working. Owned here rather than in the
  // sweep panel because it gates this panel's per-model buttons too.
  const [sweepRunning, setSweepRunning] = useState(false);
  // Kept beside the assessment report rather than inside the suite panel: the
  // ranked rows show each model's badges and capability verdicts too, so one
  // fetch feeds both surfaces and they can never disagree about what a model
  // claims. Disk-only on the server — safe to load with the tab.
  const [capabilityReport, setCapabilityReport] = useState(null);
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState(null);
  const capabilityRequest = useRef(0);

  const [searchParams, updateParams] = useUrlParams();
  const measureBackend = searchParams.get('measureBackend') || '';
  const measureModel = searchParams.get('measureModel') || '';
  const measureTuning = searchParams.get('measureTuning') || '';
  const sweepBackend = searchParams.get('sweepBackend') || '';
  const sweepModel = searchParams.get('sweepModel') || '';

  // The two gates are alternatives, not siblings — both hold the provider, and
  // only one is reachable by clicking. Each open therefore drops the other's
  // params, so the URL never carries a target for a gate that is not on screen.
  // (What GUARANTEES one drawer is the precedence rule further down, not this.)
  const openTarget = useCallback((entry) => updateParams({
    ...CLOSED_SWEEP_PARAMS,
    measureBackend: entry.backend,
    measureModel: entry.modelId,
    measureTuning: entry.tuningKey || null,
  }), [updateParams]);

  // `replace` so closing the drawer doesn't leave a Back button that reopens it
  // on a run the user just cancelled.
  const closeTarget = useCallback(() => {
    updateParams(CLOSED_GATE_PARAMS, { replace: true });
    setTuningEdits(null);
  }, [updateParams]);

  // Names the model for the sweep panel's consent gate — that panel owns the
  // gate and the progress for BOTH sweeps, because there is only one
  // server-side queue and so only one place that may render a Stop button.
  const openSweepTarget = useCallback((entry) => updateParams({
    ...CLOSED_MEASURE_PARAMS,
    sweepBackend: entry.backend,
    sweepModel: entry.modelId,
  }), [updateParams]);

  const closeSweepTarget = useCallback(
    () => updateParams(CLOSED_GATE_PARAMS, { replace: true }),
    [updateParams],
  );

  const load = useCallback(async (nextIntent) => {
    setLoading(true);
    // The panel owns its own empty/error rendering, so silence the default toast
    // (client/src/AGENTS.md: custom catch ⇒ silent).
    const data = await getLocalLlmAssessments(nextIntent, { silent: true }).catch(() => null);
    setReport(data);
    setLoading(false);
  }, []);

  useEffect(() => { load(intent); }, [load, intent]);

  const loadCapabilities = useCallback(async () => {
    const request = ++capabilityRequest.current;
    setCapabilityLoading(true);
    await getModelCapabilityTests({ silent: true })
      .then((data) => {
        if (request !== capabilityRequest.current) return;
        setCapabilityReport(data);
        setCapabilityError(null);
      })
      .catch((error) => { if (request === capabilityRequest.current) setCapabilityError(error); })
      .finally(() => { if (request === capabilityRequest.current) setCapabilityLoading(false); });
  }, []);

  useEffect(() => { loadCapabilities(); }, [loadCapabilities]);

  // One lookup shared by every ranked row, rebuilt only when the report changes —
  // a per-row `find` over every installed model would be quadratic on a box with
  // thirty models installed.
  const capabilityByModel = useMemo(() => new Map(
    (capabilityReport?.models || []).map((m) => [`${m.backend}:${m.modelId}`, m]),
  ), [capabilityReport]);

  const selectedTuple = useMemo(
    () => decodeLocalModelAssessmentKey(selectedKey),
    [selectedKey],
  );
  const selectedEntry = useMemo(() => {
    if (!selectedTuple) return null;
    const wanted = entryKey(selectedTuple);
    const rows = [report?.ranked, report?.excluded, report?.assessments, report?.uninstalled];
    return rows.flatMap((group) => group || []).find((entry) => entryKey(entry) === wanted) || null;
  }, [report, selectedTuple]);
  const selectedEvidenceLoading = Boolean(selectedKey && !report);

  // Both this panel and the suite panel drive the same URL params, so a row's
  // chip opens the same drawer the matrix does without either owning the other.
  const openCapabilityTest = useCallback((capBackend, capModel, capTest) => {
    updateParams({ ...CLOSED_GATE_PARAMS, capBackend, capModel, capTest });
  }, [updateParams]);

  // The row the URL names, once the report can say which one it is — that record
  // is what carries the tuning a re-measure starts from. Matched through
  // `entryKey` so "the same measurement" has one definition, not two.
  const measureMatch = useMemo(() => {
    if (!measureBackend || !measureModel) return null;
    const wanted = entryKey({ backend: measureBackend, modelId: measureModel, tuningKey: measureTuning });
    const hit = (rows) => rows?.find((entry) => entryKey(entry) === wanted);
    return hit(report?.ranked) || hit(report?.excluded) || hit(report?.unassessed) || null;
  }, [report, measureBackend, measureModel, measureTuning]);

  // An id the report doesn't list still opens the drawer — the URL is the source
  // of truth for what's open — and says so, rather than bouncing: the same id is
  // legitimately absent for the moment between a first run landing and the
  // refreshed report arriving, which is why the notice also stands down mid-run.
  const measureOpen = Boolean(measureBackend && measureModel);
  const pendingTarget = measureOpen
    ? measureMatch || { backend: measureBackend, modelId: measureModel, tuningKey: measureTuning }
    : null;
  const recordTuning = measureMatch?.tuning;
  const tuningDraft = tuningEdits
    ?? (recordTuning && typeof recordTuning === 'object' ? recordTuning : {});

  // The sweep gate's whole payload, derived from the model pair in the URL plus
  // the report — the runtime label and the grid are the server's own, never
  // carried in the link, so a shared link describes what would run TODAY.
  //
  // The row is matched through `modelKey`, not `entryKey`: a sweep varies the
  // tuning, so a model with three recorded configurations is still one sweep
  // target, not three. A pair the report no longer lists still opens the gate —
  // the URL is the source of truth for what's open — and says so, the same as
  // the measure drawer; with no grid behind it, Start is already off anyway.
  //
  // The measure drawer wins when a hand-edited link names both: a Drawer assumes
  // it is the only one open (one scroll lock, one focus trap), and the measure
  // gate is the one that can be mid-run.
  const tuningSweepRequest = useMemo(() => {
    if (!sweepBackend || !sweepModel || measureOpen) return null;
    const wanted = modelKey({ backend: sweepBackend, modelId: sweepModel });
    const hit = (rows) => rows?.find((entry) => modelKey(entry) === wanted);
    const listed = Boolean(hit(report?.ranked) || hit(report?.excluded) || hit(report?.unassessed));
    return {
      backend: sweepBackend,
      modelId: sweepModel,
      runtimeLabel: runtimeLabelFor(sweepBackend),
      variants: gridFor(report, sweepBackend),
      unknownTarget: Boolean(report) && !listed,
    };
  }, [report, runtimeLabelFor, sweepBackend, sweepModel, measureOpen]);

  // Which model this panel is currently measuring. A ref, not state: the socket
  // handler subscribes once and must read the CURRENT target, not the one
  // captured when it was registered.
  const activeTargetRef = useRef(null);

  // A run occupies the local provider for minutes. Without an abort, leaving
  // the page (or changing your mind) leaves it running with nobody listening —
  // the server drops the assessment on an aborted signal rather than recording a
  // cancel as a `does-not-fit`.
  const runControllerRef = useRef(null);
  useEffect(() => () => runControllerRef.current?.abort(), []);

  const [runAssessment, running] = useAsyncAction(async (target) => {
    const controller = new AbortController();
    runControllerRef.current = controller;
    // An aborted fetch rejects with the generic "Server unreachable" message.
    // That is OUR abort, not a failure, so swallow it here rather than letting
    // useAsyncAction toast an error the user just asked for.
    const result = await runLocalLlmAssessment(
      { backend: target.backend, modelId: target.modelId, tuning: compactTuning(target.tuning) },
      { silent: true, signal: controller.signal },
    ).catch((err) => {
      if (controller.signal.aborted) return { cancelled: true };
      throw err;
    }).finally(() => { runControllerRef.current = null; });
    // The ranking is server-derived, so pull the fresh report once a run lands
    // rather than re-implementing the scoring here. A cancelled run recorded
    // nothing, so there is nothing new to fetch.
    if (!result?.cancelled) await load(intent);
    return result;
  }, { errorMessage: 'Assessment failed' });

  const confirmRun = async () => {
    const target = {
      backend: pendingTarget.backend,
      modelId: pendingTarget.modelId,
      tuning: tuningDraft,
    };
    activeTargetRef.current = target;
    const result = await runAssessment(target);
    activeTargetRef.current = null;
    closeTarget();
    // An aborted run recorded nothing on either side, so there is no verdict to
    // report — marked `cancelled` by the abort catch above, or by the server
    // when it saw the signal drop mid-run.
    if (result && !result.cancelled) {
      const verdict = VERDICT_META[result.verdict]?.label || result.verdict;
      // A tuning that could not be applied means the verdict describes a
      // different configuration — surface that at the point of the result
      // rather than only in the row the user has to go find.
      if (tuningNoticeChip(result)) {
        toast.warning(`${target.modelId}: ${verdict} — ${tuningNoticeChip(result)} (${result.tuningNotApplied || 'reason not recorded'})`);
        return;
      }
      toast.success(`${target.modelId}: ${verdict}`);
    }
  };

  const [removeAssessment, removing] = useAsyncAction(async (entry) => {
    const tuningKey = entry.tuningKey || '';
    await deleteLocalLlmAssessment(entry.backend, entry.modelId, tuningKey, { silent: true });
    const isDropped = (r) => r.backend === entry.backend && r.modelId === entry.modelId && (r.tuningKey || '') === tuningKey;
    setReport((prev) => {
      if (!prev) return prev;
      const assessments = prev.assessments.filter((a) => !isDropped(a));
      // The model only returns to "not yet measured" when its LAST tuning is
      // gone — dropping one of several still leaves evidence for it.
      const stillMeasured = assessments.some((a) => a.backend === entry.backend && a.modelId === entry.modelId);
      return {
        ...prev,
        ranked: prev.ranked.filter((r) => !isDropped(r)),
        assessments,
        unassessed: stillMeasured
          ? prev.unassessed
          : [...prev.unassessed, { backend: entry.backend, modelId: entry.modelId, params: null }],
      };
    });
    return true;
  }, { errorMessage: 'Could not discard that measurement' });

  const cancelRun = () => {
    runControllerRef.current?.abort();
    // Stop accepting frames for the abandoned run BEFORE the drawer closes, or a
    // late frame would repopulate a progress bar with nothing behind it.
    activeTargetRef.current = null;
    closeTarget();
  };

  // The sweep is excluded from the panel's OWN disable: pressing Stop has to stay
  // available while the queue is what is busy.
  const localBusy = running || removing;
  const busy = localBusy || sweepRunning;
  const activeIntent = INTENTS.find((i) => i.id === intent);

  return (
    <div className="space-y-4 min-w-0">
      {/* No refresh control: the report loads with the tab and reloads itself
          after every run, sweep and discard, so a manual refresh only ever
          re-fetched what was already on screen. */}
      <div className="flex items-center gap-2">
        <Gauge size={16} className="text-port-accent" />
        <p className="text-[11px] text-gray-500">Compare measured evidence first, then run a focused check when the result leaves a question.</p>
        {loading && <BrailleSpinner />}
      </div>

      <TabPills
        tabs={PERFORMANCE_VIEWS}
        activeTab={activeView}
        onChange={openView}
        ariaLabel="Model performance tasks"
        controlsIdPrefix="performance-task"
        mobileCompact
      />

      <details hidden={activeView !== 'results'} className="bg-port-card border border-port-border rounded-xl px-4 py-3">
        <summary className="cursor-pointer text-xs text-gray-400">How measurements and rankings work</summary>
        <p className="text-[11px] text-gray-500 pt-2">
          An explicit assessment runs one short generation at each sampled context size and records throughput, first-token timing, context stability, and resident memory. Tokens/s and chars/s remain separate units; missing evidence is never treated as zero. Results stay on this machine because they describe its current hardware and runtime state.
        </p>
      </details>

      <div hidden={activeView !== 'results'}>
        <RuntimeRoster runtimes={runtimes} />
      </div>

      <div
        hidden={activeView !== 'portos-benchmark'}
        role="tabpanel"
        id="performance-task-portos-benchmark"
        aria-labelledby="tab-portos-benchmark"
      >
        {portosBenchmarkVisited && <Suspense fallback={PANEL_FALLBACK}><PortosModelBenchmarkPanel /></Suspense>}
      </div>

      <div
        hidden={activeView !== 'agent-checks'}
        role="tabpanel"
        id="performance-task-agent-checks"
        aria-labelledby="tab-agent-checks"
      >
        <AgentBenchmarkPanel active={activeView === 'agent-checks'} disabled={busy} />
      </div>

      <div
        hidden={activeView !== 'capabilities'}
        role="tabpanel"
        id="performance-task-capabilities"
        aria-labelledby="tab-capabilities"
      >
        <Suspense fallback={PANEL_FALLBACK}>
          <ModelCapabilityTests
            report={capabilityReport}
            loading={capabilityLoading}
            error={capabilityError}
            onReload={loadCapabilities}
            disabled={busy}
          />
        </Suspense>
      </div>

      <div
        hidden={activeView !== 'tuning'}
        role="tabpanel"
        id="performance-task-tuning"
        aria-labelledby="tab-tuning"
        className="space-y-4"
      >
        <Suspense fallback={PANEL_FALLBACK}>
          <AssessmentSweepPanel
            counts={report?.sweepScopes}
            contextTokens={report?.defaultContextTokens || []}
            disabled={localBusy}
            onRunningChange={setSweepRunning}
            onSweepFinished={() => load(intent)}
            tuningRequest={tuningSweepRequest}
            onTuningRequestClose={closeSweepTarget}
          />
          <LocalBenchmarkPanel
            report={report}
            runtimeLabelFor={runtimeLabelFor}
            disabled={busy}
          />
        </Suspense>
        <ModelThroughputReport
          report={report?.throughputReport}
          runtimeLabelFor={runtimeLabelFor}
        />
        <TuningComparison
          rows={report?.tuningComparison}
          runtimeLabelFor={runtimeLabelFor}
        />
      </div>

      <div
        hidden={activeView !== 'results'}
        role="tabpanel"
        id="performance-task-results"
        aria-labelledby="tab-results"
        className="space-y-4"
      >
      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="assessment-intent" className="text-xs text-gray-400">Rank for</label>
        <select
          id="assessment-intent"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
        >
          {INTENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        <span className="text-xs text-gray-500">{activeIntent?.blurb}</span>
      </div>

      {loading && !report ? (
        <BrailleSpinner text="Loading assessments" />
      ) : !report ? (
        <p className="text-xs text-gray-500">Could not load assessments. Use Refresh to try again.</p>
      ) : (
        <>
          {report.readError && (
            <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
              <AlertTriangle size={12} /> {report.readError} — the next assessment will start a fresh record.
            </p>
          )}
          {report.listErrors?.length > 0 && (
            <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
              <AlertTriangle size={12} />
              Could not list installed models for {report.listErrors.map(runtimeLabelFor).join(', ')} —
              models there may be missing from this list.
              <Link to="/models/llms-runtimes" className="text-port-accent hover:underline">View runtimes</Link>
            </p>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)] items-start">
            <div className="space-y-2">
            {report.ranked.length > 0 ? (
              <div className="space-y-2">
                {report.ranked.map((entry) => (
                <RankedAssessmentRow
                  key={entryKey(entry)}
                  entry={entry}
                  runtimeLabel={runtimeLabelFor(entry.backend)}
                  busy={busy}
                  selected={selectedTuple && entryKey(entry) === entryKey(selectedTuple)}
                  sweepVariants={gridFor(report, entry.backend).length}
                  onRemeasure={openTarget}
                  onDelete={removeAssessment}
                  onSweepTunings={openSweepTarget}
                  capability={capabilityByModel.get(`${entry.backend}:${entry.modelId}`) || null}
                  capabilityTests={capabilityReport?.tests}
                  onOpenCapabilityTest={openCapabilityTest}
                  search={location.search}
                />
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                Nothing measured yet. Pick a model below and run an assessment to see how it actually performs here.
              </p>
            )}

          {report.excluded?.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-gray-400">Measured, but not recommended</h3>
              {report.excluded.map((entry) => (
                <div key={entryKey(entry)} className="flex items-center gap-2 text-xs flex-wrap">
                  <Link className="text-gray-300 font-mono break-all hover:text-port-accent" to={{ pathname: localModelAssessmentPath(entry), search: location.search }}>{entry.modelId}</Link>
                  {/* Several rows can name the same model — one per tuning — so
                      the configuration is what tells them apart. */}
                  <span className="px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-500">
                    {entry.tuningLabel || 'backend defaults'}
                  </span>
                  <VerdictPill verdict={entry.verdict} />
                  {entry.reason && <span className="text-gray-500">{entry.reason}</span>}
                </div>
              ))}
            </div>
          )}

          {report.unassessed?.length > 0 && (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-gray-400">
                Not yet measured ({report.unassessed.length})
              </h3>
              <p className="text-[11px] text-gray-500">
                No evidence recorded — that is not a mark against them, just an unanswered question.
              </p>
              <div className="space-y-1 pt-1">
                {report.unassessed.map((entry) => (
                  <div key={modelKey(entry)} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-gray-300 font-mono break-all min-w-0">
                      {entry.modelId}
                      <span className="text-gray-600 ml-2">{runtimeLabelFor(entry.backend)}</span>
                    </span>
                    <button
                      onClick={() => openTarget(entry)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white transition-colors disabled:opacity-50 shrink-0"
                    >
                      <Play size={11} /> Measure
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
            </div>
            <SelectedEvidence
              entry={selectedEntry}
              report={report}
              runtimeLabelFor={runtimeLabelFor}
              loading={selectedEvidenceLoading}
              selected={Boolean(selectedKey)}
              search={location.search}
            />
          </div>
        </>
      )}
      </div>

      <AssessmentDrawer
        target={pendingTarget}
        unknownTarget={Boolean(report) && !measureMatch && !running}
        runtimeLabel={runtimeLabelFor(pendingTarget?.backend)}
        contextTokens={report?.defaultContextTokens || []}
        tuningSpecs={specsFor(report, pendingTarget?.backend)}
        tuning={tuningDraft}
        onTuningChange={setTuningEdits}
        running={running}
        activeTargetRef={activeTargetRef}
        onClose={cancelRun}
        onConfirm={confirmRun}
      />
    </div>
  );
}

export default LocalModelAssessments;
