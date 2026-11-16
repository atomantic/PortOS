/**
 * Subscribes to the server's Beeper realtime relay — invalidation frames (`{ kind, chatID, ids, seq,
 * ts }`, never message content) plus the `connected` / `reconnecting` / `down` transport state.
 *
 * Re-emits `beeper:subscribe` on every socket `connect`. Returns `{ realtime, connectionState,
 * lastInvalidation, seedRealtime }`. Use when: Any Beeper surface that must refetch when the mirror
 * changes (#33).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription';

/**
 * Subscribe to the server's Beeper realtime relay (fork issue #33, decided on #12). The frames are INVALIDATION ONLY (`{ kind, chatID, ids, seq, ts }`, never message bodies, display names or handles): a consumer refetches from the PortOS API, the read path for the mirror, which keeps "displayed" implying "persisted" and a wrong broadcast leaking a UUID, not a conversation.
 * **The subscription is re-emitted on every `connect`, not just at mount:** the server rebuilds an empty per-socket subscriber Set on reconnect, so a one-shot emit goes permanently dead after a laptop sleep (as for `useMoltworldWs` and `ChiefOfStaff`). One global subscription with client-side filtering, like every other subscriber namespace: per-conversation subscribe would drag in pending-request generation tracking for a volume problem a single-user localhost install doesn't have.
 * @param {object} [options]
 * @param {(frame: object) => void} [options.onInvalidate] called per invalidation frame.
 */
export default function useBeeperRealtime({ onInvalidate } = {}) {
  useSocketSubscription('beeper');
  // `null` = the server has not spoken yet (not-yet-known), distinct from a
  // reported `down`. A card must not render "offline" for a question it has
  // never asked.
  const [realtime, setRealtime] = useState(null);
  const [lastInvalidation, setLastInvalidation] = useState(null);

  // The callback rides a ref so a caller passing an inline arrow does not
  // re-run the effect — which would tear down and re-emit the subscription on
  // every render.
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;
  // Once the socket has spoken it is the fresher source, so a later status
  // refetch must not overwrite it with what the HTTP snapshot happened to hold.
  const socketSpokeRef = useRef(false);

  useEffect(() => {
    const handleInvalidate = (frame) => {
      setLastInvalidation(frame ?? null);
      onInvalidateRef.current?.(frame);
    };
    // Validate shape, not truthiness: `state` is the whole point of the frame,
    // and an absent/malformed payload must preserve the previous snapshot
    // rather than blanking the dot.
    const handleState = (state) => {
      if (!state || typeof state.state !== 'string') return;
      socketSpokeRef.current = true;
      setRealtime(state);
    };

    socket.on('beeper:invalidate', handleInvalidate);
    socket.on('beeper:realtime', handleState);

    return () => {
      socket.off('beeper:invalidate', handleInvalidate);
      socket.off('beeper:realtime', handleState);
    };
  }, []);

  // Seed the liveness state from a status payload the caller already fetched
  // (`GET /api/beeper/status` carries `realtime`), so the dot is correct before
  // the first socket frame arrives rather than blank until something changes.
  const seedRealtime = useCallback((state) => {
    if (socketSpokeRef.current) return;
    if (state && typeof state.state === 'string') setRealtime(state);
  }, []);

  return {
    realtime,
    connectionState: realtime?.state ?? null,
    lastInvalidation,
    seedRealtime,
  };
}
