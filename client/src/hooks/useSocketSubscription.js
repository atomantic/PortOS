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
 * - `payload` / `releasePayload`: a consumer that changes how the server
 *   serves the room (ChiefOfStaff's `{ taskLists: 'invalidate' }` mode, which
 *   `registerSubscriber` stores on the server-side socket) emits its own
 *   `<namespace>:subscribe` with `payload` at mount and on every `connect`,
 *   regardless of the refcount — the shared subscription may already exist
 *   and the server would otherwise never hear about the mode. At unmount it
 *   emits `releasePayload` the same way, BEFORE any final unsubscribe,
 *   because the mode outlives room membership on the server socket. Both are
 *   read through refs: a fresh object literal per render must not churn the
 *   subscription.
 *
 * Pass no namespace for broadcast-only consumers; no room is acquired.
 *
 * @param {string} namespace - a namespace registered server-side via
 *   `registerSubscriber` (e.g. 'notifications', 'errors', 'instances', 'loops').
 * @param {{ onResubscribe?: () => void, enabled?: boolean, payload?: object, releasePayload?: object }} [options]
 */
export function useSocketSubscription(namespace, {
  onResubscribe, enabled = true, payload, releasePayload,
} = {}) {
  const onResubscribeRef = useRef(onResubscribe);
  onResubscribeRef.current = onResubscribe;
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const releasePayloadRef = useRef(releasePayload);
  releasePayloadRef.current = releasePayload;

  useEffect(() => {
    if (!namespace || !enabled) return;
    const entry = getEntry(namespace);

    const subscribeWithPayload = () => {
      if (payloadRef.current !== undefined) socket.emit(`${namespace}:subscribe`, payloadRef.current);
    };
    // Registered before the shared handler fires below, so on connect the
    // bare subscribe lands first and this consumer's mode overrides it.
    const callback = () => {
      subscribeWithPayload();
      onResubscribeRef.current?.();
    };
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
    subscribeWithPayload();

    return () => {
      entry.callbacks.delete(callback);
      entry.count -= 1;
      if (releasePayloadRef.current !== undefined) {
        socket.emit(`${namespace}:subscribe`, releasePayloadRef.current);
      }
      if (entry.count <= 0) {
        socket.emit(`${namespace}:unsubscribe`);
        if (entry.connectHandler) socket.off('connect', entry.connectHandler);
        registry.delete(namespace);
      }
    };
  }, [namespace, enabled]);
}
