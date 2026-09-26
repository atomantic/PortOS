import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription';
import { useVisibilityEvent } from './useVisibilityEvent';

const visible = () => document.visibilityState !== 'hidden';

/**
 * Read once, then reconcile a resource on room events, reconnect and tab show.
 * Keep events stable (module-level). fetchFn returns data without setting state.
 * resourceKey cancels old reads; updateData applies mutation responses and
 * prevents an older in-flight read from overwriting them.
 */
export function useSocketResource(fetchFn, { namespace, events, resourceKey = null, matchesEvent = () => true }) {
  const [state, setState] = useState({ key: resourceKey, data: null, loading: true, error: null });
  const fetchRef = useRef(fetchFn);
  const matchesRef = useRef(matchesEvent);
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
    const read = () => {
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
          await Promise.resolve().then(() => fetchRef.current()).then(data => {
            if (!disposed && started === revision) {
              setState({ key: resourceKey, data, loading: false, error: null });
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
    const invalidate = payload => {
      if (visible() && matchesRef.current(payload)) read();
    };
    for (const event of events) socket.on(event, invalidate);
    if (visible()) read();
    return () => {
      disposed = true;
      controller.current = null;
      for (const event of events) socket.off(event, invalidate);
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
