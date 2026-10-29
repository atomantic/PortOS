/**
 * The relay's payloads come from the peer, and on a password-free install an
 * announced peer is any LAN host. socket.io-client runs listeners in a
 * nextTick, so a listener that throws becomes an uncaughtException and the
 * server exits — then crash-loops, since every boot reconnects to the peer.
 *
 * Drives a REAL Socket.IO server playing the hostile peer and the REAL relay
 * client over loopback; vitest fails the run on any uncaught error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';

vi.mock('./instanceIdentity.js', () => ({
  getInstanceId: async () => 'self-example-instance',
  UNKNOWN_INSTANCE_ID: 'unknown',
}));
const applyPeerSyncEvent = vi.hoisted(() => vi.fn(async () => ({ applied: false })));
vi.mock('./peerSyncEvents.js', () => ({ applyPeerSyncEvent }));

const { connectToPeer, disconnectFromPeer, peerRealtimeSyncSince } = await import('./peerSocketRelay.js');
const { instanceEvents } = await import('./instanceEvents.js');
const { peerFetch } = await import('../lib/peerHttpClient.js');

const PEER = { id: 'peer-example', name: 'Example Peer', address: '127.0.0.1' };
const MALFORMED = [null, undefined, 'agent', 42, [], { agent: null }, {}, { id: '' }, { agent: { id: 7 } }];

let httpServer;
let ioServer;

const startHostilePeer = (onSubscribe) => new Promise((resolve) => {
  httpServer = createServer((req, res) => {
    // fetchPeerAgents' initial snapshot, equally peer-controlled.
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ running: [null, 'agent', { id: 'agent-listed' }, { id: '' }] }));
  });
  ioServer = new Server(httpServer);
  ioServer.on('connection', (socket) => socket.on('cos:subscribe', () => onSubscribe(socket)));
  httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port));
});

const record = () => {
  const seen = [];
  const events = ['peer:agent:spawned', 'peer:agent:updated', 'peer:agent:completed', 'peer:agent:output', 'peer:agents:updated'];
  const listeners = events.map((event) => {
    const listener = (payload) => seen.push([event, payload]);
    instanceEvents.on(event, listener);
    return [event, listener];
  });
  return { seen, stop: () => listeners.forEach(([event, listener]) => instanceEvents.off(event, listener)) };
};

afterEach(async () => {
  disconnectFromPeer(PEER.id);
  if (ioServer) await new Promise((resolve) => ioServer.close(resolve));
  ioServer = undefined;
  httpServer = undefined;
});

describe('peer socket relay with hostile payloads', () => {
  it('drops malformed agent events without throwing and still relays well-formed ones', async () => {
    const recorder = record();
    const done = new Promise((resolve) => instanceEvents.on('peer:agent:completed', function onDone({ agent }) {
      if (agent?.id !== 'agent-valid') return;
      instanceEvents.off('peer:agent:completed', onDone);
      resolve();
    }));
    const port = await startHostilePeer((socket) => {
      for (const payload of MALFORMED) {
        socket.emit('cos:agent:spawned', payload);
        socket.emit('cos:agent:updated', payload);
        socket.emit('cos:agent:completed', payload);
        socket.emit('cos:agent:output', payload);
      }
      socket.emit('cos:agent:output', { peerId: 'peer-spoofed', agentId: 'agent-valid', line: 'example' });
      socket.emit('cos:agent:spawned', { agent: { id: 'agent-valid', status: 'running' } });
      socket.emit('cos:agent:updated', { id: 'agent-valid', status: 'reviewing' });
      socket.emit('cos:agent:completed', { agent: { id: 'agent-valid' } });
    });

    connectToPeer({ ...PEER, port });
    await done;
    recorder.stop();

    const agentEvents = recorder.seen.filter(([event]) => ['peer:agent:spawned', 'peer:agent:updated', 'peer:agent:completed'].includes(event));
    expect(agentEvents.map(([event, { agent }]) => [event, agent.id, agent.status])).toEqual([
      ['peer:agent:spawned', 'agent-valid', 'running'],
      ['peer:agent:updated', 'agent-valid', 'reviewing'],
      ['peer:agent:completed', 'agent-valid', undefined],
    ]);
    // Output frames are opaque; only a non-object is dropped, and the peer
    // cannot attribute its output to another peer.
    const outputs = recorder.seen.filter(([event]) => event === 'peer:agent:output').map(([, payload]) => payload);
    expect(outputs.every((payload) => payload.peerId === PEER.id)).toBe(true);
    expect(outputs).toContainEqual({ peerId: PEER.id, agentId: 'agent-valid', line: 'example' });
    const snapshotAgents = recorder.seen.filter(([event]) => event === 'peer:agents:updated').flatMap(([, { agents }]) => agents);
    expect(snapshotAgents.every((agent) => typeof agent?.id === 'string' && agent.id)).toBe(true);
  });

  it('subscribes to sync frames only when the peer advertises them and attributes each frame to this connection', async () => {
    applyPeerSyncEvent.mockClear();
    applyPeerSyncEvent.mockRejectedValueOnce(new Error('example apply failure'));
    let peerSocket;
    const subscribed = new Promise((resolve) => {
      httpServer = createServer((req, res) => res.end('{}'));
      ioServer = new Server(httpServer);
      ioServer.on('connection', (socket) => {
        peerSocket = socket;
        socket.on('peer:sync:subscribe', resolve);
        socket.on('cos:subscribe', () => socket.emit('peer:sync:available', { v: 1 }));
      });
    });
    const port = await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port)));
    connectToPeer({ ...PEER, port });
    await subscribed;
    peerSocket.emit('peer:sync:event', 'malformed');
    peerSocket.emit('peer:sync:event', { id: 'second', peerId: 'peer-spoofed' });
    await vi.waitFor(() => expect(applyPeerSyncEvent).toHaveBeenCalledTimes(2));
    expect(applyPeerSyncEvent.mock.calls.map(([sender, frame]) => [sender.id, frame])).toEqual([
      [PEER.id, 'malformed'],
      [PEER.id, { id: 'second', peerId: 'peer-spoofed' }],
    ]);
  });

  it('reports a live realtime subscription only for a connection that names this install, until it drops', async () => {
    const instanceIds = [];
    httpServer = createServer((req, res) => res.end('{}'));
    ioServer = new Server(httpServer);
    ioServer.on('connection', (socket) => {
      instanceIds.push(socket.handshake.headers['x-portos-instance-id'] ?? null);
      socket.emit('peer:sync:available', { v: 1 });
      socket.on('peer:sync:subscribe', () => {
        socket.emit('peer:sync:subscribed');
        // Emits are ordered per socket: once this lands, so has the ack.
        socket.emit('cos:agent:spawned', { agent: { id: 'agent-marker' } });
      });
    });
    const port = await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port)));
    const realtime = () => new Promise((resolve) => instanceEvents.once('peer:sync:realtime', resolve));

    // Unpaired: the socket carries no identity, so the peer would send it nothing.
    const acknowledged = new Promise((resolve) => instanceEvents.once('peer:agent:spawned', resolve));
    connectToPeer({ ...PEER, port });
    await acknowledged;
    expect(peerRealtimeSyncSince(PEER.id)).toBeNull();
    disconnectFromPeer(PEER.id);

    // Paired, after a first request resolved this install's identity (as the probe does).
    const paired = { ...PEER, port, syncSecret: 'example-pair-secret-'.padEnd(48, 'x'), peerAuthAccepted: true };
    await peerFetch(`http://127.0.0.1:${port}/`, {}, paired).then((res) => res.text());
    const live = realtime();
    connectToPeer(paired);
    expect(await live).toEqual({ peerId: PEER.id, live: true });
    expect(instanceIds).toEqual([null, 'self-example-instance']);
    expect(peerRealtimeSyncSince(PEER.id)).toEqual(expect.any(Number));

    const dropped = realtime();
    for (const socket of ioServer.of('/').sockets.values()) socket.disconnect(true);
    expect(await dropped).toEqual({ peerId: PEER.id, live: false });
    expect(peerRealtimeSyncSince(PEER.id)).toBeNull();
  });
});
