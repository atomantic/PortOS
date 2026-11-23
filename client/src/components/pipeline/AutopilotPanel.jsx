import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Rocket, Loader2, X, Sliders, PauseCircle, Play } from 'lucide-react';
import toast from '../ui/Toast';
import { usePipelineProgress } from '../../hooks/usePipelineProgress';
import usePersistedOptions, { readBoolean, readInteger, readNumber } from './usePersistedOptions';
import {
  startPipelineAutopilot,
  cancelPipelineAutopilot,
  pausePipelineAutopilot,
  getPipelineAutopilotStatus,
  getPipelineAutopilotModelMetrics,
  pipelineAutopilotSseUrl,
  getPipelineSeries,
  listPipelineIssues,
} from '../../services/apiPipeline.js';
import { getProviders } from '../../services/apiProviders.js';
import { getSettings, patchSettingsSlice } from '../../services/apiSystem.js';
import { providerModelLabel, resolveSeriesRunLlm } from '../../utils/providers';
import { autopilotStepLabel, describeAutopilotVerification, autopilotMarkerTerminal } from '../../lib/autopilotMilestones';
import AutopilotMilestones from './AutopilotMilestones';
import CanonReadinessPanel from './CanonReadinessPanel';
import SeriesAutopilotSchedule from './SeriesAutopilotSchedule';
import AutopilotOptionsPanel from './AutopilotOptionsPanel';
import AutopilotStageQualitySections, { ROUND_MIN, ROUND_MAX } from './AutopilotStageQualitySections';
import AutopilotStatusBanner, { craftGapCaution, editorialCheckCaution, selfImproveLine, observerLine } from './AutopilotStatusBanner';
import { resolveInheritedLlmRoute } from './autopilotLlmRoute';
import { READINESS_GATE_LABELS } from '../../lib/editorialHealth.js';
import { SERIES_AUTOPILOT_DEFAULTS } from '../../../../server/lib/seriesAutopilotDefaults.js';

// Threshold input: a [0,10] number (0.5 steps allowed — NOT integer-rounded like
// the round clamps), blank/invalid → the default.
const clampFoundationThreshold = (n, fallback) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(10, Math.round(v * 100) / 100));
};

// Editorial-health readiness gate (#1316/#1580) — the "manuscript clean" bar the
// autopilot must clear before visuals. Mirrors READINESS_GATES on the server. The
// Options select sends a chosen gate as a PER-RUN override only (it does NOT
// persist, unlike the round inputs) so a one-off looser/stricter run never edits
// the install's saved default; '' means "use the saved default" and sends nothing.
// Clamp a number-input value to [min, max] integers, with a blank/invalid field
// falling back to `fallback` (NOT min — for round gates fallback is the default,
// not 0, so a cleared input never silently disables a gate; an explicitly typed 0
// is still honored). `max === null` leaves the value uncapped.
const clampNumber = (n, { fallback, min, max }) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const rounded = Math.max(min, Math.round(v));
  return max === null ? rounded : Math.min(max, rounded);
};
const clampRound = (n, fallback) => clampNumber(n, { fallback, min: ROUND_MIN, max: ROUND_MAX });
// Pause threshold: blank → 0 (off), non-negative integer, no upper cap.
const clampThreshold = (n) => clampNumber(n, { fallback: 0, min: 0, max: null });
// Revision cycles: at least 1 (0 would strand the loop), capped like the rounds.
const clampCycles = (n, fallback) => clampNumber(n, { fallback, min: 1, max: ROUND_MAX });
// Plateau delta: a float ≥ 0 (blank → the default). No rounding, unlike the gates.
const clampDelta = (n, fallback) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(10, Math.max(0, v));
};

// Every option that follows the "saved default + per-run override" contract, as
// ONE row each: the display default, how to read a saved value (undefined =
// absent/invalid → the default), the clamp applied both on blur and when the
// value is sent as an override, and whether editing persists immediately.
// `persistOnEdit` is for controls with no blur event (checkboxes); the numeric
// inputs persist from RoundInput's onBlur instead. Keyed by the SETTING key the
// server reads, so a key can't drift between the load, the save and the run.
// Per-run-only options (readiness gate, unlock pre-pass, provider/model/effort)
// are deliberately NOT here — they are never persisted.
const OPTION_SPECS = {
  maxArcVerifyRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxArcVerifyRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxArcVerifyRounds),
  },
  maxEditorialRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxEditorialRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxEditorialRounds),
  },
  maxBeatContinuityRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxBeatContinuityRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxBeatContinuityRounds),
  },
  // #1613 — non-negative integer, no upper cap (0 = off).
  checkFindingsPauseThreshold: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.checkFindingsPauseThreshold,
    read: readInteger,
    clamp: clampThreshold,
  },
  // #1615 — plain boolean, no clamp. Defaults ON.
  notifyOnPause: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.notifyOnPause,
    read: readBoolean,
    persistOnEdit: true,
  },
  // #2171 — revision loop: enable checkbox + cycle bounds + plateau delta.
  revisionEnabled: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionEnabled,
    read: readBoolean,
    persistOnEdit: true,
  },
  revisionMinCycles: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionMinCycles,
    read: readInteger,
    clamp: (v) => clampCycles(v, SERIES_AUTOPILOT_DEFAULTS.revisionMinCycles),
  },
  revisionMaxCycles: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionMaxCycles,
    read: readInteger,
    clamp: (v) => clampCycles(v, SERIES_AUTOPILOT_DEFAULTS.revisionMaxCycles),
  },
  revisionPlateauDelta: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.revisionPlateauDelta,
    read: readNumber,
    clamp: (v) => clampDelta(v, SERIES_AUTOPILOT_DEFAULTS.revisionPlateauDelta),
  },
  // #2176 — foundation gate (defaults ON) + weighted threshold + round bound.
  foundationGate: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.foundationGate,
    read: readBoolean,
    persistOnEdit: true,
  },
  foundationThreshold: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.foundationThreshold,
    read: readNumber,
    clamp: (v) => clampFoundationThreshold(v, SERIES_AUTOPILOT_DEFAULTS.foundationThreshold),
  },
  maxFoundationRounds: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.maxFoundationRounds,
    read: readInteger,
    clamp: (v) => clampRound(v, SERIES_AUTOPILOT_DEFAULTS.maxFoundationRounds),
  },
  // Pipeline self-improvement — boolean, off by default.
  selfImprove: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.selfImprove,
    read: readBoolean,
    persistOnEdit: true,
  },
  // Observing orchestrator — boolean, off by default. Persisted like selfImprove:
  // a scheduled unattended run is exactly where the user wants the pipeline
  // hardening itself.
  observer: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.observer,
    read: readBoolean,
    persistOnEdit: true,
  },
  autoSelectModels: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.autoSelectModels,
    read: readBoolean,
    persistOnEdit: true,
  },
  overrideStagePins: {
    defaultValue: SERIES_AUTOPILOT_DEFAULTS.overrideStagePins,
    read: readBoolean,
    persistOnEdit: true,
  },
};

