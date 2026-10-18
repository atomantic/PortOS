import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Server as SocketIoServer } from 'socket.io';
import { io as SocketIoClient } from 'socket.io-client';
import { installUpgradeFallback } from '../lib/upgradeFallback.js';
import {
  createEidoverseExpressMiddleware,
  embedParentOrigin,
  mountEidoverseWebSocket,
  stripEidoverseHostPrefix,
  isEidoverseRootProxyPath,
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

const rawGet = (port, path, hostHeader) => new Promise((settle, reject) => {
  const probe = httpRequest({ host: '127.0.0.1', port, path, headers: { host: hostHeader } }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => settle({ status: response.statusCode, body }));
  });
  probe.once('error', reject);
  probe.end();
});

afterEach(async () => {
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
});

describe('main-server eidoverse reverse-proxy', () => {
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

    const result = await rawGet(port, '/eidoverse-host/embed-config', '127.0.0.1:15555');
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ parentOrigin: 'http://127.0.0.1:15555' });
    expect(upstreamRequests).toEqual([]);

    const root = await rawGet(port, '/embed-config', '127.0.0.1:15555');
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

  it('completes a /ws upgrade whose upstream answers after 1.5 s when Socket.IO is attached with destroyUpgrade: false', async () => {
    const upstream = createServer();
    const upstreamWss = new WebSocketServer({ noServer: true });
    webSocketServers.push(upstreamWss);
    upstream.on('upgrade', (req, socket, head) => {
      const timer = setTimeout(() => {
        upstreamWss.handleUpgrade(req, socket, head, (ws) => {
          ws.send('slow-ready');
        });
      }, 1500);
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
      path: '/socket.io',
    });
    ioServers.push(io);
    mountEidoverseWebSocket(server, {
      isActive: () => true,
      targetHost: '127.0.0.1',
      targetPort: upstreamPort,
      getProtocol: () => 'http',
    });
    installUpgradeFallback(server);
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
  });
});
