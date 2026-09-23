/**
 * iTerm2 bridge — shows and drives this Mac's live iTerm2 sessions from the
 * Shell page's iTerm2 view (#8114). Design record: docs/ITERM.md.
 *
 * SEPARATE FROM PORTOS SHELLS, BY CONSTRUCTION. iTerm owns these sessions'
 * size and lifecycle, so they live in this module's own registry and its own
 * `iterm:*` socket events. Nothing here touches `services/shell.js`
 * `shellSessions`, so an iTerm session can never appear in the PortOS tab
 * strip, the Workspaces widget, the session cap, or an agent-run lookup.
 *
 * DEMAND-DRIVEN, NEVER AT BOOT. The one connection to iTerm's private Unix
 * socket opens only while the `iterm` instance feature is enabled AND a socket
 * is listing or viewing sessions. It closes `idleMs` (60s) after the last
 * subscriber leaves, and immediately when the feature turns off. Every
 * connect / disconnect decision goes through `reconcileItermBridge()`, which
 * is idempotent and serialized on one promise tail (the `beeperArming.js`
 * shape), and logs only on status transitions.
 *
 * STREAMS ONLY WHAT IS VIEWED. Screen-update notifications are subscribed per
 * session while at least one socket views it; bursts coalesce to one buffer
 * fetch in flight plus one trailing refetch. The list-level notifications
 * (new session, terminate, layout, variable changes) stay subscribed for the
 * life of the connection.
 *
 * iTerm IS AUTHORITATIVE FOR SIZE: there is deliberately no resize path — a
 * phone viewer must never shrink the desktop window. PortOS also never
 * creates, closes or restarts iTerm sessions.
 *
 * Every notification, `ws` event and timer callback runs inside try/catch:
 * this code executes outside any request lifecycle.
 */

import net from 'net';
import WebSocket from 'ws';
import {
  ITERM_NOTIFICATION,
  ITERM_SESSION_VARIABLES,
  ITERM_VARIABLE_SCOPE,
  decodeItermServerMessage,
  encodeItermClientMessage,
  flattenItermLayout,
} from '../lib/itermMessages.js';
import { renderItermFrame } from '../lib/itermScreenRender.js';
import {
  ITERM_APP_NAME,
  detectItermInstall,
  isItermRunning,
  itermSocketPath,
  requestItermCookie,
} from './itermAuth.js';

export const ITERM_FEATURE_ID = 'iterm';
export const ITERM_SESSION_PREFIX = 'iterm-';
export const ITERM_SUBPROTOCOL = 'api.iterm2.com';

const LOG_PREFIX = 'iTerm2 bridge';
const FAILURE_STATES = new Set(['auth-failed', 'connect-failed']);

const defaultIsFeatureEnabled = async () => {
  const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
  return isInstanceFeatureEnabled(ITERM_FEATURE_ID);
};

