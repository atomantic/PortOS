/**
 * Moltworld WebSocket Client Service
 *
 * Manages a single WebSocket connection to Moltworld's real-time event stream.
 * Emits events through an EventEmitter that gets forwarded via Socket.IO to clients.
 *
 * Events emitted on moltworldWsEvents:
 *   status      - connection state changes ({ status, connectedAt, ... })
 *   event       - all incoming events (raw parsed data)
 *   presence    - agent presence snapshots
 *   thinking    - agent thought events
 *   action      - agent action events (move, build, etc.)
 *   interaction - agent-to-agent interactions
 *   nearby      - nearby agent list updates
 *   hello_ack   - server acknowledged our hello
 */

// Uses Node's built-in WHATWG `WebSocket` (global since Node 22, stable in
// Node 24) — no `ws` dependency. The browser-style API differs from `ws`:
// events arrive via addEventListener with an event object (message text is
// `evt.data`), there's no `.terminate()` (native `.close()` is safe in the
// CONNECTING state, unlike `ws`), and there's no `.removeAllListeners()` —
// we track our handlers per-socket and removeEventListener them in cleanup.
import EventEmitter from 'events';
import * as platformAccounts from './platformAccounts.js';
import * as agentActivity from './agentActivity.js';

export const moltworldWsEvents = new EventEmitter();

// Connection state
let ws = null;
// The event listeners attached to the current `ws` — native WebSocket has no
// `.removeAllListeners()`, so cleanupWs() removes exactly what we added.
let wsListeners = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectedAt = null;
let lastEvent = null;
let currentStatus = 'disconnected';
let isReconnecting = false;
let currentAccountId = null;
let currentPortosAgentId = null;  // PortOS agent personality ID (for activity logging)
let currentMoltworldAgentId = null;  // Moltworld credential ID (for WS protocol)
let currentAgentName = null;

const MAX_RECONNECT_DELAY_MS = 60000;
const BASE_RECONNECT_DELAY_MS = 2000;
const CONNECT_TIMEOUT_MS = 10000;

function setStatus(status) {
  currentStatus = status;
  const stateSnapshot = getStatus();
  moltworldWsEvents.emit('status', stateSnapshot);
  console.log(`🌐 Moltworld WS: ${status}`);
}

