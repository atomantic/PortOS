import { useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { getMediaJob } from '../services/apiMediaJobs';

/**
 * Subscribe to live progress for a single mediaJobQueue job (image-gen
 * today, video-gen once a caller passes kind='video'). Filters socket
 * events by jobId so multiple instances of this hook coexist (one per
 * comic panel / storyboard scene) without cross-talk.
 *
 * Returns:
 *   {
 *     status: 'unknown' | 'queued' | 'running' | 'completed' | 'failed' | 'canceled',
 *     progress, step, totalSteps, currentImage,
 *     filename, path, error,
 *   }
 *
 * Initial state is hydrated from GET /api/media-jobs/:id so navigating
 * back to a page mid-render picks up the in-flight job's snapshot
 * instead of showing an empty preview until the next event lands.
 */
const INITIAL_STATE = Object.freeze({
  status: 'unknown',
  progress: 0,
  step: 0,
  totalSteps: null,
  currentImage: null,
  filename: null,
  path: null,
  error: null,
});

export default function useMediaJobProgress(jobId, { kind = 'image' } = {}) {
  const [state, setState] = useState(INITIAL_STATE);
  // SYNCHRONOUS reset when `jobId` changes — React's "adjusting state on
  // prop change" pattern. Doing this in a `useEffect` (as we used to)
  // means the FIRST render after `jobId` flips still returns the previous
  // job's `status` / `filename`. Consumers that fire `onJobCompleted` on
  // status='completed' would mis-attribute the prior job's filename to the
  // NEW jobId and prematurely clear the rest of a queued batch. With this
  // pattern React discards the in-progress render and re-runs the
  // component immediately, so the new jobId is never observed against
  // stale state.
  const prevJobIdRef = useRef(jobId);
  if (prevJobIdRef.current !== jobId) {
    prevJobIdRef.current = jobId;
    setState(INITIAL_STATE);
  }
  // Track mount so the initial fetch's setState doesn't fire after unmount
  // (the panel could be removed while the GET is in flight).
  //
  // The set-in-effect-setup pattern (NOT relying on `useRef(true)`'s initial
  // value alone) is required: React 18 StrictMode in dev fires
  // mount → cleanup → mount, but the ref is preserved across the simulated
  // remount. Without re-setting `true` in setup, cleanup flips it to false
  // and it never goes back up — the initial fetch's `.then` permanently
  // no-ops for every dev render.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!jobId) return undefined;

    // Hydrate from the server. The job may already be completed (the user
    // reloaded after the render finished) — without this fetch the UI
    // would never reflect that.
    let canceled = false;
    getMediaJob(jobId).then((job) => {
      if (canceled || !mountedRef.current) return;
      setState((prev) => ({
        ...prev,
        status: job.status || 'unknown',
        filename: job.result?.filename || prev.filename,
        path: job.result?.path || prev.path,
        error: job.error || prev.error,
      }));
    }).catch(() => {
      // 404 (job past 24h archive TTL) and any other failure stay silent;
      // MediaJobThumb's `fallbackFilename` path bypasses this fetch entirely
      // when the parent already has the completed render's filename.
    });

    const evtPrefix = kind === 'video' ? 'video-gen' : 'image-gen';
    const onStarted = (data) => {
      if (data.generationId !== jobId) return;
      setState((prev) => {
        const totalSteps = data.totalSteps ?? prev.totalSteps;
        if (prev.status === 'running' && totalSteps === prev.totalSteps) return prev;
        return { ...prev, status: 'running', totalSteps };
      });
    };
    // Diffusion runners throttle `currentImage` but still emit identical
    // step/progress between frames. Return prev unchanged on a no-op tick so
    // each panel doesn't re-render unnecessarily — N panels × every tick
    // adds up across a comic page.
    const onProgress = (data) => {
      if (data.generationId !== jobId) return;
      setState((prev) => {
        const next = {
          ...prev,
          status: 'running',
          progress: data.progress ?? prev.progress,
          step: data.step ?? prev.step,
          totalSteps: data.totalSteps ?? prev.totalSteps,
          currentImage: data.currentImage ?? prev.currentImage,
        };
        if (
          next.status === prev.status
          && next.progress === prev.progress
          && next.step === prev.step
          && next.totalSteps === prev.totalSteps
          && next.currentImage === prev.currentImage
        ) return prev;
        return next;
      });
    };
    const onCompleted = (data) => {
      if (data.generationId !== jobId) return;
      setState((prev) => ({
        ...prev,
        status: 'completed',
        filename: data.filename ?? prev.filename,
        path: data.path ?? prev.path,
      }));
    };
    const onFailed = (data) => {
      if (data.generationId !== jobId) return;
      // The mediaJobQueue collapses user-canceled jobs into a *:failed
      // socket event (SIGTERM looks like a failure to the underlying gen
      // module) while the persisted job.status is actually 'canceled'.
      // Re-fetch the authoritative state so MediaJobThumb's canceled UI
      // is reachable in live sessions, not just on reload.
      setState((prev) => ({ ...prev, status: 'failed', error: data.error || 'failed' }));
      getMediaJob(jobId).then((job) => {
        if (canceled || !mountedRef.current) return;
        if (job?.status === 'canceled') {
          setState((prev) => ({ ...prev, status: 'canceled', error: job.error || prev.error }));
        }
      }).catch(() => {});
    };

    socket.on(`${evtPrefix}:started`, onStarted);
    socket.on(`${evtPrefix}:progress`, onProgress);
    socket.on(`${evtPrefix}:completed`, onCompleted);
    socket.on(`${evtPrefix}:failed`, onFailed);
    return () => {
      canceled = true;
      socket.off(`${evtPrefix}:started`, onStarted);
      socket.off(`${evtPrefix}:progress`, onProgress);
      socket.off(`${evtPrefix}:completed`, onCompleted);
      socket.off(`${evtPrefix}:failed`, onFailed);
    };
  }, [jobId, kind]);

  return state;
}
