import { useCallback, useSyncExternalStore } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';
import { subscribeVisibility } from './useVisibilityEvent.js';

/**
 * One shared system-activity snapshot for the update banner and the live
 * activity widget.
 *
 * The server emits `system:activity` when an activity source changes. Bursts
 * collapse into one read of `GET /api/system/activity` (no GPU shell-out).
 * Subscribe and socket reconnect each read immediately, which is how a missed
 * frame is recovered. A failed or shape-invalid read keeps the previous
 * snapshot and reports `status: 'error'` — it never publishes an idle snapshot
 * the banner could treat as "safe to restart."
 *
 * There is no interval. An idle page produces no recurring processing requests.
 * GPU samples are a separate visible-only poll; they have no lifecycle event.
 */

export const SYSTEM_ACTIVITY_COALESCE_MS = 50;

export const sameProcessingSnapshot = (a, b) => {
  if (!a || !b) return a === b;
  return a.agents?.active === b.agents?.active
    && a.agents?.queued === b.agents?.queued
    && a.agents?.trusted === b.agents?.trusted
    && a.gpu?.status === b.gpu?.status
    && a.gpu?.laneBusy === b.gpu?.laneBusy
    && a.gpu?.gpus?.[0]?.utilizationPercent === b.gpu?.gpus?.[0]?.utilizationPercent
    && a.mind?.thinking === b.mind?.thinking
    && a.mind?.queued === b.mind?.queued
    && a.mind?.status === b.mind?.status
    && a.mind?.trusted === b.mind?.trusted
    && a.llm?.active === b.llm?.active
    && a.llm?.trusted === b.llm?.trusted
    && a.backup?.inProgress === b.backup?.inProgress
    && a.update?.inProgress === b.update?.inProgress
    && a.activity?.idle === b.activity?.idle
    && a.activity?.activeCount === b.activity?.activeCount
    && a.activity?.queuedCount === b.activity?.queuedCount
    && (a.appOperations || []).length === (b.appOperations || []).length
    && a.jobs?.length === b.jobs?.length
    && (a.extras?.imageTo3d || []).length === (b.extras?.imageTo3d || []).length
    && (a.jobs || []).every((job, index) => job?.id === b.jobs[index]?.id
      && job?.status === b.jobs[index]?.status
      && job?.progress === b.jobs[index]?.progress
      && job?.position === b.jobs[index]?.position
      && job?.statusMsg === b.jobs[index]?.statusMsg)
    && (a.extras?.imageTo3d || []).every((item, index) => item?.id === b.extras?.imageTo3d?.[index]?.id
      && item?.name === b.extras?.imageTo3d?.[index]?.name);
};

const EMPTY = { snapshot: null, status: 'unknown', error: null };

let state = EMPTY;
let generation = 0;
let inFlight = null;
let followUp = false;
let timer = null;
let hiddenDeferred = false;
let unsubscribeVisibility = null;
const listeners = new Set();

const publish = (next) => {
  state = next;
  for (const notify of listeners) notify();
};

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

function read() {
  if (inFlight) {
    followUp = true;
    return inFlight;
  }
  const started = generation;
  inFlight = api.getSystemActivity({ silent: true }).then((snapshot) => {
    if (started !== generation) return;
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.activity || typeof snapshot.activity.idle !== 'boolean') {
      publish({ snapshot: state.snapshot, status: 'error', error: new Error('Invalid system activity') });
      return;
    }
    const nextSnapshot = state.snapshot && sameProcessingSnapshot(state.snapshot, snapshot) ? state.snapshot : snapshot;
    publish({ snapshot: nextSnapshot, status: 'ready', error: null });
  }).catch((error) => {
    if (started !== generation) return;
    const err = error instanceof Error ? error : new Error(String(error ?? 'System activity read failed'));
    publish({ snapshot: state.snapshot, status: 'error', error: err });
  }).finally(() => {
    inFlight = null;
    if (followUp && listeners.size) {
      followUp = false;
      schedule();
    }
  });
  return inFlight;
}

function schedule() {
  if (!visible()) {
    hiddenDeferred = true;
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (listeners.size) read();
  }, SYSTEM_ACTIVITY_COALESCE_MS);
}

function reconcile() {
  if (!visible()) {
    hiddenDeferred = true;
    return;
  }
  hiddenDeferred = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  read();
}

function onActivity() {
  schedule();
}

function onConnect() {
  reconcile();
}

function onVisibility(next) {
  if (next === 'visible' && hiddenDeferred && listeners.size) reconcile();
}

function subscribe(notify) {
  listeners.add(notify);
  if (listeners.size === 1) {
    socket.on('system:activity', onActivity);
    socket.on('connect', onConnect);
    unsubscribeVisibility = subscribeVisibility(onVisibility);
    reconcile();
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size) return;
    generation += 1;
    followUp = false;
    hiddenDeferred = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    socket.off('system:activity', onActivity);
    socket.off('connect', onConnect);
    unsubscribeVisibility?.();
    unsubscribeVisibility = null;
  };
}

export function useSystemActivity() {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  const refetch = useCallback(() => {
    generation += 1;
    return reconcile();
  }, []);
  return { ...snapshot, refetch };
}

/** Test seam. Call only after every consumer has unmounted. */
export function __resetSystemActivityForTests() {
  generation += 1;
  followUp = false;
  hiddenDeferred = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  inFlight = null;
  listeners.clear();
  state = EMPTY;
  socket.off('system:activity', onActivity);
  socket.off('connect', onConnect);
  unsubscribeVisibility?.();
  unsubscribeVisibility = null;
}
