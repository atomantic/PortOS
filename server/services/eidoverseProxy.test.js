import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Server as SocketIoServer } from 'socket.io';
import { io as SocketIoClient } from 'socket.io-client';
import { installUpgradeFallback } from '../lib/upgradeFallback.js';
import { EIDOVERSE_ROOT_EXACT_PATHS } from '../lib/eidoverseProxyRoutes.js';
import { registerSessionRevocation } from '../sessionRevocation.js';
import {
  closeEidoverseProxySockets,
  closeEidoverseProxySocketsForSessions,
  createEidoverseExpressMiddleware,
  embedParentOrigin,
  mountEidoverseWebSocket,
  stripEidoverseHostPrefix,
  isEidoverseRootProxyPath,
  forwardedHeaders,
  websocketRequestHead,
} from './eidoverseProxy.js';

const HOST_DESCRIPTOR = Object.freeze({
  id: 'hst_0123456789ab',
  kind: 'portos',
  label: 'Luminous Systems Garden',
  version: '9.9.9',
  caps: { eido: false },
});
vi.mock('./eidoverseWorld.js', () => ({
  readEidoverseHostDescriptor: vi.fn(async () => HOST_DESCRIPTOR),
}));

const SESSION_IDS = {
  'operator-session': 'session-operator-1',
  'operator-session-2': 'session-operator-2',
};
const auth = vi.hoisted(() => ({ enabled: false, readable: true, onVerify: null }));
vi.mock('./auth.js', async () => {
  const { extractTokens } = await import('../../lib/portosAuthCore.js');
  const findToken = async (req) => {
    if (!auth.readable) throw new Error('session store unreadable');
    if (auth.onVerify) await auth.onVerify(req);
    return extractTokens(req).find((token) => Object.hasOwn(SESSION_IDS, token)) ?? null;
  };
  return {
    isAuthEnabled: async () => auth.enabled,
    verifyRequestSession: findToken,
    verifyRequestSessionIdentity: async (req) => {
      const token = await findToken(req);
      return token ? { kind: 'session', sessionId: SESSION_IDS[token], label: null } : null;
    },
    verifyPassword: async (password) => password === 'instance-password',
  };
});
vi.mock('./eidoverseTravel.js', () => ({ getEidoverseGuestSession: async () => null }));

const servers = [];
const webSocketServers = [];
const webSocketClients = [];
const ioServers = [];

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server.address().port;
};

const closeServer = (server) => new Promise((resolve, reject) => {
  if (!server.listening) {
    resolve();
    return;
  }
  server.close((error) => (error ? reject(error) : resolve()));
});

const rawGet = (port, path, headers) => new Promise((settle, reject) => {
  const probe = httpRequest({ host: '127.0.0.1', port, path, headers }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => settle({ status: response.statusCode, body }));
  });
  probe.once('error', reject);
  probe.end();
});

/** 101 when the upgrade is admitted, else the HTTP refusal status. */
const upgradeStatus = (port, path, headers = {}) => new Promise((settle, reject) => {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  webSocketClients.push(client);
  client.once('open', () => settle(101));
  client.once('unexpected-response', (_req, response) => {
    response.resume();
    response.socket.once('close', () => settle(response.statusCode));
  });
  client.once('error', reject);
});

const listenRecordingUpstream = async () => {
  const reached = [];
  const upstream = createServer((req, res) => {
    reached.push(req.url);
    res.end('sequencer');
  });
  const webSocketServer = new WebSocketServer({ server: upstream });
  webSocketServers.push(webSocketServer);
  webSocketServer.on('connection', (_socket, req) => reached.push(req.url));
  return { reached, upstreamPort: await listen(upstream) };
};
const FOREIGN_BROWSERS = [
  ['a cross-origin page', { origin: 'https://attacker.example' }],
  ['a sandboxed page', { origin: 'null' }],
  ['a DNS-rebound page', { host: 'rebound.attacker.example', origin: 'http://rebound.attacker.example' }],
];
const REFUSED_CREDENTIALS = [
  ['no credentials', {}],
  ['a stale session', { cookie: 'portos_auth=stale' }],
  ['the instance password as Basic', { authorization: `Basic ${Buffer.from(':instance-password').toString('base64')}` }],
  ['a peer credential', { 'x-portos-peer-auth': 'peer', 'x-portos-instance-id': 'peer-instance' }],
  ['a guest cookie with no visit behind it', { cookie: 'portos_eidoverse_guest=unknown-ticket' }],
];
const OPERATOR_CREDENTIALS = [
  ['a session cookie', { cookie: 'portos_auth_5555=operator-session' }],
  ['a Bearer session', { authorization: 'Bearer operator-session' }],
];

