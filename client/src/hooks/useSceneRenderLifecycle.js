import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { getMediaJob } from '../services/apiMediaJobs';
import { evictOldest, ORPHAN_BUFFER_MAX } from '../lib/boundedMap';
import toast from '../components/ui/Toast';

/**
 * Per-scene async-render lifecycle for a Music Video board lane (reference
 * frame OR i2v clip — #1798). One call owns everything one lane needs to drive
 * its "Rendering…" spinners from media-job socket events:
 *
 *   - `genScenes` — sceneId → true while that scene's render is in flight (the
 *     spinner source).
 *   - a pending-jobs map (jobId → sceneId) so a queued render's terminal event
 *     clears the RIGHT scene's spinner.
 *   - an orphan-terminals map (jobId → failed) for the terminal event that
 *     raced ahead of the kickoff's `trackJob` registration (the HTTP response
 *     and the WebSocket terminal event arrive on separate channels, so a
 *     fast-failing queued job's event can land first).
 *   - the socket subscription: a durable `attachEvent` that folds the finished
 *     asset onto the matching scene without a refetch (does NOT touch the
 *     spinner — an older render's attach can arrive while a newer one is still
 *     in flight, so the spinner is owned solely by the job-id-correlated
 *     terminal events), plus the `completedEvent` / `failedEvent` /
 *     `canceledEvent` terminal events that clear the spinner.
 *
 * The image and video lanes were near-verbatim copies of this before the
 * extraction; the server-side image/video duplication was already unified in
 * #1791 behind `createMediaJobImageHook`, so this is the client-side analog.
 *
 * Config:
 *   - `attachEvent`    — durable broadcast that lands the finished asset
 *                        (e.g. `music-video:scene-image`). Handler receives the
 *                        raw event payload and calls `apply(data)`.
 *   - `completedEvent` — job terminal success (e.g. `image-gen:completed`).
 *   - `failedEvent`    — job terminal failure (e.g. `image-gen:failed`).
 *   - `canceledEvent`  — job cancel (e.g. `image-gen:canceled`). A queued-cancel
 *                        emits only this (no `failedEvent`), so without it the
 *                        spinner would stick — every queue-backed lane has one.
 *   - `apply(data)`    — fold the finished asset onto the matching scene
 *                        (functional setProjects update); called on `attachEvent`.
 *   - `failMessage`    — the toast string for a confirmed render failure.
 *
 * Returns `{ genScenes, startScene, clearScene, trackJob }`:
 *   - `startScene(sceneId)` — light the spinner before the kickoff request.
 *   - `clearScene(sceneId)` — drop the spinner (sync-lane finish, or a kickoff
 *     that returns no trackable job id).
 *   - `trackJob(jobId, sceneId)` — register a queued render so its terminal
 *     event clears the right scene's spinner; reconciles an already-arrived
 *     orphan terminal inline (clears the spinner, toasts on failure) instead of
 *     registering a job that's already done.
 */
