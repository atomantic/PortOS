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
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

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
// Host-control handlers the stand-ins below actually reached (#8708).
let reached = [];

// Names the setup phase that stalls. A failure before the server exists (module
// import / password hashing under suite load) otherwise surfaces only as an
// opaque test timeout, which the socket-stage waiters below cannot name (#8484).
// The deadline sits inside the unchanged 30s test budget.
const STAGE_DEADLINE_MS = 25_000;
const stage = (name, work) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`setup stage "${name}" exceeded ${STAGE_DEADLINE_MS}ms`)), STAGE_DEADLINE_MS);
  Promise.resolve(work).then(resolve, reject).finally(() => clearTimeout(timer));
});

const setInstancePassword = async () => {
  const auth = await stage('import auth.js', import('./auth.js'));
  await stage('set instance password', auth.setPassword({ newPassword: 'instance-secret' }));
  return auth;
};

const startServer = async () => {
  const { socketAuthGate } = await stage('import authGate.js', import('./authGate.js'));
  const { __testing } = await stage('import socket.js', import('./socket.js'));
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
    // Stand-ins for the host-control handlers (server/sockets/shell.js,
    // iterm.js, apps.js): record that the handler ran, which the gate must
    // prevent for a caller without host-control authority.
    socket.on('shell:start', (options) => {
      reached.push(['shell:start', options?.initialCommand]);
      socket.emit('shell:started', { sessionId: 'example-session' });
    });
    socket.on('iterm:input', () => reached.push(['iterm:input']));
    socket.on('app:update', () => reached.push(['app:update']));
    // Stand-in for socket.js's error:recover, which queues a recovery agent (#8716).
    socket.on('error:recover', () => reached.push(['error:recover']));
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  port = httpServer.address().port;
};

const stopServer = async () => {
  for (const client of clients) client.close();
  clients = [];
  reached = [];
  // Tolerate partial setup (a stage failed before the server existed) so the
  // teardown error does not mask the original failure.
  if (ioServer) await new Promise((resolve) => ioServer.close(resolve));
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  ioServer = undefined;
  httpServer = undefined;
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

afterAll(() => {
  cleanupDataRoot();
});

// Resolves on `event`; rejects with the stage name and reason if the socket
// fails the handshake (connect_error) or drops (disconnect) while we wait, so a
// transport failure under suite load surfaces as a named stage instead of an
// opaque 30s test timeout (#8484). Waiters for those events themselves opt out.
const waitFor = (emitter, event) => new Promise((resolve, reject) => {
  const cleanup = () => {
    emitter.off(event, onEvent);
    emitter.off('connect_error', onConnectError);
    emitter.off('disconnect', onDisconnect);
  };
  const onEvent = (value) => { cleanup(); resolve(value); };
  const onConnectError = (err) => { cleanup(); reject(new Error(`awaiting "${event}": connect_error ${err?.data?.code || err?.message}`)); };
  const onDisconnect = (reason) => { cleanup(); reject(new Error(`awaiting "${event}": socket disconnected (${reason})`)); };
  emitter.on(event, onEvent);
  if (event !== 'connect_error') emitter.on('connect_error', onConnectError);
  if (event !== 'disconnect') emitter.on('disconnect', onDisconnect);
});

describe('peer socket relay stays connected through cos:subscribe on a password-gated peer (#8386)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetSettings();
    instanceRegistry.data = { self: null, peers: [] };
  });

  afterEach(async () => {
    await stopServer();
  });

  it('a peer-token-authenticated socket survives cos:subscribe but is disconnected by a shell:* event', async () => {
    await setInstancePassword();
    instanceRegistry.data.peers = [{ id: 'peer-record', name: 'Example Peer', instanceId: PEER_ID, enabled: true, syncSecret: PAIR_SECRET }];
    const { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } = await stage('import peerHttpClient.js', import('../lib/peerHttpClient.js'));

    await startServer();
    const client = connectClient({
      [PEER_INSTANCE_HEADER]: PEER_ID,
      [PEER_AUTH_HEADER]: derivePeerAuthToken(PAIR_SECRET, PEER_ID),
    });

    await waitFor(client, 'connect');
    const subscribed = waitFor(client, 'cos:subscribed');
    client.emit('cos:subscribe');
    await subscribed;
    expect(client.connected).toBe(true);

    const disconnected = waitFor(client, 'disconnect');
    client.emit('shell:list');
    await disconnected;
    expect(client.connected).toBe(false);
  });

  it('a Basic-authenticated socket also survives cos:subscribe but is disconnected by a shell:* event', async () => {
    await setInstancePassword();

    await startServer();
    const client = connectClient({
      Authorization: `Basic ${Buffer.from(':instance-secret').toString('base64')}`,
    });

    await waitFor(client, 'connect');
    const subscribed = waitFor(client, 'cos:subscribed');
    client.emit('cos:subscribe');
    await subscribed;
    expect(client.connected).toBe(true);

    const disconnected = waitFor(client, 'disconnect');
    client.emit('shell:list');
    await disconnected;
    expect(client.connected).toBe(false);
  });

  it('an unauthenticated socket is rejected at the handshake', async () => {
    await setInstancePassword();

    await startServer();
    const client = connectClient({});
    const err = await waitFor(client, 'connect_error');
    expect(err.data?.code).toBe('AUTH_REQUIRED');
  });
});

