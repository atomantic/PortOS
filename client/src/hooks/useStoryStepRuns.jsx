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
 *
 * A run this mount did not start — discovered on the session read after a
 * reload / second tab, or the holder of a kickoff conflict (#10065) — is
 * ADOPTED: the same progress stream is attached, but there is no originating
 * request whose success handler could fire. The page registers (via
 * `useStoryRunMonitor`) `onAdoptedEnd({ ok, stepId, op, frame | error })` to
 * refresh the session once on settlement, and `onKickoffUncertain`, which fires
 * when a kickoff POST rejects: the server may have registered the run before the
 * acknowledgement was lost, so the page re-reads the session (re-discovering it).
 */
export function StoryStepRunProvider({ sessionId, children }) {
  // { [stepId]: { epoch, runId | null, op, phase, meta } } — a slot with
  // runId === null is still in kickoff (busy, but nothing to subscribe to yet).
  const [runs, setRuns] = useState({});
  // Handlers are closures over the panel that started the run — they must NOT be
  // state (they'd re-render the whole tree) and they must survive that panel's
  // unmount, which is the entire point of this provider.
  const handlersRef = useRef({});
  // Step ids with a kickoff in flight or a live run — the synchronous mirror of
  // `runs`, so the re-entrancy guard in `start` doesn't depend on a re-render.
  const startedRef = useRef(new Set());
  // Run ids that already settled in this mount — a stale discovery response must
  // not re-adopt a run whose terminal frame this provider already handled.
  const settledRunsRef = useRef(new Set());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Latest page callbacks (registered by useStoryRunMonitor), read at call time
  // so adopted runs never capture a stale closure.
  const callbacksRef = useRef({});

  // Opening a different story invalidates every run here. The reset must happen
  // DURING the render that changed `sessionId` (React's "adjusting state on a
  // prop change" pattern, same as `usePreviousSync`) — an effect only runs after
  // that render commits, and by then the old session's slots have already
  // rendered a stream against the NEW id, subscribing to the wrong story.
  //
  // The stamp is a monotonic epoch rather than the session id itself: an id
  // comparison can't tell "still the story I started under" from "left and came
  // back" (s1 → s2 → s1), so a kickoff settling after the round trip would
  // adopt, or clear, a slot belonging to the newer visit.
  const [session, setSession] = useState({ id: sessionId, epoch: 0 });
  const epochRef = useRef(0);
  if (session.id !== sessionId) {
    epochRef.current = session.epoch + 1;
    setSession({ id: sessionId, epoch: epochRef.current });
    setRuns({});
    handlersRef.current = {};
    startedRef.current = new Set();
    settledRunsRef.current = new Set();
  }
  const ownRuns = Object.fromEntries(
    Object.entries(runs).filter(([, run]) => run.epoch === epochRef.current),
  );

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

  const endRun = useCallback((stepId, result, runId) => {
    if (runId) settledRunsRef.current.add(runId);
    const h = clear(stepId);
    if (result.ok) h?.onComplete?.(result.frame);
    else h?.onError?.(result.error);
  }, [clear]);

  // Attach to a run this mount did not start. Returns true when a slot was
  // created. Guards: the session must still be the one the run belongs to (a late
  // response for a story the user left is dropped), the step must have no slot or
  // in-flight kickoff of its own, and a run this mount already settled is never
  // resurrected by a stale snapshot.
  const adopt = useCallback((forSessionId, { stepId, runId, op, phase, entryId }) => {
    if (forSessionId !== sessionIdRef.current || !stepId || !runId) return false;
    if (startedRef.current.has(stepId) || settledRunsRef.current.has(runId)) return false;
    const epoch = epochRef.current;
    startedRef.current.add(stepId);
    handlersRef.current[stepId] = {
      onComplete: (frame) => callbacksRef.current.onAdoptedEnd?.({ ok: true, stepId, op, frame }),
      onError: (error) => callbacksRef.current.onAdoptedEnd?.({ ok: false, stepId, op, error }),
    };
    setRuns((prev) => ({
      ...prev,
      [stepId]: { epoch, runId, op: op || 'generate', phase: phase || 'Running…', meta: entryId ? { entryId } : null, adopted: true },
    }));
    return true;
  }, []);

  // Adopt every live run a session read reported. Idempotent — safe to call on
  // every reload.
  const adoptActive = useCallback((forSessionId, activeSteps) => {
    if (!Array.isArray(activeSteps)) return;
    for (const run of activeSteps) adopt(forSessionId, run);
  }, [adopt]);

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
    const epoch = epochRef.current;
    startedRef.current.add(stepId);
    setRuns((prev) => ({ ...prev, [stepId]: { epoch, runId: null, op, phase: 'Starting…', meta } }));
    const res = await kickoff().then((r) => ({ r }), (err) => ({ err }));
    // The user left this story while the POST was in flight. The run belongs to
    // a visit that is over — its slot is already gone, and reporting its outcome
    // now would toast about work the user can no longer see.
    if (epochRef.current !== epoch) return;
    if (res.err) {
      clear(stepId);
      handlers.onError?.(res.err);
      // The POST may have reached the server before its acknowledgement was
      // lost — let the page re-read the session so a live run is re-discovered.
      callbacksRef.current.onKickoffUncertain?.();
      return;
    }
    // The kickoff collided with a DIFFERENT in-flight request for this step (a
    // different op, or a refine of another target/note). That run persists to the
    // same records, so binding THIS button's success handler to its terminal
    // frame would misreport. Don't subscribe — report it and leave the run alone.
    // (A same-work re-click returns alreadyRunning without conflict.)
    if (res.r?.conflict) {
      clear(stepId);
      // Observe the holder (never bind THIS request's handlers to it) so its
      // progress and completion stay visible instead of a dead-end refusal.
      const adopted = adopt(sessionIdRef.current, { stepId, runId: res.r.runId, op: res.r.op, entryId: res.r.entryId });
      handlers.onError?.(new Error(adopted
        ? `A ${res.r.op || 'different'} run is already in progress for this step — now monitoring it. Try again once it finishes.`
        : 'Another operation is already running for this step — try again once it finishes.'));
      return;
    }
    // A resolved-but-empty response (or a 2xx carrying no run id) has nothing to
    // subscribe to. Settling here keeps the slot from sticking "busy" forever
    // with no stream that could ever clear it, and tells the user why.
    if (!res.r?.runId) {
      clear(stepId);
      handlers.onError?.(new Error('The server did not return a run to track — try again.'));
      return;
    }
    handlersRef.current[stepId] = handlers;
    setRuns((prev) => ({ ...prev, [stepId]: { epoch, runId: res.r.runId, op, phase: 'Starting…', meta } }));
  }, [ownRuns, clear, adopt]);

  return (
    <StoryStepRunContext.Provider value={{ runs: ownRuns, start, adoptActive, callbacksRef }}>
      {Object.entries(ownRuns).map(([stepId, run]) => (run.runId ? (
        <StepRunStream
          key={`${stepId}:${run.runId}`}
          sessionId={sessionId}
          stepId={stepId}
          runId={run.runId}
          onPhase={(label) => setPhase(stepId, label)}
          onEnd={(result) => endRun(stepId, result, run.runId)}
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

/**
 * Every run slot this provider currently holds (own kickoffs + adopted ones) as
 * `[{ stepId, op, phase, adopted, meta }]`, plus `adoptActive(sessionId,
 * activeSteps)` to attach the live runs a session read reported. The page uses
 * the list for its active-run banner and the adopter on each session load, and
 * passes the settlement / lost-acknowledgement callbacks documented on the provider.
 */
export function useStoryRunMonitor({ onAdoptedEnd, onKickoffUncertain } = {}) {
  const ctx = useContext(StoryStepRunContext);
  if (!ctx) throw new Error('useStoryRunMonitor must be used inside a <StoryStepRunProvider>');
  const { callbacksRef } = ctx;
  useEffect(() => {
    callbacksRef.current = { onAdoptedEnd, onKickoffUncertain };
    return () => { callbacksRef.current = {}; };
  }, [callbacksRef, onAdoptedEnd, onKickoffUncertain]);
  const runs = Object.entries(ctx.runs)
    .filter(([, run]) => run.runId)
    .map(([stepId, run]) => ({ stepId, op: run.op, phase: run.phase, adopted: Boolean(run.adopted), meta: run.meta }));
  return { runs, adoptActive: ctx.adoptActive };
}
