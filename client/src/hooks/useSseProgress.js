import { useEffect, useRef, useState } from 'react';

// Both cancel spellings are terminal. Every emitter normalizes on `canceled`
// (single l); `cancelled` stays tolerated defensively so a stream from an
// emitter that drifts back to the double-l spelling still terminates.
const TERMINAL_TYPES = new Set(['complete', 'canceled', 'cancelled', 'error']);

/** True when a frame is one of the stream-ending types this hook closes on. */
export const isTerminalSseFrame = (frame) => TERMINAL_TYPES.has(frame?.type);

/**
 * Subscribe to a server-side EventSource stream of JSON-payload progress
 * frames. Used by both the per-issue auto-runner and the per-volume
 * beat-sheet runner — any new SSE-job hook should wrap this rather than
 * re-implement the lifecycle.
 *
 * The stream is torn down on unmount, when `url` changes, when `enabled`
 * flips false, or when a terminal frame (type === 'complete' / 'canceled'
 * / 'error') arrives.
 */
export function useSseProgress(url, { enabled = true } = {}) {
  const [frames, setFrames] = useState([]);
  const [latest, setLatest] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  // `closed` flips true when the stream ends for ANY reason — a terminal frame
  // OR a connection failure/404 (e.g. the server pruned a fast-completing job
  // before we attached). Consumers that gate UI on a run being "in flight" use
  // this to recover instead of hanging forever waiting for a terminal frame
  // that will never arrive. Reset to false on every (re)subscribe.
  const [closed, setClosed] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!url || !enabled) {
      // Clear terminal/open state when disabled so a later re-enable starts
      // clean. Without this, a stale `closed=true` from a finished run makes a
      // consumer's "is the stream over?" check fire immediately on the NEXT
      // subscribe, tearing down the new stream before it can deliver progress.
      setIsOpen(false);
      setClosed(false);
      return undefined;
    }
    setFrames([]);
    setLatest(null);
    setIsOpen(false);
    setClosed(false);

    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setIsOpen(true);
    es.onmessage = (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }
      setFrames((prev) => [...prev, data]);
      setLatest(data);
      if (TERMINAL_TYPES.has(data?.type)) {
        es.close();
        setIsOpen(false); // the connection is now closed — keep isOpen honest
        setClosed(true);
      }
    };
    es.onerror = () => {
      // EventSource fails (no auto-retry) on a non-2xx / non-event-stream
      // response — readyState CLOSED. Surface that as a terminal close so the
      // consumer stops waiting; transient errors (readyState CONNECTING) are
      // left alone so the browser's own retry can recover.
      if (es.readyState === EventSource.CLOSED) {
        setIsOpen(false);
        setClosed(true);
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url, enabled]);

  return { frames, latest, isOpen, closed, close: () => esRef.current?.close() };
}
