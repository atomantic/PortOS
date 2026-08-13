import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { storyStepProgressSseUrl } from '../services/api';
import { usePipelineProgress } from './usePipelineProgress';

// Story Builder generate/refine runs, hoisted OUT of the step panel that starts
// them (#3905). The panel is keyed by the active step id, so clicking another
// step on the rail unmounts it — when the SSE subscription and the
// onComplete/onError handlers lived inside that panel, navigating mid-run tore
// the stream down and the user got no phase updates, no completion toast, and a
// stale view until a manual refresh. Mounting this provider ABOVE the step rail
// keeps each run's subscription and handlers alive for as long as the story
// session is open, whichever step is on screen.
//
// One run per step id: the server rejects a second concurrent op on the same
// step (`conflict`), so the per-step slot mirrors that. Runs on DIFFERENT steps
// coexist — each active run renders its own <StepRunStream>, so a user can kick
// off the arc, move to the reader map, and start that one too.
const StoryStepRunContext = createContext(null);

// Subscribes to one run's progress stream. Mounted only once the kickoff POST
// has resolved (so the run is registered server-side before the EventSource
// connects) and unmounted the moment the run settles — which is also why the
// `latest`-reset race the old inline hook guarded against can't happen here: a
// fresh mount starts with a null frame. The runId check stays as defense against
// a replayed terminal frame from the step's previous run.
function StepRunStream({ sessionId, stepId, runId, onPhase, onEnd }) {
  const { latest, closed } = usePipelineProgress(storyStepProgressSseUrl, [sessionId, stepId]);
  // One effect owns every end-of-run path. A terminal frame and `closed` land on
  // the same render, so the ordered branches (plus this ref) guarantee exactly
  // one onEnd. The bare-`closed` branch covers a stream that died before any
  // terminal frame — server pruned a fast run, or the connection dropped.
  const endedRef = useRef(false);

  useEffect(() => {
    if (endedRef.current) return;
    const mine = latest && latest.runId === runId;
    if (mine && typeof latest.label === 'string' && latest.label) onPhase(latest.label);
    if (mine && latest.type === 'complete') { endedRef.current = true; onEnd({ ok: true, frame: latest }); }
    else if (mine && latest.type === 'error') { endedRef.current = true; onEnd({ ok: false, error: new Error(latest.error || 'Generation failed') }); }
    else if (closed) { endedRef.current = true; onEnd({ ok: false, error: new Error('Lost connection to the generation stream') }); }
  }, [latest, closed, runId, onPhase, onEnd]);

  return null;
}

/**
 * Hosts every in-flight Story Builder step run for one session. Mount it above
 * anything that unmounts on step navigation.
 */
