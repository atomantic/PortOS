import { useEffect, useRef } from 'react';
import socket from '../services/socket';

/**
 * Module-level refcount registry, keyed by namespace, backing the server's
 * refcount-FREE subscriber Set (`registerSubscriber` in
 * `server/services/socket.js`) with a correct client-side refcount.
 *
 * The server keeps room membership per server-side socket OBJECT — a Set that
 * `disconnect` clears entirely (server/services/socket.js:167). When the
 * shared client socket reconnects (server restart, PM2 reload, self-update,
 * laptop sleep, a Wi-Fi/Tailscale blip), the server sees a brand new socket
 * belonging to no subscriber set, so every namespace has to be re-subscribed.
 * This registry does that once per namespace, for as long as at least one
 * consumer is mounted, instead of every hook re-implementing its own
 * `socket.on('connect', subscribe)`.
 */
const registry = new Map();

function getEntry(namespace) {
  let entry = registry.get(namespace);
  if (!entry) {
    entry = { count: 0, connectHandler: null, callbacks: new Set() };
    registry.set(namespace, entry);
  }
  return entry;
}

/**
 * Subscribe this component to a shared `<namespace>:subscribe` socket room
 * for as long as it is mounted, backed by a module-level refcount so several
 * consumers of the same namespace share one subscription:
 *
 * - The FIRST mounted consumer of a namespace emits `<namespace>:subscribe`
 *   and re-emits it on every socket `connect` (initial connect and every
 *   reconnect) for as long as any consumer holds the namespace.
 * - The LAST consumer to unmount emits `<namespace>:unsubscribe`.
 * - `onResubscribe`, if given, runs after every `<namespace>:subscribe`
 *   re-emission triggered by a socket `connect` event — so a consumer can
 *   refetch whatever it may have missed while disconnected. This INCLUDES the
 *   first `connect` a mount observes: a component can mount while the socket
 *   is still connecting (or reconnecting after an outage that also broke its
 *   own initial HTTP fetch), and skipping that first connect would leave
 *   stale data uncorrected until some later reconnect. The trade-off is one
 *   redundant refetch in the common case (mount while already-connecting,
 *   HTTP fetch already fresh) — cheap next to silently missing a real miss.
 *
 * @param {string} namespace - a namespace registered server-side via
 *   `registerSubscriber` (e.g. 'notifications', 'errors', 'instances', 'loops').
 * @param {{ onResubscribe?: () => void }} [options]
 */
export function useSocketSubscription(namespace, { onResubscribe } = {}) {
  const onResubscribeRef = useRef(onResubscribe);
  onResubscribeRef.current = onResubscribe;

  useEffect(() => {
    const entry = getEntry(namespace);

    const callback = () => onResubscribeRef.current?.();
    entry.callbacks.add(callback);

    if (entry.count === 0) {
      socket.emit(`${namespace}:subscribe`);
      entry.connectHandler = () => {
        socket.emit(`${namespace}:subscribe`);
        for (const cb of entry.callbacks) cb();
      };
      socket.on('connect', entry.connectHandler);
    }
    entry.count += 1;

    return () => {
      entry.callbacks.delete(callback);
      entry.count -= 1;
      if (entry.count <= 0) {
        socket.emit(`${namespace}:unsubscribe`);
        if (entry.connectHandler) socket.off('connect', entry.connectHandler);
        registry.delete(namespace);
      }
    };
  }, [namespace]);
}
