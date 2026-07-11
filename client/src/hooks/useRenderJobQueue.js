import { useCallback, useMemo, useState } from 'react';

// Per-entry render-job queue controller for the Universe Builder page.
//
// A single render batch can queue several jobs against the SAME entry id
// (`batchPerVariation > 1`, or back-to-back renders on one row), so each
// entry maps to an ARRAY of in-flight jobIds — a scalar would overwrite
// siblings and the row spinner would clear as soon as the first job settled
// while others are still running. Canon entries share this queue too: the
// batch `/render` route compiles canon prompts when the user picks
// "all" / "canon" mode, and those jobs don't route through
// `UniverseCanonSection.renderingJobs`.
//
// Extracted from UniverseBuilder.jsx (#2374) so the queue reducer logic is
// unit-tested in isolation from the page's render orchestration.
export function useRenderJobQueue() {
  // entryId → jobId[] queue for any row with one or more in-flight renders.
  const [pendingByEntryId, setPendingByEntryId] = useState({});

  // First-jobId-per-entry view for components that only need a single
  // subscription per row (MediaJobThumb takes one jobId). When the head
  // finishes we shift it off and the next jobId in the queue takes over.
  const pendingHeadByEntryId = useMemo(() => {
    const out = {};
    for (const [entryId, jobs] of Object.entries(pendingByEntryId)) {
      if (Array.isArray(jobs) && jobs.length > 0) out[entryId] = jobs[0];
    }
    return out;
  }, [pendingByEntryId]);

  // Remove a specific completed jobId from the entry's queue (preferred path —
  // handlers know which jobId finished). When called without a jobId (failure
  // paths that want to bail entirely on the entry), drops every pending job
  // for that entry.
  const clearPendingForEntry = useCallback((entryId, jobId = null) => {
    if (!entryId) return;
    setPendingByEntryId((prev) => {
      const jobs = prev[entryId];
      if (!Array.isArray(jobs) || jobs.length === 0) return prev;
      const next = { ...prev };
      if (jobId == null) {
        delete next[entryId];
        return next;
      }
      const remaining = jobs.filter((j) => j !== jobId);
      if (remaining.length === 0) delete next[entryId];
      else next[entryId] = remaining;
      return next;
    });
  }, []);

  // Append freshly-queued jobs to their per-entry queues. Each `entryJobs`
  // item is `{ jobId, entryRef: { id, kind } }`; only `variation` / `canon`
  // kinds have per-row pending UI, so sheet (and other) kinds are skipped —
  // otherwise their jobIds would accumulate forever with no consumer to clear
  // them.
  const enqueueEntryJobs = useCallback((entryJobs) => {
    if (!Array.isArray(entryJobs) || entryJobs.length === 0) return;
    setPendingByEntryId((prev) => {
      const next = { ...prev };
      for (const { jobId, entryRef } of entryJobs) {
        if (!jobId || !entryRef?.id) continue;
        if (entryRef.kind !== 'variation' && entryRef.kind !== 'canon') continue;
        const existing = Array.isArray(next[entryRef.id]) ? next[entryRef.id] : [];
        next[entryRef.id] = [...existing, jobId];
      }
      return next;
    });
  }, []);

  return {
    pendingByEntryId,
    pendingHeadByEntryId,
    clearPendingForEntry,
    enqueueEntryJobs,
  };
}

export default useRenderJobQueue;