export function StoryStepRunProvider({ sessionId, children }) {
  // { [stepId]: { runId | null, op, phase, meta } } — a slot with runId === null
  // is still in kickoff (busy, but nothing to subscribe to yet).
  // Each slot records the session it belongs to. The reset effect below can only
  // run AFTER the render in which `sessionId` changed, so without this stamp the
  // old session's slots would render one frame against the NEW id — opening an
  // EventSource on a URL that pairs another story with this step.
  const [runs, setRuns] = useState({});
  const ownRuns = Object.fromEntries(
    Object.entries(runs).filter(([, run]) => run.sessionId === sessionId),
  );
  // Handlers are closures over the panel that started the run — they must NOT be
  // state (they'd re-render the whole tree) and they must survive that panel's
  // unmount, which is the entire point of this provider.
  const handlersRef = useRef({});
  // Step ids with a kickoff in flight or a live run — the synchronous mirror of
  // `runs`, so the re-entrancy guard in `start` doesn't depend on a re-render.
  const startedRef = useRef(new Set());
  // The session a kickoff was started under, so a kickoff that resolves AFTER
  // the user opened a different story can't register its run here — the stream
  // would build its URL from the NEW session id and subscribe to the wrong run.
  const sessionRef = useRef(sessionId);

  // A different story session means none of these runs belong to the view
  // anymore. Drop them rather than fanning their toasts into the new session.
  useEffect(() => {
    sessionRef.current = sessionId;
    setRuns({});
    handlersRef.current = {};
    startedRef.current = new Set();
  }, [sessionId]);

  const clear = useCallback((stepId) => {
    setRuns((prev) => {
      if (!(stepId in prev)) return prev;
      const next = { ...prev };
      delete next[stepId];
      return next;
    });
    const h = handlersRef.current[stepId];
    delete handlersRef.current[stepId];
    startedRef.current.delete(stepId);
    return h;
  }, []);

  // Returning `prev` unchanged for a repeat label matters: the stream's effect
  // re-runs whenever this provider re-renders (its callback props are fresh
  // arrows), so a setPhase that always allocated a new state object would loop
  // render → effect → setPhase → render forever.
  const setPhase = useCallback((stepId, label) => {
    setRuns((prev) => {
      const run = prev[stepId];
      if (!run || run.phase === label) return prev;
      return { ...prev, [stepId]: { ...run, phase: label } };
    });
  }, []);

  const endRun = useCallback((stepId, result) => {
    const h = clear(stepId);
    if (result.ok) h?.onComplete?.(result.frame);
    else h?.onError?.(result.error);
  }, [clear]);

  /**
   * Start a run on `stepId`. `kickoff` POSTs the run and resolves to the
   * server's `{ runId }` (or `{ conflict: true }`); the stream subscribes only
   * after it lands. `meta` is arbitrary per-run data the UI needs to restore
   * itself after a remount (e.g. which character is being refined).
   */
  const start = useCallback(async (stepId, op, kickoff, handlers = {}, meta = null) => {
    // The ref, not just the `runs` snapshot: two clicks inside one render tick
    // both read the same (empty) snapshot, and the second would fire a duplicate
    // kickoff the server only rejects after a round trip.
    if (ownRuns[stepId] || startedRef.current.has(stepId)) return;
    const startedUnder = sessionRef.current;
    startedRef.current.add(stepId);
    setRuns((prev) => ({ ...prev, [stepId]: { sessionId: startedUnder, runId: null, op, phase: 'Starting…', meta } }));
    const res = await kickoff().then((r) => ({ r }), (err) => ({ err }));
    // The user opened a different story while the POST was in flight. The run
    // belongs to the story they left — the reset effect already dropped its
    // slot, and reporting its outcome into the story now on screen would be a
    // toast about work the user can no longer see.
    if (sessionRef.current !== startedUnder) return;
    if (res.err || !res.r) {
      clear(stepId);
      if (res.err) handlers.onError?.(res.err);
      return;
    }
    // The kickoff collided with a DIFFERENT in-flight request for this step (a
    // different op, or a refine of another target/note). That run persists to the
    // same records, so binding THIS button's success handler to its terminal
    // frame would misreport. Don't subscribe — report it and leave the run alone.
    // (A same-work re-click returns alreadyRunning without conflict.)
    if (res.r.conflict) {
      clear(stepId);
      handlers.onError?.(new Error('Another operation is already running for this step — try again once it finishes.'));
      return;
    }
    // A 2xx with no run id has nothing to subscribe to. Settling here keeps the
    // slot from sticking "busy" forever with no stream that could ever clear it.
    if (!res.r.runId) {
      clear(stepId);
      handlers.onError?.(new Error('The server did not return a run to track — try again.'));
      return;
    }
    handlersRef.current[stepId] = handlers;
    setRuns((prev) => ({ ...prev, [stepId]: { sessionId: startedUnder, runId: res.r.runId, op, phase: 'Starting…', meta } }));
  }, [ownRuns, clear]);

  return (
    <StoryStepRunContext.Provider value={{ runs: ownRuns, start }}>
      {Object.entries(ownRuns).map(([stepId, run]) => (run.runId ? (
        <StepRunStream
          key={`${stepId}:${run.runId}`}
          sessionId={sessionId}
          stepId={stepId}
          runId={run.runId}
          onPhase={(label) => setPhase(stepId, label)}
          onEnd={(result) => endRun(stepId, result)}
        />
      ) : null))}
      {children}
    </StoryStepRunContext.Provider>
  );
}

/**
 * Read/drive the run slot for one step. Drop-in for the old panel-local hook:
 * `{ start, busy, phase, op }` — plus `meta`, so a panel remounted mid-run can
 * restore which entry the run targets instead of losing it to unmounted state.
 */
export function useStoryStepRun(stepId) {
  const ctx = useContext(StoryStepRunContext);
  if (!ctx) throw new Error('useStoryStepRun must be used inside a <StoryStepRunProvider>');
  const run = ctx.runs[stepId] || null;
  const { start } = ctx;
  const startForStep = useCallback(
    (op, kickoff, handlers, meta) => start(stepId, op, kickoff, handlers, meta),
    [start, stepId],
  );
  return {
    start: startForStep,
    busy: Boolean(run),
    phase: run?.phase || '',
    op: run?.op || null,
    meta: run?.meta ?? null,
  };
}
