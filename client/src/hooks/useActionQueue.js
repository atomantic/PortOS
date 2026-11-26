/**
 * Shared canonical Actions snapshot, coalesced socket invalidation while visible, reconnect/tab
 * re-show reconciliation and explicit stale/error state.
 *
 * Use when: Bell, dashboard previews and Actions.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { getReviewQueue } from '../services/apiReview.js';
import socket from '../services/socket';
import { subscribeVisibility } from './useVisibilityEvent';
import { coalesce } from '../utils/coalesce';
import { ACTION_QUEUE_CHANGED, INSTANCE_FEATURES_CHANGED } from '../constants/events';

// Shared by the bell, dashboard previews, and Actions page. These events carry
// invalidations only; source records are always re-read from this install.
const EVENTS = [
  'connect', 'brain:classified', 'brain:threads:changed',
  'cos:tasks:changed', 'cos:agent:completed',
  'cos:memory:approval-needed', 'cos:agent:feedback',
  'messages:changed', 'messages:draft:created', 'messages:draft:sent',
  'github:notifications:changed', 'x:changed', 'stacker-news:changed',
  'backup:started', 'backup:completed', 'backup:failed',
  'review:item:created', 'review:item:updated', 'review:item:deleted',
  'review:items:bulk-updated', 'review:queue:changed',
  'notifications:added', 'notifications:removed', 'notifications:cleared',
];
// One server change often emits several of these together (a task change sends both
// cos:tasks:changed and review:queue:changed), and each read rebuilds the whole queue.
const EVENT_COALESCE_MS = 150;
const isHidden = () => document.visibilityState === 'hidden';
const stores = new Map();

function queueStore(view) {
  if (stores.has(view)) return stores.get(view);
  let state = { data: null, loading: true, error: null };
  let inFlight = null;
  let generation = 0;
  let refreshedAt = 0;
  let unsubscribeVisibility = null;
  const listeners = new Set();
  const publish = (next) => {
    state = next;
    for (const notify of listeners) notify();
  };
  const refresh = (force = false) => {
    if (inFlight) return inFlight;
    if (!force && Date.now() - refreshedAt < 1000) return Promise.resolve();
    const started = generation;
    inFlight = getReviewQueue({ view, silent: true }).then((data) => {
      if (!Array.isArray(data?.items) || typeof data.partial !== 'boolean') {
        throw new Error('Invalid Actions response');
      }
      if (started === generation) {
        refreshedAt = Date.now();
        publish({ data, loading: false, error: null });
      }
    }).catch((error) => {
      if (started === generation) publish({ ...state, loading: false, error });
    }).finally(() => {
      inFlight = null;
      if (started !== generation && listeners.size && !isHidden() && !refreshAfterBurst.pending()) refresh(true);
    });
    return inFlight;
  };
  const refreshAfterBurst = coalesce(() => {
    if (!isHidden()) refresh(true);
  }, EVENT_COALESCE_MS);
  const invalidate = () => { generation++; refreshAfterBurst.cancel(); refresh(true); };
  // A hidden tab only marks its snapshot stale: showing it again always re-reads.
  const invalidateFromEvent = () => {
    generation++;
    if (!isHidden()) refreshAfterBurst();
  };
  const subscribe = (notify) => {
    listeners.add(notify);
    if (listeners.size === 1) {
      for (const event of EVENTS) socket.on(event, invalidateFromEvent);
      window.addEventListener(ACTION_QUEUE_CHANGED, invalidate);
      window.addEventListener(INSTANCE_FEATURES_CHANGED, invalidate);
      unsubscribeVisibility = subscribeVisibility((visibility) => {
        if (visibility === 'visible') invalidate();
      });
      void refresh(true);
    }
    return () => {
      listeners.delete(notify);
      if (!listeners.size) {
        refreshAfterBurst.cancel();
        for (const event of EVENTS) socket.off(event, invalidateFromEvent);
        window.removeEventListener(ACTION_QUEUE_CHANGED, invalidate);
        window.removeEventListener(INSTANCE_FEATURES_CHANGED, invalidate);
        unsubscribeVisibility?.();
        unsubscribeVisibility = null;
      }
    };
  };
  const store = { subscribe, getSnapshot: () => state, refresh };
  stores.set(view, store);
  return store;
}

/** One event-driven snapshot per view, retained on errors and reconciled on re-show. */
export function useActionQueue(view = 'today') {
  const store = queueStore(view);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const refetch = useCallback(() => store.refresh(true), [store]);
  return { ...state, refetch };
}

/** Test seam: call only after unmounting all consumers. */
export function __resetActionQueue() { stores.clear(); }
