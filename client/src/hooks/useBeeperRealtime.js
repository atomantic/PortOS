import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';

/**
 * Subscribe to the server's Beeper realtime relay (fork issue #33, decided on #12).
 *
 * The frames are INVALIDATION ONLY — `{ kind, chatID, ids, seq, ts }`, never
 * message bodies, display names or handles. A consumer reacts by refetching from
 * the PortOS API, which is the read path for the mirror; that is what keeps
 * "displayed" implying "persisted" and keeps a wrong broadcast leaking a UUID
 * instead of a conversation.
 *
 * **The subscription is re-emitted on every `connect`, not just at mount.** The
 * server rebuilds an empty per-socket subscriber Set on reconnect, so a one-shot
 * emit at mount goes permanently dead after a laptop sleep — the scar tissue
 * carried by `useMoltworldWs` and `ChiefOfStaff` for the same reason.
 *
 * One global subscription with client-side filtering, matching every other
 * subscriber namespace: per-conversation subscribe would drag in pending-request
 * generation tracking for a volume problem a single-user localhost install does
 * not have.
 *
 * @param {object} [options]
 * @param {(frame: object) => void} [options.onInvalidate] called per invalidation frame.
 */
export default function useBeeperRealtime({ onInvalidate } = {}) {
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
    const subscribe = () => socket.emit('beeper:subscribe');
    subscribe();
    socket.on('connect', subscribe);

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
      socket.off('connect', subscribe);
      socket.off('beeper:invalidate', handleInvalidate);
      socket.off('beeper:realtime', handleState);
      socket.emit('beeper:unsubscribe');
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