const QUALITY_OPTION_KEYS = [
  'foundationGate', 'foundationThreshold', 'maxFoundationRounds',
  'maxArcVerifyRounds', 'maxBeatContinuityRounds', 'maxEditorialRounds',
  'checkFindingsPauseThreshold', 'revisionEnabled', 'revisionMinCycles',
  'revisionMaxCycles', 'revisionPlateauDelta',
];

// Step labels are shared with the milestone map (lib/autopilotMilestones.js) so
// the live status line and the map can't name the same step differently.
const stepLabel = autopilotStepLabel;

// The record kinds one auto-resolve round can rewrite, in the order a reader
// scans them: the arc first, then down to the episodes.
const MUTATION_LABELS = [
  ['arcFieldsEdited', 'arc field'],
  ['volumesEdited', 'volume'],
  ['characterArcsEdited', 'character arc'],
  ['episodesEdited', 'episode'],
];

// Plain English for the resolver's categorical no-change reasons (the server's
// RESOLVE_NO_CHANGE_REASONS). An unmapped value falls through to the raw token
// rather than vanishing — a reason nobody can read still beats none at all.
const NO_CHANGE_LABELS = {
  'no-findings': 'there was nothing to resolve',
  'isolated-candidate-rejected': 'the candidate was too broad to be an isolated repair',
  'exact-edits-rejected': 'its exact text edits no longer matched the draft',
  'edits-matched-existing': 'it re-authored text the plan already had',
  'edits-out-of-scope': 'it answered at an altitude this gate cannot apply',
  'edits-named-no-finding': 'its edits named none of the findings it was given',
  'no-edits-returned': 'it proposed no edits at all',
};

// Turn an SSE frame into a one-line status string. Null means "nothing to say" —
// the frame is state for another surface, not activity worth a status line.
function frameLabel(f) {
  if (!f) return null;
  switch (f.type) {
    // The milestone map's cursor (server: seriesAutopilot/state.js). It follows
    // the frame that moved it, so labeling it would just overwrite that frame's
    // own status line with a duplicate.
    case 'progress': return null;
    case 'start': return f.mode === 'dry-run' ? 'Planning (dry-run)…' : 'Starting…';
    case 'note': return f.message;
    case 'step:start': return `${stepLabel(f.kind)}…`;
    case 'step:complete': return `${stepLabel(f.kind)} done`;
    case 'step:skip': return `Skipped ${stepLabel(f.kind)}${f.reason ? ` — ${f.reason}` : ''}`;
    // Same formatter the milestone row uses — the two render the SAME telemetry
    // in one card, so a second phrasing of it here is drift waiting to happen.
    case 'verify:round': return `${f.scope} check — ${describeAutopilotVerification(f.scope, f)}`;
    // What the auto-resolve round actually wrote. An episode count alone was
    // meaningless at the arc-spine gate (whose resolver may not touch episodes),
    // so name every record kind that moved — and when nothing moved, say why
    // rather than falling through to a raw `resolve:no-change` frame type.
    case 'resolve:round':
    case 'resolve:no-change': {
      const wrote = MUTATION_LABELS
        .filter(([key]) => f[key])
        .map(([key, noun]) => `${f[key]} ${noun}(s)`);
      const lead = `${f.scope} auto-resolve${f.retry ? ' (retry)' : ''} round ${f.round}`;
      if (wrote.length) return `${lead} — rewrote ${wrote.join(', ')}`;
      const why = f.noChangeReason ? ` — ${NO_CHANGE_LABELS[f.noChangeReason] || f.noChangeReason}` : '';
      const rejected = f.rejectedExactEdits ? ` · ${f.rejectedExactEdits} exact text edit(s) rejected` : '';
      return `${lead} — wrote nothing${why}${rejected}`;
    }
    // An auto-resolve round that left the draft worse was undone — say so live,
    // or the round's edits appear to still be in place while the run pauses.
    // A revert is not necessarily the end of the gate: when a corrective pass is
    // left, the run retries from the restored state, so say which one happened
    // or the user reads every rollback as "this run is about to stop".
    case 'resolve:rollback': return `${f.scope} auto-resolve went from ${f.before} to ${f.after} blocking finding(s) — `
      + `${f.reverted ? 'reverted that round' : 'could not revert that round'}`
      + `${f.retrying ? ', retrying from the best state' : ''}`;
    // Per-finding isolation: each attempt is its own kept-or-reverted decision,
    // so name the finding it was spent on — a bare "attempt 2 reverted" reads as
    // the whole gate rolling back again rather than one candidate being dropped.
    // A candidate too broad to BE an isolated repair is dropped before it is
    // applied, so it never edited the plan and its blocker counts never moved —
    // reporting that as "reverted" would describe an undo that never happened.
    case 'resolve:isolate': return `${f.scope} isolated fix ${f.attempt}${f.target ? ` (${f.target})` : ''} — `
      + (f.reason
        ? `discarded before it was applied: ${f.reason}`
        : `${f.before} → ${f.after} blocking finding(s), ${f.kept ? 'kept' : 'reverted'}`);
    // #2176 — foundation-gate telemetry.
    case 'foundation:round': return `Foundation round ${f.round} — ${describeAutopilotVerification('foundationGate', f)}`;
    case 'foundation:fix': return `${f.phase === 'pre-arc' ? 'Pre-arc foundation' : 'Foundation fix'} — ${f.dimension}${f.applied ? ' applied' : ` skipped${f.reason ? ` (${f.reason})` : ''}`}`;
    // A repair whose re-judge showed no gain is rewound. Like resolve:rollback,
    // say whether the gate is retrying from the restored checkpoint — otherwise
    // every revert reads as "this run is about to stop".
    case 'foundation:rollback': return `Foundation ${f.dimension} repair did not improve its target `
      + `(${f.targetBefore} → ${f.targetAfter}) — ${f.reverted ? 'reverted that repair' : 'could not revert that repair'}`
      + `${f.retrying ? ', retrying from the checkpoint' : ''}`;
    // #1578 — per-check telemetry forwarded from the editorial-checks runner.
    case 'check:start': return `Editorial check: ${f.label || f.checkId}…`;
    case 'check:complete': {
      const name = f.label || f.checkId;
      if (f.error) return `Editorial check: ${name} — ⚠️ errored`;
      if (f.skipped) return `Editorial check: ${name} — skipped`;
      const s = f.bySeverity;
      const sev = s && (s.high || s.medium || s.low) ? ` (${s.high}H/${s.medium}M/${s.low}L)` : '';
      return `Editorial check: ${name} — ${f.count} finding(s)${sev}`;
    }
    // Unlock pre-pass: report what it actually cleared (and what it deliberately
    // left frozen), so "unlocked everything" is never an unverifiable claim.
    case 'unlock:applied': {
      const parts = [];
      if (f.arc) parts.push('arc');
      if (f.arcFields) parts.push(`${f.arcFields} arc field(s)`);
      if (f.seasons) parts.push(`${f.seasons} volume(s)`);
      if (f.stages) parts.push(`${f.stages} stage(s)`);
      if (f.canon) parts.push(`${f.canon} canon entr${f.canon === 1 ? 'y' : 'ies'}`);
      if (f.worldFields) parts.push(`${f.worldFields} world field(s)`);
      if (parts.length === 0) return 'Unlock — nothing was locked';
      const kept = [
        f.canonForeignKept ? `${f.canonForeignKept} other series' canon` : '',
        f.worldFieldsKept ? `${f.worldFieldsKept} shared world field(s)` : '',
      ].filter(Boolean);
      return `Unlocked ${parts.join(', ')}${kept.length ? ` · kept ${kept.join(' + ')} locked` : ''}`;
    }
    case 'render:queued': return `Queued draft render: ${f.target}`;
    case 'canon:repair': return `Canon repair: ${f.filled || 0} described from prose${f.unsupported ? ` · ${f.unsupported} unsupported` : ''}`;
    case 'gap:filed': return `Filed CoS task (${f.gapKind})`;
    // Pipeline self-improvement post-mortem. Only the START frame is live — the
    // verdict rides the terminal frame (a client tears its stream down there).
    case 'selfimprove:start': return `Diagnosing the pipeline (${f.signals} signal${f.signals === 1 ? '' : 's'})…`;
    // Observing orchestrator — its passes ARE live (mid-run), so both frames show.
    case 'observer:start': return `Orchestrator observing the pipeline (${f.signals} signal${f.signals === 1 ? '' : 's'})…`;
    case 'observer:filed': return f.duplicate
      ? `Orchestrator: pipeline fix already tracked (${f.area})`
      : `Orchestrator dispatched a pipeline fix (${f.area})${f.title ? `: ${f.title}` : ''}`;
    // #1617 — immediate cancel ack; the active step finishes before `canceled`.
    case 'cancel:acknowledged': return 'Cancelling — finishing the active step…';
    case 'pause:acknowledged': return 'Pausing safely — finishing the active step…';
    case 'paused': return `Paused — ${f.reason}`;
    case 'complete': return f.dryRun ? 'Plan ready' : 'Complete';
    case 'canceled': return 'Canceled';
    case 'error': return `Failed — ${f.error}`;
    default: return f.type;
  }
}

