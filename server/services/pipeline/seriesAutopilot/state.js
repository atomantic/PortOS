/**
 * Series Autopilot — in-process run registry & progress bus (#2842 split of
 * seriesAutopilot.js). The single owner of the `runs` map every other module
 * reads through, plus the server-side event tap and its terminal frame types.
 */

import { EventEmitter } from 'events';
// Safe to import at module evaluation: diagnosisCore is a deliberate LEAF
// (lib/ helpers only), outside the session.js import cycle this file's header
// warns about.
import { diagnosisOptedIn } from './diagnosisCore.js';

// runs: Map<seriesId, { runId, clients[], lastPayload, startPayload, cancelRequested, pauseRequested,
//   finished, cleanupTimer, startedAt, mode, options, runState, activeChild,
//   activeLlmRunId }>
// `startPayload` is the run's `start` frame, retained so a client attaching
// mid-run can still read it (SSE replay only carries `lastPayload`).
export const runs = new Map();

// In-process progress bus (CDO Phase 3, #2185): every SSE frame is ALSO emitted here
// keyed by seriesId so a server-side consumer (the Creative Director plan-advance
// loop) can observe frames without an HTTP client. Listeners are short-lived but may
// run concurrently, so the 10-listener cap is lifted.
export const autopilotEvents = new EventEmitter();
autopilotEvents.setMaxListeners(0);

// Frame `type`s meaning the run reached a terminal/paused state; a server-side
// consumer settles its plan step on any of these (see the coordinator in
// startSeriesAutopilot).
export const AUTOPILOT_TERMINAL_TYPES = new Set(['complete', 'paused', 'canceled', 'error']);

// ---------------------------------------------------------------------------
// Diagnosable-signal retention (feeds `selfImprove.js`). Lives here because it is
// run-RECORD state written by `session.js#broadcast`, which lets the diagnosis
// import the registry instead of the reverse (an import cycle through session.js;
// see the barrel's TDZ note).
// ---------------------------------------------------------------------------

// Frame types kept as diagnosis evidence: the "something went sideways" detail.
// Excludes happy-path frames (the step sequence is reconstructable) and terminal
// frames (the diagnosis runs BEFORE them; they arrive as `outcome` + `reason`).
// `resolve:no-change` is kept because the convergence guard counts a resolver
// attempt that wrote nothing like one that did; without it the log had no frame for
// those rounds. Bounded by the gate's round cap.
export const SIGNAL_FRAME_TYPES = Object.freeze(new Set([
  'note', 'step:skip', 'verify:round', 'resolve:round', 'resolve:no-change', 'resolve:rollback', 'resolve:isolate', 'check:complete',
  'foundation:round', 'foundation:fix', 'foundation:rollback', 'canon:repair', 'child:retry', 'child:escalate',
  'revision:cycle', 'revision:converged', 'gap:filed',
]));

// Ceiling on the retained log; overflow is counted, not stored, so a runaway run
// can't grow the record or blow the diagnosis prompt's context.
export const MAX_SIGNALS = 200;

// A `check:complete` frame is evidence only when the check MISBEHAVED; healthy
// frames would crowd out the failures.
const isNoisyHealthyFrame = (payload) => payload?.type === 'check:complete'
  && !payload.error && !payload.skipped;

/** Is this frame worth keeping as diagnosis evidence? Pure. */
export function isSignalFrame(payload) {
  if (!payload || typeof payload.type !== 'string') return false;
  if (!SIGNAL_FRAME_TYPES.has(payload.type)) return false;
  return !isNoisyHealthyFrame(payload);
}

/**
 * Record one broadcast frame onto the run's signal log. Runs for EVERY frame of
 * EVERY run, so the opt-out comes first and stays cheap (`diagnosisOptedIn` also
 * excludes dry-runs). True when retained.
 */
export function noteSignal(run, payload) {
  if (!diagnosisOptedIn(run)) return false;
  if (!isSignalFrame(payload)) return false;
  if (!run.signals) run.signals = [];
  if (run.signals.length >= MAX_SIGNALS) {
    run.signalsDropped = (run.signalsDropped || 0) + 1;
    return false;
  }
  run.signals.push(payload);
  return true;
}

/**
 * Roll the retained log into the entries + per-type counts the diagnosis prompt
 * reads. Pure over the run record.
 */
export function summarizeSignals(run) {
  const signals = run?.signals || [];
  const counts = {};
  for (const s of signals) counts[s.type] = (counts[s.type] || 0) + 1;
  return { signals, counts, dropped: run?.signalsDropped || 0 };
}

// ---------------------------------------------------------------------------
// Live progress snapshot (the milestone map's "where are we" half). SSE replays a
// single payload, so a panel opened mid-run would show an empty map; folding the
// snapshot onto the run record gives ONE implementation, published as a `progress`
// frame and on the status route.
// ---------------------------------------------------------------------------

/** A fresh, empty progress snapshot (the shape every consumer can assume). */
export const emptyProgress = () => ({
  currentStep: null,
  currentStepComplete: false,
  completed: {},
  skipped: {},
  verified: {},
});

/**
 * A detached copy of the live progress: the fold MUTATES its maps, so handing the
 * live object to a payload/listener would let later steps rewrite delivered frames.
 */
export function snapshotProgress(run) {
  const p = run?.progress;
  if (!p) return null;
  return { ...p, completed: { ...p.completed }, skipped: { ...p.skipped }, verified: { ...p.verified } };
}

/**
 * Fold one broadcast frame into the progress snapshot. Returns true when it MOVED
 * (the caller then publishes it).
 *
 * Never folds a terminal frame: the snapshot is published as a follow-up frame and
 * SSE replay keeps only the last payload, so a `progress` frame after
 * `complete`/`paused` would hide the terminal from a late-attaching client.
 */
export function noteProgress(run, payload) {
  if (!run || !payload) return false;
  if (!run.progress) run.progress = emptyProgress();
  const p = run.progress;
  switch (payload.type) {
    case 'step:start':
      p.currentStep = payload.kind || null;
      p.currentStepComplete = false;
      return true;
    case 'step:complete':
      // `currentStep` is NOT cleared: a run that pauses or ends here still names its
      // step. `currentStepComplete` separates a gate the run RE-ENTERS (the
      // foundation gate re-checks after an arc repair) from one just finished.
      if (payload.kind) p.completed[payload.kind] = (p.completed[payload.kind] || 0) + 1;
      if (!payload.kind || payload.kind === p.currentStep) p.currentStepComplete = true;
      return true;
    case 'step:skip':
      // Sub-step skips annotate a milestone; the step itself still completes.
      if (payload.kind) p.skipped[payload.kind] = (p.skipped[payload.kind] || 0) + 1;
      return true;
    // Gate telemetry is broadcast from INSIDE the step it measures, so the tracked
    // step IS the milestone; no naming table to keep in sync with emitters.
    case 'verify:round':
      if (!p.currentStep) return false;
      p.verified[p.currentStep] = {
        round: payload.round ?? null,
        findings: payload.findings ?? null,
        blocking: payload.blocking ?? null,
        ...(payload.errored ? { errored: payload.errored } : {}),
      };
      return true;
    case 'foundation:round':
      if (!p.currentStep) return false;
      p.verified[p.currentStep] = {
        round: payload.round ?? null,
        weightedScore: payload.weightedScore ?? null,
        threshold: payload.threshold ?? null,
        ...(payload.weakest ? { weakest: payload.weakest } : {}),
      };
      return true;
    default:
      return false;
  }
}
