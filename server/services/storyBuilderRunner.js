/**
 * Story Builder — SSE runner for step generate / refine.
 *
 * `generateStep` / `refineStep` in storyBuilder.js are a single LLM call plus a
 * record persist. Run synchronously they block the HTTP request — a long
 * arc-overview leaves the button spinning with no signal. This runner mirrors
 * the pipeline auto-runner (server/services/pipeline/autoRunner.js): the POST
 * kicks the work off in the background and returns immediately; progress and
 * the terminal result land on attached SSE clients.
 *
 * SSE: a single in-memory `runs` map keyed by `${sessionId}::${stepId}` so two
 * different steps can stream concurrently while a second click on the same step
 * coalesces onto the in-flight run. Late-connecting clients receive the last
 * broadcast frame via attachSseClient's replay grace window in lib/sseUtils.js.
 *
 * Frame shapes (consumed by client/src/hooks/useStoryStepProgress.js):
 *   { type: 'start',    runId, stepId, op }
 *   { type: 'progress', label, phase }        // phase labels during the run
 *   { type: 'complete', runId, stepId, op, changes, rationale, providerId, model }
 *   { type: 'error',    runId, stepId, op, error }
 * The completed content lives in the universe/series records — the client
 * refetches the session view on `complete` rather than carrying the payload in
 * the frame (matches the pipeline auto-run's refetch-on-terminal pattern).
 */

import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, closeJobAfterDelay } from '../lib/sseUtils.js';
import { generateStep, refineStep } from './storyBuilder.js';

// runs: Map<runKey, { runId, clients[], lastPayload, startedAt, stepId, op }>
const runs = new Map();

const runKey = (sessionId, stepId) => `${sessionId}::${stepId}`;

export function isStepRunActive(sessionId, stepId) {
  return runs.has(runKey(sessionId, stepId));
}

export function attachClient(sessionId, stepId, res) {
  return attachSseClient(runs, runKey(sessionId, stepId), res);
}

function broadcast(key, payload) {
  const run = runs.get(key);
  if (!run) return;
  broadcastSse(run, payload);
}

/**
 * Kick off a step generate (op: 'generate') or refine (op: 'refine') for a
 * session. Returns the runId immediately; progress lands via SSE. Re-calling
 * while a run is in flight for the same step resolves to the existing runId.
 *
 * `options` is forwarded verbatim to generateStep/refineStep (providerId,
 * model, fromDownstream for generate; feedback, entryId, providerId, model for
 * refine) plus an `onProgress` callback the conductor uses to emit phase frames.
 */
// Identity of a kickoff request: what work it would actually do. Two clicks
// with the same signature run the same work, so the second can safely attach to
// the first's in-flight run; a different signature would do different work, so
// it must NOT bind onto the running one (else its success handler fires off
// another request's terminal frame — e.g. refining character B while character
// A's refine is in flight would toast "Refined B" for A's run).
const requestSig = (op, { entryId, feedback, fromDownstream } = {}) =>
  JSON.stringify({ op, entryId: entryId ?? null, feedback: feedback ?? null, fromDownstream: !!fromDownstream });

export function startStepRun(sessionId, stepId, { op = 'generate', ...options } = {}) {
  const key = runKey(sessionId, stepId);
  const sig = requestSig(op, options);
  // Coalesce a second click onto the in-flight run only when it's doing the SAME
  // work (matching signature) — a reload mid-run re-attaching to its own request.
  // A different signature (different op, or a refine of a different target/note)
  // would do different work, so we refuse to coalesce and report `conflict` so
  // the client doesn't bind its success handler to the running request's frame.
  //
  // Only a still-WORKING run blocks. A completed run lingers in `runs` for the
  // SSE replay grace window (closeJobAfterDelay); coalescing onto it would re-run
  // no work and replay the stale terminal frame as a false success. A fresh
  // kickoff in that window starts a new run that replaces the lingering record.
  const inFlight = runs.get(key);
  if (inFlight && !inFlight.done) {
    if (inFlight.sig === sig) return { runId: inFlight.runId, alreadyRunning: true };
    return { runId: inFlight.runId, alreadyRunning: true, conflict: true, op: inFlight.op };
  }

  const runId = randomUUID();
  const record = {
    runId,
    clients: [],
    lastPayload: null,
    startedAt: new Date().toISOString(),
    stepId,
    op,
    sig,
    done: false,
  };
  runs.set(key, record);

  // Fire-and-forget the work. The outer try/catch is the permitted boundary
  // use of try/catch in this module — without it an LLM rejection would surface
  // as an unhandledRejection and kill the process (the POST has already
  // returned, so there's no `next(err)` to bubble to).
  (async () => {
    broadcast(key, { type: 'start', runId, stepId, op });
    // Best-effort phase emitter handed to the conductor; an onProgress throw
    // must never break the run.
    const onProgress = (frame) => {
      try {
        broadcast(key, { type: 'progress', runId, ...frame });
      } catch (err) {
        console.error(`❌ story-builder progress emit failed: ${err?.message || err}`);
      }
    };

    try {
      const result = op === 'refine'
        ? await refineStep(sessionId, stepId, { ...options, onProgress })
        : await generateStep(sessionId, stepId, { ...options, onProgress });
      broadcast(key, {
        type: 'complete',
        runId,
        stepId,
        op,
        // Surface the refine attribution the client toast + UI read; generate
        // returns these only on some steps, so guard each.
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
      broadcast(key, { type: 'error', runId, stepId, op, error: message, failedAt: new Date().toISOString() });
    } finally {
      // Mark terminal so a kickoff during the grace window starts a fresh run
      // instead of coalescing onto this finished one.
      record.done = true;
      // Hold the SSE list open briefly so a client that attached just after the
      // terminal frame still replays it (matches the auto-runner / mediaJobQueue).
      // Pass this record as `expectedJob` so a replacement run that took the key
      // during the window isn't evicted by this timer.
      closeJobAfterDelay(runs, key, undefined, record);
    }
  })();

  return { runId, alreadyRunning: false };
}

// Export internals for tests.
export const __testing = { runs, runKey };
