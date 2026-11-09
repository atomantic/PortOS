import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import socket from '../services/socket';
import { getMediaJob } from '../services/apiMediaJobs';
import { evictOldest, ORPHAN_BUFFER_MAX } from '../lib/boundedMap';
import { pluralize } from '../lib/textUtils';
import toast from '../components/ui/Toast';

// Failures landing within this window of each other are one batch.
const FAILURE_BATCH_WINDOW_MS = 600;
const MAX_NAMED_SCENES = 3;

// One toast for however many scenes failed in the window: names the scene (or
// the first few, with a count) and the first reported reason.
function failureToastMessage(failMessage, failures) {
  const reason = failures.find((f) => f.error)?.error;
  const labels = [...new Set(failures.map((f) => f.label).filter(Boolean))];
  if (failures.length === 1) {
    return `${failMessage}${labels[0] ? `: ${labels[0]}` : ''}${reason ? ` — ${reason}` : ''}`;
  }
  const named = labels.slice(0, MAX_NAMED_SCENES).join(', ');
  const more = labels.length > MAX_NAMED_SCENES ? `, +${labels.length - MAX_NAMED_SCENES} more` : '';
  return `${failMessage} for ${pluralize(failures.length, 'scene')}${named ? ` (${named}${more})` : ''}${reason ? ` — ${reason}` : ''}`;
}

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
 *   - `startedEvent` / `progressEvent` — optional `*-gen:started` / `*-gen:progress`
 *                        events; they feed `sceneProgress` (queued → running +
 *                        a 0..1 fraction) for the scene whose job they name.
 *   - `onSettled({ jobId, sceneId, outcome })` — optional; called once per
 *                        tracked job with `'completed' | 'failed' | 'canceled'`
 *                        (the batch counter in `useSceneBatch` listens here).
 *   - `apply(data)`    — fold the finished asset onto the matching scene
 *                        (functional setProjects update); called on `attachEvent`.
 *   - `failMessage`    — the toast headline for a confirmed render failure
 *                        (e.g. 'Frame render failed').
 *   - `sceneLabel(sceneId)` — OPTIONAL display name of a scene, so the failure
 *                        toast says WHICH scene failed. Failure toasts also
 *                        carry the failed event's `error`, and failures that
 *                        land within a short window (a batch) collapse into ONE
 *                        summary toast instead of one identical toast per scene.
 *
 * Returns `{ genScenes, sceneProgress, sceneJobs, failedScenes, startScene, clearScene, trackJob, restoreJobs, reconcileJobs }`
 * (`sceneProgress`: sceneId → `{ progress }` once a job reports running; a scene
 * in `genScenes` with no entry is still queued;
 * `sceneJobs`: sceneId → every render in flight for it, `{ key, jobId, label, running, progress, retry }`
 * (`retry`: `{ attempt, of, inMs, reason }` while the provider was busy and the lane waits to resend),
 * since one shot may render on several providers at once;
 * `failedScenes` — sceneId → true after a confirmed render failure this session, until that scene renders again):
 *   - `startScene(sceneId, { label })` — light the spinner before the kickoff
 *     request; returns the render's key.
 *   - `clearScene(sceneId, key)` — drop that render (sync-lane finish, or a kickoff
 *     that returns no trackable job id); without a key, every render not yet bound to a job.
 *   - `trackJob(jobId, sceneId, key)` — register a queued render so its terminal
 *     event clears the right scene's spinner; reconciles an already-arrived
 *     orphan terminal inline (clears the spinner, toasts on failure) instead of
 *     registering a job that's already done.
 *   - `restoreJobs([{ jobId, sceneId }])` — after a reload, re-light the
 *     spinners for renders the server's queue still has in flight (#10154) and
 *     correlate their jobs so the terminal events clear them as usual.
 *   - `reconcileJobs(activeJobIds)` — after a socket reconnect, settle every tracked
 *     job the server no longer lists as in flight: its terminal event may have
 *     fired in the disconnect gap and Socket.IO does not replay it. Each such job's
 *     status is read once; only a terminal one settles (through the same path as the
 *     live event, so a late live event is a no-op). Resolves to how many it settled.
 */
