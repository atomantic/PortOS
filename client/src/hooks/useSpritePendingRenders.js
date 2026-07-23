import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { getMediaJob, listMediaJobs } from '../services/apiMediaJobs.js';

/**
 * Shared in-flight render tracking for the sprite workflows (#2896 reference
 * renders, #2897 walk videos): a `key → jobId` map with mount-time
 * rehydration from the media-job queue and a 4s poll that drops terminal
 * jobs, toasts failures, and fires deferred `onChanged()` refetch sweeps.
 * This is the client counterpart of the server's `createMediaJobImageHook`
 * scaffold — one copy of the subtle invariants (the `'submitting'` sentinel
 * that blocks a double paid render, the 404-only "gone" heuristic so a
 * transient fetch failure doesn't re-enable Generate mid-render, the
 * local-wins rehydrate merge) instead of one per workflow.
 *
 * - `kind`/`tagKey`/`tagField`: which jobs belong to this workflow and which
 *   tag field keys the map (e.g. kind 'image' + `spriteRef.target`, or kind
 *   'video' + `spriteWalk.direction`).
 * - `sweepDelays(finishedCount) → ms[]`: how long after a job finishes to
 *   refetch — workflows whose completion hook does slow server-side work
 *   (the walk postprocess) sweep later/twice.
 * - `failMessage(key, job)`: the toast for a failed job.
 */
export function useSpritePendingRenders({
  recordId, kind, tagKey, tagField, onChanged,
  sweepDelays = (finished) => (finished > 1 ? [500, 2500] : [500]),
  failMessage = (key, job) => `Render failed for ${key}: ${job?.error || 'see media jobs'}`,
}) {
  const [pendingJobs, setPendingJobs] = useState({});

  // Rehydrate in-flight renders on mount/record switch — a reload or
  // navigate-away-and-back would otherwise lose the map and re-enable
  // Generate mid-render, inviting a duplicate paid render for the same key.
  // Locally-started jobs win over the snapshot on key collision.
  useEffect(() => {
    let stale = false;
    listMediaJobs({ kind, owner: 'sprites' }, { silent: true })
      .then((jobs) => {
        if (stale) return;
        const active = {};
        for (const job of jobs || []) {
          const tag = job.params?.[tagKey];
          if (tag?.recordId === recordId && ['queued', 'running'].includes(job.status)) {
            active[tag[tagField]] = job.id;
          }
        }
        if (Object.keys(active).length > 0) setPendingJobs((prev) => ({ ...active, ...prev }));
      })
      .catch(() => {}); // best-effort — the poll and server guards still apply
    return () => { stale = true; };
  }, [recordId, kind, tagKey, tagField]);

  // Poll in-flight jobs (parallel — they're independent); on a terminal
  // state drop the entry and fire the workflow's refetch sweep(s).
  useEffect(() => {
    if (Object.keys(pendingJobs).length === 0) return undefined;
    const timer = setInterval(async () => {
      const entries = Object.entries(pendingJobs).filter(([, jobId]) => jobId !== 'submitting');
      const results = await Promise.all(entries.map(async ([key, jobId]) => {
        try {
          return { key, job: await getMediaJob(jobId) };
        } catch (err) {
          // Only a 404 means the job is truly gone — a transient fetch
          // failure must NOT drop the entry (that would re-enable Generate
          // mid-render and stop the auto-refresh); retry on the next tick.
          return { key, job: null, gone: err?.status === 404 };
        }
      }));
      const finished = results.filter(({ job, gone }) => (job ? ['completed', 'failed', 'canceled'].includes(job.status) : gone));
      if (finished.length === 0) return;
      setPendingJobs((prev) => {
        const next = { ...prev };
        for (const { key } of finished) delete next[key];
        return next;
      });
      for (const { key, job } of finished) {
        if (job?.status === 'failed') toast.error(failMessage(key, job));
      }
      for (const delay of sweepDelays(finished.length)) setTimeout(onChanged, delay);
    }, 4000);
    // sweepDelays/failMessage are per-workflow config, not reactive inputs.
    return () => clearInterval(timer);
  }, [pendingJobs, onChanged]);

  // Sentinel jobId while the enqueue request is in flight — reserves the key
  // immediately so a double-click (or a slow multipart upload) can't submit
  // two paid renders. The poll skips sentinel entries.
  const beginSubmit = (key) => setPendingJobs((prev) => ({ ...prev, [key]: 'submitting' }));
  const resolveSubmit = (key, jobId) => setPendingJobs((prev) => ({ ...prev, [key]: jobId }));
  const cancelSubmit = (key) => setPendingJobs((prev) => {
    const next = { ...prev };
    if (next[key] === 'submitting') delete next[key];
    return next;
  });

  return { pendingJobs, beginSubmit, resolveSubmit, cancelSubmit };
}

export default useSpritePendingRenders;
