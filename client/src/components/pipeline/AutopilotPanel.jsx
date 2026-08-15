import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Rocket, Loader2, X, Sliders, ShieldCheck, AlertCircle, CheckCircle2,
  PauseCircle, Play, ScanSearch, ChevronRight, ChevronDown,
} from 'lucide-react';
import toast from '../ui/Toast';
import { usePipelineProgress } from '../../hooks/usePipelineProgress';
import usePersistedOptions, { readBoolean, readInteger, readNumber } from '../../hooks/usePersistedOptions';
import {
  startPipelineAutopilot,
  cancelPipelineAutopilot,
  pausePipelineAutopilot,
  getPipelineAutopilotStatus,
  getPipelineAutopilotModelMetrics,
  pipelineAutopilotSseUrl,
  getPipelineSeriesCanonReadiness,
  getPipelineSeries,
  listPipelineIssues,
  getProviders,
  getSettings,
  patchSettingsSlice,
} from '../../services/api';
import { providerDisplayName, providerModelLabel, assignmentModelOptions, resolveSeriesRunLlm, resolveCliEffort } from '../../utils/providers';
import { autopilotStepLabel, describeAutopilotVerification, autopilotMarkerTerminal } from '../../lib/autopilotMilestones';
import Pill from '../ui/Pill';
import ProviderModelSelector from '../ProviderModelSelector';
import AutopilotMilestones from './AutopilotMilestones';
import SeriesAutopilotSchedule from './SeriesAutopilotSchedule';
import { severityColor } from './constants.js';

