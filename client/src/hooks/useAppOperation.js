import { useState, useCallback, useEffect, useRef } from 'react';
import socket from '../services/socket';

/**
 * Hook for socket-based app operations (update, standardize) with live step tracking.
 */
export function useAppOperation({ onComplete } = {}) {
  const [steps, setSteps] = useState([]);
  const [isOperating, setIsOperating] = useState(false);
  const [operatingAppId, setOperatingAppId] = useState(null);
  const [operationType, setOperationType] = useState(null);
  const [error, setError] = useState(null);
  const [completed, setCompleted] = useState(false);
  const clearTimerRef = useRef(null);

  // Clear auto-dismiss timer on unmount
  useEffect(() => () => clearTimeout(clearTimerRef.current), []);

  const handleStep = useCallback((data) => {
    setSteps(prev => {
      const existing = prev.findIndex(s => s.step === data.step);
      const entry = { step: data.step, status: data.status, message: data.message, timestamp: data.timestamp };
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }, []);

  const finish = useCallback((opType) => {
    setIsOperating(false);
    setCompleted(true);
    clearTimerRef.current = setTimeout(() => {
      setSteps([]);
      setCompleted(false);
      setOperatingAppId(null);
      setOperationType(null);
      setError(null);
    }, 5000);
  }, []);

  const startUpdate = useCallback((appId) => {
    clearTimeout(clearTimerRef.current);
    setSteps([]);
    setError(null);
    setCompleted(false);
    setIsOperating(true);
    setOperatingAppId(appId);
    setOperationType('update');

    const onStep = (data) => handleStep(data);
    const onError = (data) => {
      setError(data.message);
      setIsOperating(false);
      cleanup();
    };
    const onDone = (data) => {
      if (data.steps?.some(s => s.warning)) {
        setSteps(prev => prev.map(s => s.step === 'restart' && s.status === 'running' ? { ...s, status: 'warning', message: data.steps.find(ds => ds.warning)?.warning } : s));
      }
      finish('update');
      onComplete?.();
      cleanup();
    };
    const cleanup = () => {
      socket.off('app:update:step', onStep);
      socket.off('app:update:error', onError);
      socket.off('app:update:complete', onDone);
    };

    socket.on('app:update:step', onStep);
    socket.on('app:update:error', onError);
    socket.on('app:update:complete', onDone);
    socket.emit('app:update', { appId });
  }, [handleStep, finish, onComplete]);

  const startStandardize = useCallback((appId) => {
    clearTimeout(clearTimerRef.current);
    setSteps([]);
    setError(null);
    setCompleted(false);
    setIsOperating(true);
    setOperatingAppId(appId);
    setOperationType('standardize');

    const onStep = (data) => handleStep(data);
    const onError = (data) => {
      setError(data.message);
      setIsOperating(false);
      cleanup();
    };
    const onDone = () => {
      finish('standardize');
      onComplete?.();
      cleanup();
    };
    const cleanup = () => {
      socket.off('app:standardize:step', onStep);
      socket.off('app:standardize:error', onError);
      socket.off('app:standardize:complete', onDone);
    };

    socket.on('app:standardize:step', onStep);
    socket.on('app:standardize:error', onError);
    socket.on('app:standardize:complete', onDone);
    socket.emit('app:standardize', { appId });
  }, [handleStep, finish, onComplete]);

  return { steps, isOperating, operatingAppId, operationType, error, completed, startUpdate, startStandardize };
}
