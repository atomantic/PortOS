import { useEffect, useRef } from 'react';

// Singleton emitter so N subscribers share one document-level
// `visibilitychange` listener. With 20+ widgets on the Dashboard, a per-hook
// listener fires 20+ near-simultaneous handlers on every tab show/hide; this
// keeps the listener count to one regardless of subscriber count.
//
// The non-hook `subscribeVisibility(fn)` export lets other singletons
// (e.g. useTimeTick's ticker registry) reuse this listener without paying
// for a per-component `useEffect`.

const subscribers = new Set();
let attached = false;

const dispatch = () => {
  const state = typeof document !== 'undefined' ? document.visibilityState : 'visible';
  for (const fn of subscribers) fn(state);
};

const ensureAttached = () => {
  if (attached || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', dispatch);
  attached = true;
};

const detachIfEmpty = () => {
  if (!attached || subscribers.size > 0 || typeof document === 'undefined') return;
  document.removeEventListener('visibilitychange', dispatch);
  attached = false;
};

/**
 * Subscribe to `document.visibilitychange` from non-hook code (other
 * singletons, services). Returns an unsubscribe function. Reuses the same
 * document-level listener as `useVisibilityEvent` so the listener count
 * stays at one regardless of how many hooks AND singletons subscribe.
 *
 * @param {(state: DocumentVisibilityState) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeVisibility(fn) {
  subscribers.add(fn);
  ensureAttached();
  return () => {
    subscribers.delete(fn);
    detachIfEmpty();
  };
}

/**
 * Subscribe to `document.visibilitychange` via a shared singleton listener.
 * The handler receives the new `document.visibilityState` string.
 *
 * @param {(state: DocumentVisibilityState) => void} handler
 */
export function useVisibilityEvent(handler) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; }, [handler]);

  useEffect(() => {
    return subscribeVisibility((state) => handlerRef.current?.(state));
  }, []);
}

// Test-only escape hatch. Lets the test reset module-scope state between
// runs without exposing it as a public API.
export function __resetVisibilityEventForTests() {
  subscribers.clear();
  if (attached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', dispatch);
  }
  attached = false;
}