const RUN_ENDED = new Set(['complete', 'canceled', 'error', 'paused']);

// How many recent frames the live activity log shows. Also the stopping point
// for the backward frame walk that builds it.
const ACTIVITY_LINES = 6;

/**
 * Series-level autonomous-mode control: launch / cancel / live progress, a
 * resume-or-paused banner driven by the persisted `series.autopilot` marker,
 * and a production-readiness (canon descriptive-integrity) check.
 */
export default function AutopilotPanel({ series, onSeriesUpdate, onIssuesUpdate }) {
  const seriesId = series?.id;
  const [active, setActive] = useState(false);
  const [attachVersion, setAttachVersion] = useState(0);
  const [pausePending, setPausePending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState(null);
  const [plan, setPlan] = useState(null);
  const [planTotals, setPlanTotals] = useState(null);
  // Milestone-map state. `seedProgress` is the snapshot the status route hands a
  // panel that attaches MID-RUN (SSE replays one frame, so the live `progress`
  // frames alone would start the map at zero); `terminal` is how the tracked run
  // ended, which turns the step it stopped on from "running" into "blocked".
  const [seedProgress, setSeedProgress] = useState(null);
  const [terminal, setTerminal] = useState(null);
  const [showOpts, setShowOpts] = useState(false);
  const [includeVisual, setIncludeVisual] = useState(true);
  const [fileGaps, setFileGaps] = useState(false);

  // A paused run is a continuation, not a new configuration. Restore the two
  // run-local toggles the server stamped onto its marker so a reload/restart
  // cannot silently turn gap filing off (or visuals back on). A completed run
  // and a different series intentionally return to the ordinary defaults.
  const resumeIncludeVisual = series?.autopilot?.resumeOptions?.includeVisual;
  const resumeFileGaps = series?.autopilot?.resumeOptions?.fileGaps;
  useEffect(() => {
    const paused = series?.autopilot?.status === 'paused';
    setIncludeVisual(paused && typeof resumeIncludeVisual === 'boolean' ? resumeIncludeVisual : true);
    setFileGaps(paused && typeof resumeFileGaps === 'boolean' ? resumeFileGaps : false);
  }, [seriesId, series?.autopilot?.status, resumeIncludeVisual, resumeFileGaps]);
  // Persist a setting (clamped) so a later Resume picks it up server-side.
  // Keep same-control writes ordered so start() also waits for an in-flight
  // blur save. Independent settings patches are merged atomically server-side.
  const persistTailRef = useRef(Promise.resolve());
  const persistRounds = useCallback((patch) => {
    const next = persistTailRef.current
      .catch(() => {})
      .then(() => patchSettingsSlice('pipelineEditorialChecks', patch).catch(() => null));
    persistTailRef.current = next;
    return next;
  }, []);
  // Every persisted option (saved default + per-run override) in one registry —
  // see OPTION_SPECS. The registry owns the state, the per-field dirty flags, the
  // hydrate-if-untouched pass and the edited-only override collection, so adding
  // an option is one spec row plus its control, not seven scattered edits.
  const options = usePersistedOptions(OPTION_SPECS, persistRounds);
  const opt = options.values;
  // Per-run readiness-gate override (#1580). '' = use the saved default (send
  // nothing). `savedGate` is the persisted gate, shown in the "saved default"
  // option label so the user knows what the fallback is.
  const [readinessGate, setReadinessGate] = useState('');
  const [savedGate, setSavedGate] = useState('');
  // Unlock-everything pre-pass. PER-RUN ONLY and never persisted (like
  // `readinessGate` below, unlike every other option here): it rewrites lock
  // state the user set by hand, and a saved default would be picked up by
  // scheduled unattended runs of every series. Always starts unticked, so
  // clearing locks is a fresh, deliberate choice each run.
  const [unlockForRun, setUnlockForRun] = useState(false);
  // Per-run provider/model override. '' = "use the series default", i.e. the
  // provider picked in the series header (`series.llm`), falling back to the
  // install's active provider — the same chain the server resolves in
  // resolveAutopilotLlm, so the copy below names what will actually run. Per-run
  // only (never persisted, like the readiness gate): pinning a different model
  // for one run must not silently re-point every other action on the series.
  const [providerOverride, setProviderOverride] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  // Per-run reasoning effort (#3641). Same per-run-only contract as the
  // provider/model pin: '' = "use whatever the provider's config already bakes
  // in". Sent as `effortOverride`, which the server threads as a SOFT run-level
  // default — a stage with its own `effort` pin still wins.
  const [effortOverride, setEffortOverride] = useState('');
  // Optional independent critic route for this run. Creation/repair keeps the
  // run default above; judges, verification and analytical editorial passes use
  // this route. Exact prompt-stage pins still win over both soft defaults.
  const [separateJudgeLlm, setSeparateJudgeLlm] = useState(false);
  const [judgeProviderOverride, setJudgeProviderOverride] = useState('');
  const [judgeModelOverride, setJudgeModelOverride] = useState('');
  const [judgeEffortOverride, setJudgeEffortOverride] = useState('');
  // Optional routes scoped to one Autopilot step + role. This is the UI side of
  // the model-performance loop: a user can pin a proven specialist (or run an
  // experiment) without repointing every creative or judge call in the run.
  const [stageLlm, setStageLlm] = useState({});
  const [editStageLlm, setEditStageLlm] = useState(false);
  const [selectedStageLlm, setSelectedStageLlm] = useState('foundationGate');
  const [selectedStageRole, setSelectedStageRole] = useState('creative');
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [modelMetrics, setModelMetrics] = useState(null);
  // Provider/model/effort the ACTIVE run reported on its start frame — what the
  // live progress line names, so a run started elsewhere (or by the scheduler)
  // still says which provider (and how hard it thinks) it is spending on.
  const [runLlm, setRunLlm] = useState(null);
  const [productionScope, setProductionScope] = useState('series');

  // A cooperative cancel persists every non-destructive run-local LLM choice.
  // Restore those choices on Resume so a model experiment does not silently
  // collapse back to the series default after a pause/restart.
  useEffect(() => {
    const paused = series?.autopilot?.status === 'paused';
    const resume = paused ? series?.autopilot?.resumeOptions : null;
    setProductionScope(resume?.productionScope || 'series');
    setProviderOverride(resume?.providerOverride || '');
    setModelOverride(resume?.modelOverride || '');
    setEffortOverride(resume?.effortOverride || '');
    setSeparateJudgeLlm(!!resume?.judgeLlm);
    setJudgeProviderOverride(resume?.judgeLlm?.providerOverride || '');
    setJudgeModelOverride(resume?.judgeLlm?.modelOverride || '');
    setJudgeEffortOverride(resume?.judgeLlm?.effortOverride || '');
    setStageLlm(resume?.stageLlm || {});
    setEditStageLlm(!!resume?.stageLlm && Object.keys(resume.stageLlm).length > 0);
  }, [
    seriesId,
    series?.autopilot?.status,
    series?.autopilot?.resumeOptions?.productionScope,
    series?.autopilot?.resumeOptions?.providerOverride,
    series?.autopilot?.resumeOptions?.modelOverride,
    series?.autopilot?.resumeOptions?.effortOverride,
    series?.autopilot?.resumeOptions?.judgeLlm?.providerOverride,
    series?.autopilot?.resumeOptions?.judgeLlm?.modelOverride,
    series?.autopilot?.resumeOptions?.judgeLlm?.effortOverride,
    series?.autopilot?.resumeOptions?.stageLlm,
  ]);

  useEffect(() => {
    let canceled = false;
    getProviders({ silent: true })
      .then((data) => {
        if (canceled) return;
        setProviders(data?.providers || []);
        setActiveProviderId(data?.activeProvider || null);
      })
      .catch(() => null); // picker degrades to the "series default" option only
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    let canceled = false;
    getPipelineAutopilotModelMetrics(seriesId, { silent: true })
      .then((data) => { if (!canceled) setModelMetrics(data); })
      .catch(() => null);
    return () => { canceled = true; };
  }, [seriesId]);

  // Disarm the unlock consent whenever the panel switches series. This
  // component is reused across `seriesId` changes rather than remounted, so
  // without this a box ticked for series A would still be armed — invisibly,
  // since the Options popover is collapsed — when the user lands on series B
  // and hits Run. Consent is per series AND per run; never inherited.
  useEffect(() => { setUnlockForRun(false); }, [seriesId]);

  // Effective provider/model this run will use: per-run override → series.llm →
  // active provider (the client mirror of the server's resolveAutopilotLlm), so
  // the Options copy names what will actually run.
  const seriesProviderId = series?.llm?.provider || '';
  const { provider: effProviderId, model: effModel } = resolveSeriesRunLlm(series, {
    overrideProvider: providerOverride,
    overrideModel: modelOverride,
    activeProviderId,
  });
  // What a BLANK model selection resolves to — the series model, but only while
  // the chosen provider still owns it. Names the "Series default (…)" option so
  // it can't claim a model the run wouldn't actually use.
  const { model: inheritedModel } = resolveSeriesRunLlm(series, {
    overrideProvider: providerOverride,
    activeProviderId,
  });
  const runRoute = useMemo(
    () => resolveInheritedLlmRoute(providers, {
      baseProviderId: effProviderId, baseModel: effModel, baseEffort: effortOverride,
    }),
    [providers, effProviderId, effModel, effortOverride],
  );
  // A pin naming a provider that is gone or disabled is a SOFT default server
  // side — the run quietly falls back to the active provider. Say so rather than
  // asserting a provider that won't run (only once the list has loaded, or a
  // slow fetch would flash the warning on a perfectly good pin).
  const effProvider = runRoute.provider;
  const effProviderUnavailable = !!effProviderId && providers.length > 0
    && (!effProvider || effProvider.enabled === false);
  const providerModels = runRoute.models;
  // What the picked effort ACTUALLY runs as: the server clamps a level the
  // resolved provider/model doesn't offer down its ladder, and emits no flag at
  // all for a provider with no effort control. Naming the clamped value (rather
  // than the raw pick) keeps the copy honest.
  const effectiveEffort = runRoute.effort;
  const judgeBaseEffort = judgeEffortOverride || effortOverride;
  const judgeRoute = useMemo(
    () => resolveInheritedLlmRoute(providers, {
      baseProviderId: effProviderId, baseModel: effModel, baseEffort: effortOverride,
      overrideProvider: judgeProviderOverride, overrideModel: judgeModelOverride,
      overrideEffort: judgeEffortOverride,
    }),
    [providers, effProviderId, effModel, effortOverride, judgeProviderOverride, judgeModelOverride, judgeEffortOverride],
  );
  const { providerId: judgeProviderId, model: judgeModel, models: judgeModels, effort: judgeEffort } = judgeRoute;
  const selectedStageRoute = stageLlm?.[selectedStageLlm]?.[selectedStageRole] || {};
  const isJudgeStage = selectedStageRole === 'judge';
  const stageBaseProviderId = isJudgeStage ? judgeProviderId : effProviderId;
  const stageBaseModel = isJudgeStage ? judgeModel : effModel;
  const stageBaseEffort = isJudgeStage ? judgeBaseEffort : effortOverride;
  const stageRoute = useMemo(
    () => resolveInheritedLlmRoute(providers, {
      baseProviderId: stageBaseProviderId, baseModel: stageBaseModel, baseEffort: stageBaseEffort,
      overrideProvider: selectedStageRoute.providerOverride, overrideModel: selectedStageRoute.modelOverride,
      overrideEffort: selectedStageRoute.effortOverride,
    }),
    [providers, stageBaseProviderId, stageBaseModel, stageBaseEffort, selectedStageRoute],
  );
  const { providerId: stageProviderId, model: stageModel, models: stageModels, effort: stageEffort } = stageRoute;
  const updateSelectedStageRoute = useCallback((patch) => {
    setStageLlm((current) => {
      const currentRoute = current?.[selectedStageLlm]?.[selectedStageRole] || {};
      const nextRoute = Object.fromEntries(
        Object.entries({ ...currentRoute, ...patch }).filter(([, value]) => !!value),
      );
      const nextStage = { ...(current?.[selectedStageLlm] || {}) };
      if (Object.keys(nextRoute).length > 0) nextStage[selectedStageRole] = nextRoute;
      else delete nextStage[selectedStageRole];
      const next = { ...current };
      if (Object.keys(nextStage).length > 0) next[selectedStageLlm] = nextStage;
      else delete next[selectedStageLlm];
      return next;
    });
  }, [selectedStageLlm, selectedStageRole]);

  // Load the persisted option defaults so the Options controls reflect the
  // install's settings. The autopilot reads the same settings server-side, so we
  // never send an untouched option as a per-run override — we just keep the UI in
  // sync and persist edits back. `hydrate` applies the fetched values only to
  // fields the user hasn't already edited, so a slow load can't clobber a fast
  // edit (per-field).
  const { hydrate } = options;
  useEffect(() => {
    let canceled = false;
    getSettings({ silent: true })
      .then((s) => {
        if (canceled) return;
        const pec = s?.pipelineEditorialChecks || {};
        hydrate(pec);
        // Persisted readiness gate — display-only, drives the "saved default" label.
        setSavedGate(READINESS_GATE_LABELS[pec.readinessGate] ? pec.readinessGate : '');
      })
      .catch(() => null); // load failed → inputs keep defaults but start() only persists EDITED fields
    return () => { canceled = true; };
  }, [hydrate]);

  const { latest, frames } = usePipelineProgress(pipelineAutopilotSseUrl, [seriesId], { enabled: active });

  // `frames` is the hook's bounded history (useSseProgress `maxFrames`), so a
  // full pass per frame batch stays cheap: the newest `progress` frame is the
  // milestone map's cursor; the last few labelled frames are the activity log,
  // whose last line is also the status line.
  const { snapshot, activityLines } = useMemo(() => ({
    snapshot: frames.findLast((f) => f?.type === 'progress') ?? null,
    activityLines: frames.map(frameLabel).filter(Boolean).slice(-ACTIVITY_LINES),
  }), [frames]);
  // Fall back to the status route's snapshot until this stream emits one of its
  // own — a panel attaching mid-run has no frames yet.
  const progress = snapshot || seedProgress;
  // A `progress` frame is deliberately label-less, so the status line keeps
  // naming the last frame that had something to say. `latest` covers a stream
  // whose frames were never collected.
  const latestLabel = activityLines.at(-1) || frameLabel(latest);

  const onSeriesUpdateRef = useRef(onSeriesUpdate);
  const onIssuesUpdateRef = useRef(onIssuesUpdate);
  onSeriesUpdateRef.current = onSeriesUpdate;
  onIssuesUpdateRef.current = onIssuesUpdate;
  // The runId of the run THIS panel is currently tracking. After a run ends,
  // useSseProgress leaves the terminal frame in `latest`; without this guard a
  // fresh Run/Resume would see that stale terminal frame and immediately tear
  // the new run down. Terminal frames whose runId doesn't match are ignored.
  const activeRunIdRef = useRef(null);
  const activeRunSeriesIdRef = useRef(seriesId);
  const settledRunIdRef = useRef(null);
  const terminalVersionRef = useRef(0);

  // Read a run's `start` frame — mode (the dry-run badge), the resolved run
  // provider/model, and a dry-run's plan. Shared by the SSE frame and the
  // status payload's copy of it (see the re-attach effect below).
  const applyStartFrame = useCallback((f) => {
    setMode(f.mode || null);
    setRunLlm({
      provider: f.provider || null,
      model: f.model || null,
      effort: f.effort || null,
      judge: f.judge || null,
    });
    if (Array.isArray(f.plan)) setPlan(f.plan);
    if (f.planTotals) setPlanTotals(f.planTotals);
  }, []);

  // Re-attach to an in-flight run on (re)mount.
  useEffect(() => {
    if (!seriesId) return undefined;
    let canceled = false;
    const terminalVersion = terminalVersionRef.current;
    getPipelineAutopilotStatus(seriesId, { silent: true })
      .then((s) => {
        if (canceled || terminalVersion !== terminalVersionRef.current || !s?.active) return;
        // The live start frame owns identity; the persisted marker can still
        // describe a previous run, and dry-runs never persist one.
        const knownRunId = activeRunSeriesIdRef.current === seriesId ? activeRunIdRef.current : null;
        const runId = s.start?.runId || knownRunId || null;
        if (settledRunIdRef.current && runId === settledRunIdRef.current) return;
        activeRunIdRef.current = runId;
        activeRunSeriesIdRef.current = seriesId;
        // SSE replays only the last frame, so the run's `start` frame comes back
        // on the status payload instead — same shape, same reader.
        if (s.start) applyStartFrame(s.start);
        // …and its position in that plan, so the map opens where the run
        // actually is instead of claiming nothing has happened yet.
        if (s.progress) setSeedProgress(s.progress);
        setTerminal(null);
        setPausePending(s.pauseRequested === true);
        setActive(true);
      })
      .catch(() => null);
    return () => { canceled = true; };
  }, [seriesId, attachVersion, applyStartFrame]);

  // Capture dry-run plan + mode. The plan rides the start frame, but a fast
  // dry-run can complete before the client attaches and only the terminal frame
  // is replayed — so also read the plan off a dry-run complete frame.
  useEffect(() => {
    if (latest?.type === 'start') {
      applyStartFrame(latest);
    } else if (latest?.type === 'complete' && latest.dryRun && Array.isArray(latest.plan)) {
      // A fast dry-run can finish before the client attaches, so this terminal
      // frame is the only place the plan (and the fact that it WAS a dry-run,
      // which is what makes the map a plan rather than a progress meter) lands.
      setMode('dry-run');
      setPlan(latest.plan);
      if (latest.planTotals) setPlanTotals(latest.planTotals);
    }
  }, [latest, applyStartFrame]);

  // Run-ended handling: refresh series (for the marker) + issues, toast outcome.
  useEffect(() => {
    if (!active || !latest || !RUN_ENDED.has(latest.type)) return;
    // Ignore a terminal frame left over from a previous run (stale `latest`).
    if (activeRunIdRef.current && latest.runId && latest.runId !== activeRunIdRef.current) return;
    settledRunIdRef.current = latest.runId || activeRunIdRef.current;
    terminalVersionRef.current += 1;
    setActive(false);
    setPausePending(false);
    // Freeze the map on how this run ended: a paused/errored run keeps its
    // milestones on screen with the step it stopped on flagged, rather than the
    // list vanishing the moment the stream closes.
    setTerminal(latest.type);
    getPipelineSeries(seriesId, { silent: true }).then((s) => { if (s) onSeriesUpdateRef.current?.(s); }).catch(() => null);
    listPipelineIssues(seriesId, { silent: true }).then((is) => onIssuesUpdateRef.current?.(Array.isArray(is) ? is : [])).catch(() => null);
    if (latest.type === 'complete') {
      if (latest.dryRun) toast.success('Autopilot plan ready');
      else if (latest.craftGapIssues > 0) toast.warning(`Autopilot complete with ${craftGapCaution(latest.craftGapIssues)}`);
      else if (latest.editorialCheckErrors > 0) toast.warning(`Autopilot complete — ${editorialCheckCaution(latest.editorialCheckErrors)}`);
      else toast.success('Autopilot complete — selected production pass finished');
    }
    else if (latest.type === 'canceled') toast.success('Autopilot canceled');
    else if (latest.type === 'paused') toast.warning(`Autopilot paused — ${latest.reason || 'needs review'}`);
    else toast.error(latest.error || 'Autopilot failed');
    // The self-improvement verdict rides the terminal frame; announce a filed
    // PortOS fix separately so it isn't buried in the run's own outcome toast.
    const siLine = selfImproveLine(latest.selfImprove);
    if (siLine) toast(siLine);
    // Same for the observing orchestrator's run summary.
    const obLine = observerLine(latest.observer);
    if (obLine) toast(obLine);
  }, [active, latest, seriesId]);

  const start = useCallback(async () => {
    setStarting(true);
    setPlan(null);
    setPlanTotals(null);
    // The previous run's map must not bleed into this one — the fresh run
    // rebuilds both halves (plan on its start frame, progress from its frames).
    setSeedProgress(null);
    setTerminal(null);
    // ONLY the options the user edited (clamped, real values — never the display
    // defaults of untouched options, which would mask a saved setting). Send them
    // as per-run overrides AND persist them: the override makes the edit effective
    // for THIS run even if the save fails (persist is best-effort, server
    // precedence is per-run → setting → default), and the persist makes it the
    // saved default for next time. Untouched options send nothing, so the server
    // resolves them from the persisted setting.
    const roundOverrides = options.collectOverrides();
    if (Object.keys(roundOverrides).length) await persistRounds(roundOverrides);
    // Per-run readiness-gate override (#1580): send it ONLY when the user picked a
    // specific gate. Unlike the round inputs we never persist it — '' leaves the
    // server to resolve the gate from the saved setting (then the default).
    const gateOverride = READINESS_GATE_LABELS[readinessGate] ? { readinessGate } : {};
    // Per-run unlock pre-pass — sent only when ticked, and never persisted (see
    // the state declaration): a saved default would reach unattended scheduled
    // runs of every series, and this one rewrites user-set lock state.
    const unlockOverride = unlockForRun ? { unlockForRun: true } : {};
    // Per-run provider/model override, sent ONLY when the user picked one —
    // otherwise the server resolves the series' own llm (then the active
    // provider). Never persisted, like the readiness gate. Picking a provider
    // clears the model, so a sent model always belongs to the effective provider.
    const llmOverride = {
      ...(providerOverride ? { providerOverride } : {}),
      ...(modelOverride ? { modelOverride } : {}),
      ...(effortOverride ? { effortOverride } : {}),
      ...(separateJudgeLlm && (judgeProviderOverride || judgeModelOverride || judgeEffortOverride) ? {
        judgeLlm: {
          ...(judgeProviderOverride ? { providerOverride: judgeProviderOverride } : {}),
          ...(judgeModelOverride ? { modelOverride: judgeModelOverride } : {}),
          ...(judgeEffortOverride ? { effortOverride: judgeEffortOverride } : {}),
        },
      } : {}),
      ...(Object.keys(stageLlm).length > 0 ? { stageLlm } : {}),
    };
    const scopeOverride = productionScope === 'first-issue' ? { productionScope } : {};
    const res = await startPipelineAutopilot(seriesId, { includeVisual, fileGaps, ...scopeOverride, ...roundOverrides, ...gateOverride, ...unlockOverride, ...llmOverride }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not start autopilot'); return null; });
    setStarting(false);
    if (!res) return;
    setMode(res.mode || null);
    setShowOpts(false);
    // Spend the unlock consent — it authorizes exactly the run just started.
    // Without this it stays armed behind a now-collapsed Options popover while
    // the Run button remains visible, so the next click would silently clear
    // locks again with no checkbox on screen to reveal it. Re-arming is one
    // deliberate tick, which is the whole contract of this option.
    setUnlockForRun(false);
    // Track this run's id BEFORE enabling the stream so the terminal-frame
    // effect can reject a stale terminal frame from the previous run.
    activeRunIdRef.current = res.runId || null;
    activeRunSeriesIdRef.current = seriesId;
    setAttachVersion((version) => version + 1);
    setActive(true);
    // `options` is the single dep for every persisted option — the registry reads
    // live values through refs, so no option can be forgotten here.
  }, [seriesId, includeVisual, fileGaps, productionScope, unlockForRun, readinessGate, providerOverride, modelOverride, effortOverride, separateJudgeLlm, judgeProviderOverride, judgeModelOverride, judgeEffortOverride, stageLlm, options, persistRounds]);

  const cancel = useCallback(async () => {
    setPausePending(false);
    await cancelPipelineAutopilot(seriesId).catch(() => null);
  }, [seriesId]);

  const pause = useCallback(async () => {
    const result = await pausePipelineAutopilot(seriesId).catch(() => null);
    setPausePending(result?.pauseRequested === true);
  }, [seriesId]);

  if (!seriesId) return null;

  const ap = series.autopilot;
  const liveLabel = active ? (latestLabel || 'Working…') : null;
  // #1617 — once the server acks the cancel, switch the Stop button to a
  // disabled "Cancelling…" state so the user gets feedback (and can't re-fire
  // cancel) while the active step finishes and the terminal frame arrives.
  const canceling = active && latest?.type === 'cancel:acknowledged';
  const pausing = active && (pausePending || latest?.type === 'pause:acknowledged');
  const runLabel = ap?.status === 'paused' ? 'Resume autopilot'
    : ap?.status === 'done' ? 'Run autopilot again'
      : 'Run autopilot';

  // Milestone map (#4140). The live halves — the plan off the run's `start`
  // frame and the progress the stream folds — only exist while this panel has a
  // run to watch, so a reload the morning after a pause used to show the resume
  // banner with nothing beside it. The marker the run stamped carries both;
  // fall back to it only when there is no live plan to draw, so a dry-run
  // preview and a run in flight both keep the fresher in-memory copy.
  const markerPlan = !active && !plan && ap?.plan?.length ? ap.plan : null;
  const mapPlan = markerPlan || plan;
  const mapProgress = markerPlan ? ap.progress : progress;
  // A marker records how the run ended as a STATUS; the fold reads a terminal
  // frame type, so translate. Without this the step a paused run stopped on
  // would redraw as still running.
  const mapTerminal = markerPlan ? autopilotMarkerTerminal(ap.status) : terminal;

  const customStages = Object.values(stageLlm)
    .filter((routes) => Object.values(routes || {}).some((route) => route && Object.values(route).some(Boolean))).length;
  const qualityOverrides = QUALITY_OPTION_KEYS
    .filter((key) => (OPTION_SPECS[key].clamp?.(opt[key]) ?? opt[key]) !== OPTION_SPECS[key].defaultValue).length
    + Number(Boolean(readinessGate));

  return (
    <div className="border border-port-border rounded-lg bg-port-card/40">
      <div className="flex items-center gap-2 flex-wrap p-3">
        <Rocket size={15} className="text-port-accent" />
        <span className="text-sm font-medium text-white">Autonomous mode</span>
        <span className="text-xs text-gray-500">reviews the story before producing the selected issues</span>

        <div className="ml-auto flex items-center gap-2">
          {!active ? (
            <>
              <button
                type="button"
                onClick={() => setShowOpts((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40"
                title="Run options"
                aria-expanded={showOpts}
              >
                <Sliders size={12} /> Options
              </button>
              <button
                type="button"
                onClick={start}
                disabled={starting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
              >
                {starting ? <Loader2 size={14} className="animate-spin" /> : (ap?.status === 'paused' ? <Play size={14} /> : <Rocket size={14} />)}
                {runLabel}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={pause}
                disabled={pausing || canceling}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-port-accent hover:text-white border border-port-accent/40 bg-port-bg hover:bg-port-accent/10 disabled:opacity-50 disabled:cursor-default"
                title="Finish the active step, then pause without stopping its AI run"
              >
                {pausing ? <Loader2 size={12} className="animate-spin" /> : <PauseCircle size={12} />} {pausing ? 'Pausing…' : 'Pause safely'}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={canceling}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-port-warning hover:text-white border border-port-warning/40 bg-port-bg hover:bg-port-warning/10 disabled:opacity-50 disabled:hover:text-port-warning disabled:cursor-default"
                title="Stop the active AI run immediately"
              >
                {canceling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} {canceling ? 'Cancelling…' : 'Stop now'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Options popover */}
      {!active ? (
        <div className="px-3 pb-3 flex flex-wrap items-center gap-2">
          <label htmlFor="autopilot-production-scope" className="text-xs text-gray-400">Produce</label>
          <select
            id="autopilot-production-scope"
            value={productionScope}
            onChange={(event) => setProductionScope(event.target.value)}
            disabled={starting}
            className="max-w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
          >
            <option value="series">All planned issues</option>
            <option value="first-issue">First issue only</option>
          </select>
          <span className="text-xs text-gray-500">
            {productionScope === 'first-issue'
              ? 'Draft and draw the opening. Editorial repairs can still update the whole plan and any existing drafts.'
              : 'The opening receives developmental review before later issues are drafted.'}
          </span>
        </div>
      ) : null}
      {showOpts && !active ? (
        <AutopilotOptionsPanel
          providers={providers} activeProviderId={activeProviderId} seriesProviderId={seriesProviderId}
          opt={opt} options={options} modelMetrics={modelMetrics}
          effProviderId={effProviderId} effModel={effModel} effectiveEffort={effectiveEffort}
          effProviderUnavailable={effProviderUnavailable} providerModels={providerModels}
          inheritedModel={inheritedModel}
          providerOverride={providerOverride} setProviderOverride={setProviderOverride}
          modelOverride={modelOverride} setModelOverride={setModelOverride}
          effortOverride={effortOverride} setEffortOverride={setEffortOverride}
          separateJudgeLlm={separateJudgeLlm} setSeparateJudgeLlm={setSeparateJudgeLlm}
          judgeProviderId={judgeProviderId} judgeModel={judgeModel} judgeEffort={judgeEffort}
          judgeModels={judgeModels}
          judgeProviderOverride={judgeProviderOverride} setJudgeProviderOverride={setJudgeProviderOverride}
          judgeModelOverride={judgeModelOverride} setJudgeModelOverride={setJudgeModelOverride}
          judgeEffortOverride={judgeEffortOverride} setJudgeEffortOverride={setJudgeEffortOverride}
          includeVisual={includeVisual} setIncludeVisual={setIncludeVisual}
          fileGaps={fileGaps} setFileGaps={setFileGaps}
          unlockForRun={unlockForRun} setUnlockForRun={setUnlockForRun}
        />
      ) : null}

      {!active && (
        <AutopilotStageQualitySections
          providers={providers} opt={opt} options={options}
          customStages={customStages} qualityOverrides={qualityOverrides}
          editStageLlm={editStageLlm} setEditStageLlm={setEditStageLlm} setStageLlm={setStageLlm}
          selectedStageLlm={selectedStageLlm} setSelectedStageLlm={setSelectedStageLlm}
          selectedStageRole={selectedStageRole} setSelectedStageRole={setSelectedStageRole}
          selectedStageRoute={selectedStageRoute} stageProviderId={stageProviderId}
          stageModel={stageModel} stageModels={stageModels} stageEffort={stageEffort}
          stageBaseProviderId={stageBaseProviderId} stageBaseModel={stageBaseModel}
          updateSelectedStageRoute={updateSelectedStageRoute}
          readinessGate={readinessGate} setReadinessGate={setReadinessGate} savedGate={savedGate}
        />
      )}

      {/* Live progress */}
      {active ? (
        <div className="px-3 pb-3 border-t border-port-border pt-2">
          <div className="text-xs text-gray-300 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-port-accent" />
            {mode === 'dry-run' ? <span className="uppercase tracking-wider text-[10px] text-port-accent">dry-run</span> : null}
            {liveLabel}
          </div>
          {/* Name the provider/model this run resolved to, so an in-flight run
              (including one the scheduler started) says what it is spending on.
              A null run provider means it fell through to the active provider;
              with neither known there is nothing truthful to name, so say nothing. */}
          {runLlm?.provider || activeProviderId ? (
            <div className="mt-1 text-[11px] text-gray-500">
              create/repair on {providerModelLabel(providers, runLlm?.provider || activeProviderId, runLlm?.model)}
              {runLlm?.effort ? ` at ${runLlm.effort} effort` : ''}
              {runLlm?.judge ? (
                <> · judge/verify on {providerModelLabel(
                  providers,
                  runLlm.judge.provider || runLlm?.provider || activeProviderId,
                  runLlm.judge.model,
                )}{runLlm.judge.effort ? ` at ${runLlm.judge.effort} effort` : ''}</>
              ) : null}
            </div>
          ) : null}
          {activityLines.length ? (
            <div className="mt-2 max-h-28 overflow-y-auto text-[11px] text-gray-500 space-y-0.5">
              {activityLines.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Milestone map — the run's whole job (the plan its `start` frame
          projected) measured against where it actually is. Rendered whenever a
          plan exists, so it survives after the stream closes: a dry-run persists
          no marker and completes immediately, and a run that pauses while the
          panel is open keeps its map beside the banner. Both halves are
          in-memory on the server, so a reload after the run ended falls back to
          the copy the run stamped on its marker (#4140) — see `markerPlan`.
          Cleared when the next run starts. `planTotals` carries the #1576
          estimated cos-action budget so a large series on a small daily cap can
          see, before starting, whether it will run out before editorial; it and
          `mode` are set from the same start frame as the live `plan`, so a
          marker-drawn map (which only happens when there is no live plan) has
          neither — no estimate and no dry-run badge, both correct for a run
          that has already spent its budget. */}
      <AutopilotMilestones
        plan={mapPlan}
        planTotals={planTotals}
        progress={mapProgress}
        terminal={mapTerminal}
        dryRun={mode === 'dry-run'}
      />

      {!active ? <AutopilotStatusBanner ap={ap} /> : null}

      {/* Scheduled unattended runs (#2174) — hidden while a run is active. */}
      {!active ? (
        <SeriesAutopilotSchedule series={series} providers={providers} activeProviderId={activeProviderId} />
      ) : null}

      {/* Production readiness (canon descriptive integrity) */}
      <CanonReadinessPanel seriesId={seriesId} />
    </div>
  );
}
