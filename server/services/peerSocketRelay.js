/**
 * Peer Socket Relay
 *
 * Connects as a Socket.IO client to each online peer, subscribes to cos:agent:*
 * events, and re-emits them locally through instanceEvents for the client UI.
 * Also subscribes to the peer's realtime sync frames (`peer:sync:event`) and
 * applies them, one at a time per peer, through peerSyncEvents.js. Whether
 * that subscription is live (peerRealtimeSyncSince) sets the sync loop's
 * cadence for the categories the frames carry.
 */

import { io } from 'socket.io-client';
import { instanceEvents } from './instanceEvents.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { memoizedSelfInstanceId, peerFetch, peerSocketOptionsFor, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { isPlainObject } from '../lib/objects.js';

// Map<peerId, { socket, agents: Map<agentId, agent>, peer }>
const peerConnections = new Map();

const CONNECT_TIMEOUT_MS = 5000;

// Relay payloads are peer-controlled — on a password-free install an announced
// peer is any LAN host — so only a plain object with a string id is an agent.
const relayedAgent = (data) => {
  const agent = isPlainObject(data?.agent) ? data.agent : data;
  return isPlainObject(agent) && typeof agent.id === 'string' && agent.id ? agent : null;
};

/**
 * Connect to a peer's Socket.IO server and subscribe to agent events
 */
export function connectToPeer(peer) {
  // peerSocketOptionsFor injects the same credential headers peerFetch sends
  // (the pair token, and Basic until the receiver confirms the token).
  const socketOptions = peerSocketOptionsFor(peer);
  // The peer delivers sync frames only to a socket that names this install
  // (paired peers). The header is fixed for the socket's life, so a socket
  // opened before this install's id was resolved, or under an id a restore
  // has since replaced, is reopened with the current one (the probe calls
  // this every cycle while the peer is online).
  const identity = socketOptions.extraHeaders?.[PEER_INSTANCE_HEADER] ?? null;
  const existing = peerConnections.get(peer.id);
  if (existing) {
    if (existing.identity === identity) return;
    console.log(`🔗 Peer relay reopening for ${peer.name}: this install's identity changed`);
    disconnectFromPeer(peer.id);
  }

  const url = peerBaseUrl(peer);
  const socket = io(url, {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 5000,
    timeout: CONNECT_TIMEOUT_MS,
    ...socketOptions
  });

  // `host` is required so fetchPeerAgents() can rebuild the HTTPS URL via peerBaseUrl();
  // `auth`, `syncSecret` and `peerAuthAccepted` are carried so its peerFetch
  // presents the same credential as the probe (#8356).
  const conn = {
    socket,
    agents: new Map(),
    // Frames apply in arrival order so a delete never races the upsert before it.
    syncQueue: Promise.resolve(),
    // The instance id this socket names itself by (null: unidentified).
    identity,
    // When the peer acknowledged that it will send video frames to this
    // socket; null while none can arrive.
    realtimeSince: null,
    peer: {
      id: peer.id, name: peer.name, address: peer.address, host: peer.host ?? null, port: peer.port, auth: peer.auth ?? null,
      syncSecret: peer.syncSecret ?? null, peerAuthAccepted: peer.peerAuthAccepted === true,
    }
  };

  peerConnections.set(peer.id, conn);

  socket.on('connect', () => {
    console.log(`🔗 Peer relay connected: ${peer.name} (${url})`);
    socket.emit('cos:subscribe');

    // Fetch initial agent state via HTTP
    void fetchPeerAgents(conn);
  });

  socket.on('disconnect', () => {
    console.log(`🔗 Peer relay disconnected: ${peer.name}`);
    setRealtime(conn, peer.id, null);
    conn.agents.clear();
    instanceEvents.emit('peer:agents:updated', { peerId: peer.id, agents: [] });
  });

  // socket.io-client calls listeners from a nextTick, where a throw is an
  // uncaughtException that exits the server; contain it per event.
  const onPeerAgentEvent = (event, handler) => socket.on(event, (data) => {
    try {
      handler(data);
    } catch (err) {
      console.error(`❌ Peer relay ${event} from ${peer.name} failed: ${err.message}`);
    }
  });

  // Subscribe only when the peer advertises the channel: an older peer with a
  // password set disconnects a relay socket that sends an event it doesn't allow.
  socket.on('peer:sync:available', () => socket.emit('peer:sync:subscribe'));
  // Only an ack that promises delivery counts: an older server acks without
  // `deliver`, and a peer that does not share video history with us says false.
  socket.on('peer:sync:subscribed', (ack) => {
    if (identity && ack?.deliver === true) setRealtime(conn, peer.id, Date.now());
  });

  // The sender is this connection's peer; the frame's own claims are not trusted.
  // Lazy: the apply side pulls in the sync merge graph only once a frame arrives.
  socket.on('peer:sync:event', (data) => {
    conn.syncQueue = conn.syncQueue
      .then(() => import('./peerSyncEvents.js'))
      .then((m) => m.applyPeerSyncEvent({ id: peer.id, name: peer.name }, data))
      .catch((err) => console.error(`❌ Peer relay peer:sync:event from ${peer.name} failed: ${err.message}`));
  });

  // Agent spawned
  onPeerAgentEvent('cos:agent:spawned', (data) => {
    const agent = relayedAgent(data);
    if (!agent) return;
    conn.agents.set(agent.id, agent);
    instanceEvents.emit('peer:agent:spawned', { peerId: peer.id, agent });
    instanceEvents.emit('peer:agents:updated', {
      peerId: peer.id,
      agents: Array.from(conn.agents.values())
    });
  });

  // Agent updated
  onPeerAgentEvent('cos:agent:updated', (data) => {
    const agent = relayedAgent(data);
    if (!agent) return;
    // Spread, not Object.assign: a peer-sent `__proto__` key stays plain data.
    const merged = { ...conn.agents.get(agent.id), ...agent };
    conn.agents.set(agent.id, merged);
    instanceEvents.emit('peer:agent:updated', { peerId: peer.id, agent: merged });
  });

  // Agent output (streaming)
  onPeerAgentEvent('cos:agent:output', (data) => {
    if (!isPlainObject(data)) return;
    instanceEvents.emit('peer:agent:output', { ...data, peerId: peer.id });
  });

  // Agent completed
  onPeerAgentEvent('cos:agent:completed', (data) => {
    const agent = relayedAgent(data);
    if (!agent) return;
    conn.agents.delete(agent.id);
    instanceEvents.emit('peer:agent:completed', { peerId: peer.id, agent });
    instanceEvents.emit('peer:agents:updated', {
      peerId: peer.id,
      agents: Array.from(conn.agents.values())
    });
  });
}

