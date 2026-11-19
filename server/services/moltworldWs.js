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
// we track our handlers per socket and remove them in cleanup.
import EventEmitter from 'events';
import * as platformAccounts from './platformAccounts.js';
import * as agentActivity from './agent/agentActivity.js';

export const moltworldWsEvents = new EventEmitter();

// Connection state
let ws = null;
let cancelConnection = null;
let connectionRequest = 0;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectedAt = null;
let lastEvent = null;
let currentStatus = 'disconnected';
let currentAccountId = null;
let currentPortosAgentId = null;  // PortOS agent personality ID (for activity logging)
let currentMoltworldAgentId = null;  // Moltworld credential ID (for WS protocol)
let currentAgentName = null;

const MAX_RECONNECT_ATTEMPTS = 10;
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
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log(`🌐 Moltworld WS: reconnect attempts exhausted (${reconnectAttempts})`);
    setStatus('disconnected');
    return;
  }
  const delayCeiling = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
  const delay = Math.floor(delayCeiling * (0.5 + Math.random() * 0.5));
  reconnectAttempts++;
  console.log(`🌐 Moltworld WS: reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // The attempt handles teardown, logging, and any next retry before rejecting.
    doConnect(true).catch(() => {});
  }, delay);
  reconnectTimer.unref?.();
  setStatus('reconnecting');
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

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    console.log(`🌐 Moltworld WS: ignored non-object JSON frame`);
    return;
  }

  lastEvent = Date.now();
  const eventType = data.type || data.event || 'unknown';

  // Reset backoff when the relay accepts hello. Opening the transport alone
  // would reset the budget even if the relay immediately rejected credentials.
  const isHelloAck = eventType === 'hello_ack' || eventType === 'welcome';
  if (isHelloAck) {
    reconnectAttempts = 0;
  }

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
  } else if (isHelloAck) {
    moltworldWsEvents.emit('hello_ack', data);
    console.log(`🌐 Moltworld WS: hello acknowledged`);
  }
}

/**
 * Open a WebSocket connection. Resolves once hello is sent, and rejects if
 * the attempt fails before then.
 */
function doConnect(isRetry = false) {
  return new Promise((resolve, reject) => {
    let instance;
    let timeout;
    let settled = false;

    function cleanup() {
      clearTimeout(timeout);
      ws = null;
      connectedAt = null;
      cancelConnection = null;
      if (!instance) return;
      // Abandoned native sockets can still emit close and error as they finish.
      for (const [type, handler] of Object.entries(listeners)) {
        instance.removeEventListener(type, handler);
      }
      if (instance.readyState === WebSocket.OPEN || instance.readyState === WebSocket.CONNECTING) {
        instance.close();
      }
    }

    function fail(error) {
      cleanup();
      if (!settled) {
        reject(error);
      }
      if (currentStatus === 'disconnected') return;
      if (!settled && isRetry) {
        console.error(`🌐 Moltworld WS: reconnect failed: ${error.message}`);
      }
      if (settled || isRetry) {
        scheduleReconnect();
      } else {
        setStatus('disconnected');
      }
    }

    const onOpen = () => {
      clearTimeout(timeout);
      try {
        send({
          type: 'hello',
          agentId: currentMoltworldAgentId,
          name: currentAgentName
        });
      } catch (err) {
        fail(new Error(`WebSocket hello failed: ${err.message}`));
        return;
      }

      settled = true;
      connectedAt = Date.now();
      resolve();
      setStatus('connected');
    };

    const onMessage = (evt) => handleMessage(String(evt.data));

    const onClose = (evt) => {
      console.log(`🌐 Moltworld WS: closed (code=${evt.code})`);
      fail(new Error(`WebSocket closed before hello (code=${evt.code})`));
    };

    // Native WebSocket can fire a generic Event with no error detail.
    const onError = (evt) => {
      const detail = evt?.message || evt?.error?.message || 'connection error';
      console.error(`🌐 Moltworld WS: error: ${detail}`);
      fail(new Error(`WebSocket connection failed: ${detail}`));
    };

    const listeners = { open: onOpen, message: onMessage, close: onClose, error: onError };
    cancelConnection = () => fail(new Error('WebSocket connection cancelled'));
    setStatus('connecting');
    // A synchronous status listener may cancel this attempt.
    if (!cancelConnection) return;

    try {
      instance = new WebSocket('wss://moltworld.io/ws');
    } catch (err) {
      fail(err);
      return;
    }
    ws = instance;
    for (const [type, handler] of Object.entries(listeners)) {
      instance.addEventListener(type, handler);
    }
    timeout = setTimeout(() => {
      fail(new Error('WebSocket connection timed out — Moltworld may not have a WebSocket endpoint available'));
    }, CONNECT_TIMEOUT_MS);
  });
}

/**
 * Connect to Moltworld WebSocket relay.
 * Looks up credentials from platformAccounts by accountId.
 * Awaits the connection result — resolves once hello is sent.
 */
export async function connect(accountId) {
  // Disconnect existing connection if any
  disconnect();
  const request = connectionRequest;

  const account = await platformAccounts.getAccountWithCredentials(accountId);
  if (request !== connectionRequest) {
    throw new Error('WebSocket connection cancelled');
  }
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
  connectionRequest++;
  clearReconnectTimer();
  currentStatus = 'disconnected';
  cancelConnection?.();
  reconnectAttempts = 0;
  currentPortosAgentId = null;
  currentMoltworldAgentId = null;
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
