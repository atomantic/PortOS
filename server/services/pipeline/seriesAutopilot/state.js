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

// In-process progress bus (CDO Phase 3, #2185). Every SSE frame the run
// broadcasts to attached HTTP clients is ALSO emitted here keyed by seriesId, so
// a SERVER-SIDE consumer — the Creative Director plan-advance loop running an
// autopilot as one plan step — can observe progress/pause/terminal frames
// without opening an HTTP/SSE client. SSE behavior is unchanged; this is a
// parallel tap, not a replacement. Listeners are per-seriesId and short-lived
// (attached for the life of one plan step), but a busy install could run several
// concurrently, so lift the default 10-listener cap to avoid a spurious leak
// warning. The payloads are the exact SSE frames (they carry `type`).
export const autopilotEvents = new EventEmitter();
autopilotEvents.setMaxListeners(0);

// The frame `type`s that mean the run reached a terminal/paused state — a
// server-side consumer settles its plan step on any of these. `complete` (or a
// dry-run `complete`), `paused` (convergence/budget/child pause), `canceled`
// (user stop), and `error` (run-ending throw) are exhaustive of the run's exit
// frames (see the fire-and-forget coordinator in startSeriesAutopilot).
export const AUTOPILOT_TERMINAL_TYPES = new Set(['complete', 'paused', 'canceled', 'error']);

// ---------------------------------------------------------------------------
// Diagnosable-signal retention (feeds the opt-in self-improvement post-mortem,
// `selfImprove.js`). It lives here rather than there because it is run-RECORD
// state — `session.js#broadcast` writes it on the record this module owns, and
// keeping it here is what lets the diagnosis import the registry instead of the
// registry importing the diagnosis (an import cycle through session.js, which
// this package has been bitten by before — see the barrel's TDZ note).
// ---------------------------------------------------------------------------

// Frame types worth keeping as diagnosis evidence. Deliberately excludes the
// high-volume happy-path frames (`start` / `step:start` / `step:complete`) — the
// step SEQUENCE is reconstructable from the outcome, while these carry the
// "something went sideways" detail a diagnosis actually reasons over. The
// terminal frames (`complete` / `paused` / `error`) are excluded too: the
// diagnosis runs BEFORE them, and their content reaches it as the `outcome` +
// `reason` arguments instead.
// `resolve:no-change` is here for the same reason the loop emits it at all: the
// convergence guard counts a resolver attempt that wrote nothing exactly like
// one that did, so a pause reading "no net progress over 2 rounds of
// auto-resolve" was handed a log with no frame for those rounds — the diagnosis
// could see the attempts had happened only by inference. Bounded by the gate's
// round cap, and it carries counts + an enum, so retaining it costs one small
// frame per attempt.
export const SIGNAL_FRAME_TYPES = Object.freeze(new Set([
  'note', 'step:skip', 'verify:round', 'resolve:round', 'resolve:no-change', 'resolve:rollback', 'resolve:isolate', 'check:complete',
  'foundation:round', 'foundation:fix', 'foundation:rollback', 'canon:repair', 'child:retry', 'child:escalate',
  'revision:cycle', 'revision:converged', 'gap:filed',
]));

// Ceiling on the retained log. A long run emits a `verify:round` per gate round
// and a `check:complete` per check per pass; past this the overflow is counted,
// not stored, so a runaway run can't grow the record unbounded (or blow the
// diagnosis prompt's context).
export const MAX_SIGNALS = 200;

// A `check:complete` frame is only evidence when the check MISBEHAVED — a check
// that ran and reported findings is the system working. Without this filter a
// 40-check pass would flood the log with healthy frames and crowd out the
// failures that matter.
const isNoisyHealthyFrame = (payload) => payload?.type === 'check:complete'
  && !payload.error && !payload.skipped;

/** Is this frame worth keeping as diagnosis evidence? Pure. */
export function isSignalFrame(payload) {
  if (!payload || typeof payload.type !== 'string') return false;
  if (!SIGNAL_FRAME_TYPES.has(payload.type)) return false;
  return !isNoisyHealthyFrame(payload);
}

/**
 * Record one broadcast frame onto the run's signal log. Called from `broadcast`
 * for EVERY frame of EVERY run, so the opt-out must come first and stay cheap: a
 * run that opted into no diagnosis pass (`diagnosisOptedIn` — which also
 * excludes dry-runs, whose telemetry isn't worth diagnosing) does a few
 * property reads and returns. True when retained.
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
// Live progress snapshot — the milestone map's "where are we" half (the plan on
// the `start` frame is the "what's the whole job" half).
//
// Everything here is already derivable from frames the run broadcasts, but only
// by a client that watched the WHOLE stream: SSE replays a single payload, so a
// panel opened mid-run (the normal case for a long unattended run) would show an
// empty map. Folding it onto the run record instead means the snapshot has ONE
// implementation, published two ways — a `progress` frame after every frame that
// moves it, and the same object on the status route for a mid-run attach.
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
 * A detached copy of the run's live progress. The fold MUTATES the maps it owns,
 * so handing the live object to an SSE payload / event listener would let a
 * later step silently rewrite a frame that was already delivered — the reader
 * would see counts from the future. One shallow clone per published snapshot.
 */
export function snapshotProgress(run) {
  const p = run?.progress;
  if (!p) return null;
  return { ...p, completed: { ...p.completed }, skipped: { ...p.skipped }, verified: { ...p.verified } };
}

/**
 * Fold one broadcast frame into the run's progress snapshot. Returns true when
 * the snapshot MOVED (so the caller publishes it) and false otherwise, which is
 * the common case — most frames are chatter the map doesn't track.
 *
 * Deliberately never folds a terminal frame: the caller publishes the snapshot
 * as a follow-up frame, and SSE replay keeps only the last payload, so a
 * `progress` frame emitted after `complete`/`paused` would hide the terminal
 * from a client that attaches late.
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
      // `currentStep` is deliberately NOT cleared: the next step:start replaces
      // it within the same tick, and leaving it set means a run that pauses or
      // ends right here still names the step it was on. `currentStepComplete` is
      // what separates the two readings — without it, a gate the run RE-ENTERS
      // (the foundation gate re-checks after an arc repair) is indistinguishable
      // from one it just finished, and the map shows the wrong row working.
      if (payload.kind) p.completed[payload.kind] = (p.completed[payload.kind] || 0) + 1;
      if (!payload.kind || payload.kind === p.currentStep) p.currentStepComplete = true;
      return true;
    case 'step:skip':
      // Sub-step skips (one issue's render, one script's craft pass) — the step
      // itself still completes, so these annotate a milestone rather than
      // advancing it.
      if (payload.kind) p.skipped[payload.kind] = (p.skipped[payload.kind] || 0) + 1;
      return true;
    // Both gate-telemetry frames are broadcast from INSIDE the step they
    // measure, so the step already being tracked IS the milestone they belong
    // to. Keying off it (rather than translating the frame's `scope`) means a
    // new gate needs no naming table kept in sync with its emitter.
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
