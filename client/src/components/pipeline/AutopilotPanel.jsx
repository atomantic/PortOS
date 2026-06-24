import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Rocket, Loader2, X, Sliders, ShieldCheck, AlertCircle, CheckCircle2,
  PauseCircle, Play, ScanSearch, ChevronRight,
} from 'lucide-react';
import toast from '../ui/Toast';
import { usePipelineProgress } from '../../hooks/usePipelineProgress';
import {
  startPipelineAutopilot,
  cancelPipelineAutopilot,
  getPipelineAutopilotStatus,
  pipelineAutopilotSseUrl,
  getPipelineSeriesCanonReadiness,
  getPipelineSeries,
  listPipelineIssues,
  getSettings,
  patchSettingsSlice,
} from '../../services/api';

// Convergence-round bounds — mirror the server (seriesAutopilot.js + the
// pipelineEditorialChecks settings schema). 0 = skip that gate entirely.
const ROUND_MIN = 0;
const ROUND_MAX = 20;
const DEFAULT_ARC_ROUNDS = 3;
const DEFAULT_EDITORIAL_ROUNDS = 2;
const DEFAULT_BEAT_CONTINUITY_ROUNDS = 2;
const clampRound = (n, fallback) => {
  // A blank/cleared field falls back to the default — NOT 0. (Number('') === 0,
  // and 0 means "skip the gate", so without this a cleared input would silently
  // disable a verification gate.) An explicitly typed 0 is still honored.
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(ROUND_MIN, Math.min(ROUND_MAX, Math.round(v)));
};

// A single convergence-round field for the Options popover. Allows '' mid-edit
// (so the field can be cleared) and clamps + persists the chosen value on blur —
// but ONLY when the user actually changed it. A bare focus+blur (tabbing through
// Options) must not persist the display fallback or mark the field dirty, or it
// would clobber a saved limit before settings load and block the load from
// applying it.
function RoundInput({ id, label, settingKey, value, setValue, defaultValue, persist }) {
  const dirtyRef = useRef(false);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-gray-300">{label}</label>
      <input
        id={id}
        type="number"
        min={ROUND_MIN}
        max={ROUND_MAX}
        value={value}
        onChange={(e) => { dirtyRef.current = true; setValue(e.target.value === '' ? '' : Number(e.target.value)); }}
        onBlur={() => {
          if (!dirtyRef.current) return; // untouched — don't persist/clamp/mark dirty
          dirtyRef.current = false;
          const v = clampRound(value, defaultValue);
          setValue(v);
          persist({ [settingKey]: v });
        }}
        className="w-16 px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-gray-200"
      />
    </div>
  );
}

const SEVERITY_COLORS = {
  high: 'text-port-error border-port-error/40 bg-port-error/10',
  medium: 'text-port-warning border-port-warning/40 bg-port-warning/10',
  low: 'text-gray-400 border-gray-500/30 bg-gray-700/20',
};

// Human labels for each conductor step kind (matches seriesAutopilot.js).
const STEP_LABELS = {
  generateArc: 'Generating arc',
  generateEpisodes: 'Generating episodes',
  verifyArc: 'Verifying arc',
  beatSheet: 'Generating beat sheets',
  textStages: 'Writing prose + scripts',
  scriptVerify: 'Verifying scripts',
  editorialReview: 'Editorial review',
  reverseOutline: 'Refreshing scene segmentation',
  canonVerify: 'Checking canon descriptions',
  visualDraft: 'Drafting comic art',
};

const stepLabel = (kind) => STEP_LABELS[kind] || kind;

// Turn an SSE frame into a one-line status string.
function frameLabel(f) {
  if (!f) return null;
  switch (f.type) {
    case 'start': return f.mode === 'dry-run' ? 'Planning (dry-run)…' : 'Starting…';
    case 'note': return f.message;
    case 'step:start': return `${stepLabel(f.kind)}…`;
    case 'step:complete': return `${stepLabel(f.kind)} done`;
    case 'step:skip': return `Skipped ${stepLabel(f.kind)}${f.reason ? ` — ${f.reason}` : ''}`;
    case 'verify:round': return `${f.scope} check — ${f.blocking} blocking of ${f.findings} finding(s)`;
    case 'render:queued': return `Queued draft render: ${f.target}`;
    case 'gap:filed': return `Filed CoS task (${f.gapKind})`;
    case 'paused': return `Paused — ${f.reason}`;
    case 'complete': return f.dryRun ? 'Plan ready' : 'Complete';
    case 'canceled': return 'Canceled';
    case 'error': return `Failed — ${f.error}`;
    default: return f.type;
  }
}

