import { useEffect, useRef, useState } from 'react';
import { safeParseJSON } from '../lib/genUtils';

/**
 * Shared EventSource lifecycle for the BYO runtime install modals
 * (Flux2InstallModal, RuntimeInstallModal). Both streamed the same shape of
 * SSE install log — open on `open`, dispatch `stage`/`log`/`complete`/`error`
 * frames, cap the retained log, surface a "connection lost" error when the
 * socket drops before `complete`, and auto-scroll the log to the bottom — so
 * the plumbing lives here once and each modal keeps only its own chrome.
 *
 * Frame contract (matches the server emitters in pythonSetup.js /
 * setup-image-video.sh):
 *   { type: 'stage',    stage, message? }  → advances currentStage + logs it
 *   { type: 'log',      message }          → appends a log line
 *   { type: 'complete', message }          → done=true, onComplete(), closes
 *   { type: 'error',    message }          → error set, closes
 *
 * Closing the EventSource (via `close()` on cancel, or unmount/disable) is what
 * the server interprets as a cancel — it SIGTERMs the underlying pip/bash child.
 *
 * Deliberately NOT built on `useSseProgress`: this needs kind-tagged log
 * accumulation with a cap + optional debounced flush, stage tracking, a
 * `streamStarted` signal, `doneRef`-gated connection-lost suppression, an
 * `onComplete` callback, and auto-scroll — all beyond what `useSseProgress`
 * exposes. Wrapping it would add indirection without removing code.
 *
 * `flushMs` controls log batching: 0 flushes each line synchronously (fine for
 * the structured, bounded FLUX.2 stream); >0 buffers and flushes on a debounce
 * so a chatty pip/git stream re-renders the log list at ~1/flushMs Hz instead
 * of once per line.
 *
 * @param {string|null} url - SSE endpoint; null/empty leaves the stream closed.
 * @param {object} opts
 * @param {boolean} [opts.enabled=true] - when false, the stream stays closed and state resets.
 * @param {() => void} [opts.onComplete] - fired once on the `complete` frame.
 * @param {number} [opts.maxLogLines=500] - cap on retained log lines.
 * @param {number} [opts.flushMs=0] - 0 = per-line flush; >0 = debounce window.
 * @returns {{ logs, currentStage, done, error, streamStarted, logsEndRef, close }}
 */

const DEFAULT_MAX_LOG_LINES = 500;
const CONNECTION_LOST_MESSAGE = 'Connection to installer lost. Restart PortOS or try again.';

export function useInstallStream(url, {
  enabled = true,
  onComplete,
  maxLogLines = DEFAULT_MAX_LOG_LINES,
  flushMs = 0,
} = {}) {
  const [logs, setLogs] = useState([]);
  const [currentStage, setCurrentStage] = useState(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [streamStarted, setStreamStarted] = useState(false);
  const logsEndRef = useRef(null);
  const esRef = useRef(null);
  // Mirror `done` into a ref so es.onerror reads the latest value — the effect
  // closure captures the initial done=false and never refreshes, so without
  // this the modal can flash "Connection lost" when the server cleanly closes
  // the socket right after sending `complete`.
  const doneRef = useRef(false);
  // Stash onComplete in a ref so the EventSource effect doesn't tear down the
  // SSE connection on every parent re-render with a fresh inline arrow.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Buffer incoming lines and flush them together. Pip and git can each emit
  // hundreds of lines/sec; per-line setState would re-render the whole log list
  // on every line.
  const pendingRef = useRef([]);
  const flushTimerRef = useRef(null);
  const flush = () => {
    flushTimerRef.current = null;
    if (pendingRef.current.length === 0) return;
    const incoming = pendingRef.current;
    pendingRef.current = [];
    setLogs((prev) => {
      const combined = [...prev, ...incoming];
      return combined.length > maxLogLines ? combined.slice(-maxLogLines) : combined;
    });
  };
  const appendLog = (entry) => {
    pendingRef.current.push(entry);
    if (flushMs > 0) {
      if (flushTimerRef.current == null) flushTimerRef.current = setTimeout(flush, flushMs);
    } else {
      flush();
    }
  };

  useEffect(() => {
    const clearFlush = () => {
      if (flushTimerRef.current != null) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      // Drop any un-flushed lines too: with flushMs > 0 a superseded stream can
      // leave buffered lines behind, and the next stream's flush would render
      // them into its own log.
      pendingRef.current = [];
    };
    const closeStream = () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };

    if (!enabled || !url) {
      setLogs([]);
      setCurrentStage(null);
      setDone(false);
      doneRef.current = false;
      setError(null);
      setStreamStarted(false);
      clearFlush();
      closeStream();
      return undefined;
    }

    // Reset state on every (re)subscribe, not just on disable — a url change
    // while enabled (e.g. a retry that bumps an attempt counter) must start
    // the new stream clean, or a prior run's `error`/`done`/log lines leak
    // into it (wedging consumers that derive "installing" from those flags).
    setLogs([]);
    setCurrentStage(null);
    setDone(false);
    doneRef.current = false;
    setError(null);
    setStreamStarted(true);
    const es = new EventSource(url);
    esRef.current = es;
    // Close the instance that fired this event, not whatever esRef currently
    // points at — so a late callback from a superseded stream can't tear down
    // (or null out) a newer one after a url/enabled change.
    const closeThis = () => { if (esRef.current === es) esRef.current = null; es.close(); };

    es.onmessage = (ev) => {
      if (esRef.current !== es) return; // stale callback from a superseded stream
      const msg = safeParseJSON(ev.data);
      if (!msg) return;
      if (msg.type === 'stage') {
        setCurrentStage(msg.stage);
        appendLog({ kind: 'stage', text: msg.message || msg.stage });
      } else if (msg.type === 'log') {
        appendLog({ kind: 'log', text: msg.message });
      } else if (msg.type === 'complete') {
        setDone(true);
        doneRef.current = true;
        appendLog({ kind: 'success', text: msg.message });
        flush();
        closeThis();
        onCompleteRef.current?.();
      } else if (msg.type === 'error') {
        setError(msg.message);
        appendLog({ kind: 'error', text: msg.message });
        flush();
        closeThis();
      }
    };

    es.onerror = () => {
      if (esRef.current !== es) return; // stale callback from a superseded stream
      // Network drop or server killed the stream. If we already saw `complete`
      // this is harmless; otherwise surface it so the user isn't stuck on a
      // forever-spinning modal.
      setError((prev) => prev ?? (doneRef.current ? null : CONNECTION_LOST_MESSAGE));
      closeThis();
    };

    return () => {
      clearFlush();
      closeThis();
    };
    // onComplete intentionally excluded — it lives in onCompleteRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled, maxLogLines, flushMs]);

  // Auto-scroll on every new line. behavior:'auto' (instant) avoids queueing
  // hundreds of smooth-scroll animations during a chatty install.
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [logs.length]);

  const close = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  };

  return { logs, currentStage, done, error, streamStarted, logsEndRef, close };
}
