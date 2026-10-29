/**
 * Outbound delivery of realtime sync frames over a REAL Socket.IO server: only
 * a subscribed socket whose identified peer this install shares the category
 * with receives a frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

const registry = vi.hoisted(() => ({ peers: [] }));
vi.mock('./instances.js', async () => {
  const actual = await vi.importActual('./instances.js');
  return { ...actual, getPeers: async () => registry.peers };
});
vi.mock('./instanceIdentity.js', async () => ({
  ...(await vi.importActual('./instanceIdentity.js')),
  getInstanceId: async () => 'self-example-instance',
}));

const { deliverPeerSyncEvent, registerPeerSyncSubscriber } = await import('./peerSyncEventBus.js');

const FRAME = { v: 1, category: 'videoHistory', op: 'upsert', id: 'v1', record: { id: 'v1' }, originInstanceId: 'self-example-instance' };
const peer = (instanceId, videoHistory) => ({ id: `rec-${instanceId}`, name: instanceId, instanceId, enabled: true, syncCategories: { videoHistory } });

let httpServer;
let ioServer;
let clients = [];

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  if (ioServer) await new Promise((resolve) => ioServer.close(resolve));
  ioServer = undefined;
});

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

const connect = async (port, instanceId, subscribe) => {
  const client = ioClient(`http://127.0.0.1:${port}`, {
    reconnection: false, transports: ['websocket'],
    extraHeaders: instanceId ? { 'X-PortOS-Instance-Id': instanceId } : {},
  });
  clients.push(client);
  const frames = [];
  client.on('peer:sync:event', (frame) => frames.push(frame));
  await once(client, 'connect');
  let ack = null;
  if (subscribe) {
    const subscribed = once(client, 'peer:sync:subscribed');
    client.emit('peer:sync:subscribe');
    ack = await subscribed;
  }
  return { client, frames, ack };
};

describe('deliverPeerSyncEvent', () => {
  it('delivers concurrent publications in publication order', async () => {
    registry.peers = [peer('peer-shared', true)];
    httpServer = createServer();
    ioServer = new Server(httpServer);
    ioServer.on('connection', (socket) => registerPeerSyncSubscriber(socket));
    const port = await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port)));
    const qualifying = await connect(port, 'peer-shared', true);
    // The first delivery's socket lookup is slow; the second must still go out after it.
    const realIn = ioServer.in.bind(ioServer);
    let first = true;
    ioServer.in = (room) => {
      const target = realIn(room);
      if (!first) return target;
      first = false;
      return { fetchSockets: async () => { await new Promise((r) => setTimeout(r, 30)); return target.fetchSockets(); } };
    };
    const upsert = deliverPeerSyncEvent(ioServer, FRAME);
    const del = deliverPeerSyncEvent(ioServer, { ...FRAME, op: 'delete', record: undefined });
    expect(await Promise.all([upsert, del])).toEqual([1, 1]);
    const marker = once(qualifying.client, 'example:marker');
    ioServer.emit('example:marker');
    await marker;
    expect(qualifying.frames.map((f) => f.op)).toEqual(['upsert', 'delete']);
  });

  it('sends a frame only to subscribed sockets whose known peer shares the category', async () => {
    registry.peers = [peer('peer-shared', true), peer('peer-off', false)];
    httpServer = createServer();
    ioServer = new Server(httpServer);
    ioServer.on('connection', (socket) => registerPeerSyncSubscriber(socket));
    const port = await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port)));

    const unknown = await connect(port, 'peer-unknown', true);
    const categoryOff = await connect(port, 'peer-off', true);
    const qualifying = await connect(port, 'peer-shared', true);
    const browser = await connect(port, null, false);
    const unsubscribedPeer = await connect(port, 'peer-shared', false);
    const all = [unknown, categoryOff, qualifying, browser, unsubscribedPeer];

    // The ack promises delivery exactly where delivery happens.
    expect([unknown.ack, categoryOff.ack, qualifying.ack]).toEqual([
      { ok: true, deliver: false }, { ok: true, deliver: false }, { ok: true, deliver: true },
    ]);
    expect(await deliverPeerSyncEvent(ioServer, FRAME)).toBe(1);
    // Emits are ordered per socket, so a frame sent before this marker has arrived once it does.
    const markers = all.map(({ client }) => once(client, 'example:marker'));
    ioServer.emit('example:marker');
    await Promise.all(markers);

    expect(qualifying.frames).toEqual([FRAME]);
    for (const other of [unknown, categoryOff, browser, unsubscribedPeer]) expect(other.frames).toEqual([]);
  });

  it('treats the unknown-identity placeholder as no identity', async () => {
    // The placeholder this module refuses must stay instanceIdentity's sentinel.
    expect((await import('./instanceIdentity.js')).UNKNOWN_INSTANCE_ID).toBe('unknown');
    registry.peers = [peer('unknown', true)];
    httpServer = createServer();
    ioServer = new Server(httpServer);
    ioServer.on('connection', (socket) => registerPeerSyncSubscriber(socket));
    const port = await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port)));
    const claimed = await connect(port, 'unknown', true);
    const [serverSocket] = await ioServer.in('peer-sync').fetchSockets();
    expect(serverSocket.data.peerSyncInstanceId).toBeNull();
    expect(await deliverPeerSyncEvent(ioServer, FRAME)).toBe(0);
    const marker = once(claimed.client, 'example:marker');
    ioServer.emit('example:marker');
    await marker;
    expect(claimed.frames).toEqual([]);
  });

  it('sends an image frame to peers the library manifest is served to, video category or not', async () => {
    registry.peers = [
      peer('peer-video-off', false),
      { ...peer('peer-sync-off', true), syncEnabled: false },
      { ...peer('peer-inbound-only', true), directions: ['inbound'] },
    ];
    httpServer = createServer();
    ioServer = new Server(httpServer);
    ioServer.on('connection', (socket) => registerPeerSyncSubscriber(socket));
    const port = await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port)));
    const outbound = await connect(port, 'peer-video-off', true);
    const silenced = await connect(port, 'peer-sync-off', true);
    const inboundOnly = await connect(port, 'peer-inbound-only', true);
    const imageFrame = { v: 1, category: 'imageHistory', op: 'delete', id: 'fox.png', tombstone: { key: 'fox.png', deletedAt: '2026-01-01T00:00:00.000Z' }, originInstanceId: 'self-example-instance' };

    expect(await deliverPeerSyncEvent(ioServer, imageFrame)).toBe(1);
    const all = [outbound, silenced, inboundOnly];
    const markers = all.map(({ client }) => once(client, 'example:marker'));
    ioServer.emit('example:marker');
    await Promise.all(markers);
    expect(outbound.frames).toEqual([imageFrame]);
    expect(silenced.frames).toEqual([]);
    expect(inboundOnly.frames).toEqual([]);
  });

  it('delivers nothing for a category with no receiver gate', async () => {
    expect(await deliverPeerSyncEvent({ in: () => { throw new Error('not reached'); } }, { ...FRAME, category: 'brain' })).toBe(0);
  });
});