export default function useSceneRenderLifecycle({
  attachEvent,
  completedEvent,
  failedEvent,
  canceledEvent,
  startedEvent,
  progressEvent,
  onSettled,
  apply,
  failMessage,
  sceneLabel,
}) {
  // sceneId → the renders in flight for it, oldest first: `{ key, jobId, label, running, progress }`.
  // A shot can have several at once (a local clip and a grok clip, #15128); `jobId`
  // is null until the kickoff returns, `running` flips on the job's started/progress event.
  const [sceneJobs, setSceneJobs] = useState({});
  const keySeq = useRef(0);
  const editJobs = useCallback((sceneId, edit) => setSceneJobs((prev) => {
    const current = prev[sceneId] || [];
    const nextList = edit(current);
    if (nextList === current) return prev;
    const next = { ...prev };
    if (nextList.length) next[sceneId] = nextList; else delete next[sceneId];
    return next;
  }), []);
  const genScenes = useMemo(() => Object.fromEntries(Object.keys(sceneJobs).map((sceneId) => [sceneId, true])), [sceneJobs]);
  // A scene with no running render has no entry (it is still queued).
  const sceneProgress = useMemo(() => Object.fromEntries(Object.entries(sceneJobs)
    .map(([sceneId, list]) => [sceneId, list.find((entry) => entry.running)])
    .filter(([, entry]) => entry)
    .map(([sceneId, entry]) => [sceneId, { progress: entry.progress }])), [sceneJobs]);
  // sceneId → true once a render for it failed this session (cleared when the scene renders again or succeeds).
  const [failedScenes, setFailedScenes] = useState({});
  const markFailed = useCallback((sceneId, failed) => setFailedScenes((prev) => {
    if (!!prev[sceneId] === failed) return prev;
    const next = { ...prev };
    if (failed) next[sceneId] = true; else delete next[sceneId];
    return next;
  }), []);
  // jobId → sceneId for renders this lane is awaiting.
  const pendingRef = useRef(new Map());
  // jobId → outcome ('completed' | 'failed' | 'canceled') for terminal events that beat their kickoff's
  // trackJob registration. Capped so unrelated jobs across the app can't grow
  // it unbounded; the kickoff reconciles its own entry on arrival.
  const orphanRef = useRef(new Map());
  // Latest `apply` / `failMessage` without re-subscribing the socket every
  // render — the effect keys on the (static) event names and reads the mutable
  // callbacks through this ref, mirroring the original `[]`-deps effects.
  const cfgRef = useRef({ apply, failMessage, onSettled, sceneLabel });
  cfgRef.current = { apply, failMessage, onSettled, sceneLabel };
  // Failures waiting for the batch window to close, and that window's timer.
  const failuresRef = useRef([]);
  const flushTimerRef = useRef(null);
  // The socket effect's `settle`, so a reconnect reconcile settles through the same idempotent path.
  const settleRef = useRef(null);

  // Queue one confirmed failure; the toast fires once the window closes so a
  // batch of failures reads as one summary rather than N identical toasts.
  const reportFailure = useCallback((sceneId, error) => {
    failuresRef.current.push({ label: cfgRef.current.sceneLabel?.(sceneId) || '', error: typeof error === 'string' ? error.trim() : '' });
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const failures = failuresRef.current;
      failuresRef.current = [];
      if (failures.length) toast.error(failureToastMessage(cfgRef.current.failMessage, failures));
    }, FAILURE_BATCH_WINDOW_MS);
  }, []);
  // A navigated-away page must not pop a late failure toast onto another view.
  useEffect(() => () => {
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    failuresRef.current = [];
  }, []);

  // Returns the new render's key: pass it to trackJob / clearScene so a second
  // render on the same shot never settles the first one's placeholder.
  const startScene = useCallback((sceneId, { label = null } = {}) => {
    markFailed(sceneId, false);
    keySeq.current += 1;
    const key = `r${keySeq.current}`;
    editJobs(sceneId, (list) => [...list, { key, jobId: null, label, running: false, progress: null }]);
    return key;
  }, [markFailed, editJobs]);
  // With a key, drop that one render; without one, every render not yet bound to a job
  // (a kickoff that failed or returned nothing to track).
  const clearScene = useCallback((sceneId, key = null) => editJobs(sceneId, (list) => {
    const next = list.filter((entry) => (key ? entry.key !== key : entry.jobId));
    return next.length === list.length ? list : next;
  }), [editJobs]);
  const settleJob = useCallback((sceneId, jobId) => editJobs(sceneId, (list) => {
    const next = list.filter((entry) => entry.jobId !== jobId);
    return next.length === list.length ? list : next;
  }), [editJobs]);
  // Bind a job to the render that started it (by key, else the oldest unbound one), or add it.
  const bindJob = useCallback((sceneId, jobId, key = null, label = null) => editJobs(sceneId, (list) => {
    if (list.some((entry) => entry.jobId === jobId)) return list;
    const index = list.findIndex((entry) => (key ? entry.key === key : !entry.jobId));
    if (index === -1) {
      keySeq.current += 1;
      return [...list, { key: `r${keySeq.current}`, jobId, label, running: false, progress: null }];
    }
    return list.map((entry, i) => (i === index ? { ...entry, jobId, label: entry.label ?? label } : entry));
  }), [editJobs]);

  // The orphan-reconcile helper used by the kickoff `.then`: if the terminal
  // event already raced ahead, settle it now; otherwise register the pending job.
  const trackJob = useCallback((jobId, sceneId, key = null) => {
    if (orphanRef.current.has(jobId)) {
      const orphan = orphanRef.current.get(jobId);
      orphanRef.current.delete(jobId);
      if (key) clearScene(sceneId, key);
      else editJobs(sceneId, (list) => {
        const index = list.findIndex((entry) => !entry.jobId);
        return index === -1 ? list : list.filter((_, i) => i !== index);
      });
      const failed = typeof orphan === 'object' ? orphan.failed : orphan === 'failed';
      const outcome = (typeof orphan === 'object' ? orphan.outcome : orphan) || (failed ? 'failed' : 'completed');
      const error = typeof orphan === 'object' ? orphan.error : undefined;
      if (failed || outcome === 'failed') {
        markFailed(sceneId, true);
        reportFailure(sceneId, error);
      }
      cfgRef.current.onSettled?.({ jobId, sceneId, outcome });
      return;
    }
    pendingRef.current.set(jobId, sceneId);
    bindJob(sceneId, jobId, key);
  }, [clearScene, editJobs, bindJob, markFailed, reportFailure]);

  const restoreJobs = useCallback((entries) => {
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e?.jobId && e?.sceneId);
    for (const { jobId, sceneId, label, status } of list) {
      if (pendingRef.current.has(jobId)) continue;
      pendingRef.current.set(jobId, sceneId);
      bindJob(sceneId, jobId, `restored-${jobId}`, label || null);
      if (status === 'running') editJobs(sceneId, (jobs) => jobs.map((entry) => (entry.jobId === jobId ? { ...entry, running: true } : entry)));
    }
  }, [bindJob, editJobs]);

  // Socket.IO replays nothing after a reconnect, so a job that finished in the gap
  // never reaches `settle`. `activeJobIds` is the server's current in-flight list.
  const reconcileJobs = useCallback(async (activeJobIds) => {
    const active = new Set(activeJobIds);
    const stale = [...pendingRef.current.keys()].filter((jobId) => !active.has(jobId));
    const jobs = await Promise.all(stale.map((jobId) => getMediaJob(jobId).catch(() => null)));
    let settled = 0;
    stale.forEach((jobId, i) => {
      const job = jobs[i];
      const outcome = job?.status === 'error' ? 'failed' : job?.status;
      if (!['completed', 'failed', 'canceled'].includes(outcome)) return; // still live or unreadable: leave it
      const sceneId = pendingRef.current.get(jobId);
      if (!sceneId) return; // the live event settled it while we were fetching
      settleRef.current?.({ jobId, error: job.error }, false, outcome);
      if (outcome === 'failed') {
        markFailed(sceneId, true);
        reportFailure(sceneId, job.error);
      }
      settled += 1;
    });
    return settled;
  }, [markFailed, reportFailure]);

  useEffect(() => {
    const onAttach = (data) => cfgRef.current.apply(data);
    // jobId → pending error-toast timer (running-cancel deferral; see onFailed).
    const failTimers = new Map();
    // Unmount/re-run guard for the deferred fail-toast fetch below: cleared in
    // cleanup so a `getMediaJob` promise still in flight (or a re-arm) can't pop
    // a "render failed" toast onto whatever page the user navigated to.
    let mounted = true;
    // `failed` is the toast bit (an orphan failure still owes its kickoff a
    // toast); `outcome` is what actually happened, for the batch counter.
    const settle = (data, failed, outcome) => {
      const jobId = data?.generationId || data?.jobId;
      if (!jobId) return;
      const sceneId = pendingRef.current.get(jobId);
      if (!sceneId) {
        // Not yet correlated (the kickoff `trackJob` hasn't run, or it's an
        // unrelated job). Stash it so a slightly-late registration can
        // reconcile; cap so other pages' renders can't grow this unbounded.
        const orphans = orphanRef.current;
        orphans.set(jobId, { failed: !!failed, outcome, error: data?.error });
        evictOldest(orphans, ORPHAN_BUFFER_MAX);
        return;
      }
      pendingRef.current.delete(jobId);
      settleJob(sceneId, jobId);
      if (failed) {
        markFailed(sceneId, true);
        reportFailure(sceneId, data?.error);
      }
      cfgRef.current.onSettled?.({ jobId, sceneId, outcome });
    };
    settleRef.current = settle;
    const onCompleted = (data) => settle(data, false, 'completed');
    // started / progress: a tracked job is running; keep the fraction for its card.
    const onRunning = (data) => {
      const jobId = data?.generationId || data?.jobId;
      const sceneId = jobId && pendingRef.current.get(jobId);
      if (!sceneId) return;
      const progress = typeof data.progress === 'number' && Number.isFinite(data.progress)
        ? Math.min(1, Math.max(0, data.progress)) : null;
      editJobs(sceneId, (list) => {
        const index = list.findIndex((entry) => entry.jobId === jobId);
        if (index === -1) return list;
        const entry = list[index];
        const nextProgress = progress ?? entry.progress;
        // A lane waiting to resend after a busy provider says so on each tick; any other frame clears it.
        const nextRetry = data.retry && typeof data.retry === 'object' ? data.retry : null;
        if (entry.running && entry.progress === nextProgress && (entry.retry ?? null) === nextRetry) return list;
        return list.map((item, i) => (i === index ? { ...item, running: true, progress: nextProgress, retry: nextRetry } : item));
      });
    };
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
    const armFailToast = (jobId, sceneId, error, attempt = 0) => {
      failTimers.set(jobId, setTimeout(() => {
        failTimers.delete(jobId);
        if (!mounted) return; // navigated away before the timer fired
        getMediaJob(jobId)
          .then((job) => {
            if (!mounted) return; // unmounted while the status fetch was in flight
            const status = job?.status;
            if (status === 'canceled') return; // user cancel — never a failure toast
            if (status === 'failed' || status === 'error') {
              markFailed(sceneId, true);
              reportFailure(sceneId, error || job?.error);
              return;
            }
            if (attempt < 2) armFailToast(jobId, sceneId, error, attempt + 1); // non-terminal: wait, don't toast yet
          })
          .catch(() => {
            if (mounted) {
              markFailed(sceneId, true);
              reportFailure(sceneId, error);
            }
          });
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
      const ownedSceneId = pendingRef.current.get(jobId);
      const owned = !!ownedSceneId;
      settle(data, !owned, 'failed');
      if (owned && !failTimers.has(jobId)) armFailToast(jobId, ownedSceneId, data?.error);
    };
    // Queued-cancel emits no `failedEvent`; running-cancel emits failed then this.
    // Either way clear the spinner and cancel any pending failure toast.
    const onCanceled = (data) => {
      const jobId = data?.generationId || data?.jobId;
      if (jobId) {
        const t = failTimers.get(jobId);
        if (t) { clearTimeout(t); failTimers.delete(jobId); }
      }
      settle(data, false, 'canceled');
    };

    socket.on(attachEvent, onAttach);
    if (startedEvent) socket.on(startedEvent, onRunning);
    if (progressEvent) socket.on(progressEvent, onRunning);
    socket.on(completedEvent, onCompleted);
    socket.on(failedEvent, onFailed);
    socket.on(canceledEvent, onCanceled);
    return () => {
      socket.off(attachEvent, onAttach);
      if (startedEvent) socket.off(startedEvent, onRunning);
      if (progressEvent) socket.off(progressEvent, onRunning);
      socket.off(completedEvent, onCompleted);
      socket.off(failedEvent, onFailed);
      socket.off(canceledEvent, onCanceled);
      mounted = false;
      settleRef.current = null;
      for (const t of failTimers.values()) clearTimeout(t);
      failTimers.clear();
    };
  }, [attachEvent, completedEvent, failedEvent, canceledEvent, startedEvent, progressEvent, settleJob, editJobs, markFailed, reportFailure]);

  return { genScenes, sceneProgress, sceneJobs, failedScenes, startScene, clearScene, trackJob, restoreJobs, reconcileJobs };
}