// Convergence-round bounds — mirror the server (seriesAutopilot.js + the
// pipelineEditorialChecks settings schema). 0 = skip that gate entirely.
const ROUND_MIN = 0;
const ROUND_MAX = 20;
const DEFAULT_ARC_ROUNDS = 3;
const DEFAULT_EDITORIAL_ROUNDS = 2;
const DEFAULT_BEAT_CONTINUITY_ROUNDS = 2;
// Editorial-checks pause threshold (#1613) — mirror the server default (0 = off).
// Unlike the round bounds it has no upper cap; a large N is effectively off.
const DEFAULT_CHECK_PAUSE_THRESHOLD = 0;
// Pause-notification escalation (#1615) — mirror the server default (on). The one
// autopilot setting that defaults ON: a zero-cost in-app banner when a run pauses.
const DEFAULT_NOTIFY_ON_PAUSE = true;
// Iterate-to-quality revision loop (#2171) — mirror the server defaults. Off by
// default (a fresh burst of judge + cut LLM spend); cycles bound the cost and the
// plateau delta is the mean-score movement below which the series counts converged.
const DEFAULT_REVISION_ENABLED = false;
const DEFAULT_REVISION_MIN_CYCLES = 1;
const DEFAULT_REVISION_MAX_CYCLES = 2;
const DEFAULT_REVISION_PLATEAU_DELTA = 0.3;
// Foundation-quality gate (#2176) — mirror the server defaults. The gate itself
// defaults ON (the point of the phase); the weighted [0,10] threshold the
// foundation must clear before drafting mirrors autonovel's 7.5 bar; the improve
// loop is bounded by MAX_FOUNDATION_ROUNDS (3).
const DEFAULT_FOUNDATION_GATE = true;
const DEFAULT_FOUNDATION_THRESHOLD = 7.5;
const DEFAULT_FOUNDATION_ROUNDS = 3;
// Pipeline self-improvement — mirror the server default (off). When on, a run
// that ends badly diagnoses whether PortOS's own automation is at fault and
// files a worktree-isolated, approval-gated CoS task against PortOS to fix it.
const DEFAULT_SELF_IMPROVE = false;
// Observing orchestrator — mirror the server default (off). When on, the run
// watches its own telemetry step by step and dispatches AUTO-APPROVED PortOS
// fix tasks (worktree + PR + review loop + merge, no human gate) as pipeline
// defects surface. Supersedes the selfImprove terminal diagnosis when both on.
const DEFAULT_OBSERVER = false;
// Evidence is collected regardless; routing stays opt-in so a series cannot
// silently switch models merely because a sample threshold was reached.
const DEFAULT_AUTO_SELECT_MODELS = false;
// Force the run's route onto stages pinned on the Prompts page — mirror the
// server default (off).
const DEFAULT_OVERRIDE_STAGE_PINS = false;
const AUTOPILOT_LLM_STAGES = [
  ['characterFoundation', 'Character foundation'],
  ['generateArc', 'Generate arc'],
  ['repairArcStructure', 'Repair arc structure'],
  ['verifyArcSpine', 'Verify arc spine'],
  ['generateEpisodes', 'Generate episodes'],
  ['foundationGate', 'Foundation quality gate'],
  ['verifyArc', 'Verify arc'],
  ['beatSheet', 'Beat sheets'],
  ['beatContinuity', 'Beat continuity'],
  ['textStages', 'Draft text stages'],
  ['scriptVerify', 'Verify scripts'],
  ['editorialReview', 'Editorial review'],
  ['reverseOutline', 'Reverse outline'],
  ['editorialChecks', 'Editorial checks'],
  ['revisionCycle', 'Revision cycle'],
  ['produceTeaser', 'Produce teaser'],
];
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
const READINESS_GATE_LABELS = {
  noOpenHigh: 'No open High findings',
  noOpenHighOrMedium: 'No open High or Medium (strict)',
  none: 'None — skip the health gate',
};
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
    defaultValue: DEFAULT_ARC_ROUNDS,
    read: readInteger,
    clamp: (v) => clampRound(v, DEFAULT_ARC_ROUNDS),
  },
  maxEditorialRounds: {
    defaultValue: DEFAULT_EDITORIAL_ROUNDS,
    read: readInteger,
    clamp: (v) => clampRound(v, DEFAULT_EDITORIAL_ROUNDS),
  },
  maxBeatContinuityRounds: {
    defaultValue: DEFAULT_BEAT_CONTINUITY_ROUNDS,
    read: readInteger,
    clamp: (v) => clampRound(v, DEFAULT_BEAT_CONTINUITY_ROUNDS),
  },
  // #1613 — non-negative integer, no upper cap (0 = off).
  checkFindingsPauseThreshold: {
    defaultValue: DEFAULT_CHECK_PAUSE_THRESHOLD,
    read: readInteger,
    clamp: clampThreshold,
  },
  // #1615 — plain boolean, no clamp. Defaults ON.
  notifyOnPause: {
    defaultValue: DEFAULT_NOTIFY_ON_PAUSE,
    read: readBoolean,
    persistOnEdit: true,
  },
  // #2171 — revision loop: enable checkbox + cycle bounds + plateau delta.
  revisionEnabled: {
    defaultValue: DEFAULT_REVISION_ENABLED,
    read: readBoolean,
    persistOnEdit: true,
  },
  revisionMinCycles: {
    defaultValue: DEFAULT_REVISION_MIN_CYCLES,
    read: readInteger,
    clamp: (v) => clampCycles(v, DEFAULT_REVISION_MIN_CYCLES),
  },
  revisionMaxCycles: {
    defaultValue: DEFAULT_REVISION_MAX_CYCLES,
    read: readInteger,
    clamp: (v) => clampCycles(v, DEFAULT_REVISION_MAX_CYCLES),
  },
  revisionPlateauDelta: {
    defaultValue: DEFAULT_REVISION_PLATEAU_DELTA,
    read: readNumber,
    clamp: (v) => clampDelta(v, DEFAULT_REVISION_PLATEAU_DELTA),
  },
  // #2176 — foundation gate (defaults ON) + weighted threshold + round bound.
  foundationGate: {
    defaultValue: DEFAULT_FOUNDATION_GATE,
    read: readBoolean,
    persistOnEdit: true,
  },
  foundationThreshold: {
    defaultValue: DEFAULT_FOUNDATION_THRESHOLD,
    read: readNumber,
    clamp: (v) => clampFoundationThreshold(v, DEFAULT_FOUNDATION_THRESHOLD),
  },
  maxFoundationRounds: {
    defaultValue: DEFAULT_FOUNDATION_ROUNDS,
    read: readInteger,
    clamp: (v) => clampRound(v, DEFAULT_FOUNDATION_ROUNDS),
  },
  // Pipeline self-improvement — boolean, off by default.
  selfImprove: {
    defaultValue: DEFAULT_SELF_IMPROVE,
    read: readBoolean,
    persistOnEdit: true,
  },
  // Observing orchestrator — boolean, off by default. Persisted like selfImprove:
  // a scheduled unattended run is exactly where the user wants the pipeline
  // hardening itself.
  observer: {
    defaultValue: DEFAULT_OBSERVER,
    read: readBoolean,
    persistOnEdit: true,
  },
  autoSelectModels: {
    defaultValue: DEFAULT_AUTO_SELECT_MODELS,
    read: readBoolean,
    persistOnEdit: true,
  },
  overrideStagePins: {
    defaultValue: DEFAULT_OVERRIDE_STAGE_PINS,
    read: readBoolean,
    persistOnEdit: true,
  },
};

// A single numeric field for the Options popover (round bounds + the pause
// threshold). Allows '' mid-edit (so the field can be cleared) and clamps +
// persists the chosen value on blur — but ONLY when the user actually changed it.
// A bare focus+blur (tabbing through Options) must not persist the display
// fallback or mark the field dirty, or it would clobber a saved limit before
// settings load and block the load from applying it. `max` caps the input (null =
// uncapped). `settingKey` / `value` / `setValue` / `clamp` / `persist` come from
// the option registry's `inputProps(key)` — the clamp is the option's own, so
// what a blur saves is exactly what a run sends.
function RoundInput({ id, label, settingKey, value, setValue, persist, max = ROUND_MAX, clamp, min = ROUND_MIN, step }) {
  const dirtyRef = useRef(false);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-gray-300">{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max ?? undefined}
        step={step ?? undefined}
        value={value}
        onChange={(e) => { dirtyRef.current = true; setValue(e.target.value === '' ? '' : Number(e.target.value)); }}
        onBlur={() => {
          if (!dirtyRef.current) return; // untouched — don't persist/clamp/mark dirty
          dirtyRef.current = false;
          const v = clamp(value);
          setValue(v);
          persist({ [settingKey]: v });
        }}
        className="w-16 px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-gray-200"
      />
    </div>
  );
}

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

