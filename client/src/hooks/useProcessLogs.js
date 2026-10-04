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

// The server keeps ONE `pm2 logs` stream per (socket.id, processName)
// (server/sockets/logs.js) — a second `logs:subscribe` for a key already in
// use kills the first stream and starts another, so two mounted
// `useProcessLogs` consumers of the same process (e.g. the desktop launch
// panel and the Processes tab) would otherwise clobber each other's stream
// (#8113). This module-level registry makes the CLIENT the refcount owner:
// the first consumer subscribes, later consumers attach to the existing
// entry, and only the last consumer to leave unsubscribes. One shared socket
// listener per event fans each frame out to every attached consumer.
//
// Keyed by `processName` alone (not `processName + appId`): the server's own
// stream key (`streamKey`) and its no-appId fallback lookup
// (`resolvePm2HomeForProcess`) both already treat `processName` as globally
// unique across apps, so two different apps sharing one PM2 process name
// already collide on the SERVER's single socket-scoped stream slot today —
// this registry mirrors that existing invariant rather than introducing one.
const registry = new Map(); // processName -> entry

// Stream lifecycle, shared by every consumer of an entry. `live` is only set by
// the server's matching `logs:subscribed` ack; the three terminal states keep
// the captured lines but must never render as an active stream (#9959).
export const LOG_STREAM_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  LIVE: 'live',
  CLOSED: 'closed', // the PM2 tail child exited
  ERROR: 'error', // the server reported a stream error
  DISCONNECTED: 'disconnected', // the socket transport dropped
});
const { CONNECTING, LIVE, CLOSED, ERROR, DISCONNECTED } = LOG_STREAM_STATUS;
const isTerminal = (status) => status === CLOSED || status === ERROR || status === DISCONNECTED;

const createEntry = (processName, lines, appId) => ({
  processName,
  appId,
  lines,
  consumers: new Set(), // Set<{ onLine, onStatus, onReset }>
  buffer: [], // shared tail buffer for late joiners, capped at MAX_LINES
  status: CONNECTING,
  detail: null, // human-readable reason for a terminal status
});

const setEntryStatus = (entry, status, detail = null) => {
  entry.status = status;
  entry.detail = detail;
  entry.consumers.forEach((consumer) => consumer.onStatus(status, detail));
};

const subscribeEntry = (entry) => {
  setEntryStatus(entry, CONNECTING);
  socket.emit('logs:subscribe', {
    processName: entry.processName,
    lines: entry.lines,
    ...(entry.appId ? { appId: entry.appId } : {}),
  });
};

const appendToEntry = (entry, payload) => {
  entry.buffer.push(payload);
  if (entry.buffer.length > MAX_LINES) entry.buffer.splice(0, entry.buffer.length - MAX_LINES);
  entry.consumers.forEach((consumer) => consumer.onLine(payload));
};

// One listener per event for the whole module. A per-consumer `socket.on`
// would need a per-consumer `socket.off` on unmount, and the LAST consumer
// leaving must not silence the SURVIVING consumers of other processes.
socket.on('logs:line', (data) => {
  const entry = registry.get(data.processName);
  if (!entry) return;
  appendToEntry(entry, { line: data.line, type: data.type, timestamp: data.timestamp });
});

socket.on('logs:subscribed', (data) => {
  const entry = registry.get(data.processName);
  if (!entry) return;
  setEntryStatus(entry, LIVE);
});

socket.on('logs:error', (data) => {
  const entry = registry.get(data.processName);
  if (!entry) return;
  appendToEntry(entry, { line: `Error: ${data.error}`, type: 'stderr', timestamp: Date.now() });
  setEntryStatus(entry, ERROR, String(data.error));
});

// The server flushes the final buffered lines BEFORE this frame (and suppresses
// a replaced predecessor's close), so it is a real, terminal end of the stream.
// With the socket still connected nothing else would ever re-subscribe, so the
// entry stays closed until the user retries. An earlier `logs:error` keeps its
// more specific detail.
socket.on('logs:close', (data) => {
  const entry = registry.get(data.processName);
  if (!entry || entry.status === ERROR) return;
  const code = data.code == null ? '' : ` (exit code ${data.code})`;
  setEntryStatus(entry, CLOSED, `Log stream closed${code}`);
});

socket.on('disconnect', (reason) => {
  registry.forEach((entry) => {
    if (entry.consumers.size > 0) {
      setEntryStatus(entry, DISCONNECTED, `Connection to the server was lost${reason ? ` (${reason})` : ''}`);
    }
  });
});

// The server drops every stream owned by a disconnected socket
// (`cleanupSocketStreams`), so a reconnect must re-subscribe every still-live
// entry, or every mounted consumer freezes with no error frame ever emitted.
socket.on('connect', () => {
  registry.forEach((entry) => {
    if (entry.consumers.size > 0) {
      // The server replays the requested PM2 tail on every subscription.
      // Replace each consumer's old tail before that replay arrives so a
      // reconnect cannot append duplicate history to the shared buffer/UI.
      entry.buffer = [];
      entry.consumers.forEach((consumer) => consumer.onReset());
      subscribeEntry(entry);
    }
  });
});

