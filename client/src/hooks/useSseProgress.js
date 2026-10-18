import { useEffect, useRef, useState } from 'react';
import { maybeRedirectToLogin } from '../services/apiCore';

// Both cancel spellings are terminal. Every emitter normalizes on `canceled`
// (single l); `cancelled` stays tolerated defensively so a stream from an
// emitter that drifts back to the double-l spelling still terminates.
// `paused` is terminal too: the series-autopilot runner ends a run by
// broadcasting `paused` (budget/non-convergence/canon gate) and then closing
// the SSE server-side, so the client must treat it as stream-ending. Inert for
// other consumers — no other runner emits a `paused` frame.
const TERMINAL_TYPES = new Set(['complete', 'canceled', 'cancelled', 'error', 'paused']);

/** True when a frame is one of the stream-ending types this hook closes on. */
export const isTerminalSseFrame = (frame) => TERMINAL_TYPES.has(frame?.type);

export const DEFAULT_MAX_SSE_FRAMES = 200;

// One shared empty history so a `maxFrames: 0` consumer's `frames` keeps a
// stable identity (every setFrames(EMPTY_FRAMES) bails out as a no-op).
const EMPTY_FRAMES = Object.freeze([]);

/** Append a frame, dropping the oldest ones so at most `max` are retained. */
export const appendBoundedFrame = (frames, frame, max) => (
  frames.length < max ? [...frames, frame] : [...frames.slice(frames.length - max + 1), frame]
);

/**
 * GET uses EventSource reconnects; POST reads one fetch stream without retry.
 * Subscribe to a server-side SSE stream of JSON-payload progress
 * frames. Used by both the per-issue auto-runner and the per-volume
 * beat-sheet runner — any new SSE-job hook should wrap this rather than
 * re-implement the lifecycle.
 *
 * The stream is torn down on unmount, when `url` changes, when `enabled`
 * flips false, or when a terminal frame (type === 'complete' / 'canceled'
 * / 'error') arrives.
 *
 * `frames` is a bounded history: at most `maxFrames` (default 200) are
 * retained, the oldest dropped first, so a multi-hour run cannot grow memory
 * or make each append O(run length). `latest` is its own cell — a consumer
 * that only needs the newest frame passes `maxFrames: 0` and the history is
 * never written, so it pays one state update (one render) per frame.
 */
export function useSseProgress(url, { enabled = true, method = 'GET', maxFrames = DEFAULT_MAX_SSE_FRAMES } = {}) {
  const [frames, setFrames] = useState(EMPTY_FRAMES);
  const [latest, setLatest] = useState(null);
  const [latestUrl, setLatestUrl] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  // `closed` flips true when the stream ends for ANY reason — a terminal frame
  // OR a connection failure/404 (e.g. the server pruned a fast-completing job
  // before we attached). Consumers that gate UI on a run being "in flight" use
  // this to recover instead of hanging forever waiting for a terminal frame
  // that will never arrive. Reset to false on every (re)subscribe.
  const [closed, setClosed] = useState(false);
  const esRef = useRef(null);
  // Read through a ref inside the stream handlers so a changed cap neither
  // resubscribes nor is ignored.
  const maxFramesRef = useRef(maxFrames);
  useEffect(() => { maxFramesRef.current = maxFrames; }, [maxFrames]);
  const record = (data, streamUrl) => {
    const max = maxFramesRef.current;
    if (max > 0) setFrames(prev => appendBoundedFrame(prev, data, max));
    setLatest(data);
    setLatestUrl(streamUrl);
  };

  useEffect(() => {
    if (!url || !enabled) {
      // Clear terminal/open state when disabled so a later re-enable starts
      // clean. Without this, a stale `closed=true` from a finished run makes a
      // consumer's "is the stream over?" check fire immediately on the NEXT
      // subscribe, tearing down the new stream before it can deliver progress.
      setIsOpen(false);
      setClosed(false);
      setLatestUrl(null);
      return undefined;
    }
    setFrames(EMPTY_FRAMES);
    setLatest(null);
    setLatestUrl(null);
    setIsOpen(false);
    setClosed(false);

    // A mutation stream gets exactly one request. Defer setup one tick so
    // React StrictMode's setup/cleanup probe cannot start the mutation twice.
    if (method === 'POST') {
      const controller = new AbortController();
      const connection = { close: () => controller.abort() };
      esRef.current = connection;
      const isCurrent = () => esRef.current === connection && !controller.signal.aborted;
      const receive = (data) => {
        if (!isCurrent()) return;
        record(data, url);
        if (isTerminalSseFrame(data)) {
          setIsOpen(false);
          setClosed(true);
          connection.close();
        }
      };
      const run = async () => {
        let reader;
        try {
          const response = await fetch(url, { method: 'POST', signal: controller.signal });
          if (!isCurrent()) return;
          if (!response.ok || !response.body?.getReader) {
            const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            maybeRedirectToLogin(response, error);
            throw new Error(error.error || `HTTP ${response.status}`);
          }
          setIsOpen(true);
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const consume = (frame) => {
            const json = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart()).join('\n');
            if (!json) return;
            let data;
            try { data = JSON.parse(json); } catch { return; }
            receive(data);
          };
          while (isCurrent()) {
            const { done, value } = await reader.read();
            if (!isCurrent()) break;
            if (done) {
              buffer += decoder.decode();
              if (buffer.trim()) consume(buffer);
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() || '';
            for (const frame of frames) consume(frame);
          }
          if (isCurrent()) receive({ type: 'error', message: 'Download connection lost. Try again.', kind: 'connection_lost' });
        } catch (error) {
          if (isCurrent()) receive({ type: 'error', message: error.message || 'Download connection lost. Try again.', kind: 'connection_lost' });
        } finally {
          if (reader) await reader.cancel().catch(() => {});
        }
      };
      const startTimer = setTimeout(run, 0);
      return () => {
        clearTimeout(startTimer);
        connection.close();
        if (esRef.current === connection) esRef.current = null;
      };
    }

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
      record(data, url);
      if (TERMINAL_TYPES.has(data?.type)) {
        es.close();
        setIsOpen(false); // the connection is now closed — keep isOpen honest
        setClosed(true);
      }
    };
    es.onerror = () => {
      setIsOpen(false);
      // EventSource fails (no auto-retry) on a non-2xx / non-event-stream
      // response — readyState CLOSED. Surface that as a terminal close so the
      // consumer stops waiting; transient errors (readyState CONNECTING) are
      // left alone so the browser's own retry can recover.
      if (es.readyState === EventSource.CLOSED) {
        setClosed(true);
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [url, enabled, method]);

  return { frames, latest, latestUrl, isOpen, closed, close: () => esRef.current?.close() };
}
