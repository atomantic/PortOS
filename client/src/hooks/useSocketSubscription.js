/**
 * Hook giving refcounted `subscribe`/`unsubscribe` for a socket subscriber room, re-subscribing on
 * reconnect and unsubscribing when the last consumer unmounts.
 */

import { useEffect, useRef } from 'react';
import socket from '../services/socket';

/**
 * Module-level refcount registry, keyed by namespace, backing the server's refcount-FREE subscriber Set (`registerSubscriber` in `server/services/socket.js`). Room membership is per server-side socket OBJECT
 * and `disconnect` clears it (server/services/socket.js:167), so after a reconnect (restart, PM2 reload, self-update, sleep, network blip) every namespace must be re-subscribed; this does it once per namespace
 * while any consumer is mounted instead of each hook re-implementing `socket.on('connect', subscribe)`.
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
 * - `onResubscribe`, if given, runs after every socket-`connect`-triggered `<namespace>:subscribe` re-emission so a consumer can refetch what it missed while disconnected. This INCLUDES the first `connect` a mount
 *   observes (it can mount while the socket is still connecting, after an outage that also broke its initial HTTP fetch); the cost is one redundant refetch in the common case.
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
 * @param {string} namespace - a namespace registered server-side via
 *   `registerSubscriber` (e.g. 'notifications', 'errors', 'instances', 'loops').
 * @param {{ onResubscribe?: () => void, enabled?: boolean, payload?: object, releasePayload?: object }} [options]
  * client/src/test/guards/ui/socketSubscriptionConventions.test.js enforces this: no code emits a literal `<ns>:subscribe` outside this hook.
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
