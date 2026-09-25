/**
 * Integration test for #8386: a peer relay socket (server/services/
 * peerSocketRelay.js) authenticates the handshake with the paired peer
 * token or the legacy Basic password, never a session. Before this fix,
 * `registerAuthHandlers`'s per-event re-check in socket.js disconnected it
 * the moment it emitted `cos:subscribe`, because that check only recognizes
 * a real operator session.
 *
 * Drives a REAL Socket.IO server (socketAuthGate + registerAuthHandlers, the
 * two files this fix touches) and a REAL socket.io-client over a loopback
 * HTTP server, so the handshake and per-event middleware run unmocked.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';

const { tempRoot, makeProxy, cleanup: cleanupDataRoot } = mockPathsDataRoot({ prefix: 'portos-peer-relay-auth-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// Cheap scrypt params so setPassword()/verifyPassword() don't burn the test
// budget — same override authGate.test.js uses.
vi.mock('../../lib/portosAuthCore.js', async () => {
  const actual = await vi.importActual('../../lib/portosAuthCore.js');
  const testParams = { N: 1024, r: 8, p: 1, maxmem: 8 * 1024 * 1024 };
  const hashPassword = (password, salt) =>
    actual.__hashPasswordWithParamsForTests(password, salt, testParams);
  return {
    ...actual,
    hashPassword,
    verifyPasswordAgainst: async (auth, password) => {
      if (!auth?.enabled || !auth.passwordHash || !auth.salt || typeof password !== 'string' || password.length === 0) return false;
      return actual.constantEqual(await hashPassword(password, auth.salt), auth.passwordHash);
    },
  };
});

const PEER_ID = 'peer-example-instance';
const PAIR_SECRET = 'p'.repeat(40);
const instanceRegistry = vi.hoisted(() => ({ data: { self: null, peers: [] } }));
vi.mock('./instanceIdentity.js', async () => ({
  ...(await vi.importActual('./instanceIdentity.js')),
  loadData: async () => instanceRegistry.data,
}));

const resetSettings = () => {
  writeFileSync(join(tempRoot, 'settings.json'), '{}\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};

let httpServer;
let ioServer;
let port;
let clients = [];

const startServer = async () => {
  const { socketAuthGate } = await import('./authGate.js');
  const { __testing } = await import('./socket.js');
  httpServer = createServer();
  ioServer = new Server(httpServer);
  ioServer.use(socketAuthGate);
  ioServer.on('connection', (socket) => {
    __testing.registerAuthHandlers(socket, ioServer);
    __testing.registerSubscriptionHandlers(socket, ioServer);
    // Stand-in for a host-control-shaped event (server/sockets/shell.js);
    // never actually reached by a peer-authenticated socket once the auth
    // middleware above disconnects it first.
    socket.on('shell:list', () => socket.emit('shell:sessions', { sessions: [] }));
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  port = httpServer.address().port;
};

const stopServer = async () => {
  for (const client of clients) client.close();
  clients = [];
  await new Promise((resolve) => ioServer.close(resolve));
  await new Promise((resolve) => httpServer.close(resolve));
};

const connectClient = (extraHeaders) => {
  const client = ioClient(`http://127.0.0.1:${port}`, {
    reconnection: false,
    timeout: 2000,
    transports: ['websocket'],
    extraHeaders,
  });
  clients.push(client);
  return client;
};

const waitFor = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));

describe('peer socket relay stays connected through cos:subscribe on a password-gated peer (#8386)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetSettings();
    instanceRegistry.data = { self: null, peers: [] };
  });

  afterEach(async () => {
    await stopServer();
  });

  afterAll(() => {
    cleanupDataRoot();
  });

  it('a peer-token-authenticated socket survives cos:subscribe but is disconnected by a shell:* event', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'instance-secret' });
    instanceRegistry.data.peers = [{ id: 'peer-record', name: 'Example Peer', instanceId: PEER_ID, enabled: true, syncSecret: PAIR_SECRET }];
    const { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } = await import('../lib/peerHttpClient.js');

    await startServer();
    const client = connectClient({
      [PEER_INSTANCE_HEADER]: PEER_ID,
      [PEER_AUTH_HEADER]: derivePeerAuthToken(PAIR_SECRET, PEER_ID),
    });

    await waitFor(client, 'connect');
    client.emit('cos:subscribe');
    await waitFor(client, 'cos:subscribed');
    expect(client.connected).toBe(true);

    client.emit('shell:list');
    await waitFor(client, 'disconnect');
    expect(client.connected).toBe(false);
  });

  it('a Basic-authenticated socket also survives cos:subscribe but is disconnected by a shell:* event', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'instance-secret' });

    await startServer();
    const client = connectClient({
      Authorization: `Basic ${Buffer.from(':instance-secret').toString('base64')}`,
    });

    await waitFor(client, 'connect');
    client.emit('cos:subscribe');
    await waitFor(client, 'cos:subscribed');
    expect(client.connected).toBe(true);

    client.emit('shell:list');
    await waitFor(client, 'disconnect');
    expect(client.connected).toBe(false);
  });

  it('an unauthenticated socket is rejected at the handshake', async () => {
    const auth = await import('./auth.js');
    await auth.setPassword({ newPassword: 'instance-secret' });

    await startServer();
    const client = connectClient({});
    const err = await waitFor(client, 'connect_error');
    expect(err.data?.code).toBe('AUTH_REQUIRED');
  });
});
