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
  if (subscribe) {
    const subscribed = once(client, 'peer:sync:subscribed');
    client.emit('peer:sync:subscribe');
    await subscribed;
  }
  return { client, frames };
};

describe('deliverPeerSyncEvent', () => {
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

    expect(await deliverPeerSyncEvent(ioServer, FRAME)).toBe(1);
    // Emits are ordered per socket, so a frame sent before this marker has arrived once it does.
    const markers = all.map(({ client }) => once(client, 'example:marker'));
    ioServer.emit('example:marker');
    await Promise.all(markers);

    expect(qualifying.frames).toEqual([FRAME]);
    for (const other of [unknown, categoryOff, browser, unsubscribedPeer]) expect(other.frames).toEqual([]);
  });

  it('delivers nothing for a category with no sync mapping', async () => {
    expect(await deliverPeerSyncEvent({ in: () => { throw new Error('not reached'); } }, { ...FRAME, category: 'imageHistory' })).toBe(0);
  });
});