afterEach(async () => {
  auth.enabled = false;
  auth.readable = true;
  webSocketClients.splice(0).forEach((client) => client.terminate());
  await Promise.all(webSocketServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  while (ioServers.length > 0) {
    const io = ioServers.pop();
    try {
      io?.close();
    } catch {}
  }
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('eidoverse proxy route helpers', () => {
  it('strips the /eidoverse-host prefix for relative assets', () => {
    expect(stripEidoverseHostPrefix('/eidoverse-host/')).toBe('/');
    expect(stripEidoverseHostPrefix('/eidoverse-host')).toBe('/');
    expect(stripEidoverseHostPrefix('/eidoverse-host/main.js')).toBe('/main.js');
    expect(stripEidoverseHostPrefix('/eidoverse-host/a?b=1')).toBe('/a?b=1');
    expect(stripEidoverseHostPrefix('/version')).toBe(null);
  });

  it('recognizes exact and prefix root allowlist entries from routes.ts', () => {
    expect(isEidoverseRootProxyPath('/version')).toBe(true);
    expect(isEidoverseRootProxyPath('/ws')).toBe(true);
    expect(isEidoverseRootProxyPath('/library/foo.glb')).toBe(true);
    expect(isEidoverseRootProxyPath('/node_modules/three/build/three.module.js')).toBe(true);
    expect(isEidoverseRootProxyPath('/AGENTS.md')).toBe(true);
    expect(isEidoverseRootProxyPath('/eidoverse')).toBe(false);
    expect(isEidoverseRootProxyPath('/api/settings')).toBe(false);
  });

  it('preserves a non-5555 Host port in same-origin embed parent origins', () => {
    const req = { headers: { host: '127.0.0.1:15555' } };
    expect(embedParentOrigin(req, 'http', 'same-origin')).toBe('http://127.0.0.1:15555');
    expect(embedParentOrigin(req, 'http', 'bridge')).toMatch(/:5555$/);
  });

  it.each(['host:1:2', 'host:', 'host:abc', 'host:123456', 'host:80/path', '[::1]junk', '[::1', 'user@host'])(
    'names no same-origin embedder for the malformed Host %s', (host) => {
      expect(embedParentOrigin({ headers: { host } }, 'http', 'same-origin')).toBe(null);
    },
  );

  it.each(['host', 'host-alpha.example:15555', '[::1]', '[::1]:5555'])('keeps the well-formed Host %s', (host) => {
    expect(embedParentOrigin({ headers: { host } }, 'http', 'same-origin')).toBe(`http://${host}`);
  });
});

const mountApp = async ({ active, upstreamPort, spaBody = 'spa' }) => {
  const app = express();
  app.use(createEidoverseExpressMiddleware({
    isActive: () => active,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    getProtocol: () => 'http',
  }));
  app.use((_req, res) => {
    res.status(200).type('text/plain').send(spaBody);
  });
  const server = createServer(app);
  mountEidoverseWebSocket(server, {
    isActive: () => active,
    targetHost: '127.0.0.1',
    targetPort: upstreamPort,
    getProtocol: () => 'http',
  });
  return listen(server);
};

describe('main-server eidoverse admission', () => {
  it.each(REFUSED_CREDENTIALS)('refuses every HTTP and WebSocket entry point given %s when a password is set', async (_label, headers) => {
    auth.enabled = true;
    const { reached, upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });

    for (const path of [...EIDOVERSE_ROOT_EXACT_PATHS, '/library/a.glb', '/AGENTS.md', '/eidoverse-host', '/eidoverse-host/', '/eidoverse-host/upload']) {
      expect((await rawGet(port, path, headers)).status, path).toBe(401);
    }
    for (const path of ['/ws', '/ws?world=a', '/eidoverse-host/ws']) {
      expect(await upgradeStatus(port, path, headers), path).toBe(401);
    }
    expect(reached).toEqual([]);
    // Only Eidoverse's own paths are gated: the login shell still loads.
    expect((await rawGet(port, '/login', headers)).body).toBe('spa');
  });

  it.each(FOREIGN_BROWSERS.flatMap(([label, headers]) => [true, false].map((enabled) => [label, enabled, headers])))(
    'refuses %s with password enabled=%s, even carrying a live session', async (_label, enabled, foreign) => {
      auth.enabled = enabled;
      const { reached, upstreamPort } = await listenRecordingUpstream();
      const port = await mountApp({ active: true, upstreamPort });
      const headers = { ...foreign, cookie: 'portos_auth=operator-session' };

      for (const path of ['/eidoverse-host/', '/upload', '/embed-config', '/host']) {
        expect((await rawGet(port, path, headers)).status, path).toBe(403);
      }
      for (const path of ['/ws', '/eidoverse-host/ws']) {
        expect(await upgradeStatus(port, path, headers), path).toBe(403);
      }
      expect(reached).toEqual([]);
    },
  );

  it.each(OPERATOR_CREDENTIALS)('admits an operator with %s when a password is set', async (_label, credentials) => {
    auth.enabled = true;
    const { reached, upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });
    const headers = { ...credentials, origin: `http://127.0.0.1:${port}` };

    expect((await rawGet(port, '/eidoverse-host/main.js', headers)).status).toBe(200);
    expect(await upgradeStatus(port, '/ws', headers)).toBe(101);
    await vi.waitFor(() => expect(reached).toEqual(['/main.js', '/ws']));
  });

  it('admits a same-origin browser on a password-free install', async () => {
    const { reached, upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });
    const headers = { origin: `http://127.0.0.1:${port}` };

    expect((await rawGet(port, '/eidoverse-host/main.js', headers)).status).toBe(200);
    expect(await upgradeStatus(port, '/ws', headers)).toBe(101);
    await vi.waitFor(() => expect(reached).toEqual(['/main.js', '/ws']));
  });

  it('fails closed when the session store cannot be read', async () => {
    auth.enabled = true;
    auth.readable = false;
    const { reached, upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });

    expect((await rawGet(port, '/version', {})).status).toBe(503);
    expect(await upgradeStatus(port, '/ws')).toBe(503);
    expect(reached).toEqual([]);
  });

  it('ends open sockets when PortOS sessions are revoked', async () => {
    const { upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });
    expect(await upgradeStatus(port, '/ws')).toBe(101);
    const closed = once(webSocketClients.at(-1), 'close');
    closeEidoverseProxySockets();
    await closed;
  });

  it('closes only the revoked operator session sockets on targeted sessions:revoked', async () => {
    auth.enabled = true;
    const { upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });
    const origin = `http://127.0.0.1:${port}`;
    expect(await upgradeStatus(port, '/ws', { cookie: 'portos_auth=operator-session', origin })).toBe(101);
    const revokedSocket = webSocketClients.at(-1);
    expect(await upgradeStatus(port, '/eidoverse-host/ws', { cookie: 'portos_auth=operator-session-2', origin })).toBe(101);
    const keptSocket = webSocketClients.at(-1);

    const authEvents = new EventEmitter();
    registerSessionRevocation({
      authEvents,
      closeEidoverseProxySockets,
      closeEidoverseProxySocketsForSessions,
    });
    const closed = once(revokedSocket, 'close');
    authEvents.emit('sessions:revoked', ['session-operator-1']);
    await closed;

    expect(revokedSocket.readyState).toBe(WebSocket.CLOSED);
    expect(keptSocket.readyState).toBe(WebSocket.OPEN);
    keptSocket.close();
    await once(keptSocket, 'close');
  });

  it('rejects an in-flight WebSocket upgrade when its session is revoked during admission', async () => {
    auth.enabled = true;
    const { reached, upstreamPort } = await listenRecordingUpstream();
    const port = await mountApp({ active: true, upstreamPort });
    const origin = `http://127.0.0.1:${port}`;
    const authEvents = new EventEmitter();
    registerSessionRevocation({
      authEvents,
      closeEidoverseProxySockets,
      closeEidoverseProxySocketsForSessions,
    });
    auth.onVerify = async () => {
      authEvents.emit('sessions:revoked', ['session-operator-1']);
    };
    try {
      expect(await upgradeStatus(port, '/ws', { cookie: 'portos_auth=operator-session', origin })).toBe(401);
      expect(reached).toEqual([]);
    } finally {
      auth.onVerify = null;
    }
  });
});

