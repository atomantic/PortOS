/**
 * Story Builder — SSE runner for step generate / refine.
 *
 * The POST kicks `generateStep` / `refineStep` off in the background (mirroring
 * server/services/pipeline/autoRunner.js) and returns immediately; progress and
 * the terminal result land on attached SSE clients. Runs are keyed by
 * `${sessionId}::${stepId}`: different steps stream concurrently, a second click
 * on the same step coalesces. Late clients get the last frame via the replay
 * grace window in lib/sseUtils.js.
 *
 * Frame shapes (consumed by client/src/hooks/useStoryStepRuns.jsx):
 *   { type: 'start',    runId, stepId, op }
 *   { type: 'progress', label, phase }        // phase labels during the run
 *   { type: 'complete', runId, stepId, op, changes, rationale, providerId, model }
 *   { type: 'error',    runId, stepId, op, error }
 * The completed content lives in the universe/series records; the client
 * refetches on `complete` instead of carrying the payload in the frame.
 */

import { createSseRunner } from '../lib/sseUtils.js';
import { generateStep, refineStep } from './storyBuilder.js';

// Uses the factory's OPTIONAL signature-based coalescing, and keeps its own
// error frame inside `work` (it carries `stepId`/`op`); the factory's catch is
// only the safety net.
const runner = createSseRunner({ logLabel: 'story-builder' });

const runKey = (sessionId, stepId) => `${sessionId}::${stepId}`;

export function isStepRunActive(sessionId, stepId) {
  return runner.isActive(runKey(sessionId, stepId));
}

export function attachClient(sessionId, stepId, res) {
  return runner.attachClient(runKey(sessionId, stepId), res);
}

// Bounded, read-only projection of a session's in-flight runs so a client that
// lost its slot can re-attach. Deliberately omits the signature, feedback text,
// clients and abort controller.
export function listActiveStepRuns(sessionId) {
  const prefix = runKey(sessionId, '');
  return runner.listActive(prefix).map(({ key, runId, startedAt, phase, meta }) => ({
    stepId: key.slice(prefix.length),
    runId,
    op: meta.op,
    startedAt,
    phase,
    ...(meta.entryId ? { entryId: meta.entryId } : {}),
  }));
}

/**
 * Kick off a step generate or refine for a session. Returns the runId
 * immediately; progress lands via SSE. `options` is forwarded verbatim to
 * generateStep/refineStep plus an `onProgress` callback for phase frames.
 */
// Identity of a kickoff: same signature = same work, so a second click may attach
// to the in-flight run. A different signature must NOT bind onto it, or its
// success handler would fire off another request's terminal frame (refining B
// would toast "Refined B" for A's run).
const requestSig = (op, { entryId, feedback, fromDownstream } = {}) =>
  JSON.stringify({ op, entryId: entryId ?? null, feedback: feedback ?? null, fromDownstream: !!fromDownstream });

export function startStepRun(sessionId, stepId, { op = 'generate', ...options } = {}) {
  const key = runKey(sessionId, stepId);
  const sig = requestSig(op, options);
  // A matching signature coalesces onto the in-flight run; a different one
  // reports `conflict` + the live run's `op` (via `meta`) so the client won't
  // bind to the running request's frame. A finished run in the replay grace
  // window does NOT block: the factory starts a fresh run.
  return runner.start(key, async ({ runId, broadcast, record }) => {
    broadcast({ type: 'start', runId, stepId, op });
    // Best-effort: an onProgress throw must never break the run.
    const onProgress = (frame) => {
      try {
        // Latest phase label for clients attaching mid-run (listActiveStepRuns).
        if (typeof frame?.label === 'string' && frame.label) record.phase = frame.label.slice(0, 200);
        broadcast({ type: 'progress', runId, ...frame });
      } catch (err) {
        console.error(`❌ story-builder progress emit failed: ${err?.message || err}`);
      }
    };

    // Own the error frame here (and swallow) so the factory's catch doesn't double-emit.
    try {
      const result = op === 'refine'
        ? await refineStep(sessionId, stepId, { ...options, onProgress })
        : await generateStep(sessionId, stepId, { ...options, onProgress });
      broadcast({
        type: 'complete',
        runId,
        stepId,
        op,
        // Refine attribution for the client; generate returns these only on some steps.
        changes: Array.isArray(result?.changes) ? result.changes : undefined,
        rationale: typeof result?.rationale === 'string' ? result.rationale : undefined,
        providerId: result?.providerId,
        model: result?.model,
        completedAt: new Date().toISOString(),
      });
      console.log(`✅ story-builder ${op} complete — session=${sessionId.slice(0, 8)} step=${stepId} runId=${runId.slice(0, 8)}`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ story-builder ${op} failed — session=${sessionId.slice(0, 8)} step=${stepId} ${message}`);
      broadcast({ type: 'error', runId, stepId, op, error: message, failedAt: new Date().toISOString() });
    }
  }, { sig, meta: { op, ...(options.entryId ? { entryId: options.entryId } : {}) } });
}

// Export internals for tests.
export const __testing = { runs: runner.runs, runKey };
