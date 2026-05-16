import { useEffect, useRef, useState } from 'react';

const TERMINAL_TYPES = new Set(['complete', 'canceled', 'error']);

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
  const esRef = useRef(null);

  useEffect(() => {
    if (!url || !enabled) return undefined;
    setFrames([]);
    setLatest(null);
    setIsOpen(false);

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
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setIsOpen(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url, enabled]);

  return { frames, latest, isOpen, close: () => esRef.current?.close() };
}