function setRealtime(conn, peerId, since) {
  if (conn.realtimeSince === since) return;
  conn.realtimeSince = since;
  instanceEvents.emit('peer:sync:realtime', { peerId, live: since !== null });
}

/**
 * When the peer (registry id) acknowledged it will send this install video
 * frames, or null when none can arrive: the peer is older (never advertises
 * the channel or never promises delivery), does not share video history with
 * us, is unpaired, is disconnected, or knows us by an id we no longer hold.
 * Frames sent before this moment were missed, so the sync loop treats it as the
 * point after which a snapshot may be skipped.
 */
export function peerRealtimeSyncSince(peerId) {
  const conn = peerConnections.get(peerId);
  if (!conn?.socket.connected || conn.identity !== memoizedSelfInstanceId()) return null;
  return conn.realtimeSince;
}

/**
 * Fetch current agents from peer via HTTP and populate initial state
 */
async function fetchPeerAgents(conn) {
  const { peer } = conn;
  const url = `${peerBaseUrl(peer)}/api/cos/agents`;
  await withAbortTimeout(CONNECT_TIMEOUT_MS, async (signal) => {
    const res = await peerFetch(url, { signal }, peer);
    if (!res.ok) return;
    const data = await res.json();
    const listed = data?.running || data?.agents;
    const agents = Array.isArray(listed) ? listed.map(relayedAgent).filter(Boolean) : [];
    conn.agents.clear();
    for (const agent of agents) {
      conn.agents.set(agent.id, agent);
    }
    instanceEvents.emit('peer:agents:updated', {
      peerId: peer.id,
      agents: Array.from(conn.agents.values())
    });
    console.log(`🔗 Peer ${peer.name}: ${agents.length} active agent(s)`);
  }).catch(() => {
    // Silent — agents will populate via socket events
  });
}

/**
 * Disconnect from a peer and clean up
 */
export function disconnectFromPeer(peerId) {
  const conn = peerConnections.get(peerId);
  if (!conn) return;

  conn.socket.disconnect();
  setRealtime(conn, peerId, null);
  conn.agents.clear();
  peerConnections.delete(peerId);
  instanceEvents.emit('peer:agents:updated', { peerId, agents: [] });
  console.log(`🔗 Peer relay cleaned up: ${conn.peer.name}`);
}