const RUN_ENDED = new Set(['complete', 'canceled', 'error', 'paused']);

// #1572 — shared caution tail for a `done` run that filed blocking script-craft
// gaps, so the completion toast and the persisted-status banner can't drift.
const craftGapCaution = (n) => `${n} filed script-craft gap${n === 1 ? '' : 's'} — resolve before rendering`;

function Findings({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-1.5 mt-2">
      {items.map((f, i) => (
        <li key={i} className={`text-xs p-2 rounded border ${SEVERITY_COLORS[f.severity] || SEVERITY_COLORS.medium}`}>
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
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState(null);
  const [plan, setPlan] = useState(null);
  const [showOpts, setShowOpts] = useState(false);
  const [includeVisual, setIncludeVisual] = useState(true);
  const [fileGaps, setFileGaps] = useState(false);
  const [arcRounds, setArcRounds] = useState(DEFAULT_ARC_ROUNDS);
  const [editorialRounds, setEditorialRounds] = useState(DEFAULT_EDITORIAL_ROUNDS);
  const [beatContinuityRounds, setBeatContinuityRounds] = useState(DEFAULT_BEAT_CONTINUITY_ROUNDS);
  // Per-field dirty flags. Until a field is edited its input shows a display
  // default we must NOT persist (that would clobber a higher saved setting on
  // the untouched gate). Tracked per-field so editing one gate never discards
  // the loaded value of the other. start() persists ONLY the edited fields; the
  // untouched ones keep their on-disk value via patchSettingsSlice's merge.
  const arcEditedRef = useRef(false);
  const editorialEditedRef = useRef(false);
  const beatContinuityEditedRef = useRef(false);
  const [canon, setCanon] = useState(null);
  const [canonLoading, setCanonLoading] = useState(false);

  // Load the persisted convergence-round defaults so the Options inputs reflect
  // the install's setting. The autopilot reads the same setting server-side, so
  // we never send these as per-run overrides — we just keep the UI in sync and
  // persist edits back. Apply the fetched value only to fields the user hasn't
  // already edited, so a slow load can't clobber a fast edit (per-field).
  useEffect(() => {
    let canceled = false;
    getSettings({ silent: true })
      .then((s) => {
        if (canceled) return;
        const pec = s?.pipelineEditorialChecks || {};
        if (!arcEditedRef.current) setArcRounds(Number.isInteger(pec.maxArcVerifyRounds) ? pec.maxArcVerifyRounds : DEFAULT_ARC_ROUNDS);
        if (!editorialEditedRef.current) setEditorialRounds(Number.isInteger(pec.maxEditorialRounds) ? pec.maxEditorialRounds : DEFAULT_EDITORIAL_ROUNDS);
        if (!beatContinuityEditedRef.current) setBeatContinuityRounds(Number.isInteger(pec.maxBeatContinuityRounds) ? pec.maxBeatContinuityRounds : DEFAULT_BEAT_CONTINUITY_ROUNDS);
      })
      .catch(() => null); // load failed → inputs keep defaults but start() only persists EDITED fields
    return () => { canceled = true; };
  }, []);

  // Persist a round setting (clamped) so a later Resume picks it up server-side.
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

  // User edited an input — mark that field dirty so a late settings load can't
  // overwrite it and so start() knows to persist it.
  const editArcRounds = useCallback((v) => { arcEditedRef.current = true; setArcRounds(v); }, []);
  const editEditorialRounds = useCallback((v) => { editorialEditedRef.current = true; setEditorialRounds(v); }, []);
  const editBeatContinuityRounds = useCallback((v) => { beatContinuityEditedRef.current = true; setBeatContinuityRounds(v); }, []);

  const { latest, frames } = usePipelineProgress(pipelineAutopilotSseUrl, [seriesId], { enabled: active });

  const onSeriesUpdateRef = useRef(onSeriesUpdate);
  const onIssuesUpdateRef = useRef(onIssuesUpdate);
  onSeriesUpdateRef.current = onSeriesUpdate;
  onIssuesUpdateRef.current = onIssuesUpdate;
  // The runId of the run THIS panel is currently tracking. After a run ends,
  // useSseProgress leaves the terminal frame in `latest`; without this guard a
  // fresh Run/Resume would see that stale terminal frame and immediately tear
  // the new run down. Terminal frames whose runId doesn't match are ignored.
  const activeRunIdRef = useRef(null);

  // Re-attach to an in-flight run on (re)mount.
  useEffect(() => {
    if (!seriesId) return undefined;
    let canceled = false;
    getPipelineAutopilotStatus(seriesId, { silent: true })
      .then((s) => {
        if (canceled || !s?.active) return;
        activeRunIdRef.current = s.autopilot?.runId || null;
        setActive(true);
      })
      .catch(() => null);
    return () => { canceled = true; };
  }, [seriesId]);

  // Capture dry-run plan + mode. The plan rides the start frame, but a fast
  // dry-run can complete before the client attaches and only the terminal frame
  // is replayed — so also read the plan off a dry-run complete frame.
  useEffect(() => {
    if (latest?.type === 'start') {
      setMode(latest.mode || null);
      if (Array.isArray(latest.plan)) setPlan(latest.plan);
    } else if (latest?.type === 'complete' && latest.dryRun && Array.isArray(latest.plan)) {
      setPlan(latest.plan);
    }
  }, [latest]);

  // Run-ended handling: refresh series (for the marker) + issues, toast outcome.
  useEffect(() => {
    if (!active || !latest || !RUN_ENDED.has(latest.type)) return;
    // Ignore a terminal frame left over from a previous run (stale `latest`).
    if (activeRunIdRef.current && latest.runId && latest.runId !== activeRunIdRef.current) return;
    setActive(false);
    getPipelineSeries(seriesId, { silent: true }).then((s) => { if (s) onSeriesUpdateRef.current?.(s); }).catch(() => null);
    listPipelineIssues(seriesId, { silent: true }).then((is) => onIssuesUpdateRef.current?.(Array.isArray(is) ? is : [])).catch(() => null);
    if (latest.type === 'complete') {
      if (latest.dryRun) toast.success('Autopilot plan ready');
      else if (latest.craftGapIssues > 0) toast.warning(`Autopilot complete with ${craftGapCaution(latest.craftGapIssues)}`);
      else toast.success('Autopilot complete — draft is production-ready');
    }
    else if (latest.type === 'canceled') toast.success('Autopilot canceled');
    else if (latest.type === 'paused') toast.warning(`Autopilot paused — ${latest.reason || 'needs review'}`);
    else toast.error(latest.error || 'Autopilot failed');
  }, [active, latest, seriesId]);

  const start = useCallback(async () => {
    setStarting(true);
    setPlan(null);
    // Collect ONLY the gates the user edited (clamped, real values — never the
    // display defaults of untouched gates, which would mask a saved setting). Send
    // them as per-run overrides AND persist them: the override makes the edit
    // effective for THIS run even if the save fails (persist is best-effort,
    // server precedence is per-run → setting → default), and the persist makes it
    // the saved default for next time. Untouched gates send nothing, so the server
    // resolves them from the persisted setting.
    const roundOverrides = {};
    if (arcEditedRef.current) roundOverrides.maxArcVerifyRounds = clampRound(arcRounds, DEFAULT_ARC_ROUNDS);
    if (editorialEditedRef.current) roundOverrides.maxEditorialRounds = clampRound(editorialRounds, DEFAULT_EDITORIAL_ROUNDS);
    if (beatContinuityEditedRef.current) roundOverrides.maxBeatContinuityRounds = clampRound(beatContinuityRounds, DEFAULT_BEAT_CONTINUITY_ROUNDS);
    if (Object.keys(roundOverrides).length) await persistRounds(roundOverrides);
    const res = await startPipelineAutopilot(seriesId, { includeVisual, fileGaps, ...roundOverrides }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not start autopilot'); return null; });
    setStarting(false);
    if (!res) return;
    setMode(res.mode || null);
    setShowOpts(false);
    // Track this run's id BEFORE enabling the stream so the terminal-frame
    // effect can reject a stale terminal frame from the previous run.
    activeRunIdRef.current = res.runId || null;
    setActive(true);
  }, [seriesId, includeVisual, fileGaps, arcRounds, editorialRounds, beatContinuityRounds, persistRounds]);

  const cancel = useCallback(async () => {
    await cancelPipelineAutopilot(seriesId).catch(() => null);
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
  const liveLabel = active ? (frameLabel(latest) || 'Working…') : null;
  const runLabel = ap?.status === 'paused' ? 'Resume autopilot'
    : ap?.status === 'done' ? 'Run autopilot again'
      : 'Run autopilot';

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
            <button
              type="button"
              onClick={cancel}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-port-warning hover:text-white border border-port-warning/40 bg-port-bg hover:bg-port-warning/10"
            >
              <X size={12} /> Stop
            </button>
          )}
        </div>
      </div>

      {/* Options popover */}
      {showOpts && !active ? (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t border-port-border pt-3">
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={includeVisual} onChange={(e) => setIncludeVisual(e.target.checked)} />
            Draft cover + all interior pages (comic targets)
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={fileGaps} onChange={(e) => setFileGaps(e.target.checked)} />
            File CoS tasks for gaps it can&apos;t resolve
          </label>
          <div className="flex flex-wrap gap-4 pt-1">
            <RoundInput
              id="autopilot-arc-rounds"
              label="Arc verify rounds"
              settingKey="maxArcVerifyRounds"
              value={arcRounds}
              setValue={editArcRounds}
              defaultValue={DEFAULT_ARC_ROUNDS}
              persist={persistRounds}
            />
            <RoundInput
              id="autopilot-beat-continuity-rounds"
              label="Beat continuity rounds"
              settingKey="maxBeatContinuityRounds"
              value={beatContinuityRounds}
              setValue={editBeatContinuityRounds}
              defaultValue={DEFAULT_BEAT_CONTINUITY_ROUNDS}
              persist={persistRounds}
            />
            <RoundInput
              id="autopilot-editorial-rounds"
              label="Editorial rounds"
              settingKey="maxEditorialRounds"
              value={editorialRounds}
              setValue={editEditorialRounds}
              defaultValue={DEFAULT_EDITORIAL_ROUNDS}
              persist={persistRounds}
            />
          </div>
          <p className="text-[11px] text-gray-500">
            How many auto-resolve rounds each gate attempts before pausing for human review (0 skips the gate, max {ROUND_MAX}). Saved as the default and reused on Resume.
          </p>
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
          {frames?.length ? (
            <div className="mt-2 max-h-28 overflow-y-auto text-[11px] text-gray-500 space-y-0.5">
              {frames.slice(-6).map((f, i) => <div key={i}>{frameLabel(f)}</div>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Dry-run plan — rendered whenever a plan exists, so it survives after the
          dry-run stream closes (a dry-run persists no marker and completes
          immediately). Cleared when the next run starts. */}
      {plan?.length ? (
        <div className="px-3 pb-3 border-t border-port-border pt-2 text-[11px] text-gray-400">
          <div className="uppercase tracking-wider text-gray-500 mb-1">{active ? 'Planned steps' : 'Dry-run plan'}</div>
          <ul className="space-y-0.5">
            {plan.map((p, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <ChevronRight size={10} /> {stepLabel(p.kind)} ×{p.count}{p.note ? ` — ${p.note}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Persisted status banner (paused / done / error). A `done` run that
          filed blocking script-craft gaps (#1572) is shown as a caution, not
          "production-ready" — those gaps still block downstream rendering. */}
      {!active && ap && ap.status && ap.status !== 'idle' && ap.status !== 'running' ? (() => {
        const doneWithGaps = ap.status === 'done' && ap.craftGapIssues > 0;
        const tone = ap.status === 'paused' || doneWithGaps ? 'warning' : ap.status === 'error' ? 'error' : 'success';
        return (
        <div className={`px-3 pb-3 border-t pt-2 ${tone === 'warning' ? 'border-port-warning/30' : tone === 'error' ? 'border-port-error/30' : 'border-port-success/30'}`}>
          <div className="flex items-center gap-2 text-xs">
            {ap.status === 'paused' ? <PauseCircle size={13} className="text-port-warning" />
              : doneWithGaps ? <AlertCircle size={13} className="text-port-warning" />
                : ap.status === 'done' ? <CheckCircle2 size={13} className="text-port-success" />
                  : <AlertCircle size={13} className="text-port-error" />}
            <span className={tone === 'warning' ? 'text-port-warning' : tone === 'success' ? 'text-port-success' : 'text-port-error'}>
              {ap.status === 'paused' ? (ap.currentStep ? `Paused at ${stepLabel(ap.currentStep)}` : 'Paused')
                : doneWithGaps ? `Completed with ${craftGapCaution(ap.craftGapIssues)}`
                  : ap.status === 'done' ? 'Last run completed — draft is production-ready' : 'Last run errored'}
            </span>
            {ap.status === 'paused' && ap.pauseKind === 'divergence' ? (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] bg-port-warning/15 text-port-warning border border-port-warning/30"
                title="Auto-resolve stopped reducing blocking findings — needs a human edit, not more rounds"
              >
                not converging
              </span>
            ) : null}
          </div>
          {ap.lastError && ap.status !== 'done' ? <p className="text-[11px] text-gray-400 mt-1">{ap.lastError}</p> : null}
          <Findings items={ap.residualFindings} />
        </div>
        );
      })() : null}

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
