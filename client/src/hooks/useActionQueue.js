import { useCallback, useSyncExternalStore } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';
import { subscribeVisibility } from './useVisibilityEvent';
import { ACTION_QUEUE_CHANGED, INSTANCE_FEATURES_CHANGED } from '../constants/events';

// Shared by the bell, dashboard previews, and Actions page. These events carry
// invalidations only; source records are always re-read from this install.
const EVENTS = [
  'connect', 'brain:classified', 'brain:threads:changed',
  'cos:tasks:user:changed', 'cos:tasks:cos:changed', 'cos:agent:completed',
  'cos:memory:approved', 'cos:memory:rejected', 'cos:agent:feedback',
  'messages:changed', 'messages:draft:created', 'messages:draft:sent',
  'backup:started', 'backup:completed', 'backup:failed',
  'review:item:created', 'review:item:updated', 'review:item:deleted',
  'review:items:bulk-updated', 'review:queue:changed',
  'notifications:added', 'notifications:removed', 'notifications:cleared',
];
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
    inFlight = api.getReviewQueue({ view, silent: true }).then((data) => {
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
      if (started !== generation && listeners.size) refresh(true);
    });
    return inFlight;
  };
  const invalidate = () => { generation++; refresh(true); };
  const subscribe = (notify) => {
    listeners.add(notify);
    if (listeners.size === 1) {
      for (const event of EVENTS) socket.on(event, invalidate);
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
        generation++;
        for (const event of EVENTS) socket.off(event, invalidate);
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
