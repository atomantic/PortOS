import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { cancelImageGen } from '../services/apiImageVideo';
import toast from '../components/ui/Toast';

// useImageGenQueue — work-scoped live queue of in-flight image renders.
//
// Subscribes once to the global image-gen:* socket events. SceneCard calls
// `register({jobId, sceneId, sceneLabel})` after kicking off a render so the
// hook can label rows; the hook then matches incoming events by jobId. The
// queue auto-prunes terminal jobs after 1s so the dock briefly flashes "done"
// before disappearing.
//
// Returns { queue, runningCount, register, stopAll, stopOne }.
//
// Orphan-event buffer hygiene: image-gen:* events are emitted globally
// (server only knows generationId, not which page issued it), so any image
// render anywhere in the app would otherwise pile up entries here. We cap
// the buffer to ORPHAN_MAX_ENTRIES and evict each entry ORPHAN_TTL_MS after
// last write — preventing unbounded memory growth on long-lived sessions.
const ORPHAN_TTL_MS = 30_000;
const ORPHAN_MAX_ENTRIES = 64;

export default function useImageGenQueue() {
  const [queue, setQueue] = useState([]);
  // Authoritative copy lives in a ref so socket callbacks don't see stale
  // closures. setQueue is only called via patch().
  const queueRef = useRef([]);
  const pruneTimersRef = useRef(new Map());
  // Race-buffer: image-gen:* events can arrive BEFORE register() — the
  // server emits started/progress while the HTTP response is still in
  // flight, so SceneCard learns the jobId after the events. Stash the
  // latest state for unknown jobIds so register() can replay it.
  //
  // Bounded by both a TTL (per-entry expiry timer) and a hard size cap
  // (LRU eviction) so unrelated global image-gen events don't accumulate.
  const orphanEventsRef = useRef(new Map());
  const orphanTimersRef = useRef(new Map());
  // Tracks the post-cancel fallback prune timers. Stored so unmount can
  // clear them (avoids "setState on unmounted hook" warnings) and so a real
  // terminal socket event can supersede the fallback. Keyed: 'all' for
  // Stop-all, jobId for Stop-one.
  const cancelFallbackTimersRef = useRef(new Map());

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

  const clearOrphan = useCallback((jobId) => {
    const t = orphanTimersRef.current.get(jobId);
    if (t) {
      clearTimeout(t);
      orphanTimersRef.current.delete(jobId);
    }
    orphanEventsRef.current.delete(jobId);
  }, []);

  const stashOrphan = useCallback((jobId, delta) => {
    // Refresh the entry by re-inserting it last so the Map's iteration order
    // gives us a cheap LRU for the size-cap eviction below.
    const prior = orphanEventsRef.current.get(jobId) || {};
    orphanEventsRef.current.delete(jobId);
    orphanEventsRef.current.set(jobId, { ...prior, ...delta });
    // (Re)arm TTL timer.
    const existingTimer = orphanTimersRef.current.get(jobId);
    if (existingTimer) clearTimeout(existingTimer);
    const t = setTimeout(() => {
      orphanTimersRef.current.delete(jobId);
      orphanEventsRef.current.delete(jobId);
    }, ORPHAN_TTL_MS);
    orphanTimersRef.current.set(jobId, t);
    // Hard cap: drop the oldest entry if we're over budget.
    while (orphanEventsRef.current.size > ORPHAN_MAX_ENTRIES) {
      const oldest = orphanEventsRef.current.keys().next().value;
      if (oldest === undefined) break;
      const oldTimer = orphanTimersRef.current.get(oldest);
      if (oldTimer) clearTimeout(oldTimer);
      orphanTimersRef.current.delete(oldest);
      orphanEventsRef.current.delete(oldest);
    }
  }, []);

  const register = useCallback(({ jobId, sceneId, sceneLabel }) => {
    if (!jobId) return;
    // Replay any events that arrived before this jobId was registered, so
    // the row starts in its true current state (often already 'running' or
    // even 'done' for fast renders) instead of stale 'queued'.
    const orphan = orphanEventsRef.current.get(jobId);
    clearOrphan(jobId);
    patch((prev) => {
      const idx = prev.findIndex((q) => q.jobId === jobId);
      const base = {
        jobId,
        sceneId: sceneId || null,
        sceneLabel: sceneLabel || 'Scene',
        status: 'queued',
        progress: 0,
        eta: null,
        registeredAt: Date.now(),
      };
      const entry = orphan ? { ...base, ...orphan } : base;
      if (idx < 0) return [...prev, entry];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...entry };
      return copy;
    });
    // If the orphan stream already saw a terminal event, prune the row
    // shortly so the dock doesn't pin a phantom done/error indefinitely.
    if (orphan && (orphan.status === 'done' || orphan.status === 'error')) {
      schedulePrune(jobId);
    }
  }, [patch, schedulePrune, clearOrphan]);

  // Apply an event's state delta to the queue. If the matching jobId hasn't
  // been registered yet, stash the merged delta in orphanEventsRef so the
  // eventual register() call can replay it.
  //
  // We probe the ref FIRST (no array allocation, no setState) and only call
  // patch() when there's a match. Without this guard, every global
  // `image-gen:*` event from anywhere in the app would force a rerender of
  // the Writers Room page even when the jobId is irrelevant.
  const applyEvent = useCallback((jobId, delta, terminal = false) => {
    if (!jobId) return;
    const idx = queueRef.current.findIndex((q) => q.jobId === jobId);
    if (idx < 0) {
      stashOrphan(jobId, delta);
      return;
    }
    patch((prev) => {
      const i = prev.findIndex((q) => q.jobId === jobId);
      if (i < 0) return prev;
      const copy = prev.slice();
      copy[i] = { ...copy[i], ...delta };
      return copy;
    });
    if (terminal) {
      // A real terminal event supersedes any post-cancel fallback timer for
      // this job.
      const fallback = cancelFallbackTimersRef.current.get(jobId);
      if (fallback) {
        clearTimeout(fallback);
        cancelFallbackTimersRef.current.delete(jobId);
      }
      schedulePrune(jobId);
    }
  }, [patch, schedulePrune, stashOrphan]);

  useEffect(() => {
    const onStarted = (data) => {
      applyEvent(data.generationId, { status: 'running', totalSteps: data.totalSteps ?? null });
    };
    const onProgress = (data) => {
      applyEvent(data.generationId, {
        status: 'running',
        progress: data.progress ?? 0,
        eta: data.eta ?? null,
        step: data.step ?? 0,
        totalSteps: data.totalSteps ?? null,
      });
    };
    const onCompleted = (data) => {
      applyEvent(data.generationId, { status: 'done', progress: 1 }, true);
    };
    const onFailed = (data) => {
      applyEvent(data.generationId, { status: 'error', error: data.error || data.message || null }, true);
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
  }, [applyEvent]);

  useEffect(() => () => {
    for (const t of pruneTimersRef.current.values()) clearTimeout(t);
    pruneTimersRef.current.clear();
    for (const t of orphanTimersRef.current.values()) clearTimeout(t);
    orphanTimersRef.current.clear();
    orphanEventsRef.current.clear();
    for (const t of cancelFallbackTimersRef.current.values()) clearTimeout(t);
    cancelFallbackTimersRef.current.clear();
  }, []);

  // Hard cutoff: if the server never confirms cancellation with a terminal
  // event, fall back to pruning the canceling row so the dock doesn't pin a
  // phantom row indefinitely.
  const CANCEL_FALLBACK_MS = 5000;

  // Mark a row as canceling, then issue cancel to the server. On a successful
  // cancel HTTP response, KEEP the row in 'canceling' state and let the
  // eventual image-gen:failed/completed terminal event prune it via
  // schedulePrune — that way a still-actively-canceling job stays visible to
  // the user, and the terminal event isn't treated as an orphan (which would
  // otherwise buffer it for 30s in the orphan map).
  // On HTTP failure, surface the error and restore each row's PRIOR status
  // (stashed on the entry as `_prevStatus`) so a queued job doesn't get
  // incorrectly flipped to running, and an already-completed job doesn't get
  // resurrected. Only revert rows that are still 'canceling' — a real socket
  // event arriving in the interim wins.
  const stopOne = useCallback(async (jobId) => {
    if (!jobId) return;
    patch((prev) => prev.map((q) => (
      q.jobId === jobId
        ? { ...q, status: 'canceling', _prevStatus: q.status }
        : q
    )));
    const err = await cancelImageGen({ jobId }).then(() => null).catch((e) => e);
    if (err) {
      toast.error(`Cancel failed: ${err.message || err}`);
      patch((prev) => prev.map((q) => {
        if (q.jobId !== jobId || q.status !== 'canceling') return q;
        const restored = { ...q, status: q._prevStatus || 'running' };
        delete restored._prevStatus;
        return restored;
      }));
      return;
    }
    // Server accepted; arm a fallback prune in case the terminal event
    // never arrives. Tracked in cancelFallbackTimersRef so unmount cleans
    // it up — without that we could setState on an unmounted hook if the
    // user navigates away within the 5s window.
    const existing = cancelFallbackTimersRef.current.get(jobId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      cancelFallbackTimersRef.current.delete(jobId);
      patch((prev) => prev.filter((q) => !(q.jobId === jobId && q.status === 'canceling')));
    }, CANCEL_FALLBACK_MS);
    cancelFallbackTimersRef.current.set(jobId, t);
  }, [patch]);

  const stopAll = useCallback(async () => {
    patch((prev) => prev.map((q) => (
      q.status === 'queued' || q.status === 'running'
        ? { ...q, status: 'canceling', _prevStatus: q.status }
        : q
    )));
    const err = await cancelImageGen({ all: true }).then(() => null).catch((e) => e);
    if (err) {
      toast.error(`Cancel all failed: ${err.message || err}`);
      patch((prev) => prev.map((q) => {
        if (q.status !== 'canceling') return q;
        const restored = { ...q, status: q._prevStatus || 'running' };
        delete restored._prevStatus;
        return restored;
      }));
      return;
    }
    // One fallback timer for the whole batch — repeated Stop-all clicks
    // shouldn't pile up timeouts.
    const existing = cancelFallbackTimersRef.current.get('all');
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      cancelFallbackTimersRef.current.delete('all');
      patch((prev) => prev.filter((q) => q.status !== 'canceling'));
    }, CANCEL_FALLBACK_MS);
    cancelFallbackTimersRef.current.set('all', t);
  }, [patch]);

  // Decouple status counts from any specific UI string. Consumers compute
  // their own labels — the dock distinguishes "Rendering N" vs "Canceling N".
  const renderingCount = queue.filter((q) => q.status === 'queued' || q.status === 'running').length;
  const cancelingCount = queue.filter((q) => q.status === 'canceling').length;
  const activeCount = renderingCount + cancelingCount;

  return { queue, renderingCount, cancelingCount, activeCount, register, stopOne, stopAll };
}