describe('host-control socket events need operator authority (#8708)', () => {
  const REMOTE_VIA_DEV_PROXY = { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' };

  beforeEach(async () => {
    vi.resetModules();
    resetSettings();
    instanceRegistry.data = { self: null, peers: [] };
  });

  afterEach(async () => {
    await stopServer();
  });

  it('auth off: a remote caller is refused every host-control event and runs nothing', async () => {
    await startServer();
    const client = connectClient(REMOTE_VIA_DEV_PROXY);
    await waitFor(client, 'connect');

    const shellRefused = waitFor(client, 'shell:error');
    client.emit('shell:start', { initialCommand: 'echo example' });
    expect(await shellRefused).toMatchObject({ code: 'HOST_CONTROL_FORBIDDEN' });

    const itermRefused = waitFor(client, 'iterm:error');
    client.emit('iterm:input', { id: 'example-iterm', data: 'ls\r' });
    expect(await itermRefused).toMatchObject({ code: 'HOST_CONTROL_FORBIDDEN', id: 'example-iterm' });

    const updateRefused = waitFor(client, 'app:update:error');
    client.emit('app:update', { appId: 'example-app' });
    expect(await updateRefused).toMatchObject({ code: 'HOST_CONTROL_FORBIDDEN', appId: 'example-app' });

    const recoverRefused = waitFor(client, 'error:recover:error');
    client.emit('error:recover', { code: 'EXAMPLE_ERROR' });
    expect(await recoverRefused).toMatchObject({ code: 'HOST_CONTROL_FORBIDDEN' });

    // Read-only subscriptions stay open, and the refusals did not disconnect.
    const subscribed = waitFor(client, 'cos:subscribed');
    client.emit('cos:subscribe');
    await subscribed;
    expect(client.connected).toBe(true);
    expect(reached).toEqual([]);
  });

  it('auth off: a local caller, direct or through the dev proxy, keeps the shell', async () => {
    await startServer();
    for (const headers of [{}, { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }]) {
      const client = connectClient(headers);
      await waitFor(client, 'connect');
      const started = waitFor(client, 'shell:started');
      client.emit('shell:start', { initialCommand: 'echo example' });
      await started;
    }
    expect(reached).toEqual([['shell:start', 'echo example'], ['shell:start', 'echo example']]);
  });

  it('auth on: a session socket keeps the shell; a remote connection does not change that', async () => {
    const auth = await stage('import auth.js', import('./auth.js'));
    const { token } = await stage('set instance password', auth.setPassword({ newPassword: 'instance-secret' }));
    await startServer();
    const client = connectClient({ cookie: `portos_auth=${token}`, ...REMOTE_VIA_DEV_PROXY });
    await waitFor(client, 'connect');
    const started = waitFor(client, 'shell:started');
    client.emit('shell:start', {});
    await started;
    expect(reached).toEqual([['shell:start', undefined]]);
  });

  it('auth on: a Basic-authenticated relay socket never reaches a host-control handler', async () => {
    await setInstancePassword();
    await startServer();
    const client = connectClient({ Authorization: `Basic ${Buffer.from(':instance-secret').toString('base64')}` });
    await waitFor(client, 'connect');
    const disconnected = waitFor(client, 'disconnect');
    client.emit('shell:start', { initialCommand: 'echo example' });
    await disconnected;
    expect(reached).toEqual([]);
  });
});
