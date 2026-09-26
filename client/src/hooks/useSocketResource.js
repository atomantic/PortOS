import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription';
import { useVisibilityEvent } from './useVisibilityEvent';

const visible = () => document.visibilityState !== 'hidden';

/**
 * Read once, then reconcile a resource on room events, reconnect and tab show.
 * Omit namespace for globally broadcast events. fetchFn receives
 * { reconcile, events: [{ event, payload }] } for targeted invalidation reads.
 * Keep events stable (module-level). fetchFn returns data without setting state.
 * resourceKey cancels old reads; updateData applies mutation responses and
 * prevents an older in-flight read from overwriting them.
 */
export function useSocketResource(fetchFn, { namespace, events, resourceKey = null, matchesEvent = () => true, compare }) {
  const [state, setState] = useState({ key: resourceKey, data: null, loading: true, error: null });
  const fetchRef = useRef(fetchFn);
  const matchesRef = useRef(matchesEvent);
  const compareRef = useRef(compare);
  compareRef.current = compare;
  fetchRef.current = fetchFn;
  matchesRef.current = matchesEvent;
  const controller = useRef(null);

  const refetch = useCallback(() => controller.current?.read(), []);
  useSocketSubscription(namespace, { onResubscribe: () => {
    if (visible()) refetch();
  } });

  useEffect(() => {
    let disposed = false;
    let pending = null;
    let dirty = false;
    let revision = 0;
    let reconcile = false;
    let invalidations = [];
    const read = (invalidation = null) => {
      if (invalidation) invalidations.push(invalidation);
      else reconcile = true;
      if (disposed) return Promise.resolve();
      if (pending) {
        dirty = true;
        return pending;
      }
      // Defer invocation one microtask so a synchronous event burst is one read.
      pending = Promise.resolve().then(async () => {
        if (disposed) return;
        do {
          dirty = false;
          const started = revision;
          const request = { reconcile, events: invalidations };
          reconcile = false;
          invalidations = [];
          await Promise.resolve().then(() => fetchRef.current(request)).then(data => {
            if (!disposed && started === revision) {
              setState(previous => ({
                key: resourceKey,
                data: compareRef.current?.(previous.data, data) ? previous.data : data,
                loading: false, error: null
              }));
            }
          }, error => {
            if (!disposed && started === revision) {
              setState(previous => ({ ...previous, loading: false, error }));
            }
          });
        } while (dirty && !disposed && visible());
        pending = null;
      });
      return pending;
    };
    controller.current = {
      read,
      key: resourceKey,
      update: updater => {
        revision += 1;
        setState(previous => ({ key: resourceKey, data: updater(previous.data), loading: false, error: null }));
      },
    };
    setState({ key: resourceKey, data: null, loading: true, error: null });
    const handlers = events.map(event => {
      const invalidate = payload => {
        if (visible() && matchesRef.current(payload, event)) read({ event, payload });
      };
      socket.on(event, invalidate);
      return [event, invalidate];
    });
    // Broadcast domains have no subscription room. Room consumers already
    // reconcile through useSocketSubscription, so never attach both paths.
    const reconnect = () => { if (visible()) read(); };
    if (!namespace) socket.on('connect', reconnect);
    if (visible()) read();
    return () => {
      disposed = true;
      controller.current = null;
      for (const [event, handler] of handlers) socket.off(event, handler);
      if (!namespace) socket.off('connect', reconnect);
    };
  }, [namespace, events, resourceKey]);

  const lastVisibility = useRef(document.visibilityState);
  useVisibilityEvent(state => {
    const changed = lastVisibility.current !== state;
    lastVisibility.current = state;
    if (changed && state === 'visible') refetch();
  });

  const updateData = useCallback(updater => {
    if (controller.current?.key === resourceKey) controller.current.update(updater);
  }, [resourceKey]);

  const current = state.key === resourceKey ? state : { data: null, loading: true, error: null };
  return { ...current, refetch, updateData };
}