export function getStatus() {
  return {
    status: currentStatus,
    connectedAt,
    lastEvent,
    reconnectAttempts,
    portosAgentId: currentPortosAgentId,
    moltworldAgentId: currentMoltworldAgentId,
    agentName: currentAgentName,
    accountId: currentAccountId
  };
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnectTimer();
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS
  );
  reconnectAttempts++;
  setStatus('reconnecting');
  isReconnecting = true;
  console.log(`🌐 Moltworld WS: reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => doConnect().catch(err => {
    console.error(`🌐 Moltworld WS: reconnect failed: ${err.message}`);
  }), delay);
}

function handleMessage(raw) {
  // External data from Moltworld — parse guard is justified
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`🌐 Moltworld WS: invalid JSON received`);
    return;
  }

  lastEvent = Date.now();
  const eventType = data.type || data.event || 'unknown';

  // Forward all events
  moltworldWsEvents.emit('event', data);

  // Dispatch by type
  if (eventType === 'presence' || eventType === 'presence_snapshot') {
    moltworldWsEvents.emit('presence', data);
  } else if (eventType === 'thinking' || eventType === 'thought') {
    moltworldWsEvents.emit('thinking', data);
  } else if (eventType === 'action' || eventType === 'move' || eventType === 'build') {
    moltworldWsEvents.emit('action', data);
  } else if (eventType === 'interaction' || eventType === 'message' || eventType === 'say') {
    moltworldWsEvents.emit('interaction', data);
    // Log interactions to activity service
    if (currentPortosAgentId && data.agentId) {
      agentActivity.logActivity({
        agentId: currentPortosAgentId,
        accountId: currentAccountId,
        action: 'mw_interaction',
        params: { eventType, from: data.agentName || data.agentId },
        status: 'completed',
        result: { type: eventType, content: data.message || data.thought || '' },
        timestamp: new Date().toISOString()
      }).catch(err => {
        console.warn(`⚠️ Activity log failed eventType=${eventType}: ${err?.message || String(err)}`);
      });
    }
  } else if (eventType === 'nearby') {
    moltworldWsEvents.emit('nearby', data);
  } else if (eventType === 'hello_ack' || eventType === 'welcome') {
    moltworldWsEvents.emit('hello_ack', data);
    console.log(`🌐 Moltworld WS: hello acknowledged`);
  }
}

function cleanupWs() {
  if (ws) {
    // Native WebSocket has no removeAllListeners() — detach exactly the
    // handlers we registered in doConnect so a torn-down socket can't fire
    // 'close'/'error' into the reconnect logic after we've abandoned it.
    if (wsListeners) {
      for (const [type, handler] of Object.entries(wsListeners)) {
        ws.removeEventListener(type, handler);
      }
      wsListeners = null;
    }
    // close() is valid (and a no-op) in OPEN and CONNECTING alike for the
    // native WebSocket — no terminate()/throw split like `ws` needed.
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

/**
 * Open a WebSocket connection. Returns a promise that resolves on open
 * or rejects on error/timeout. When called from reconnect, the promise
 * result is ignored (fire-and-forget).
 */
function doConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return Promise.resolve();
  }

  setStatus('connecting');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(`🌐 Moltworld WS: connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`);
      cleanupWs();
      setStatus('disconnected');
      reject(new Error('WebSocket connection timed out — Moltworld may not have a WebSocket endpoint available'));
    }, CONNECT_TIMEOUT_MS);

    const instance = new WebSocket('wss://moltworld.io/ws');
    ws = instance;

    const onOpen = () => {
      clearTimeout(timeout);
      connectedAt = Date.now();
      reconnectAttempts = 0;
      isReconnecting = false;
      setStatus('connected');

      // Send hello with agent credentials
      send({
        type: 'hello',
        agentId: currentMoltworldAgentId,
        name: currentAgentName
      });

      resolve();
    };

    // Native WebSocket delivers the frame payload on `evt.data` (a string for
    // text frames); `ws` passed the raw buffer as the first arg.
    const onMessage = (evt) => handleMessage(String(evt.data));

    const onClose = (evt) => {
      clearTimeout(timeout);
      console.log(`🌐 Moltworld WS: closed (code=${evt.code})`);
      ws = null;
      wsListeners = null;
      if (currentStatus !== 'disconnected') {
        scheduleReconnect();
      }
    };

    // Native WebSocket fires a generic Event on error (no `.message`); the
    // useful detail arrives in the subsequent close event. Synthesize a stable
    // message so logs/rejections stay informative.
    const onError = (evt) => {
      clearTimeout(timeout);
      const detail = evt?.message || evt?.error?.message || 'connection error';
      console.error(`🌐 Moltworld WS: error: ${detail}`);
      cleanupWs();
      if (isReconnecting) {
        // Continue backoff loop on reconnect failures
        scheduleReconnect();
      } else {
        setStatus('disconnected');
        reject(new Error(`WebSocket connection failed: ${detail}`));
      }
    };

    wsListeners = { open: onOpen, message: onMessage, close: onClose, error: onError };
    instance.addEventListener('open', onOpen);
    instance.addEventListener('message', onMessage);
    instance.addEventListener('close', onClose);
    instance.addEventListener('error', onError);
  });
}

/**
 * Connect to Moltworld WebSocket relay.
 * Looks up credentials from platformAccounts by accountId.
 * Awaits the connection result — resolves on open, rejects on error/timeout.
 */
export async function connect(accountId) {
  // Disconnect existing connection if any
  disconnect();

  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (!account) {
    throw new Error('Account not found');
  }
  if (account.platform !== 'moltworld') {
    throw new Error('Account is not a Moltworld account');
  }
  if (account.status !== 'active') {
    throw new Error(`Account not active: ${account.status}`);
  }

  currentAccountId = accountId;
  currentPortosAgentId = account.agentId;  // PortOS personality ID for activity logging
  currentMoltworldAgentId = account.credentials.agentId || account.credentials.apiKey;  // Moltworld protocol ID
  currentAgentName = account.credentials.username || 'Agent';

  await doConnect();
}

/**
 * Disconnect from Moltworld WebSocket
 */
export function disconnect() {
  clearReconnectTimer();
  currentStatus = 'disconnected';
  isReconnecting = false;
  connectedAt = null;
  reconnectAttempts = 0;
  currentPortosAgentId = null;
  currentMoltworldAgentId = null;
  cleanupWs();
  setStatus('disconnected');
}

/**
 * Send a JSON message through the WebSocket
 */
export function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected');
  }
  ws.send(JSON.stringify(message));
}

/**
 * Send a move command
 */
export function sendMove(x, y, thought) {
  send({
    type: 'move',
    agentId: currentMoltworldAgentId,
    x,
    y,
    ...(thought ? { thinking: thought } : {})
  });
  if (currentPortosAgentId && currentAccountId) {
    agentActivity.logActivity({
      agentId: currentPortosAgentId,
      accountId: currentAccountId,
      action: 'mw_explore',
      params: { x, y, thinking: thought, via: 'ws' },
      status: 'completed',
      result: { type: 'move' },
      timestamp: new Date().toISOString()
    }).catch(err => console.warn(`⚠️ Activity log failed: ${err.message}`));
  }
}

/**
 * Send a think command
 */
export function sendThink(thought) {
  send({
    type: 'think',
    agentId: currentMoltworldAgentId,
    thought
  });
  if (currentPortosAgentId && currentAccountId) {
    agentActivity.logActivity({
      agentId: currentPortosAgentId,
      accountId: currentAccountId,
      action: 'mw_think',
      params: { thought, via: 'ws' },
      status: 'completed',
      result: { type: 'think' },
      timestamp: new Date().toISOString()
    }).catch(err => console.warn(`⚠️ Activity log failed: ${err.message}`));
  }
}

/**
 * Send an interaction to another agent
 */
export function sendInteract(toAgentId, payload) {
  send({
    type: 'interact',
    agentId: currentMoltworldAgentId,
    to: toAgentId,
    ...payload
  });
  if (currentPortosAgentId && currentAccountId) {
    agentActivity.logActivity({
      agentId: currentPortosAgentId,
      accountId: currentAccountId,
      action: 'mw_say',
      params: { to: toAgentId, ...payload, via: 'ws' },
      status: 'completed',
      result: { type: 'interact' },
      timestamp: new Date().toISOString()
    }).catch(err => console.warn(`⚠️ Activity log failed: ${err.message}`));
  }
}

/**
 * Request nearby agents list
 */
export function sendNearby(radius) {
  send({
    type: 'nearby',
    agentId: currentMoltworldAgentId,
    ...(radius ? { radius } : {})
  });
}
