import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';

const CLEAR_DELAY_MS = 5000;

const mergeStep = (prev, data) => {
  const entry = { step: data.step, status: data.status, message: data.message, timestamp: data.timestamp };
  const existing = prev.findIndex(s => s.step === data.step);
  if (existing < 0) return [...prev, entry];
  const next = [...prev];
  next[existing] = entry;
  return next;
};

const isLive = (op) => !!op && !op.completed && !op.error;

/**
 * Hook for socket-based app operations (update, standardize) with live step tracking.
 *
 * The server owns the in-flight set (`app:operations:active`) because these
 * operations run for minutes and outlive the page that started them. The hook
 * subscribes for its whole lifetime and rehydrates on mount, so collapsing the
 * row — or navigating away from /apps and back — never loses a running
 * operation (#3435). Operations are tracked per app id, so two apps updating
 * from different tabs are both represented rather than one shadowing the other.
 *
 * `appId` scopes a single-app surface (an app's Overview tab) to its own
 * operation; omit it on the multi-app list, which reports every operation.
 */
export function useAppOperation({ onComplete, appId: scopeAppId } = {}) {
  const [operations, setOperations] = useState({});
  const clearTimersRef = useRef({});
  const onCompleteRef = useRef(onComplete);

  useEffect(() => { onCompleteRef.current = onComplete; });

  useEffect(() => () => {
    for (const timer of Object.values(clearTimersRef.current)) clearTimeout(timer);
  }, []);

  const drop = useCallback((appId) => {
    clearTimeout(clearTimersRef.current[appId]);
    delete clearTimersRef.current[appId];
    setOperations(prev => {
      if (!prev[appId]) return prev;
      const next = { ...prev };
      delete next[appId];
      return next;
    });
  }, []);

  useEffect(() => {
    const inScope = (appId) => !scopeAppId || appId === scopeAppId;
    // Frames from an older server carry no appId; attribute them to the app we
    // are scoped to (or the only live operation) rather than dropping them.
    const resolveAppId = (data, current) => {
      if (data?.appId) return data.appId;
      if (scopeAppId) return scopeAppId;
      const live = Object.values(current).filter(isLive);
      return live.length === 1 ? live[0].appId : null;
    };

    const patch = (data, updater) => setOperations(prev => {
      const appId = resolveAppId(data, prev);
      if (!appId || !inScope(appId)) return prev;
      const current = prev[appId] || { appId, appName: null, type: 'update', steps: [] };
      return { ...prev, [appId]: updater(current) };
    });

    const onActive = ({ operations: active = [] } = {}) => {
      setOperations(prev => {
        const next = {};
        for (const op of active) {
          if (!inScope(op.appId)) continue;
          const current = prev[op.appId];
          next[op.appId] = {
            appId: op.appId,
            appName: op.appName ?? current?.appName ?? null,
            type: op.type,
            steps: op.steps?.length ? op.steps : (current?.steps || []),
            error: null,
            errorCode: null,
            completed: false
          };
        }
        // The server drops an operation from the set the moment it ends, so keep
        // entries that already reported a terminal outcome — they're mid-display
        // and their own clear timer removes them. Anything else we still believed
        // was running is genuinely gone (e.g. the server restarted).
        for (const [appId, op] of Object.entries(prev)) {
          if (!next[appId] && !isLive(op)) next[appId] = op;
        }
        return next;
      });
    };

    const onStep = (data) => patch(data, current => ({ ...current, steps: mergeStep(current.steps, data) }));

    const onError = (data) => {
      // A refused duplicate dispatch says nothing about the run already in
      // flight — surface it without marking that run failed.
      if (data?.duplicate) {
        toast.error(data.message || 'That operation is already running');
        // Re-sync so the optimistic entry this dispatch created is replaced by
        // the operation the server is actually running.
        socket.emit('app:operations:list');
        return;
      }
      patch(data, current => ({ ...current, error: data?.message || 'Operation failed', errorCode: data?.code || null }));
    };

    const onDone = (data) => {
      patch(data, current => {
        const warning = data?.steps?.find(s => s.warning)?.warning;
        const steps = warning
          ? current.steps.map(s => (s.step === 'restart' && s.status === 'running' ? { ...s, status: 'warning', message: warning } : s))
          : current.steps;
        // `success: false` is a failed run, not a finished one — don't report it
        // as "complete" the way the pre-#3435 hook did.
        return data?.success === false
          ? { ...current, steps, error: 'Operation did not complete successfully' }
          : { ...current, steps, completed: true };
      });
      const appId = data?.appId || scopeAppId;
      if (appId) {
        clearTimeout(clearTimersRef.current[appId]);
        clearTimersRef.current[appId] = setTimeout(() => drop(appId), CLEAR_DELAY_MS);
      }
      onCompleteRef.current?.();
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
  }, [scopeAppId, drop]);

  const start = useCallback((type, appId, appName, options = {}) => {
    clearTimeout(clearTimersRef.current[appId]);
    delete clearTimersRef.current[appId];
    setOperations(prev => ({ ...prev, [appId]: { appId, appName, type, steps: [], error: null, errorCode: null, completed: false } }));
    socket.emit(type === 'update' ? 'app:update' : 'app:standardize', { appId, ...options });
  }, []);

  const startUpdate = useCallback((appId, appName, options = {}) => start('update', appId, appName, options), [start]);
  const startStandardize = useCallback((appId, appName) => start('standardize', appId, appName), [start]);

  const list = Object.values(operations);
  // Single-operation view, for surfaces scoped to one app (Overview tab).
  const primary = list.find(isLive) || list[0] || null;

  return {
    operations: list,
    // Derived, not a separate flag: a stale `isOperating` was how the old hook
    // let a finished operation keep every row's buttons disabled.
    isOperating: list.some(isLive),
    steps: primary?.steps || [],
    error: primary?.error ?? null,
    errorCode: primary?.errorCode ?? null,
    completed: primary?.completed ?? false,
    operatingAppId: primary?.appId ?? null,
    operatingAppName: primary?.appName ?? null,
    operationType: primary?.type ?? null,
    startUpdate,
    startStandardize,
    dismiss: drop
  };
}
