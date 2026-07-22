import { useState, useEffect, useRef, useCallback } from 'react';
import { uuidv4 } from '../lib/uuid.js';
import useMounted from './useMounted.js';
import toast from '../components/ui/Toast';

const newQueueId = () => uuidv4();

/**
 * Client-side serial batch queue for VideoGen (#2834). Owns the queue array,
 * the running-item marker, and the worker effect that pumps the head of the
 * queue whenever nothing is generating.
 *
 * The caller supplies:
 *   - `generating` — the page's in-flight flag; the worker parks while true.
 *   - `runGeneration(payload)` — runs one payload through the SSE pipeline and
 *     resolves/rejects when the job settles. Held on a ref so the worker always
 *     calls the latest closure without re-subscribing the effect on every
 *     render (the page recreates runGeneration each render).
 *
 * Returns the queue state plus `enqueue` / `removeFromQueue` /
 * `clearFinishedQueue` / `cancelRunning` mutators.
 */
export function useVideoGenQueue({ generating, runGeneration }) {
  // Each item snapshots the params at enqueue time so the user can keep editing
  // the form while jobs are in flight without affecting the queued ones. The
  // active generation is held in the page's `generating`/`progress`;
  // `runningQueueId` (if set) marks which queued item it represents.
  const [queue, setQueue] = useState([]);
  const [runningQueueId, setRunningQueueId] = useState(null);

  // Always call the freshest runGeneration without listing it in the worker
  // effect's deps — the page recreates it every render, and re-running the
  // worker on identity churn would re-dispatch.
  const runGenerationRef = useRef(runGeneration);
  runGenerationRef.current = runGeneration;

  // BUSY-backoff retry timer for the queue worker, held on a ref so it can be
  // cleared from a stable unmount cleanup regardless of how often the worker
  // effect re-runs (setQueue/setRunningQueueId churn consumes the effect's own
  // cleanup before the async .catch ever assigns the timer, so the effect
  // cleanup alone can't be trusted to clear it).
  const busyRetryTimerRef = useRef(null);
  // Generation token for the queue-worker dispatch. Bumped only when a new item
  // is actually dispatched; a stale async then/catch/finally (from a superseded
  // dispatch or after unmount) sees a moved-on token and bails without touching
  // state or re-releasing the running slot.
  const queueWorkerGenRef = useRef(0);
  // Unmount guard for the queue worker's deferred callbacks (StrictMode-safe:
  // resets to true on mount, so the mount→cleanup→remount cycle can't strand it
  // false and freeze the queue worker). A dedicated unmount cleanup clears any
  // pending BUSY-retry timer — this is the authoritative clear (the worker
  // effect's own cleanup is unreliable, see the queue-worker effect below).
  const mountedRef = useMounted();
  useEffect(() => () => {
    if (busyRetryTimerRef.current) {
      clearTimeout(busyRetryTimerRef.current);
      busyRetryTimerRef.current = null;
    }
  }, []);

  const enqueue = useCallback((payload) => {
    // Strip File blobs for snapshot — re-using a File across multiple queued
    // submissions is fine, but we need a stable JSON-ish summary for the
    // queue UI display. Hold the Files in `_blobs` separately.
    const { sourceImage, lastImage, audioFile: audioBlob, ...summary } = payload;
    setQueue((q) => [...q, {
      id: newQueueId(),
      status: 'pending',
      params: summary,
      _blobs: {
        sourceImage: sourceImage instanceof File ? sourceImage : null,
        lastImage: lastImage instanceof File ? lastImage : null,
        audioFile: audioBlob instanceof File ? audioBlob : null,
      },
      enqueuedAt: Date.now(),
    }]);
    toast.success('Added to queue');
  }, []);

  const removeFromQueue = useCallback((id) => {
    setQueue((q) => q.filter((item) => item.id !== id || item.status === 'running'));
  }, []);

  // Drops both successful and errored items — the panel surfaces this as
  // "Clear finished" so the label matches the behavior.
  const clearFinishedQueue = useCallback(() => {
    setQueue((q) => q.filter((item) => item.status !== 'complete' && item.status !== 'error'));
  }, []);

  // Mark the running item errored + release the slot (called from the page's
  // Cancel handler). No-op when nothing is running.
  const cancelRunning = useCallback(() => {
    if (!runningQueueId) return;
    setQueue((q) => q.map((item) => item.id === runningQueueId ? { ...item, status: 'error', error: 'Cancelled' } : item));
    setRunningQueueId(null);
  }, [runningQueueId]);

  // Queue worker — pumps the head of the queue when nothing's running.
  // Runs as an effect so it picks up any newly-enqueued item even while
  // the user is interacting with the form.
  //
  // BUSY backoff: the server's `cancel()` keeps `activeProcess` set until
  // the SIGKILL'd child actually exits (up to ~8s), so a freshly-cancelled
  // item leaving the running slot here will often hit a 409 VIDEO_GEN_BUSY
  // when the worker tries to dispatch the next pending item. Treat that as
  // "not yet" (return the item to pending) instead of marking it errored.
  useEffect(() => {
    if (generating || runningQueueId) return;
    const next = queue.find((item) => item.status === 'pending');
    if (!next) return;
    // Capture a generation token for this dispatch. Every deferred callback
    // below re-checks it (via isCurrent) so a superseded dispatch or an
    // unmount can't set state / re-release the running slot after teardown.
    const myGen = ++queueWorkerGenRef.current;
    const isCurrent = () => mountedRef.current && myGen === queueWorkerGenRef.current;
    setRunningQueueId(next.id);
    setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'running', startedAt: Date.now() } : item));
    const payload = { ...next.params };
    if (next._blobs?.sourceImage) payload.sourceImage = next._blobs.sourceImage;
    if (next._blobs?.lastImage) payload.lastImage = next._blobs.lastImage;
    if (next._blobs?.audioFile) payload.audioFile = next._blobs.audioFile;
    let busyRetry = false;
    runGenerationRef.current(payload).then((res) => {
      if (!isCurrent()) return;
      setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'complete', result: res } : item));
    }).catch((err) => {
      if (!isCurrent()) return;
      const isBusy = /already in progress|VIDEO_GEN_BUSY|409/i.test(err?.message || '');
      if (isBusy) {
        // Bounce the item back to pending after a short delay so the worker
        // re-tries once the server's previous child has finished cleaning up.
        busyRetry = true;
        setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'pending', startedAt: undefined } : item));
        busyRetryTimerRef.current = setTimeout(() => {
          busyRetryTimerRef.current = null;
          // Stale/unmounted: a fresh dispatch (or teardown) already owns the
          // slot, so don't release it out from under whatever runs now.
          if (!isCurrent()) return;
          setRunningQueueId((curr) => (curr === next.id ? null : curr));
        }, 1500);
        return;
      }
      setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'error', error: err.message } : item));
    }).finally(() => {
      // For the BUSY branch the timeout above releases the slot — releasing
      // it here too would let the worker immediately re-fire and hit the
      // same 409 before the server's old child has exited.
      if (isCurrent() && !busyRetry) setRunningQueueId(null);
    });
    // Effect cleanup: cancel a pending BUSY-retry setTimeout. This is a
    // best-effort clear; because the worker effect re-runs on every
    // setQueue/setRunningQueueId, this cleanup is usually consumed before the
    // async .catch assigns the timer — the authoritative clear lives in the
    // dedicated unmount effect above, and the isCurrent()/mountedRef guards in
    // the timer callback prevent any stale setState.
    return () => {
      if (busyRetryTimerRef.current) {
        clearTimeout(busyRetryTimerRef.current);
        busyRetryTimerRef.current = null;
      }
    };
  }, [queue, generating, runningQueueId, mountedRef]);

  return { queue, runningQueueId, enqueue, removeFromQueue, clearFinishedQueue, cancelRunning };
}
