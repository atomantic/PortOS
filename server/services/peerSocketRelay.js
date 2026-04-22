/**
 * Peer Socket Relay
 *
 * Connects as a Socket.IO client to each online peer, subscribes to cos:agent:*
 * events, and re-emits them locally through instanceEvents for the client UI.
 */

import { io } from 'socket.io-client';
import { instanceEvents } from './instanceEvents.js';
import { peerBaseUrl } from '../lib/peerUrl.js';

// Map<peerId, { socket, agents: Map<agentId, agent>, peer }>
const peerConnections = new Map();

const CONNECT_TIMEOUT_MS = 5000;

/**
 * Connect to a peer's Socket.IO server and subscribe to agent events
 */
export function connectToPeer(peer) {
  if (peerConnections.has(peer.id)) return;

  const url = peerBaseUrl(peer);
  const socket = io(url, {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 5000,
    timeout: CONNECT_TIMEOUT_MS
  });

  // `host` is required so fetchPeerAgents() can rebuild the HTTPS URL via peerBaseUrl()
  const conn = {
    socket,
    agents: new Map(),
    peer: { id: peer.id, name: peer.name, address: peer.address, host: peer.host ?? null, port: peer.port }
  };

  peerConnections.set(peer.id, conn);

  socket.on('connect', () => {
    console.log(`🔗 Peer relay connected: ${peer.name} (${url})`);
    socket.emit('cos:subscribe');

    // Fetch initial agent state via HTTP
    fetchPeerAgents(conn);
  });

  socket.on('disconnect', () => {
    console.log(`🔗 Peer relay disconnected: ${peer.name}`);
    conn.agents.clear();
    instanceEvents.emit('peer:agents:updated', { peerId: peer.id, agents: [] });
  });

  // Agent spawned
  socket.on('cos:agent:spawned', (data) => {
    const agent = data.agent || data;
    conn.agents.set(agent.id, agent);
    instanceEvents.emit('peer:agent:spawned', { peerId: peer.id, agent });
    instanceEvents.emit('peer:agents:updated', {
      peerId: peer.id,
      agents: Array.from(conn.agents.values())
    });
  });

  // Agent updated
  socket.on('cos:agent:updated', (data) => {
    const agent = data.agent || data;
    const existing = conn.agents.get(agent.id);
    if (existing) {
      Object.assign(existing, agent);
    } else {
      conn.agents.set(agent.id, agent);
    }
    instanceEvents.emit('peer:agent:updated', { peerId: peer.id, agent: conn.agents.get(agent.id) });
  });

  // Agent output (streaming)
  socket.on('cos:agent:output', (data) => {
    instanceEvents.emit('peer:agent:output', { peerId: peer.id, ...data });
  });

  // Agent completed
  socket.on('cos:agent:completed', (data) => {
    const agent = data.agent || data;
    conn.agents.delete(agent.id);
    instanceEvents.emit('peer:agent:completed', { peerId: peer.id, agent });
    instanceEvents.emit('peer:agents:updated', {
      peerId: peer.id,
      agents: Array.from(conn.agents.values())
    });
  });
}

/**
 * Fetch current agents from peer via HTTP and populate initial state
 */
async function fetchPeerAgents(conn) {
  const { peer } = conn;
  const url = `${peerBaseUrl(peer)}/api/cos/agents`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return;
    const data = await res.json();
    const agents = data.running || data.agents || [];
    conn.agents.clear();
    for (const agent of agents) {
      conn.agents.set(agent.id, agent);
    }
    instanceEvents.emit('peer:agents:updated', {
      peerId: peer.id,
      agents: Array.from(conn.agents.values())
    });
    console.log(`🔗 Peer ${peer.name}: ${agents.length} active agent(s)`);
  } catch {
    // Silent — agents will populate via socket events
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Disconnect from a peer and clean up
 */
export function disconnectFromPeer(peerId) {
  const conn = peerConnections.get(peerId);
  if (!conn) return;

  conn.socket.disconnect();
  conn.agents.clear();
  peerConnections.delete(peerId);
  instanceEvents.emit('peer:agents:updated', { peerId, agents: [] });
  console.log(`🔗 Peer relay cleaned up: ${conn.peer.name}`);
}

/**
 * Get current agent snapshot for a peer
 */
export function getPeerAgents(peerId) {
  const conn = peerConnections.get(peerId);
  if (!conn) return [];
  return Array.from(conn.agents.values());
}

/**
 * Disconnect all peer relays (for shutdown)
 */
export function disconnectAll() {
  for (const [peerId] of peerConnections) {
    disconnectFromPeer(peerId);
  }
}