describe('main-server eidoverse reverse-proxy', () => {
  it('strips /eidoverse-host and forwards to the sequencer', async () => {
    const upstreamPort = await listen(createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    }));
    const port = await mountApp({ active: true, upstreamPort });

    const response = await fetch(`http://127.0.0.1:${port}/eidoverse-host/main.js?v=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: '/main.js?v=1' });
  });

  it('proxies root /version only while the host is active', async () => {
    const upstreamPort = await listen(createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, from: 'eidoverse' }));
    }));

    const activePort = await mountApp({ active: true, upstreamPort, spaBody: 'spa-active' });
    const active = await fetch(`http://127.0.0.1:${activePort}/version`);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ path: '/version', from: 'eidoverse' });

    const inactivePort = await mountApp({ active: false, upstreamPort, spaBody: 'spa-inactive' });
    const inactive = await fetch(`http://127.0.0.1:${inactivePort}/version`);
    expect(inactive.status).toBe(200);
    expect(await inactive.text()).toBe('spa-inactive');
  });

  it('answers path-mounted /embed-config with the full browser Host as parentOrigin', async () => {
    const upstreamRequests = [];
    const upstreamPort = await listen(createServer((req, res) => {
      upstreamRequests.push(req.url);
      res.writeHead(200);
      res.end('sequencer');
    }));
    const port = await mountApp({ active: true, upstreamPort });

    const result = await rawGet(port, '/eidoverse-host/embed-config', { host: '127.0.0.1:15555' });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ parentOrigin: 'http://127.0.0.1:15555' });
    expect(upstreamRequests).toEqual([]);

    const root = await rawGet(port, '/embed-config', { host: '127.0.0.1:15555' });
    expect(root.status).toBe(200);
    expect(JSON.parse(root.body)).toEqual({ parentOrigin: 'http://127.0.0.1:15555' });
  });

  it('upgrades root /ws to the sequencer while active', async () => {
    const upstream = createServer();
    const webSocketServer = new WebSocketServer({ server: upstream });
    webSocketServers.push(webSocketServer);
    webSocketServer.on('connection', (socket) => {
      socket.send('ready');
      socket.on('message', (message) => socket.send(`echo:${message}`));
    });
    const upstreamPort = await listen(upstream);
    const port = await mountApp({ active: true, upstreamPort });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    webSocketClients.push(client);
    const first = once(client, 'message');
    await once(client, 'open');
    expect(String((await first)[0])).toBe('ready');
    const echo = once(client, 'message');
    client.send('ping');
    expect(String((await echo)[0])).toBe('echo:ping');
    client.close();
    await once(client, 'close');
    webSocketClients.pop();
  });

  it('forwards a JSON POST body when mounted in the production order', async () => {
    let receivedBody = null;
    let receivedHeaders = null;
    const upstreamPort = await listen(createServer((req, res) => {
      receivedHeaders = req.headers;
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
      });
    }));

    // Mirror production order from server/index.js:
    // Eidoverse proxy mounted BEFORE express.json()
    const app = express();
    app.use(createEidoverseExpressMiddleware({
      isActive: () => true,
      targetHost: '127.0.0.1',
      targetPort: upstreamPort,
      getProtocol: () => 'http',
    }));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    const server = createServer(app);
    const port = await listen(server);

    const payload = { action: 'ping', count: 42 };
    const response = await fetch(`http://127.0.0.1:${port}/eidoverse-host/api/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ ok: true, echo: payload });
    expect(receivedBody).toBe(JSON.stringify(payload));
    expect(Number(receivedHeaders['content-length'])).toBe(Buffer.byteLength(JSON.stringify(payload)));
  });

  const fallbackTimeoutMs = 40;
  const handshakeDelayMs = 80;

  it('completes a /ws upgrade whose upstream answers after the fallback deadline', async () => {
    const upstream = createServer();
    const upstreamWss = new WebSocketServer({ noServer: true });
    webSocketServers.push(upstreamWss);
    upstream.on('upgrade', (req, socket, head) => {
      const timer = setTimeout(() => {
        upstreamWss.handleUpgrade(req, socket, head, (ws) => {
          ws.send('slow-ready');
        });
      }, handshakeDelayMs);
      timer.unref?.();
    });
    const upstreamPort = await listen(upstream);

    const app = express();
    app.use(createEidoverseExpressMiddleware({
      isActive: () => true,
      targetHost: '127.0.0.1',
      targetPort: upstreamPort,
      getProtocol: () => 'http',
    }));
    const server = createServer(app);
    const io = new SocketIoServer(server, {
      destroyUpgrade: false,
      destroyUpgradeTimeout: fallbackTimeoutMs,
      path: '/socket.io',
    });
    ioServers.push(io);
    mountEidoverseWebSocket(server, {
      isActive: () => true,
      targetHost: '127.0.0.1',
      targetPort: upstreamPort,
      getProtocol: () => 'http',
    });
    installUpgradeFallback(server, { timeoutMs: fallbackTimeoutMs });
    const port = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    webSocketClients.push(client);
    const first = once(client, 'message');
    await once(client, 'open');
    expect(String((await first)[0])).toBe('slow-ready');
    client.close();
    await once(client, 'close');
    webSocketClients.pop();
  });

  it('ends an upgrade request for an unclaimed path after a bounded timeout', async () => {
    const app = express();
    const server = createServer(app);
    const io = new SocketIoServer(server, {
      destroyUpgrade: false,
      path: '/socket.io',
    });
    ioServers.push(io);
    mountEidoverseWebSocket(server, {
      isActive: () => true,
      targetHost: '127.0.0.1',
      targetPort: 5556,
      getProtocol: () => 'http',
    });
    installUpgradeFallback(server, { timeoutMs: 100 });
    const port = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/unclaimed-upgrade-path`);
    webSocketClients.push(client);
    const closed = await new Promise((resolve) => {
      client.on('close', () => resolve(true));
      client.on('error', () => resolve(true));
    });
    expect(closed).toBe(true);
    expect(client.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    webSocketClients.pop();
  });

  it('preserves Socket.IO upgrades on the same server when destroyUpgrade: false is set', async () => {
    const app = express();
    const server = createServer(app);
    const io = new SocketIoServer(server, {
      destroyUpgrade: false,
      path: '/socket.io',
    });
    ioServers.push(io);
    mountEidoverseWebSocket(server, {
      isActive: () => true,
      targetHost: '127.0.0.1',
      targetPort: 5556,
      getProtocol: () => 'http',
    });
    installUpgradeFallback(server);
    const port = await listen(server);

    const client = SocketIoClient(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
    });
    await once(client, 'connect');
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it('preserves Socket.IO upgrades with delayed allowRequest authorization', async () => {
    const app = express();
    const server = createServer(app);
    const io = new SocketIoServer(server, {
      destroyUpgrade: false,
      path: '/socket.io',
      allowRequest: async (_req, callback) => {
        await new Promise((resolve) => setTimeout(resolve, handshakeDelayMs));
        callback(null, true);
      },
    });
    ioServers.push(io);
    installUpgradeFallback(server, { timeoutMs: fallbackTimeoutMs });
    const port = await listen(server);

    const client = SocketIoClient(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      transports: ['websocket'],
    });
    await once(client, 'connect');
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it('ends an unanswered upgrade to /socket.io (without trailing slash) after timeout', async () => {
    const app = express();
    const server = createServer(app);
    const io = new SocketIoServer(server, {
      destroyUpgrade: false,
      path: '/socket.io',
    });
    ioServers.push(io);
    installUpgradeFallback(server, { timeoutMs: 100 });
    const port = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/socket.io`);
    webSocketClients.push(client);
    const closed = await new Promise((resolve) => {
      client.on('close', () => resolve(true));
      client.on('error', () => resolve(true));
    });
    expect(closed).toBe(true);
    expect(client.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    webSocketClients.pop();
  });
});

describe('upstream credential stripping', () => {
  const headers = {
    host: 'portos.example:5555',
    authorization: 'Bearer secret',
    'x-portos-peer-auth': 'peer',
    cookie: 'portos_auth=a; portos_auth_5555=b; portos_eidoverse_guest=g; eido=keep',
  };
  const rawHeaders = Object.entries(headers).flat();

  it('removes PortOS credentials from forwarded HTTP headers but keeps other cookies', () => {
    const out = forwardedHeaders({ headers }, 'http', '127.0.0.1', 8940);
    expect(out.authorization).toBeUndefined();
    expect(out['x-portos-peer-auth']).toBeUndefined();
    expect(out.cookie).toBe('eido=keep');
  });

  it('omits Cookie entirely when only PortOS cookies were present', () => {
    const out = forwardedHeaders({ headers: { host: 'h', cookie: 'portos_auth=a' } }, 'http', '127.0.0.1', 8940);
    expect('cookie' in out).toBe(false);
  });

  it('applies the same stripping to the WebSocket upgrade head', () => {
    const head = websocketRequestHead(
      { rawHeaders, headers, method: 'GET', url: '/ws', httpVersion: '1.1' }, 'http', '127.0.0.1', 8940,
    );
    expect(head).not.toMatch(/portos_auth|authorization|x-portos-peer-auth|portos_eidoverse_guest/i);
    expect(head).toContain('cookie: eido=keep');
  });
});
