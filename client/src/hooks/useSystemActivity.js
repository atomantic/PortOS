/**
 * One shared bounded system-activity snapshot.
 *
 * Socket invalidation coalesces to a single read; reconnect and reshow reconcile missed frames. A
 * failed read stays unknown, never idle. Use when: Update banner and the live-activity widget. GPU
 * samples stay on a visible-only poll — they have no event.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { getSystemActivity } from '../services/apiAppShell.js';
import socket from '../services/socket';
import { sameJsonShape } from '../lib/sameJsonShape';
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

export const sameProcessingSnapshot = sameJsonShape;

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
  inFlight = getSystemActivity({ silent: true }).then((snapshot) => {
    if (started !== generation) return;
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.activity || typeof snapshot.activity.idle !== 'boolean') {
      publish({ snapshot: state.snapshot, status: 'error', error: new Error('Invalid system activity') });
      return;
    }
    if (state.snapshot && sameProcessingSnapshot(state.snapshot, snapshot)) {
      if (state.status !== 'ready' || state.error !== null) {
        publish({ snapshot: state.snapshot, status: 'ready', error: null });
      }
      return;
    }
    publish({ snapshot, status: 'ready', error: null });
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

function onDisconnect() {
  generation += 1;
  publish({ ...state, status: 'unknown', error: null });
}

function onVisibility(next) {
  if (next === 'visible' && hiddenDeferred && listeners.size) reconcile();
}

function subscribe(notify) {
  listeners.add(notify);
  if (listeners.size === 1) {
    socket.on('system:activity', onActivity);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
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
    socket.off('disconnect', onDisconnect);
    // A later subscriber must not display an idle verdict from this session
    // before its new read returns. No one was listening while it was away.
    state = { ...state, status: 'unknown', error: null };
    unsubscribeVisibility?.();
    unsubscribeVisibility = null;
  };
}

const skipSubscription = () => () => {};

export function useSystemActivity({ enabled = true } = {}) {
  const snapshot = useSyncExternalStore(enabled ? subscribe : skipSubscription, () => state, () => state);
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
  socket.off('disconnect', onDisconnect);
  unsubscribeVisibility?.();
  unsubscribeVisibility = null;
}
