import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../services/socket';

const CLEAR_DELAY_MS = 5000;

const mergeStep = (prev, data) => {
  const entry = { step: data.step, status: data.status, message: data.message, timestamp: data.timestamp };
  const existing = prev.findIndex(s => s.step === data.step);
  if (existing < 0) return [...prev, entry];
  const next = [...prev];
  next[existing] = entry;
  return next;
};

/**
 * Hook for socket-based app operations (update, standardize) with live step tracking.
 *
 * The server owns the in-flight set (`app:operations:active`) because these
 * operations run for minutes and outlive the page that started them. The hook
 * subscribes for its whole lifetime and rehydrates on mount, so collapsing the
 * row — or navigating away from /apps and back — never loses a running
 * operation (#3435).
 *
 * `appId` scopes a single-app surface (an app's Overview tab) to its own
 * operation; omit it on the multi-app list, which reports whichever operation
 * is running.
 */
export function useAppOperation({ onComplete, appId: scopeAppId } = {}) {
  const [steps, setSteps] = useState([]);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState(null);
  const [completed, setCompleted] = useState(false);
  const clearTimerRef = useRef(null);
  const onCompleteRef = useRef(onComplete);
  // Mirrors the state the socket handlers need to read without re-subscribing
  // on every render: which app we're tracking, and whether that operation has
  // already reported a terminal outcome — so the `operations: []` broadcast
  // that follows a completion doesn't wipe the result off screen.
  const trackedRef = useRef({ appId: null, finished: false });

  useEffect(() => { onCompleteRef.current = onComplete; });

  useEffect(() => () => clearTimeout(clearTimerRef.current), []);

  const track = useCallback((next) => {
    clearTimeout(clearTimerRef.current);
    trackedRef.current = { appId: next.appId, finished: false };
    setOperation(next);
    setError(null);
    setCompleted(false);
  }, []);

  const reset = useCallback(() => {
    clearTimeout(clearTimerRef.current);
    trackedRef.current = { appId: null, finished: false };
    setSteps([]);
    setOperation(null);
    setError(null);
    setCompleted(false);
  }, []);

  useEffect(() => {
    // A frame is ours when it names the app we track (or the app this hook is
    // scoped to), or when it carries no appId at all — an older server that
    // predates the per-app broadcast.
    const isOurs = (data) => {
      if (!data?.appId) return true;
      if (scopeAppId) return data.appId === scopeAppId;
      return !trackedRef.current.appId || data.appId === trackedRef.current.appId;
    };

    const onActive = ({ operations = [] } = {}) => {
      const inScope = scopeAppId ? operations.filter(op => op.appId === scopeAppId) : operations;
      const active = inScope.find(op => op.appId === trackedRef.current.appId) || inScope[0];
      if (active) {
        track({ appId: active.appId, appName: active.appName, type: active.type });
        setSteps(active.steps || []);
        return;
      }
      // Nothing running server-side. Leave a just-finished result on screen and
      // only clear when we still believe an operation is in flight (e.g. the
      // server restarted mid-run, so the work is genuinely gone).
      if (trackedRef.current.appId && !trackedRef.current.finished) reset();
    };

    const onStep = (data) => {
      if (!isOurs(data)) return;
      setSteps(prev => mergeStep(prev, data));
    };

    const onError = (data) => {
      if (!isOurs(data)) return;
      trackedRef.current.finished = true;
      setError(data?.message || 'Operation failed');
    };

    const onDone = (data) => {
      if (!isOurs(data)) return;
      const warning = data?.steps?.find(s => s.warning)?.warning;
      if (warning) {
        setSteps(prev => prev.map(s => (
          s.step === 'restart' && s.status === 'running' ? { ...s, status: 'warning', message: warning } : s
        )));
      }
      trackedRef.current.finished = true;
      setCompleted(true);
      onCompleteRef.current?.();
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(reset, CLEAR_DELAY_MS);
    };

    const requestActive = () => socket.emit('app:operations:list');

    socket.on('app:operations:active', onActive);
    socket.on('app:update:step', onStep);
    socket.on('app:update:error', onError);
    socket.on('app:update:complete', onDone);
    socket.on('app:standardize:step', onStep);
    socket.on('app:standardize:error', onError);
    socket.on('app:standardize:complete', onDone);
    socket.on('connect', requestActive);
    // The socket is normally connected long before this page mounts, so the
    // server's connect-time push already fired — ask for the set again.
    requestActive();

    return () => {
      socket.off('app:operations:active', onActive);
      socket.off('app:update:step', onStep);
      socket.off('app:update:error', onError);
      socket.off('app:update:complete', onDone);
      socket.off('app:standardize:step', onStep);
      socket.off('app:standardize:error', onError);
      socket.off('app:standardize:complete', onDone);
      socket.off('connect', requestActive);
    };
  }, [track, reset, scopeAppId]);

  const start = useCallback((type, appId, appName) => {
    track({ appId, appName, type });
    setSteps([]);
    socket.emit(type === 'update' ? 'app:update' : 'app:standardize', { appId });
  }, [track]);

  const startUpdate = useCallback((appId, appName) => start('update', appId, appName), [start]);
  const startStandardize = useCallback((appId, appName) => start('standardize', appId, appName), [start]);

  return {
    steps,
    // Derived, not a separate flag: a stale `isOperating` was how the old hook
    // let a finished operation keep every other row's buttons disabled.
    isOperating: !!operation && !completed && !error,
    operatingAppId: operation?.appId ?? null,
    operatingAppName: operation?.appName ?? null,
    operationType: operation?.type ?? null,
    error,
    completed,
    startUpdate,
    startStandardize,
    dismiss: reset
  };
}
