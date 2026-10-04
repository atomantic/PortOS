import { useCallback, useEffect, useRef, useState } from 'react';
import { usePipelineProgress } from './usePipelineProgress.js';

const RUN_ENDED = new Set(['complete', 'canceled', 'cancelled', 'error']);

/**
 * One series-scoped background run (Reverse Outline, Continuity Bible) from
 * acknowledgement to settlement, including the case where the progress stream
 * ends WITHOUT a terminal frame — the server evicts a finished run after a short
 * replay window, so a delayed kickoff/status response or a reconnect can attach
 * to a run that no longer exists (progress GET 404 → `closed`).
 *
 * Settling paths:
 * - a terminal frame for the owned run → `onTerminal(frame)`;
 * - stream closed with no matching terminal frame → read the status endpoint:
 *   inactive → `onReconciled({ canceled })` (re-read the saved result), still
 *   active → `recovery: 'disconnected'` (Reattach / Cancel, never a resubmit),
 *   unreadable → `recovery: 'unknown'` (Retry status);
 * - `cancel()` answered `canceled:false` (or failing) → the same status read.
 *
 * Every asynchronous recovery is guarded by a run token (bumped on adopt,
 * settle and scope change), so a delayed read for an old run or series can't
 * clear a newer run. It never POSTs a generation and never polls.
 *
 * @param {object} opts
 * @param {string} opts.scopeId series id the run belongs to
 * @param {(id: string) => string} opts.urlBuilder SSE-URL builder from services/api
 * @param {(id: string, options: {silent: boolean}) => Promise<{active: boolean}>} opts.fetchStatus
 * @param {(id: string) => Promise<{canceled: boolean}>} opts.requestCancel
 * @param {(frame: object) => void} opts.onTerminal fires once for the owned run's terminal frame
 * @param {(info: {canceled: boolean}) => void} opts.onReconciled fires when the status read shows the run is gone
 * @returns {{
 *   active: boolean, observing: boolean,
 *   recovery: null|'checking'|'disconnected'|'unknown',
 *   cancelState: null|'requesting'|'pending',
 *   adopt: (runId?: string|null) => void, cancel: () => Promise<void>,
 *   reattach: () => void, retryStatus: () => Promise<void>,
 * }}
 */
export function useSeriesRunLifecycle({ scopeId, urlBuilder, fetchStatus, requestCancel, onTerminal, onReconciled }) {
  const [active, setActive] = useState(false);
  const [observing, setObserving] = useState(false);
  const [recovery, setRecovery] = useState(null);
  const [cancelState, setCancelState] = useState(null);
  const runIdRef = useRef(null);
  const tokenRef = useRef(0);
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;
  const observingRef = useRef(false);
  observingRef.current = observing;
  const cancelStateRef = useRef(null);
  cancelStateRef.current = cancelState;
  // Latest callbacks, so async continuations never run a stale closure.
  const callbacksRef = useRef({});
  callbacksRef.current = { fetchStatus, requestCancel, onTerminal, onReconciled };

  const release = useCallback(() => {
    tokenRef.current += 1;
    runIdRef.current = null;
    setActive(false);
    setObserving(false);
    setRecovery(null);
    setCancelState(null);
  }, []);

  // A series switch drops the old series' run entirely (and invalidates its
  // in-flight recovery reads) before the new series adopts its own.
  useEffect(() => () => release(), [scopeId, release]);

  const adopt = useCallback((runId = null) => {
    tokenRef.current += 1;
    runIdRef.current = runId;
    setActive(true);
    setObserving(true);
    setRecovery(null);
    setCancelState(null);
  }, []);

  const { latest, closed } = usePipelineProgress(urlBuilder, [scopeId], { enabled: active && observing });

  // Terminal frame for the owned run.
  useEffect(() => {
    if (!active || !observing || !latest || !RUN_ENDED.has(latest.type)) return;
    if (runIdRef.current && latest.runId && latest.runId !== runIdRef.current) return;
    release();
    callbacksRef.current.onTerminal?.(latest);
  }, [active, observing, latest, release]);

  // `detached`: the stream is not attached, so an "still active" answer means
  // the run needs the Reattach affordance; attached (a false cancel while the
  // stream is live) leaves the observation alone.
  const reconcile = useCallback(async ({ detached }) => {
    const token = tokenRef.current;
    const forScope = scopeRef.current;
    if (detached) setRecovery('checking');
    let status = null;
    try {
      status = await callbacksRef.current.fetchStatus(forScope, { silent: true });
    } catch {
      status = null;
    }
    if (token !== tokenRef.current || forScope !== scopeRef.current) return;
    if (typeof status?.active !== 'boolean') {
      setRecovery(detached ? 'unknown' : null);
      return;
    }
    if (status.active) {
      setRecovery(detached ? 'disconnected' : null);
      return;
    }
    const canceled = cancelStateRef.current === 'pending';
    release();
    callbacksRef.current.onReconciled?.({ canceled });
  }, [release]);

  // The stream ended with no terminal frame for this run (404 on a pruned run,
  // or a mismatched frame): stop observing and reconcile against the server.
  // Transient CONNECTING errors never set `closed`, so they don't land here.
  useEffect(() => {
    if (!active || !observing || !closed) return;
    const ownedTerminal = latest && RUN_ENDED.has(latest.type)
      && (!runIdRef.current || !latest.runId || latest.runId === runIdRef.current);
    if (ownedTerminal) return;
    setObserving(false);
    reconcile({ detached: true });
  }, [active, observing, closed, latest, reconcile]);

  const cancel = useCallback(async () => {
    const token = tokenRef.current;
    const forScope = scopeRef.current;
    setCancelState('requesting');
    let res = null;
    try {
      res = await callbacksRef.current.requestCancel(forScope);
    } catch {
      res = null;
    }
    if (token !== tokenRef.current || forScope !== scopeRef.current) return;
    if (res?.canceled) {
      // Accepted: stay visibly pending until the terminal frame (or a status
      // read) shows the server settled.
      setCancelState('pending');
      return;
    }
    // Nothing to cancel (already evicted) or the request failed: the cancel
    // can't produce a terminal frame, so reconcile instead of waiting on one.
    setCancelState(null);
    await reconcile({ detached: !observingRef.current });
  }, [reconcile]);

  const reattach = useCallback(() => {
    setRecovery(null);
    setObserving(true);
  }, []);

  const retryStatus = useCallback(() => reconcile({ detached: true }), [reconcile]);

  return { active, observing, recovery, cancelState, adopt, cancel, reattach, retryStatus };
}
