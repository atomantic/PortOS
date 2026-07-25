import { useState, useEffect, useCallback, useRef } from 'react';
import socket from '../services/socket';

// Ring-buffer cap. `pm2 logs` replays the tail on subscribe and then streams
// live, so an unbounded array grows without limit on a chatty process.
const MAX_LINES = 1000;
// Batch window. The server emits one `logs:line` event PER LINE, and each lands
// in its own socket task that React won't auto-batch — so a compiling desktop
// app (or the 200-500 line tail replay on subscribe) would otherwise be one
// render and two full array allocations per line. Matches the repo's stated
// ~250ms debounce for high-frequency state writes.
const FLUSH_MS = 250;

/**
 * Subscribe to one PM2 process's live log stream over the shared socket.
 *
 * Wraps the `logs:subscribe` / `logs:line` / `logs:subscribed` / `logs:error`
 * dance so callers only deal with `{ logs, subscribed }`. Every frame is
 * filtered by `processName` before it lands — the server emits the name on each
 * line, and a stale frame from a just-unsubscribed process would otherwise be
 * appended to the new one's buffer.
 *
 * **One stream per socket.** The server calls `cleanupStream(socket.id)` on
 * every subscribe, so two mounted callers fight over the single slot and the
 * later mount wins. Only ever have one of these active at a time (the app detail
 * view's tabs are mutually exclusive, which is what makes that safe).
 *
 * @param {string|null} processName PM2 process to tail; falsy = unsubscribed/idle.
 * @param {object} [options]
 * @param {number} [options.lines=500] Tail depth requested on subscribe.
 * @param {string} [options.appId] App whose custom PM2_HOME holds the process.
 *   Omit for processes in the default home.
 * @returns {{ logs: Array<{line: string, type: string, timestamp: number}>, subscribed: boolean, clear: () => void }}
 *   `clear()` empties the local buffer only — the stream stays subscribed, so
 *   new lines keep arriving (this backs a "Clear" button, not an unsubscribe).
 */
export function useProcessLogs(processName, options = {}) {
  const { lines = 500, appId } = options;
  const [logs, setLogs] = useState([]);
  const [subscribed, setSubscribed] = useState(false);
  const pendingRef = useRef([]);
  const flushTimerRef = useRef(null);

  useEffect(() => {
    setLogs([]);
    setSubscribed(false);
    if (!processName) return;

    const flush = () => {
      flushTimerRef.current = null;
      if (pendingRef.current.length === 0) return;
      const incoming = pendingRef.current;
      pendingRef.current = [];
      setLogs(prev => {
        const combined = [...prev, ...incoming];
        return combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined;
      });
    };
    const append = (entry) => {
      pendingRef.current.push(entry);
      if (flushTimerRef.current == null) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    };

    socket.emit('logs:subscribe', { processName, lines, ...(appId ? { appId } : {}) });

    const handleLog = (data) => {
      if (data.processName !== processName) return;
      append({ line: data.line, type: data.type, timestamp: data.timestamp });
    };

    const handleSubscribed = (data) => {
      if (data.processName === processName) setSubscribed(true);
    };

    const handleError = (data) => {
      if (data.processName !== processName) return;
      append({ line: `Error: ${data.error}`, type: 'stderr', timestamp: Date.now() });
    };

    socket.on('logs:line', handleLog);
    socket.on('logs:subscribed', handleSubscribed);
    socket.on('logs:error', handleError);

    return () => {
      socket.emit('logs:unsubscribe', { processName });
      socket.off('logs:line', handleLog);
      socket.off('logs:subscribed', handleSubscribed);
      socket.off('logs:error', handleError);
      // Drop the pending batch with the subscription: the effect re-run clears
      // `logs` anyway, so flushing here would append the old process's tail to
      // the new one's empty buffer.
      if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      pendingRef.current = [];
    };
  }, [processName, lines, appId]);

  const clear = useCallback(() => {
    // Also drop anything buffered but not yet flushed, or a pending timer would
    // repopulate the list the user just cleared.
    pendingRef.current = [];
    setLogs([]);
  }, []);

  return { logs, subscribed, clear };
}

export default useProcessLogs;
