import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
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

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server.address().port;
};

const closeServer = (server) => new Promise((resolve, reject) => {
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
});
