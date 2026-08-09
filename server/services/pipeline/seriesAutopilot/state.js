/**
 * Series Autopilot — in-process run registry & progress bus (#2842 split of
 * seriesAutopilot.js). The single owner of the `runs` map every other module
 * reads through, plus the server-side event tap and its terminal frame types.
 */

import { EventEmitter } from 'events';

// runs: Map<seriesId, { runId, clients[], lastPayload, startPayload, cancelRequested,
//   finished, cleanupTimer, startedAt, mode, options, runState, activeChild }>
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
export const SIGNAL_FRAME_TYPES = Object.freeze(new Set([
  'note', 'step:skip', 'verify:round', 'resolve:round', 'check:complete',
  'foundation:round', 'foundation:fix', 'child:retry', 'child:escalate',
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
 * run that asked for neither the post-mortem (`selfImprove`) nor the observing
 * orchestrator (`observer`) — or a dry-run, which has no telemetry worth
 * diagnosing — does a few property reads and returns. True when retained.
 */
export function noteSignal(run, payload) {
  if (!run || run.mode !== 'execute') return false;
  if (run.options?.selfImprove !== true && run.options?.observer !== true) return false;
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