// Pause kinds worth calling out beside the status line — the ones where "Paused"
// alone doesn't tell the user what state the draft is in. A kind with no entry
// (maxRounds, childFailed, planningOscillation) is fully explained by the reason
// text below it.
const PAUSE_BADGES = {
  divergence: {
    label: 'not converging',
    title: 'Auto-resolve stopped reducing blocking findings — needs a human edit, not more rounds',
  },
  regression: {
    label: 'round reverted',
    title: 'An auto-resolve round left more blocking findings than it was given — its edits were reverted and the draft is back to its pre-round state',
  },
  checkFindings: {
    label: 'high findings',
    title: 'Editorial checks surfaced too many High findings — address them (or raise the threshold) and resume',
  },
  providerFailed: {
    label: 'provider failed',
    title: 'An AI repair call failed outright (provider timeout, dead CLI, rate limit) — the run kept everything it had finished; resume to retry, or switch the provider/model first',
  },
  inapplicable: {
    label: 'nothing to fix',
    title: "The owning service had nothing it was allowed to change — no linked universe, or every target is locked. Auto-resolve can't proceed without a human edit",
  },
  budget: {
    label: 'budget reached',
    title: 'The daily spend cap was reached mid-run — the run stopped where it was and resumes once the budget resets or is raised',
  },
};

// #1572 — shared caution tail for a `done` run that filed blocking script-craft
// gaps, so the completion toast and the persisted-status banner can't drift.
const craftGapCaution = (n) => `${n} filed script-craft gap${n === 1 ? '' : 's'} — resolve before rendering`;
// #1573 — a `done` run where an editorial check threw never evaluated that
// dimension, so "complete" is qualified rather than "production-ready".
const editorialCheckCaution = (n) => `${n} editorial check${n === 1 ? '' : 's'} errored — review before trusting "clean"`;

// One line for a pipeline self-improvement verdict, shared by the run-ended
// toast and the persisted-marker banner so the two can't drift. Null when the
// pass didn't run or found nothing worth filing — there's nothing to say then.
function selfImproveLine(si) {
  if (!si || si.verdict !== 'pipeline') return null;
  const what = si.title ? `: ${si.title}` : '';
  if (si.duplicate) return `Pipeline fix already tracked (${si.area})${what}`;
  if (!si.filed) return `Pipeline defect diagnosed (${si.area})${what} — filing it failed`;
  return `Filed a PortOS fix task (${si.area})${what} — approve it in CoS to start the work`;
}

// One line for the observing orchestrator's run summary, shared by the run-ended
// toast and the persisted-marker banner so the two can't drift. Null when the
// observer dispatched nothing — there's nothing to say then.
function observerLine(ob) {
  const n = ob?.filed?.length || 0;
  if (n === 0) return null;
  const fresh = ob.filed.filter((f) => f.filed).length;
  if (fresh === 0) return `Orchestrator: ${n} pipeline fix${n === 1 ? '' : 'es'} already tracked in CoS`;
  return `Orchestrator dispatched ${fresh} pipeline fix${fresh === 1 ? '' : 'es'} — PRs will review and merge on their own`;
}

