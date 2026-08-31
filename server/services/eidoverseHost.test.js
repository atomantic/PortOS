import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createEidoverseHost } from './eidoverseHost.js';

const bridges = [];
const upstreamServers = [];
const webSocketServers = [];
const webSocketClients = [];

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  upstreamServers.push(server);
  return server.address().port;
};

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

afterEach(async () => {
  webSocketClients.splice(0).forEach((client) => client.terminate());
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(webSocketServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(upstreamServers.splice(0).map(closeServer));
});

describe('Eidoverse host bridge', () => {
  it('forwards HTTP responses and the browser-facing scheme to the managed app', async () => {
    const upstreamPort = await listen(createServer((req, res) => {
      const forwardedScheme = req.headers['x-forwarded-proto'];
      res.writeHead(201, {
        'content-type': 'application/json',
        ...(forwardedScheme ? { 'x-forwarded-proto-seen': forwardedScheme } : {}),
      });
      res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
    }));
    const bridge = createEidoverseHost({
      targetPort: upstreamPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);

    const host = await bridge.start();
    expect(await bridge.waitUntilReady({ attempts: 1 })).toEqual(host);
    const response = await fetch(`http://127.0.0.1:${host.port}/worlds/example?mode=join`);

    expect(response.status).toBe(201);
    expect(response.headers.get('x-forwarded-proto-seen')).toBe('http');
    expect(await response.json()).toEqual({
      path: '/worlds/example?mode=join',
      host: `127.0.0.1:${upstreamPort}`,
    });
    expect(host).toEqual({ running: true, protocol: 'http', port: expect.any(Number) });
  });

  it('returns an honest 502 when Eidoverse is not listening', async () => {
    const reserved = createServer();
    const unusedPort = await listen(reserved);
    upstreamServers.pop();
    await closeServer(reserved);
    const bridge = createEidoverseHost({
      targetPort: unusedPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);

    const host = await bridge.start();
    const response = await fetch(`http://127.0.0.1:${host.port}/`);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Eidoverse Worlds is not running.');
  });

  it('passes the Eidoverse WebSocket exchange through the same host', async () => {
    const upstream = createServer();
    const webSocketServer = new WebSocketServer({ server: upstream });
    webSocketServers.push(webSocketServer);
    webSocketServer.on('connection', (socket, req) => {
      socket.on('message', (message) => socket.send(`echo:${message}`));
      socket.send(`scheme:${req.headers['x-forwarded-proto']}`);
    });
    const upstreamPort = await listen(upstream);
    const bridge = createEidoverseHost({
      targetPort: upstreamPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);

    const host = await bridge.start();
    const client = new WebSocket(`ws://127.0.0.1:${host.port}/ws`);
    webSocketClients.push(client);
    const firstMessage = once(client, 'message');
    await once(client, 'open');
    expect(String((await firstMessage)[0])).toBe('scheme:http');

    const echo = once(client, 'message');
    client.send('hello');
    expect(String((await echo)[0])).toBe('echo:hello');
    client.close();
    await once(client, 'close');
    webSocketClients.pop();
  });

  // A managed app on PortOS's reserved :5563 bound 127.0.0.1 explicitly while
  // this bridge bound the wildcard. macOS/BSD allow both, and the specific bind
  // wins every connection — so the bridge logged "listening", served nothing,
  // and the Eidoverse page rendered the other app's UI instead of the world.
  it('refuses to start when another process already serves the port, rather than binding to silence', async () => {
    const squatter = createServer((_req, res) => {
      res.writeHead(200);
      res.end('a different app');
    });
    const contestedPort = await listen(squatter);

    const bridge = createEidoverseHost({
      targetPort: contestedPort,
      listenHost: '0.0.0.0',
      listenPort: contestedPort,
      certDir: null,
    });
    bridges.push(bridge);

    await expect(bridge.start()).rejects.toMatchObject({
      code: 'EIDOVERSE_HOST_PORT_CONFLICT',
      status: 409,
    });
  });
});