const parseVariableValue = (json) => {
  if (typeof json !== 'string' || json === '') return null;
  try {
    const value = JSON.parse(json);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const safeEmit = (socket, event, payload) => {
  try {
    socket.emit(event, payload);
  } catch (err) {
    console.error(`❌ ${LOG_PREFIX}: emit ${event} failed: ${err.message}`);
  }
};

export function createItermBridge(deps = {}) {
  const {
    socketPath = itermSocketPath,
    auth = requestItermCookie,
    isRunning = isItermRunning,
    detectInstall = detectItermInstall,
    isFeatureEnabled = defaultIsFeatureEnabled,
    idleMs = 60_000,
    backoffInitialMs = 1_000,
    backoffMaxMs = 30_000,
    requestTimeoutMs = 10_000,
    libraryVersion = 'node portos',
  } = deps;

  let conn = null; // { ws, pending: Map<id, {resolve, reject, timer}>, nextId, warnedVariables }
  let epoch = 0;
  let status = { state: 'disconnected', detail: null };
  let sessions = new Map();
  const listSubscribers = new Set();
  let reconnectTimer = null;
  let reconnectDelay = backoffInitialMs;
  let idleTimer = null;
  let idleExpired = false;
  let tail = Promise.resolve();

  // --- projections & broadcast ----------------------------------------------

  const project = (entry) => ({
    id: entry.id,
    windowId: entry.windowId,
    tabId: entry.tabId,
    windowIndex: entry.windowIndex,
    tabIndex: entry.tabIndex,
    paneIndex: entry.paneIndex,
    paneCount: entry.paneCount,
    label: entry.name || entry.title || entry.jobName || 'iTerm2 session',
    title: entry.title,
    jobName: entry.jobName,
    cwd: entry.cwd,
    cols: entry.cols,
    rows: entry.rows,
  });

  const listItermSessions = () => [...sessions.values()].map(project);

  const broadcastList = () => {
    const payload = { status: { ...status }, sessions: listItermSessions() };
    for (const socket of listSubscribers) safeEmit(socket, 'iterm:sessions', payload);
  };

  const setStatus = (state, detail = null) => {
    if (status.state === state && status.detail === detail) return;
    const previous = status.state;
    status = { state, detail };
    if (previous !== state) {
      const log = FAILURE_STATES.has(state) ? console.error : console.log;
      const marker = FAILURE_STATES.has(state) ? '❌' : '🖥️';
      log(`${marker} ${LOG_PREFIX}: ${previous} → ${state}${detail ? ` (${detail})` : ''}`);
    }
    broadcastList();
  };

  const hasDemand = () => listSubscribers.size > 0
    || [...sessions.values()].some((entry) => entry.viewers.size > 0);

  // --- request/response -------------------------------------------------------

  const request = (message) => new Promise((resolve, reject) => {
    if (!conn) {
      reject(new Error('iTerm2 is not connected'));
      return;
    }
    const current = conn;
    const id = current.nextId;
    current.nextId += 1;
    const timer = setTimeout(() => {
      current.pending.delete(id);
      reject(new Error('iTerm2 request timed out'));
    }, requestTimeoutMs);
    current.pending.set(id, { resolve, reject, timer });
    try {
      current.ws.send(encodeItermClientMessage({ id, ...message }));
    } catch (err) {
      clearTimeout(timer);
      current.pending.delete(id);
      reject(err);
    }
  });

  const rejectPending = (current, reason) => {
    for (const { reject, timer } of current.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    current.pending.clear();
  };

  // --- session registry -------------------------------------------------------

  const emitExit = (entry) => {
    for (const viewer of entry.viewers) safeEmit(viewer, 'iterm:exit', { id: entry.id });
  };

  const clearSessions = () => {
    for (const entry of sessions.values()) emitExit(entry);
    sessions = new Map();
  };

  const subscribeScreen = (entry, subscribe) => request({
    notificationRequest: { session: entry.uuid, subscribe, notificationType: ITERM_NOTIFICATION.SCREEN_UPDATE },
  }).catch((err) => {
    console.error(`❌ ${LOG_PREFIX}: screen ${subscribe ? 'subscribe' : 'unsubscribe'} failed: ${err.message}`);
  });

  const fetchFrame = (entry) => {
    if (entry.fetchInFlight) {
      entry.fetchQueued = true;
      return entry.fetchInFlight;
    }
    entry.fetchInFlight = (async () => {
      try {
        do {
          entry.fetchQueued = false;
          const response = await request({
            getBufferRequest: { session: entry.uuid, lineRange: { screenContentsOnly: true }, includeStyles: true },
          });
          const buffer = response.getBufferResponse;
          if (!buffer || sessions.get(entry.id) !== entry) break;
          const lineCount = buffer.contents.length;
          if (lineCount > 0 && lineCount !== entry.rows && lineCount !== entry.lastLineCount) {
            // The grid may have changed under us; the list call refreshes
            // cols/rows. Once per distinct line count, never once per frame.
            refreshSessions().catch((err) => console.error(`❌ ${LOG_PREFIX}: resize refresh failed: ${err.message}`));
          }
          entry.lastLineCount = lineCount;
          entry.lastFrame = renderItermFrame({
            lines: buffer.contents,
            cursor: buffer.cursor,
            firstVisibleLine: buffer.windowedCoordRange?.coordRange?.start?.y
              ?? buffer.range?.location
              ?? buffer.numLinesAboveScreen
              ?? 0,
            cols: entry.cols,
            rows: Math.max(entry.rows || 0, lineCount),
          });
          for (const viewer of entry.viewers) safeEmit(viewer, 'iterm:output', { id: entry.id, data: entry.lastFrame });
        } while (entry.fetchQueued && entry.viewers.size > 0);
      } catch (err) {
        console.error(`❌ ${LOG_PREFIX}: screen fetch failed: ${err.message}`);
      } finally {
        entry.fetchInFlight = null;
      }
    })();
    return entry.fetchInFlight;
  };

  const loadVariables = async (entry) => {
    const response = await request({ variableRequest: { sessionId: entry.uuid, get: [...ITERM_SESSION_VARIABLES] } });
    const values = response.variableResponse?.values ?? [];
    ITERM_SESSION_VARIABLES.forEach((name, idx) => applyVariable(entry, name, values[idx]));
  };

  const applyVariable = (entry, name, json) => {
    const value = parseVariableValue(json);
    if (name === 'name') entry.name = value;
    else if (name === 'jobName') entry.jobName = value;
    else if (name === 'path') entry.cwd = value;
  };

  const monitorVariables = (entry) => Promise.all(ITERM_SESSION_VARIABLES.map((name) => request({
    notificationRequest: {
      subscribe: true,
      notificationType: ITERM_NOTIFICATION.VARIABLE_CHANGE,
      variableMonitorRequest: { name, scope: ITERM_VARIABLE_SCOPE.SESSION, identifier: entry.uuid },
    },
  })));

  const initSession = async (entry) => {
    try {
      await loadVariables(entry);
      broadcastList();
      await monitorVariables(entry);
    } catch (err) {
      if (conn && !conn.warnedVariables) {
        conn.warnedVariables = true;
        console.warn(`⚠️ ${LOG_PREFIX}: session variables unavailable: ${err.message}`);
      }
    }
  };

  const applyLayout = (listSessionsResponse) => {
    const panes = flattenItermLayout(listSessionsResponse);
    const next = new Map();
    const added = [];
    for (const pane of panes) {
      const id = `${ITERM_SESSION_PREFIX}${pane.uuid}`;
      let entry = sessions.get(id);
      if (!entry) {
        entry = {
          id, uuid: pane.uuid, name: null, jobName: null, cwd: null, lastFrame: null, lastLineCount: null,
          viewers: new Set(), fetchInFlight: null, fetchQueued: false, inputTail: Promise.resolve(),
        };
        added.push(entry);
      }
      const resized = entry.cols !== pane.cols || entry.rows !== pane.rows;
      Object.assign(entry, {
        windowId: pane.windowId,
        tabId: pane.tabId,
        windowIndex: pane.windowIndex,
        tabIndex: pane.tabIndex,
        paneIndex: pane.paneIndex,
        paneCount: pane.paneCount,
        title: pane.title,
        cols: pane.cols,
        rows: pane.rows,
      });
      if (resized && entry.viewers.size > 0 && !added.includes(entry)) fetchFrame(entry);
      next.set(id, entry);
    }
    for (const [id, entry] of sessions) {
      if (!next.has(id)) emitExit(entry);
    }
    sessions = next;
    broadcastList();
    for (const entry of added) initSession(entry);
  };

  const refreshSessions = async () => {
    const response = await request({ listSessionsRequest: {} });
    applyLayout(response.listSessionsResponse);
  };

  const removeSession = (id) => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    emitExit(entry);
    broadcastList();
  };

  // --- notifications ----------------------------------------------------------

  const handleNotification = (notification) => {
    const screen = notification.screenUpdateNotification;
    if (screen?.session) {
      const entry = sessions.get(`${ITERM_SESSION_PREFIX}${screen.session}`);
      if (entry && entry.viewers.size > 0) fetchFrame(entry);
    }
    if (notification.newSessionNotification) {
      refreshSessions().catch((err) => console.error(`❌ ${LOG_PREFIX}: new-session refresh failed: ${err.message}`));
    }
    const terminated = notification.terminateSessionNotification?.sessionId;
    if (terminated) removeSession(`${ITERM_SESSION_PREFIX}${terminated}`);
    const layout = notification.layoutChangedNotification?.listSessionsResponse;
    if (layout) applyLayout(layout);
    const variable = notification.variableChangedNotification;
    if (variable?.identifier && variable.scope === ITERM_VARIABLE_SCOPE.SESSION) {
      const entry = sessions.get(`${ITERM_SESSION_PREFIX}${variable.identifier}`);
      if (entry && ITERM_SESSION_VARIABLES.includes(variable.name)) {
        applyVariable(entry, variable.name, variable.jsonNewValue);
        broadcastList();
      }
    }
  };

  const handleFrame = (data) => {
    const message = decodeItermServerMessage(data);
    if (message.notification) {
      handleNotification(message.notification);
      return;
    }
    const waiter = conn?.pending.get(message.id);
    if (!waiter) return;
    conn.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error));
    else waiter.resolve(message);
  };

  // --- connection lifecycle ---------------------------------------------------

  const openSocket = ({ cookie, key }) => new Promise((resolve, reject) => {
    const path = typeof socketPath === 'function' ? socketPath() : socketPath;
    const ws = new WebSocket('ws://localhost/', ITERM_SUBPROTOCOL, {
      origin: 'ws://localhost/',
      headers: {
        'x-iterm2-library-version': libraryVersion,
        'x-iterm2-disable-auth-ui': 'true',
        'x-iterm2-cookie': cookie,
        'x-iterm2-key': key,
        'x-iterm2-advisory-name': ITERM_APP_NAME,
      },
      createConnection: () => net.connect(path),
      handshakeTimeout: requestTimeoutMs,
      perMessageDeflate: false,
    });
    // A permanent listener: an 'error' after the open promise settled must
    // never surface as an uncaught EventEmitter error.
    ws.on('error', (err) => {
      if (conn?.ws === ws) console.error(`❌ ${LOG_PREFIX}: local socket error`);
      reject(err);
    });
    ws.once('open', () => resolve(ws));
  });

  const onConnectionLost = (ws) => {
    if (conn?.ws !== ws) return;
    const current = conn;
    conn = null;
    rejectPending(current, 'iTerm2 connection closed');
    clearSessions();
    setStatus('disconnected');
    scheduleReconnect();
  };

  const attachConnection = (ws) => {
    conn = { ws, pending: new Map(), nextId: 1, warnedVariables: false };
    ws.on('message', (data) => {
      try {
        handleFrame(data);
      } catch (err) {
        console.error(`❌ ${LOG_PREFIX}: bad frame: ${err.message}`);
      }
    });
    ws.on('close', () => {
      try {
        onConnectionLost(ws);
      } catch (err) {
        console.error(`❌ ${LOG_PREFIX}: close handling failed: ${err.message}`);
      }
    });
  };

  const scheduleReconnect = () => {
    if (reconnectTimer || !hasDemand()) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(delay * 2, backoffMaxMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconcileItermBridge({ reason: 'reconnect' }).catch((err) => {
        console.error(`❌ ${LOG_PREFIX}: reconnect failed: ${err.message}`);
      });
    }, delay);
  };

  const connectOnce = async () => {
    const myEpoch = epoch;
    const stale = () => myEpoch !== epoch;
    const install = await detectInstall();
    if (stale()) return;
    if (install.state !== 'ready') {
      setStatus(install.state);
      scheduleReconnect();
      return;
    }
    // Checked before EVERY attempt: requesting a cookie from a quit iTerm2
    // would launch it, and PortOS must never launch iTerm2.
    if (!await isRunning()) {
      if (!stale()) {
        setStatus('not-running');
        scheduleReconnect();
      }
      return;
    }
    if (stale()) return;
    let credentials;
    try {
      credentials = await auth();
    } catch {
      if (!stale()) {
        setStatus('auth-failed', 'Local iTerm2 authentication failed');
        scheduleReconnect();
      }
      return;
    }
    if (stale()) return;
    let ws;
    try {
      ws = await openSocket(credentials);
    } catch {
      if (!stale()) {
        setStatus('connect-failed', 'Local iTerm2 socket connection failed');
        scheduleReconnect();
      }
      return;
    }
    if (stale()) {
      ws.close();
      return;
    }
    attachConnection(ws);
    reconnectDelay = backoffInitialMs;
    setStatus('connected');
    await Promise.all([
      ITERM_NOTIFICATION.NEW_SESSION,
      ITERM_NOTIFICATION.TERMINATE_SESSION,
      ITERM_NOTIFICATION.LAYOUT_CHANGE,
    ].map((notificationType) => request({ notificationRequest: { subscribe: true, notificationType } })));
    await refreshSessions();
  };

  const teardown = (reason) => {
    epoch += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimeout(idleTimer);
    idleTimer = null;
    idleExpired = false;
    reconnectDelay = backoffInitialMs;
    const current = conn;
    conn = null;
    if (current) {
      rejectPending(current, `iTerm2 bridge stopped (${reason})`);
      try {
        current.ws.close();
      } catch (err) {
        console.error(`❌ ${LOG_PREFIX}: close failed: ${err.message}`);
      }
    }
    clearSessions();
    setStatus('disconnected');
  };

  const armIdle = () => {
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      idleExpired = true;
      reconcileItermBridge({ reason: 'idle' }).catch((err) => {
        console.error(`❌ ${LOG_PREFIX}: idle reconcile failed: ${err.message}`);
      });
    }, idleMs);
  };

  const reconcileOnce = async (reason) => {
    const enabled = await Promise.resolve()
      .then(() => isFeatureEnabled())
      .catch((err) => {
        console.error(`❌ ${LOG_PREFIX}: feature check failed: ${err.message}`);
        return false;
      });
    const active = Boolean(conn || reconnectTimer);
    if (!enabled) {
      if (active || sessions.size > 0) teardown(reason);
    } else if (hasDemand()) {
      clearTimeout(idleTimer);
      idleTimer = null;
      idleExpired = false;
      if (!conn && !reconnectTimer) await connectOnce();
    } else if (active) {
      if (idleExpired) teardown(reason);
      else armIdle();
    }
    return { enabled, connected: Boolean(conn), state: status.state };
  };

  /** Idempotent; serialized so overlapping triggers settle on the last answer. */
  function reconcileItermBridge({ reason = 'unspecified' } = {}) {
    const run = () => reconcileOnce(reason).catch((err) => {
      console.error(`❌ ${LOG_PREFIX}: reconcile (${reason}) failed: ${err.message}`);
      return { enabled: false, connected: Boolean(conn), state: status.state };
    });
    const next = tail.then(run, run);
    tail = next.then(() => {}, () => {});
    return next;
  }

  // --- public surface -----------------------------------------------------------

  async function getItermStatus() {
    if (conn) return { state: 'connected', detail: null };
    const install = await detectInstall();
    if (install.state !== 'ready') return { state: install.state, detail: null };
    if (!await isRunning()) return { state: 'not-running', detail: null };
    if (FAILURE_STATES.has(status.state)) return { ...status };
    return { state: 'disconnected', detail: null };
  }

  const subscribeList = (socket) => {
    listSubscribers.add(socket);
    safeEmit(socket, 'iterm:sessions', { status: { ...status }, sessions: listItermSessions() });
    return reconcileItermBridge({ reason: 'subscribe' });
  };

  const unsubscribeList = (socket) => {
    listSubscribers.delete(socket);
    return reconcileItermBridge({ reason: 'unsubscribe' });
  };

  const attachViewer = (id, socket) => {
    const entry = sessions.get(id);
    if (!entry) return null;
    const first = entry.viewers.size === 0;
    entry.viewers.add(socket);
    if (first) {
      subscribeScreen(entry, true).then(() => {
        if (conn && sessions.get(id) === entry) fetchFrame(entry);
      });
    }
    else if (!entry.lastFrame) fetchFrame(entry);
    return { id, cols: entry.cols, rows: entry.rows, bufferedOutput: entry.lastFrame ?? '' };
  };

  const releaseViewer = (entry, socket) => {
    if (!entry.viewers.delete(socket)) return false;
    if (entry.viewers.size === 0 && sessions.get(entry.id) === entry) subscribeScreen(entry, false);
    return true;
  };

  const detachViewer = (id, socket) => {
    const entry = sessions.get(id);
    const released = entry ? releaseViewer(entry, socket) : false;
    reconcileItermBridge({ reason: 'detach' });
    return released;
  };

  const detachSocket = (socket) => {
    listSubscribers.delete(socket);
    let released = 0;
    for (const entry of sessions.values()) {
      if (releaseViewer(entry, socket)) released += 1;
    }
    reconcileItermBridge({ reason: 'socket-disconnect' });
    return released;
  };

  // Input comes only from a socket that is viewing the session.
  const sendInput = (id, data, socket) => {
    const entry = sessions.get(id);
    if (!entry || !conn || !entry.viewers.has(socket)) return false;
    // Per-session FIFO: each keystroke batch waits for the previous one's
    // acknowledgement, so order survives however fast the viewer types.
    entry.inputTail = entry.inputTail
      .then(() => request({ sendTextRequest: { session: entry.uuid, text: data } }))
      .catch((err) => console.error(`❌ ${LOG_PREFIX}: send text failed: ${err.message}`));
    return true;
  };

  const shutdown = () => {
    listSubscribers.clear();
    teardown('shutdown');
  };

  return {
    attachViewer,
    detachSocket,
    detachViewer,
    getItermStatus,
    listItermSessions,
    reconcileItermBridge,
    sendInput,
    shutdown,
    subscribeList,
    unsubscribeList,
  };
}

const bridge = createItermBridge();

export const {
  attachViewer: attachItermViewer,
  detachSocket: detachItermSocket,
  detachViewer: detachItermViewer,
  getItermStatus,
  listItermSessions,
  reconcileItermBridge,
  sendInput: sendItermInput,
  subscribeList: subscribeItermList,
  unsubscribeList: unsubscribeItermList,
} = bridge;
