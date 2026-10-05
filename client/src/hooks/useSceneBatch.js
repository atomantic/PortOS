import { useCallback, useRef, useState } from 'react';
import { cancelMediaJob } from '../services/apiMediaJobs';

/**
 * Counter for one "generate every missing frame / clip" batch on the Music Video
 * board (#10153). The batch owns no socket subscription: the lane's
 * `useSceneRenderLifecycle` reports each tracked job's terminal outcome through
 * `settled`, and this hook only attributes it to the batch that registered the
 * job.
 *
 *   - `begin(total)`          — start a batch (replaces a finished one).
 *   - `register(jobId)`       — a kicked-off job belongs to the batch. After a
 *                               cancel request a late kickoff is canceled at once.
 *   - `kickoffFailed()`       — a scene whose request never reached the queue.
 *   - `completedWithoutJob()` — a synchronous lane that finished inline.
 *   - `settled({ jobId, outcome })` — wire as the lane's `onSettled`.
 *   - `cancel()`              — cancel every queued and running job of the batch
 *                               via the media-job cancel API; the spinners clear
 *                               through the lane's canceled-event path.
 *   - `dismiss()`             — drop a finished batch's summary.
 *
 * `state` is `null` or `{ total, done, failed, canceled, cancelRequested }`.
 */
export default function useSceneBatch() {
  const [state, setState] = useState(null);
  const jobsRef = useRef(new Set());
  const cancelRef = useRef(false);

  const bump = useCallback((field) => setState((prev) => (prev ? { ...prev, [field]: prev[field] + 1 } : prev)), []);
  const cancelJob = (jobId) => { cancelMediaJob(jobId, { silent: true }).catch(() => {}); };

  const begin = useCallback((total) => {
    jobsRef.current = new Set();
    cancelRef.current = false;
    setState({ total, done: 0, failed: 0, canceled: 0, cancelRequested: false });
  }, []);
  const register = useCallback((jobId) => {
    jobsRef.current.add(jobId);
    if (cancelRef.current) cancelJob(jobId);
  }, []);
  const kickoffFailed = useCallback(() => bump(cancelRef.current ? 'canceled' : 'failed'), [bump]);
  const completedWithoutJob = useCallback(() => bump('done'), [bump]);
  const settled = useCallback(({ jobId, outcome }) => {
    if (!jobsRef.current.delete(jobId)) return;
    // A running job canceled over the API reports `failed` before `canceled`.
    bump(outcome === 'completed' ? 'done' : outcome === 'canceled' || cancelRef.current ? 'canceled' : 'failed');
  }, [bump]);
  const cancel = useCallback(() => {
    cancelRef.current = true;
    setState((prev) => (prev ? { ...prev, cancelRequested: true } : prev));
    jobsRef.current.forEach(cancelJob);
  }, []);
  const dismiss = useCallback(() => {
    jobsRef.current = new Set();
    setState(null);
  }, []);

  return { state, begin, register, kickoffFailed, completedWithoutJob, settled, cancel, dismiss };
}
