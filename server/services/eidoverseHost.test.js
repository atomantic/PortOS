import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createEidoverseHost } from './eidoverseHost.js';

// The bridge reaches the world config through a deferred `await import()`, so
// the stub stands in for the whole config graph without loading it here.
const HOST_DESCRIPTOR = Object.freeze({
  id: 'hst_0123456789ab',
  kind: 'portos',
  label: 'Luminous Systems Garden',
  version: '9.9.9',
  caps: { eido: false },
});
const readEidoverseHostDescriptor = vi.fn(async () => HOST_DESCRIPTOR);
vi.mock('./eidoverseWorld.js', () => ({
  readEidoverseHostDescriptor: (...args) => readEidoverseHostDescriptor(...args),
}));

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
  vi.unstubAllEnvs();
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

  it('answers GET /host itself, so the descriptor never reaches the sequencer', async () => {
    const upstreamRequests = [];
    const upstreamPort = await listen(createServer((req, res) => {
      upstreamRequests.push(req.url);
      res.writeHead(200);
      res.end('sequencer');
    }));
    const bridge = createEidoverseHost({
      targetPort: upstreamPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);

    const host = await bridge.start();
    const response = await fetch(`http://127.0.0.1:${host.port}/host?probe=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual(HOST_DESCRIPTOR);
    // A forwarded request would have shown up here; the whole point is that it
    // does not, so the upstream checkout needs no change to serve this.
    expect(upstreamRequests).toEqual([]);
  });

  // The renderer takes its trusted parent origin from GET /embed-config and
  // stays permanently dormant without one. The external checkout answers that
  // from a single static env var, which cannot name one install reachable as
  // localhost, a LAN address AND a MagicDNS name — so PortOS answers instead,
  // from the hostname the browser actually used plus its own scheme and port.
  it('answers GET /embed-config with the PortOS page origin the browser reached it by', async () => {
    const upstreamRequests = [];
    const upstreamPort = await listen(createServer((req, res) => {
      upstreamRequests.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ parentOrigin: null }));
    }));
    const bridge = createEidoverseHost({
      targetPort: upstreamPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);
    vi.stubEnv('PORT', '5599');

    const host = await bridge.start();
    const response = await fetch(`http://127.0.0.1:${host.port}/embed-config`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The bridge's own port is never the answer — the parent is the PortOS page.
    expect(await response.json()).toEqual({ parentOrigin: 'http://127.0.0.1:5599' });
    // Forwarding it would hand back the checkout's unset value and leave the
    // renderer with no embedder at all.
    expect(upstreamRequests).toEqual([]);

    const posted = await fetch(`http://127.0.0.1:${host.port}/embed-config`, { method: 'POST' });
    expect(posted.status).toBe(405);
    expect(upstreamRequests).toEqual([]);
  });

  it('names no embedder when the request carries no usable host', async () => {
    const upstreamPort = await listen(createServer((_req, res) => {
      res.writeHead(200);
      res.end('sequencer');
    }));
    const bridge = createEidoverseHost({
      targetPort: upstreamPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);

    const host = await bridge.start();
    // `fetch` refuses to set Host, so the raw client is the only way to ask.
    // A repaired origin would be a silent mismatch at handshake time: the
    // browser compares with ===, so an unusable host must resolve to "nobody".
    const answer = await new Promise((settle, reject) => {
      const probe = httpRequest({
        host: '127.0.0.1',
        port: host.port,
        path: '/embed-config',
        headers: { host: 'not a hostname' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => settle({ status: response.statusCode, body }));
      });
      probe.once('error', reject);
      probe.end();
    });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ parentOrigin: null });
  });

  it('refuses to write through the descriptor path, and reports an unreadable descriptor honestly', async () => {
    const upstreamRequests = [];
    const upstreamPort = await listen(createServer((req, res) => {
      upstreamRequests.push(req.url);
      res.writeHead(200);
      res.end('sequencer');
    }));
    const bridge = createEidoverseHost({
      targetPort: upstreamPort,
      listenHost: '127.0.0.1',
      listenPort: 0,
      certDir: null,
    });
    bridges.push(bridge);

    const host = await bridge.start();
    const posted = await fetch(`http://127.0.0.1:${host.port}/host`, { method: 'POST' });
    expect(posted.status).toBe(405);

    readEidoverseHostDescriptor.mockRejectedValueOnce(new Error('config unreadable'));
    const failed = await fetch(`http://127.0.0.1:${host.port}/host`);
    expect(failed.status).toBe(503);
    // Neither the refusal nor the failure may fall through to the sequencer.
    expect(upstreamRequests).toEqual([]);
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