function Findings({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-1.5 mt-2">
      {items.map((f, i) => (
        <li key={i} className={`text-xs p-2 rounded border ${severityColor(f.severity)}`}>
          <div className="flex items-center gap-2">
            <AlertCircle size={12} />
            <span className="uppercase tracking-wider font-semibold">{f.severity || 'note'}</span>
            {f.location ? <span className="text-gray-500">— {f.location}</span> : null}
          </div>
          <p className="text-gray-200 mt-0.5">{f.problem}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Series-level autonomous-mode control: launch / cancel / live progress, a
 * resume-or-paused banner driven by the persisted `series.autopilot` marker,
 * and a production-readiness (canon descriptive-integrity) check.
 */
export default function AutopilotPanel({ series, onSeriesUpdate, onIssuesUpdate }) {
  const seriesId = series?.id;
  const [active, setActive] = useState(false);
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
  // patchSettingsSlice is a GET-merge-PUT, so two overlapping calls (a blur save
  // racing start()'s save) can lose an update — a slow earlier PUT lands after a
  // newer one and clobbers it. Serialize every write onto one tail promise so the
  // cycles can't interleave; start() awaiting its own enqueued write transitively
  // awaits any in-flight blur save. Returns the promise so start() can await it.
  const persistTailRef = useRef(Promise.resolve());
  const persistRounds = useCallback((patch) => {
    const next = persistTailRef.current
      .catch(() => {})
      .then(() => patchSettingsSlice('pipelineEditorialChecks', patch, { silent: true }).catch(() => null));
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
  const [canon, setCanon] = useState(null);
  const [canonLoading, setCanonLoading] = useState(false);
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

  // A cooperative cancel persists every non-destructive run-local LLM choice.
  // Restore those choices on Resume so a model experiment does not silently
  // collapse back to the series default after a pause/restart.
  useEffect(() => {
    const paused = series?.autopilot?.status === 'paused';
    const resume = paused ? series?.autopilot?.resumeOptions : null;
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
  // A pin naming a provider that is gone or disabled is a SOFT default server
  // side — the run quietly falls back to the active provider. Say so rather than
  // asserting a provider that won't run (only once the list has loaded, or a
  // slow fetch would flash the warning on a perfectly good pin).
  const effProvider = providers.find((p) => p.id === effProviderId);
  const effProviderUnavailable = !!effProviderId && providers.length > 0
    && (!effProvider || effProvider.enabled === false);
  const providerModels = useMemo(
    () => assignmentModelOptions(null, providers, effProviderId),
    [providers, effProviderId],
  );
  // What the picked effort ACTUALLY runs as: the server clamps a level the
  // resolved provider/model doesn't offer down its ladder, and emits no flag at
  // all for a provider with no effort control. Naming the clamped value (rather
  // than the raw pick) keeps the copy honest — the same rule EffortSelect uses
  // for its out-of-ladder option.
  const effectiveEffort = resolveCliEffort(effortOverride, effProvider, effModel);
  const judgeProviderId = judgeProviderOverride || effProviderId;
  const judgeModel = judgeModelOverride
    || ((!judgeProviderOverride || judgeProviderOverride === effProviderId) ? effModel : '');
  const judgeProvider = providers.find((p) => p.id === judgeProviderId);
  const judgeModels = useMemo(
    () => assignmentModelOptions(null, providers, judgeProviderId),
    [providers, judgeProviderId],
  );
  const judgeEffort = resolveCliEffort(
    judgeEffortOverride || effortOverride,
    judgeProvider,
    judgeModel,
  );
  const selectedStageRoute = stageLlm?.[selectedStageLlm]?.[selectedStageRole] || {};
  const stageBaseProviderId = selectedStageRole === 'judge' ? judgeProviderId : effProviderId;
  const stageBaseModel = selectedStageRole === 'judge' ? judgeModel : effModel;
  const stageBaseEffort = selectedStageRole === 'judge'
    ? (judgeEffortOverride || effortOverride)
    : effortOverride;
  const stageProviderId = selectedStageRoute.providerOverride || stageBaseProviderId;
  const stageModel = selectedStageRoute.modelOverride
    || ((!selectedStageRoute.providerOverride || selectedStageRoute.providerOverride === stageBaseProviderId)
      ? stageBaseModel
      : '');
  const stageProvider = providers.find((p) => p.id === stageProviderId);
  const stageModels = useMemo(
    () => assignmentModelOptions(null, providers, stageProviderId),
    [providers, stageProviderId],
  );
  const stageEffort = resolveCliEffort(
    selectedStageRoute.effortOverride || stageBaseEffort,
    stageProvider,
    stageModel,
  );
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

  // One backward walk per frame batch yields everything the live section needs:
  // the newest `progress` frame (the milestone map's cursor) and the last few
  // labelled frames (the activity log, whose last line is also the status line).
  // Walking backward and stopping early matters — `frames` is uncapped, so
  // labelling the whole array on every arriving frame is quadratic over a run.
  const { snapshot, activityLines } = useMemo(() => {
    const lines = [];
    let found = null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const f = frames[i];
      if (!found && f?.type === 'progress') found = f;
      if (lines.length < ACTIVITY_LINES) {
        const label = frameLabel(f);
        if (label) lines.unshift(label);
      } else if (found) break;
    }
    return { snapshot: found, activityLines: lines };
  }, [frames]);
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
    getPipelineAutopilotStatus(seriesId, { silent: true })
      .then((s) => {
        if (canceled || !s?.active) return;
        activeRunIdRef.current = s.autopilot?.runId || null;
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
  }, [seriesId, applyStartFrame]);

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
      else toast.success('Autopilot complete — draft is production-ready');
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
    const res = await startPipelineAutopilot(seriesId, { includeVisual, fileGaps, ...roundOverrides, ...gateOverride, ...unlockOverride, ...llmOverride }, { silent: true })
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
    setActive(true);
    // `options` is the single dep for every persisted option — the registry reads
    // live values through refs, so no option can be forgotten here.
  }, [seriesId, includeVisual, fileGaps, unlockForRun, readinessGate, providerOverride, modelOverride, effortOverride, separateJudgeLlm, judgeProviderOverride, judgeModelOverride, judgeEffortOverride, stageLlm, options, persistRounds]);

  const cancel = useCallback(async () => {
    setPausePending(false);
    await cancelPipelineAutopilot(seriesId).catch(() => null);
  }, [seriesId]);

  const pause = useCallback(async () => {
    const result = await pausePipelineAutopilot(seriesId).catch(() => null);
    setPausePending(result?.pauseRequested === true);
  }, [seriesId]);

  const checkCanon = useCallback(async () => {
    setCanonLoading(true);
    const report = await getPipelineSeriesCanonReadiness(seriesId, { silent: true })
      .catch((err) => { toast.error(err.message || 'Canon check failed'); return null; });
    setCanonLoading(false);
    if (report) setCanon(report);
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

  return (
    <div className="border border-port-border rounded-lg bg-port-card/40">
      <div className="flex items-center gap-2 flex-wrap p-3">
        <Rocket size={15} className="text-port-accent" />
        <span className="text-sm font-medium text-white">Autonomous mode</span>
        <span className="text-xs text-gray-500">drives every missing step to a production-ready draft</span>

        <div className="ml-auto flex items-center gap-2">
          {!active ? (
            <>
              <button
                type="button"
                onClick={() => setShowOpts((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40"
                title="Run options"
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
      {showOpts && !active ? (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t border-port-border pt-3">
          {/* Which AI actually runs. The panel used to name none of this, so the
              only way to know what a run would spend on was to read the code. */}
          <div className="rounded-lg border border-port-border bg-port-bg/60 p-2.5 flex flex-col gap-2">
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Creation and repair call{' '}
              <span className="text-gray-200 font-medium">{providerModelLabel(providers, effProviderId, effModel)}</span>
              {effectiveEffort ? (
                <> at <span className="text-gray-200 font-medium">{effectiveEffort}</span> reasoning effort</>
              ) : null}
              {separateJudgeLlm ? (
                <>
                  ; judging and verification call{' '}
                  <span className="text-gray-200 font-medium">{providerModelLabel(providers, judgeProviderId, judgeModel)}</span>
                  {judgeEffort ? (
                    <> at <span className="text-gray-200 font-medium">{judgeEffort}</span> reasoning effort</>
                  ) : null}
                </>
              ) : null}
              . Stages pinned in{' '}
              <Link to="/prompts" className="text-port-accent hover:underline">Prompts</Link>{' '}
              {opt.overrideStagePins ? 'are overridden for this run' : 'keep their own provider/model/effort'}
              {effectiveEffort ? '.' : (
                <>; reasoning effort comes from the provider&apos;s config on{' '}
                  <Link to="/ai" className="text-port-accent hover:underline">AI Providers</Link>.
                </>
              )}
            </p>
            {effProviderUnavailable ? (
              <p className="text-[11px] text-port-warning">
                That provider is disabled or missing — the run falls back to{' '}
                {providerDisplayName(providers, activeProviderId, 'the active provider')}.
              </p>
            ) : null}
            <div className="max-w-md">
              <ProviderModelSelector
                providers={providers}
                selectedProviderId={providerOverride}
                effectiveProviderId={effProviderId}
                selectedModel={modelOverride}
                availableModels={providerModels}
                onProviderChange={(id) => { setProviderOverride(id); setModelOverride(''); setEffortOverride(''); }}
                onModelChange={setModelOverride}
                effort={effortOverride}
                onEffortChange={setEffortOverride}
                label="Override provider for this run"
                compact
                alwaysShowModel
                emptyProviderOption={`Series default (${providerDisplayName(providers, seriesProviderId || activeProviderId, '—')})`}
                emptyModelOption={inheritedModel ? `Series default (${inheritedModel})` : 'Default model'}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-300 pt-1">
              <input
                type="checkbox"
                checked={opt.overrideStagePins}
                onChange={(e) => options.edit('overrideStagePins', e.target.checked)}
              />
              Use this provider and model for every stage (ignore Prompts stage pins)
            </label>
            {opt.overrideStagePins ? (
              <p className="text-[11px] text-gray-500 pl-5">
                Stages that pin their own provider, model id, reasoning effort or judge in{' '}
                <Link to="/prompts" className="text-port-accent hover:underline">Prompts</Link>{' '}
                run on this route instead, so the whole pipeline — script verification included — stays on one provider.
                A stage pinned to a local provider to keep manuscript text off the network loses that too.
                Stage <em>tiers</em> (quick / coding / heavy) still apply when you leave the model blank,
                and the judge and per-stage routes below still win where you set them.
              </p>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-gray-300 pt-1">
              <input
                type="checkbox"
                checked={separateJudgeLlm}
                onChange={(e) => setSeparateJudgeLlm(e.target.checked)}
              />
              Use a separate model for judging and verification
            </label>
            {separateJudgeLlm ? (
              <div className="max-w-md pl-5">
                <ProviderModelSelector
                  providers={providers}
                  selectedProviderId={judgeProviderOverride}
                  effectiveProviderId={judgeProviderId}
                  selectedModel={judgeModelOverride}
                  availableModels={judgeModels}
                  onProviderChange={(id) => {
                    setJudgeProviderOverride(id);
                    setJudgeModelOverride('');
                    setJudgeEffortOverride('');
                  }}
                  onModelChange={setJudgeModelOverride}
                  effort={judgeEffortOverride}
                  onEffortChange={setJudgeEffortOverride}
                  label="Override judge and verifier for this run"
                  compact
                  alwaysShowModel
                  emptyProviderOption={`Run default (${providerDisplayName(providers, effProviderId, '—')})`}
                  emptyModelOption={effModel ? `Run default (${effModel})` : 'Run default model'}
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  Useful for experiments such as Luna/max writing with an independent Sol/xhigh critic. Exact stage pins in Prompts still take precedence.
                </p>
              </div>
            ) : null}
            <div className="border-t border-port-border/70 pt-2 mt-1 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={editStageLlm}
                  onChange={(e) => {
                    setEditStageLlm(e.target.checked);
                    if (!e.target.checked) setStageLlm({});
                  }}
                />
                Override a specific stage and role
              </label>
              {editStageLlm ? (
                <>
                  <p className="text-[11px] text-gray-400">
                    Stage route overrides win over run-wide and learned routes for the selected role. They are restored when a run pauses.
                  </p>
                  <div className="flex flex-wrap gap-2 max-w-2xl">
                <div>
                  <label htmlFor="autopilot-stage-llm" className="block text-[11px] text-gray-400 mb-1">Stage override</label>
                  <select
                    id="autopilot-stage-llm"
                    value={selectedStageLlm}
                    onChange={(e) => setSelectedStageLlm(e.target.value)}
                    className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-200"
                  >
                    {AUTOPILOT_LLM_STAGES.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="autopilot-stage-role" className="block text-[11px] text-gray-400 mb-1">Role</label>
                  <select
                    id="autopilot-stage-role"
                    value={selectedStageRole}
                    onChange={(e) => setSelectedStageRole(e.target.value)}
                    className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-200"
                  >
                    <option value="creative">Creative / repair</option>
                    <option value="judge">Judge / verify</option>
                  </select>
                </div>
              </div>
              <div className="max-w-md">
                <ProviderModelSelector
                  providers={providers}
                  selectedProviderId={selectedStageRoute.providerOverride || ''}
                  effectiveProviderId={stageProviderId}
                  selectedModel={selectedStageRoute.modelOverride || ''}
                  availableModels={stageModels}
                  onProviderChange={(id) => updateSelectedStageRoute({
                    providerOverride: id,
                    modelOverride: '',
                    effortOverride: '',
                  })}
                  onModelChange={(model) => updateSelectedStageRoute({ modelOverride: model })}
                  effort={selectedStageRoute.effortOverride || ''}
                  onEffortChange={(effort) => updateSelectedStageRoute({ effortOverride: effort })}
                  label="Override this stage and role"
                  compact
                  alwaysShowModel
                  emptyProviderOption={`Role default (${providerDisplayName(providers, stageBaseProviderId, '—')})`}
                  emptyModelOption={stageBaseModel ? `Role default (${stageBaseModel})` : 'Role default model'}
                />
                {Object.keys(selectedStageRoute).length > 0 ? (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[11px] text-port-accent">
                      Active: {providerModelLabel(providers, stageProviderId, stageModel)}{stageEffort ? ` / ${stageEffort}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => updateSelectedStageRoute({
                        providerOverride: '', modelOverride: '', effortOverride: '',
                      })}
                      className="text-[11px] text-gray-500 hover:text-white"
                    >
                      Clear override
                    </button>
                  </div>
                ) : null}
              </div>
                </>
              ) : null}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={opt.autoSelectModels} onChange={(e) => options.edit('autoSelectModels', e.target.checked)} />
            Let autopilot choose models from stage-specific results
          </label>
          {opt.autoSelectModels ? (
            <p className="text-[11px] text-gray-500">
              Uses separate technical and quality outcomes by step, role, provider, model and effort. Historical outcomes can backfill effort when older run records lack it. A route needs at least {modelMetrics?.minimumQualitySamples ?? 2} quality-reviewed samples and a positive reliability threshold; explicit choices above and exact Prompts-stage pins still win. Current history: {modelMetrics?.evidenceRuns ?? 0} attributed run{modelMetrics?.evidenceRuns === 1 ? '' : 's'}, {modelMetrics?.metrics?.reduce((sum, metric) => sum + (metric.qualityEvaluated || 0), 0) ?? 0} quality-reviewed.
            </p>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={includeVisual} onChange={(e) => setIncludeVisual(e.target.checked)} />
            Draft cover + all interior pages (comic targets)
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={fileGaps} onChange={(e) => setFileGaps(e.target.checked)} />
            File CoS tasks for gaps it can&apos;t resolve
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={opt.notifyOnPause} onChange={(e) => options.edit('notifyOnPause', e.target.checked)} />
            Notify me when a run pauses (with a resume link)
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={opt.foundationGate} onChange={(e) => options.edit('foundationGate', e.target.checked)} />
            Judge the foundation (world / characters / arc) before drafting
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={unlockForRun} onChange={(e) => setUnlockForRun(e.target.checked)} />
            Unlock everything this series owns first (full edit control)
          </label>
          {unlockForRun ? (
            <p className="text-[11px] text-gray-500">
              Clears the arc freeze, arc-field locks, volume locks and issue stage locks — so the run can actually apply the fixes its editorial passes find. Universe canon is only unlocked when this is the universe&apos;s <em>only</em> series: once another series shares the universe, its cast and setting stay locked, because a character this series introduced may well be one the other series is built on. Nothing is ever deleted: characters, objects and volumes can be rewritten in full but stay in the Universe and the Catalog. Locks are <em>not</em> restored when the run ends. Applies to this run only — it is never saved as a default and the box clears itself after you launch, so a scheduled or repeat run can&apos;t inherit it.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-4 pt-1">
            <RoundInput
              id="autopilot-arc-rounds"
              label="Arc verify rounds"
              {...options.inputProps('maxArcVerifyRounds')}
            />
            <RoundInput
              id="autopilot-beat-continuity-rounds"
              label="Beat continuity rounds"
              {...options.inputProps('maxBeatContinuityRounds')}
            />
            <RoundInput
              id="autopilot-editorial-rounds"
              label="Editorial rounds"
              {...options.inputProps('maxEditorialRounds')}
            />
          </div>
          <p className="text-[11px] text-gray-500">
            How many auto-resolve rounds each gate attempts before pausing for human review (0 skips the gate, max {ROUND_MAX}). Saved as the default and reused on Resume.
          </p>
          {opt.foundationGate ? (
            <>
              <div className="flex flex-wrap gap-4 pt-1">
                <RoundInput
                  id="autopilot-foundation-threshold"
                  label="Foundation threshold"
                  {...options.inputProps('foundationThreshold')}
                  max={10}
                />
                <RoundInput
                  id="autopilot-foundation-rounds"
                  label="Foundation rounds"
                  {...options.inputProps('maxFoundationRounds')}
                />
              </div>
              <p className="text-[11px] text-gray-500">
                Weighted quality bar (0–10: worldbuilding 40%, character 30%, structure 20%, craft 10%) the foundation must clear before drafting; the run repairs the largest weighted deficit up to the round limit, then pauses for review.
              </p>
            </>
          ) : null}
          <div className="flex items-center gap-2 pt-1">
            <label htmlFor="autopilot-readiness-gate" className="text-xs text-gray-300">Readiness gate</label>
            <select
              id="autopilot-readiness-gate"
              value={readinessGate}
              onChange={(e) => setReadinessGate(e.target.value)}
              className="px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-gray-200"
            >
              <option value="">
                Use saved default{savedGate ? ` (${READINESS_GATE_LABELS[savedGate]})` : ''}
              </option>
              {Object.entries(READINESS_GATE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-gray-500">
            The editorial-health bar this run must clear before drafting visuals. A per-run choice applies to this run only — it does not change the saved default.
          </p>
          <div className="pt-1">
            <RoundInput
              id="autopilot-check-pause-threshold"
              label="Pause at high findings"
              {...options.inputProps('checkFindingsPauseThreshold')}
              max={null}
            />
          </div>
          <p className="text-[11px] text-gray-500">
            When the editorial-checks pass surfaces this many High findings (or more), the run pauses for review instead of proceeding. 0 = off. Saved as the default and reused on Resume.
          </p>
          <label className="flex items-center gap-2 text-xs text-gray-300 pt-1 border-t border-port-border mt-1">
            <input type="checkbox" checked={opt.revisionEnabled} onChange={(e) => options.edit('revisionEnabled', e.target.checked)} />
            Iterate to quality (revise the weakest issue under a keep/revert score gate)
          </label>
          {opt.revisionEnabled ? (
            <>
              <div className="flex flex-wrap gap-4 pt-1">
                <RoundInput
                  id="autopilot-revision-min-cycles"
                  label="Min cycles"
                  {...options.inputProps('revisionMinCycles')}
                  min={1}
                />
                <RoundInput
                  id="autopilot-revision-max-cycles"
                  label="Max cycles"
                  {...options.inputProps('revisionMaxCycles')}
                  min={1}
                />
                <RoundInput
                  id="autopilot-revision-plateau-delta"
                  label="Plateau Δ"
                  {...options.inputProps('revisionPlateauDelta')}
                  min={0}
                  max={10}
                  step={0.1}
                />
              </div>
              <p className="text-[11px] text-gray-500">
                After the editorial-health gate, judge every drafted issue and revise the weakest via adversarial cuts, keeping a change only when the quality score doesn&apos;t regress. Stops on plateau (mean score moves less than Δ), hedged-convergence, or max cycles. Fresh judge + cut LLM spend — saved as the default and reused on Resume.
              </p>
            </>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-gray-300 pt-1 border-t border-port-border mt-1">
            <input type="checkbox" checked={opt.selfImprove} onChange={(e) => options.edit('selfImprove', e.target.checked)} />
            Improve the pipeline itself (diagnose PortOS when a run goes wrong)
          </label>
          {opt.selfImprove ? (
            <p className="text-[11px] text-gray-500">
              When a run pauses, errors, or finishes with an editorial check that threw or a step that had to be retried, it spends one call asking whether the fault is the <em>story</em> or the <em>pipeline</em> — a missing editorial step earlier in the process, a stage prompt breaking its contract, a runner swallowing a failure. A pipeline verdict files a CoS task against PortOS itself: worktree-isolated, PR-opening, and waiting in your CoS approval queue — it never starts on its own. A healthy run never spends anything here. Saved as the default and reused on Resume.
            </p>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-gray-300 pt-1">
            <input type="checkbox" checked={opt.observer} onChange={(e) => options.edit('observer', e.target.checked)} />
            Observing orchestrator (auto-fix the pipeline as the run progresses)
          </label>
          {opt.observer ? (
            <p className="text-[11px] text-gray-500">
              An orchestrator watches the run step by step. When a step&apos;s telemetry says the automation misbehaved — a retried child, a skipped step, a check that threw, a filed gap — it diagnoses what in PortOS should change (step ordering, missing steps, editorial checks, prompts, gates, even missing options) and <strong>dispatches the fix immediately</strong>: an auto-approved CoS task that works in a worktree, opens a PR, and merges after the review loop with no approval step. Enabling this is your standing consent for those unattended changes. Bounded passes per run, budget-gated, higher confidence bar than the diagnosis above (which this supersedes at the run&apos;s end). Saved as the default and reused on Resume — including scheduled runs.
            </p>
          ) : null}
          <p className="text-[11px] text-gray-500">
            Runs under the CoS auto-run autonomy domain. With it set to <em>dry-run</em>, this only previews the plan.
          </p>
        </div>
      ) : null}

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

      {/* Persisted status banner (paused / done / error). A `done` run that
          filed blocking script-craft gaps (#1572) is shown as a caution, not
          "production-ready" — those gaps still block downstream rendering. */}
      {!active && ap && ap.status && ap.status !== 'idle' && ap.status !== 'running' ? (() => {
        const doneWithGaps = ap.status === 'done' && ap.craftGapIssues > 0;
        // #1573 — a done run with errored editorial checks is a caution too (the
        // craft-gap message takes precedence when both are present).
        const doneWithCheckErrors = ap.status === 'done' && !doneWithGaps && ap.editorialCheckErrors > 0;
        const tone = ap.status === 'paused' || doneWithGaps || doneWithCheckErrors ? 'warning' : ap.status === 'error' ? 'error' : 'success';
        const siLine = selfImproveLine(ap.selfImprove);
        const obLine = observerLine(ap.observer);
        return (
        <div className={`px-3 pb-3 border-t pt-2 ${tone === 'warning' ? 'border-port-warning/30' : tone === 'error' ? 'border-port-error/30' : 'border-port-success/30'}`}>
          <div className="flex items-center gap-2 text-xs">
            {ap.status === 'paused' ? <PauseCircle size={13} className="text-port-warning" />
              : doneWithGaps || doneWithCheckErrors ? <AlertCircle size={13} className="text-port-warning" />
                : ap.status === 'done' ? <CheckCircle2 size={13} className="text-port-success" />
                  : <AlertCircle size={13} className="text-port-error" />}
            <span className={tone === 'warning' ? 'text-port-warning' : tone === 'success' ? 'text-port-success' : 'text-port-error'}>
              {ap.status === 'paused' ? (ap.currentStep ? `Paused at ${stepLabel(ap.currentStep)}` : 'Paused')
                : doneWithGaps ? `Completed with ${craftGapCaution(ap.craftGapIssues)}`
                  : doneWithCheckErrors ? `Completed — ${editorialCheckCaution(ap.editorialCheckErrors)}`
                    : ap.status === 'done' ? 'Last run completed — draft is production-ready' : 'Last run errored'}
            </span>
            {ap.status === 'paused' && PAUSE_BADGES[ap.pauseKind] ? (
              <Pill tone="warning" size="xs" title={PAUSE_BADGES[ap.pauseKind].title}>
                {PAUSE_BADGES[ap.pauseKind].label}
              </Pill>
            ) : null}
          </div>
          {ap.lastError && ap.status !== 'done' ? <p className="text-[11px] text-gray-400 mt-1">{ap.lastError}</p> : null}
          {/* Pipeline self-improvement verdict for that run — the run's trouble
              was the automation, and a PortOS fix task exists for it. */}
          {siLine ? <p className="text-[11px] text-port-accent mt-1">🔧 {siLine}</p> : null}
          {/* Observing-orchestrator summary — fixes are already dispatched and
              merging on their own; list what was filed. */}
          {obLine ? (
            <div className="mt-1">
              <p className="text-[11px] text-port-accent">👁️ {obLine}</p>
              {ap.observer.filed.map((f, i) => (
                <p key={i} className="text-[11px] text-gray-500 ml-4">{f.area}{f.title ? ` — ${f.title}` : ''}</p>
              ))}
            </div>
          ) : null}
          <Findings items={ap.residualFindings} />
          {/* Collapsed: the restored set above is the actual work queue, while
              these are what the rewound round produced — context for judging
              whether the rollback was the right call, not tasks to act on. */}
          {ap.discardedFindings?.length ? (
            <details className="mt-2 group">
              <summary className="cursor-pointer list-none flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300">
                <ChevronRight size={11} className="group-open:hidden" />
                <ChevronDown size={11} className="hidden group-open:inline" />
                Discarded — what the reverted round produced ({ap.discardedFindings.length})
              </summary>
              <Findings items={ap.discardedFindings} />
            </details>
          ) : null}
        </div>
        );
      })() : null}

      {/* Scheduled unattended runs (#2174) — hidden while a run is active. */}
      {!active ? (
        <SeriesAutopilotSchedule series={series} providers={providers} activeProviderId={activeProviderId} />
      ) : null}

      {/* Production readiness (canon descriptive integrity) */}
      <div className="px-3 pb-3 border-t border-port-border pt-2">
        <div className="flex items-center gap-2">
          <ShieldCheck size={13} className="text-gray-400" />
          <span className="text-xs text-gray-300">Production readiness — are all drawn characters/places/objects described?</span>
          <button
            type="button"
            onClick={checkCanon}
            disabled={canonLoading}
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40"
          >
            {canonLoading ? <Loader2 size={12} className="animate-spin" /> : <ScanSearch size={12} />}
            Check
          </button>
        </div>
        {canon ? (
          canon.ready ? (
            <p className="mt-2 text-xs text-port-success flex items-center gap-1.5">
              <CheckCircle2 size={12} /> Every noun that gets drawn has a description.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-port-warning">
                {canon.undescribed.length} noun(s) appear where they&apos;d be drawn but have no description — fix before generating art:
              </p>
              {canon.blockingIssues.map((bi) => (
                <div key={bi.issueId} className="text-xs">
                  <Link to={`/pipeline/issues/${bi.issueId}/nouns`} className="text-port-accent hover:underline">
                    #{bi.number} {bi.title || ''} →
                  </Link>
                  <span className="text-gray-400"> {bi.none.map((n) => `${n.name} (${n.kind})`).join(', ')}</span>
                </div>
              ))}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
