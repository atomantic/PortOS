import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { cancelImageGen } from '../services/apiImageVideo';

// useImageGenQueue — work-scoped live queue of in-flight image renders.
//
// Subscribes once to the global image-gen:* socket events. SceneCard calls
// `register({jobId, sceneId, sceneLabel})` after kicking off a render so the
// hook can label rows; the hook then matches incoming events by jobId. The
// queue auto-prunes terminal jobs after 1s so the dock briefly flashes "done"
// before disappearing.
//
// Returns { queue, runningCount, register, stopAll, stopOne }.
export default function useImageGenQueue() {
  const [queue, setQueue] = useState([]);
  // Authoritative copy lives in a ref so socket callbacks don't see stale
  // closures. setQueue is only called via patch().
  const queueRef = useRef([]);
  const pruneTimersRef = useRef(new Map());

  const patch = useCallback((updater) => {
    const next = updater(queueRef.current);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const schedulePrune = useCallback((jobId) => {
    const existing = pruneTimersRef.current.get(jobId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      pruneTimersRef.current.delete(jobId);
      patch((prev) => prev.filter((q) => q.jobId !== jobId));
    }, 1000);
    pruneTimersRef.current.set(jobId, t);
  }, [patch]);

  const register = useCallback(({ jobId, sceneId, sceneLabel }) => {
    if (!jobId) return;
    patch((prev) => {
      const idx = prev.findIndex((q) => q.jobId === jobId);
      const entry = {
        jobId,
        sceneId: sceneId || null,
        sceneLabel: sceneLabel || 'Scene',
        status: 'queued',
        progress: 0,
        eta: null,
        registeredAt: Date.now(),
      };
      if (idx < 0) return [...prev, entry];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...entry };
      return copy;
    });
  }, [patch]);

  useEffect(() => {
    const onStarted = (data) => {
      patch((prev) => prev.map((q) => q.jobId === data.generationId
        ? { ...q, status: 'running', totalSteps: data.totalSteps ?? null }
        : q));
    };
    const onProgress = (data) => {
      patch((prev) => prev.map((q) => q.jobId === data.generationId
        ? {
            ...q,
            status: 'running',
            progress: data.progress ?? q.progress ?? 0,
            eta: data.eta ?? q.eta ?? null,
            step: data.step ?? q.step ?? 0,
            totalSteps: data.totalSteps ?? q.totalSteps ?? null,
          }
        : q));
    };
    const onCompleted = (data) => {
      patch((prev) => prev.map((q) => q.jobId === data.generationId
        ? { ...q, status: 'done', progress: 1 }
        : q));
      schedulePrune(data.generationId);
    };
    const onFailed = (data) => {
      patch((prev) => prev.map((q) => q.jobId === data.generationId
        ? { ...q, status: 'error', error: data.error || data.message || null }
        : q));
      schedulePrune(data.generationId);
    };
    socket.on('image-gen:started', onStarted);
    socket.on('image-gen:progress', onProgress);
    socket.on('image-gen:completed', onCompleted);
    socket.on('image-gen:failed', onFailed);
    return () => {
      socket.off('image-gen:started', onStarted);
      socket.off('image-gen:progress', onProgress);
      socket.off('image-gen:completed', onCompleted);
      socket.off('image-gen:failed', onFailed);
    };
  }, [patch, schedulePrune]);

  useEffect(() => () => {
    for (const t of pruneTimersRef.current.values()) clearTimeout(t);
    pruneTimersRef.current.clear();
  }, []);

  const stopOne = useCallback(async (jobId) => {
    if (!jobId) return;
    await cancelImageGen({ jobId }).catch(() => {});
    patch((prev) => prev.filter((q) => q.jobId !== jobId));
  }, [patch]);

  const stopAll = useCallback(async () => {
    await cancelImageGen({ all: true }).catch(() => {});
    patch((prev) => prev.filter((q) => q.status !== 'queued' && q.status !== 'running'));
  }, [patch]);

  const runningCount = queue.filter((q) => q.status === 'queued' || q.status === 'running').length;

  return { queue, runningCount, register, stopOne, stopAll };
}