export default function useSceneRenderLifecycle({
  attachEvent,
  completedEvent,
  failedEvent,
  canceledEvent,
  apply,
  failMessage,
}) {
  const [genScenes, setGenScenes] = useState({});
  // jobId → sceneId for renders this lane is awaiting.
  const pendingRef = useRef(new Map());
  // jobId → failed(bool) for terminal events that beat their kickoff's
  // trackJob registration. Capped so unrelated jobs across the app can't grow
  // it unbounded; the kickoff reconciles its own entry on arrival.
  const orphanRef = useRef(new Map());
  // Latest `apply` / `failMessage` without re-subscribing the socket every
  // render — the effect keys on the (static) event names and reads the mutable
  // callbacks through this ref, mirroring the original `[]`-deps effects.
  const cfgRef = useRef({ apply, failMessage });
  cfgRef.current = { apply, failMessage };

  const startScene = useCallback(
    (sceneId) => setGenScenes((prev) => ({ ...prev, [sceneId]: true })),
    [],
  );
  const clearScene = useCallback(
    (sceneId) => setGenScenes((prev) => {
      const next = { ...prev };
      delete next[sceneId];
      return next;
    }),
    [],
  );

  // The orphan-reconcile helper used by the kickoff `.then`: if the terminal
  // event already raced ahead, settle it now; otherwise register the pending job.
  const trackJob = useCallback((jobId, sceneId) => {
    if (orphanRef.current.has(jobId)) {
      const failed = orphanRef.current.get(jobId);
      orphanRef.current.delete(jobId);
      clearScene(sceneId);
      if (failed) toast.error(cfgRef.current.failMessage);
      return;
    }
    pendingRef.current.set(jobId, sceneId);
  }, [clearScene]);

  useEffect(() => {
    const onAttach = (data) => cfgRef.current.apply(data);
    // jobId → pending error-toast timer (running-cancel deferral; see onFailed).
    const failTimers = new Map();
    // Unmount/re-run guard for the deferred fail-toast fetch below: cleared in
    // cleanup so a `getMediaJob` promise still in flight (or a re-arm) can't pop
    // a "render failed" toast onto whatever page the user navigated to.
    let mounted = true;
    const settle = (data, failed) => {
      const jobId = data?.generationId || data?.jobId;
      if (!jobId) return;
      const sceneId = pendingRef.current.get(jobId);
      if (!sceneId) {
        // Not yet correlated (the kickoff `trackJob` hasn't run, or it's an
        // unrelated job). Stash it so a slightly-late registration can
        // reconcile; cap so other pages' renders can't grow this unbounded.
        const orphans = orphanRef.current;
        orphans.set(jobId, !!failed);
        evictOldest(orphans, ORPHAN_BUFFER_MAX);
        return;
      }
      pendingRef.current.delete(jobId);
      clearScene(sceneId);
      if (failed) toast.error(cfgRef.current.failMessage);
    };
    const onCompleted = (data) => settle(data, false);
    // Deferred failure toast for an owned render. A render canceled WHILE RUNNING
    // reaches us as `failedEvent` (SIGTERM) just before `canceledEvent` — and
    // before the queue flips the job to 'canceled' — so neither the failed event
    // nor an immediate status fetch can tell a cancel from a real failure
    // (#1791/#1796). `canceledEvent` cancels this timer in the common case; if
    // the timer fires first it re-polls the job and only toasts on a CONFIRMED
    // terminal failure — a still-'running'/'queued' status means the cancel (or
    // the failure transition) hasn't landed yet, so it re-polls a bounded number
    // of times rather than toasting prematurely (the spinner is already cleared,
    // so giving up silently never strands the UI).
    const armFailToast = (jobId, attempt = 0) => {
      failTimers.set(jobId, setTimeout(() => {
        failTimers.delete(jobId);
        if (!mounted) return; // navigated away before the timer fired
        getMediaJob(jobId)
          .then((job) => {
            if (!mounted) return; // unmounted while the status fetch was in flight
            const status = job?.status;
            if (status === 'canceled') return; // user cancel — never a failure toast
            if (status === 'failed' || status === 'error') { toast.error(cfgRef.current.failMessage); return; }
            if (attempt < 2) armFailToast(jobId, attempt + 1); // non-terminal: wait, don't toast yet
          })
          .catch(() => { if (mounted) toast.error(cfgRef.current.failMessage); });
      }, 800));
    };
    const onFailed = (data) => {
      const jobId = data?.generationId || data?.jobId;
      if (!jobId) return;
      // Only THIS lane's renders surface a failure toast. An OWNED job clears the
      // spinner silently (settle with failed=false) and defers the toast above so
      // a running-cancel can retract it. A not-yet-owned job is stashed as an
      // orphan WITH the failure bit so a fast-fail that raced ahead of its own
      // kickoff registration is toasted by the kickoff reconciliation; an
      // unrelated job is simply capped/evicted from the orphan map unseen.
      const owned = pendingRef.current.has(jobId);
      settle(data, !owned);
      if (owned && !failTimers.has(jobId)) armFailToast(jobId);
    };
    // Queued-cancel emits no `failedEvent`; running-cancel emits failed then this.
    // Either way clear the spinner and cancel any pending failure toast.
    const onCanceled = (data) => {
      const jobId = data?.generationId || data?.jobId;
      if (jobId) {
        const t = failTimers.get(jobId);
        if (t) { clearTimeout(t); failTimers.delete(jobId); }
      }
      settle(data, false);
    };

    socket.on(attachEvent, onAttach);
    socket.on(completedEvent, onCompleted);
    socket.on(failedEvent, onFailed);
    socket.on(canceledEvent, onCanceled);
    return () => {
      socket.off(attachEvent, onAttach);
      socket.off(completedEvent, onCompleted);
      socket.off(failedEvent, onFailed);
      socket.off(canceledEvent, onCanceled);
      mounted = false;
      for (const t of failTimers.values()) clearTimeout(t);
      failTimers.clear();
    };
  }, [attachEvent, completedEvent, failedEvent, canceledEvent, clearScene]);

  return { genScenes, startScene, clearScene, trackJob };
}
