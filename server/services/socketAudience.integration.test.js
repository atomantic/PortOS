import { fakeProc } from './backup.test.fixture.js';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { io as connectSocket } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { emitErrorEvent, errorEvents, ServerError } from '../lib/errorHandler.js';
import { spawn } from '../lib/childProcess.js';
import { checkHealth } from '../lib/db.js';
import twinTests from '../routes/digital-twin/tests.js';
import { runBackup } from './backup.js';
import { apiSyncAccount } from './calendarGoogleApiSync.js';
import { PEER_SYNC_ROOM, registerPeerSyncSubscriber, setupPeerSyncEventForwarding } from './peerSyncDelivery.js';
import { peerSyncBus } from './peerSyncEventBus.js';
import { PEER_SOCKET_ROOM, setIo } from './socketIo.js';

vi.mock('./digital-twin.js', () => ({ runTests: vi.fn(async () => ({ summary: 'Fixture result' })) }));
vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(async () => ({
    type: 'google-calendar',
    subcalendars: [{ enabled: true, name: 'Example Calendar', calendarId: 'fixture-calendar' }],
  })),
  updateSubcalendars: vi.fn(async () => {}),
  updateSyncStatus: vi.fn(async () => {}),
  mergeDiscoveredSubcalendars: vi.fn(),
}));
vi.mock('./googleAuth.js', () => ({ getAuthenticatedClient: vi.fn(async () => ({})) }));
vi.mock('./calendarApi.js', () => ({ createCalendarApi: () => ({ listEvents: async () => ({ data: { items: [] } }) }) }));
vi.mock('./calendarGoogleSync.js', () => ({
  getSyncDateRange: () => ({ pastDate: new Date(0), futureDate: new Date(1) }),
  hasGoogleEventId: () => false,
  pushSyncEvents: async () => ({ newEvents: 0, updated: 0, pruned: 0, total: 0, status: 'success' }),
}));

const EVENTS = [
  'error:occurred', 'digital-twin:test-progress', 'calendar:sync:progress', 'backup:completed',
  'media:history:changed', 'media:collection-primary:changed', 'media:holders:changed',
];

it('delivers operator events only to operators while keeping explicit peer delivery', async () => {
  const backupRoot = await mkdtemp(join(tmpdir(), 'portos-socket-audience-'));
  vi.stubEnv('MEMORY_BACKEND', 'file');
  checkHealth.mockResolvedValue({ connected: false, hasSchema: false });
  const app = express();
  app.use(express.json());
  app.use(twinTests);
  const http = createServer(app);
  const io = new Server(http);
  app.set('io', io);
  const clients = [];
  const onError = vi.fn();
  errorEvents.on('error', onError);
  try {
    // Socket auth and peer room assignment have separate tests. These
    // fixtures exercise delivery after room membership has been established.
    io.on('connection', (socket) => {
      if (socket.handshake.auth.method === 'peer') void socket.join(PEER_SOCKET_ROOM);
      registerPeerSyncSubscriber(socket);
    });
    setIo(io);
    setupPeerSyncEventForwarding();
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const url = `http://127.0.0.1:${http.address().port}`;

    async function connect(method) {
      const client = connectSocket(url, { reconnection: false, transports: ['websocket'], auth: { method } });
      clients.push(client);
      const received = [];
      for (const event of [...EVENTS, 'peer:sync:available']) client.on(event, (payload) => received.push([event, payload]));
      await once(client, 'connect');
      return { client, received, socket: io.sockets.sockets.get(client.id) };
    }

    const operator = await connect('session');
    const peer = await connect('peer');
    const syncPeer = await connect('peer');
    const syncSubscriber = await connect('session');
    await syncPeer.socket.join(PEER_SYNC_ROOM);
    await syncSubscriber.socket.join(PEER_SYNC_ROOM);
    expect(peer.socket.rooms.has(PEER_SOCKET_ROOM)).toBe(true);
    expect(peer.socket.rooms.has(PEER_SYNC_ROOM)).toBe(false);
    expect(operator.socket.rooms.has(PEER_SOCKET_ROOM)).toBe(false);

    emitErrorEvent(io, new ServerError('Example error'));
    const response = await fetch(`${url}/tests/run-multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: [{ providerId: 'fixture-provider', model: 'fixture-model' }] }),
    });
    expect(response.status).toBe(200);
    await response.json();
    await apiSyncAccount('fixture-account', io);
    const proc = fakeProc();
    spawn.mockImplementationOnce(() => {
      setImmediate(() => proc.emit('close', 0));
      return proc;
    });
    await expect(runBackup(backupRoot, io)).resolves.toMatchObject({ status: 'ok' });

    peerSyncBus.emit('media-history-changed', { id: 'example-history' });
    peerSyncBus.emit('collection-primary-changed', { id: 'example-collection' });
    peerSyncBus.emit('media-holders-changed');
    await Promise.all([operator, peer, syncPeer, syncSubscriber].map(({ client, socket }) => {
      // The marker is ordered after every prior packet for the socket.
      const marker = once(client, 'example:marker');
      socket.emit('example:marker');
      return marker;
    }));

    expect(operator.received.filter(([event]) => event !== 'peer:sync:available').map(([event]) => event)).toEqual(EVENTS);
    expect(peer.received).toEqual([['peer:sync:available', expect.any(Object)]]);
    expect(syncPeer.received).toEqual([['peer:sync:available', expect.any(Object)]]);
    expect(syncSubscriber.received.filter(([event]) => event.startsWith('media:'))).toEqual([]);
  } finally {
    for (const client of clients) client.close();
    await io.close();
    setIo(null);
    errorEvents.off('error', onError);
    vi.unstubAllEnvs();
    await rm(backupRoot, { recursive: true, force: true });
  }
});
