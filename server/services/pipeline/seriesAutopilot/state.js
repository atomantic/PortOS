/**
 * Series Autopilot — in-process run registry & progress bus (#2842 split of
 * seriesAutopilot.js). The single owner of the `runs` map every other module
 * reads through, plus the server-side event tap and its terminal frame types.
 */

import { EventEmitter } from 'events';

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished,
//   cleanupTimer, startedAt, mode, options, runState, activeChild }>
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
