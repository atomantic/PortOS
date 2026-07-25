import { useState, useEffect, useCallback } from 'react';
import socket from '../services/socket';

// Ring-buffer cap. `pm2 logs` replays the tail on subscribe and then streams
// live, so an unbounded array grows without limit on a chatty process.
const MAX_LINES = 1000;

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

  useEffect(() => {
    if (!processName) {
      setLogs([]);
      setSubscribed(false);
      return;
    }

    // Reset here rather than in the caller's click handler so switching
    // processes can't briefly show the previous one's tail under the new name.
    setLogs([]);
    setSubscribed(false);

    socket.emit('logs:subscribe', { processName, lines, ...(appId ? { appId } : {}) });

    const handleLog = (data) => {
      if (data.processName !== processName) return;
      setLogs(prev => [...prev.slice(-(MAX_LINES - 1)), {
        line: data.line,
        type: data.type,
        timestamp: data.timestamp
      }]);
    };

    const handleSubscribed = (data) => {
      if (data.processName === processName) setSubscribed(true);
    };

    const handleError = (data) => {
      if (data.processName !== processName) return;
      setLogs(prev => [...prev, { line: `Error: ${data.error}`, type: 'stderr', timestamp: Date.now() }]);
    };

    socket.on('logs:line', handleLog);
    socket.on('logs:subscribed', handleSubscribed);
    socket.on('logs:error', handleError);

    return () => {
      socket.emit('logs:unsubscribe', { processName });
      socket.off('logs:line', handleLog);
      socket.off('logs:subscribed', handleSubscribed);
      socket.off('logs:error', handleError);
    };
  }, [processName, lines, appId]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, subscribed, clear };
}

export default useProcessLogs;
