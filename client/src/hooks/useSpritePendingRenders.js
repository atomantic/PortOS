import { useCallback, useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { getMediaJob, listMediaJobs } from '../services/apiMediaJobs.js';
import useMounted from './useMounted.js';

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
  // Unmount guard for the deferred sweeps (repo convention: deferred work
  // respects unmount). useMounted, NOT a bare ref — a bare ref stays false
  // after StrictMode's dev mount→cleanup→remount and would suppress every
  // sweep for the component's whole dev lifetime.
  const mountedRef = useMounted();

  // The map is keyed by direction/target, NOT by record — so a record switch
  // must clear it or character B inherits character A's in-flight entries and
  // shows "Rendering…" on a direction nothing is rendering. Runs before the
  // rehydrate below (effect order), whose async merge then refills it with
  // B's real jobs. Load-bearing now that the hook is owned by the page and
  // survives switching records (#2931) — previously it unmounted with the
  // workflow only when the character had no locked main.
  useEffect(() => { setPendingJobs({}); }, [recordId]);

  // Rehydrate in-flight renders on mount/record switch — a reload or
  // navigate-away-and-back would otherwise lose the map and re-enable
  // Generate mid-render, inviting a duplicate paid render for the same key.
  // Locally-started jobs win over the snapshot on key collision.
  useEffect(() => {
    if (!recordId) return undefined;
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
    // Torn down when the effect re-runs (any pendingJobs change) — including
    // the clear-on-record-switch. A poll's `getMediaJob` await can resolve
    // AFTER that teardown; without this flag it would delete a key from the
    // NEW record's freshly-rehydrated map (re-enabling Generate mid-render) or
    // toast a failure for a record no longer shown. Guard every post-await
    // mutation on it.
    let cancelled = false;
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
      if (cancelled) return; // record switched (or map changed) during the await — don't touch the new map
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
      // Sweeps deliberately outlive this effect (dropping a finished entry
      // re-runs it) but not the component — hence the mountedRef gate, not
      // timer cleanup, per the repo's deferred-work convention.
      for (const delay of sweepDelays(finished.length)) {
        setTimeout(() => { if (mountedRef.current) onChanged(); }, delay);
      }
    }, 4000);
    // sweepDelays/failMessage are per-workflow config, not reactive inputs.
    return () => { cancelled = true; clearInterval(timer); };
  }, [pendingJobs, onChanged]);

  // Sentinel jobId while the enqueue request is in flight — reserves the key
  // immediately so a double-click (or a slow multipart upload) can't submit
  // two paid renders. The poll skips sentinel entries. Stable identities
  // (`useCallback([])`, closing only over `setPendingJobs`) so a consumer can
  // depend on them in its own `useCallback`/`useMemo` without churning every
  // render — the Sprites page (#2931) memoizes its action closures on these.
  const beginSubmit = useCallback((key) => setPendingJobs((prev) => ({ ...prev, [key]: 'submitting' })), []);
  const resolveSubmit = useCallback((key, jobId) => setPendingJobs((prev) => ({ ...prev, [key]: jobId })), []);
  const cancelSubmit = useCallback((key) => setPendingJobs((prev) => {
    const next = { ...prev };
    if (next[key] === 'submitting') delete next[key];
    return next;
  }), []);

  return { pendingJobs, beginSubmit, resolveSubmit, cancelSubmit };
}

export default useSpritePendingRenders;