// Manual recovery. Acts only on a terminal entry, so several consumers (or a
// double click) of one shared stream produce exactly ONE replacement subscribe.
// A dropped transport reconnects first: its `connect` handler above performs the
// resubscribe, so emitting here too would subscribe twice.
const retryEntry = (entry) => {
  if (!isTerminal(entry.status)) return;
  if (entry.status === DISCONNECTED && socket.connected === false) {
    setEntryStatus(entry, CONNECTING);
    socket.connect?.();
    return;
  }
  // The server replays the PM2 tail on every subscription — drop the old tail
  // so the replay cannot duplicate history.
  entry.buffer = [];
  entry.consumers.forEach((consumer) => consumer.onReset());
  subscribeEntry(entry);
};

/**
 * Subscribe to one PM2 process's live log stream over the shared socket.
 *
 * Wraps the `logs:subscribe` / `logs:line` / `logs:subscribed` / `logs:error`
 * dance so callers only deal with `{ logs, status, ... }`. Every frame is
 * filtered by `processName` before it lands — the server emits the name on each
 * line, and a stale frame from a just-unsubscribed process would otherwise be
 * appended to the new one's buffer.
 *
 * Multiple consumers naming the same `processName` (e.g. the desktop launch
 * panel and the Processes tab tailing the same app) share one underlying
 * server stream via the module-level registry above — see #8113. A later
 * consumer is seeded from the shared entry's current tail instead of
 * triggering a re-subscribe, so the earlier consumer never sees its tail
 * replayed a second time.
 *
 * @param {string|null} processName PM2 process to tail; falsy = unsubscribed/idle.
 * @param {object} [options]
 * @param {number} [options.lines=500] Tail depth requested on subscribe.
 * @param {string} [options.appId] App whose custom PM2_HOME holds the process.
 *   Omit for processes in the default home.
 * @returns {{ logs: Array<{line: string, type: string, timestamp: number}>, subscribed: boolean,
 *   status: 'connecting'|'live'|'closed'|'error'|'disconnected', statusDetail: string|null,
 *   retry: () => void, clear: () => void }}
 *   `status` is shared by every consumer of the process; `subscribed` is just
 *   `status === 'live'`. A `closed`/`error`/`disconnected` stream keeps its
 *   captured lines but is no longer receiving — render it as unavailable and
 *   offer `retry()`, which resubscribes the shared stream once (never an
 *   automatic respawn loop).
 *   `clear()` empties the local buffer only — the stream stays subscribed, so
 *   new lines keep arriving (this backs a "Clear" button, not an unsubscribe).
 *   It never mutates the shared entry buffer, so it does not affect any other
 *   consumer's view of the same process.
 */
const INITIAL_STREAM = { status: CONNECTING, detail: null };

export function useProcessLogs(processName, options = {}) {
  const { lines = 500, appId } = options;
  const [logs, setLogs] = useState([]);
  const [stream, setStream] = useState(INITIAL_STREAM);
  const pendingRef = useRef([]);
  const flushTimerRef = useRef(null);

  useEffect(() => {
    setLogs([]);
    setStream(INITIAL_STREAM);
    if (!processName) return undefined;

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
    const queueLine = (entry) => {
      pendingRef.current.push(entry);
      if (flushTimerRef.current == null) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    };

    let entry = registry.get(processName);
    const isFirstConsumer = !entry;
    if (!entry) {
      entry = createEntry(processName, lines, appId);
      registry.set(processName, entry);
    }

    const consumer = {
      onLine: queueLine,
      onStatus: (status, detail) => setStream((prev) => (
        prev.status === status && prev.detail === detail ? prev : { status, detail }
      )),
      onReset: () => {
        pendingRef.current = [];
        if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        setLogs([]);
      },
    };
    entry.consumers.add(consumer);

    if (isFirstConsumer) {
      subscribeEntry(entry);
    } else {
      // The PM2 stream is shared, so the first consumer's tail depth must not
      // cap a later consumer that asked for more history. Reset every view
      // before replacing the stream: the server replays the expanded tail on
      // subscribe, and retaining existing lines would duplicate that replay.
      if (lines > entry.lines) {
        entry.lines = lines;
        entry.buffer = [];
        entry.consumers.forEach((existing) => existing.onReset());
        subscribeEntry(entry);
      }
      // Late joiner: seed from the existing entry's tail (capped to this
      // consumer's own `lines`) instead of re-subscribing, which would
      // replay the tail into every consumer already watching this stream. An
      // expanded stream was reset above and will seed from its replay instead.
      // This also carries a terminal state to the newcomer instead of a false
      // "connecting"/"live" read off a dead stream.
      setStream({ status: entry.status, detail: entry.detail });
      const seeded = entry.buffer.slice(-lines);
      if (seeded.length > 0) setLogs(seeded);
    }

    return () => {
      entry.consumers.delete(consumer);
      if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      pendingRef.current = [];
      // Last consumer out unsubscribes and drops the entry so a later
      // remount starts a fresh stream instead of replaying a stale tail.
      if (entry.consumers.size === 0) {
        registry.delete(processName);
        socket.emit('logs:unsubscribe', { processName });
      }
    };
  }, [processName, lines, appId]);

  const clear = useCallback(() => {
    // Also drop anything buffered but not yet flushed, or a pending timer would
    // repopulate the list the user just cleared. This only touches THIS
    // consumer's own state — the shared entry buffer other consumers seed
    // from is left untouched.
    pendingRef.current = [];
    setLogs([]);
  }, []);

  const retry = useCallback(() => {
    const entry = processName ? registry.get(processName) : null;
    if (entry) retryEntry(entry);
  }, [processName]);

  return {
    logs,
    subscribed: stream.status === LIVE,
    status: stream.status,
    statusDetail: stream.detail,
    retry,
    clear,
  };
}

export default useProcessLogs;
