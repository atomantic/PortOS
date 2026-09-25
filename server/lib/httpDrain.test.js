/**
 * Shutdown drain contract (#8323), exercised against real listeners because the
 * behaviour under test is Node's own connection handling: `server.close()` alone
 * keeps serving requests on already-open keep-alive sockets, and the drain has to
 * both let accepted work finish and keep new work out.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createHttpDrain } from './httpDrain.js';

const opened = [];
afterEach(() => {
  for (const server of opened.splice(0)) server.closeAllConnections();
});

const listen = async (handler) => {
  const server = http.createServer(handler);
  opened.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
};

const request = (port, path, agent = false) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body }));
    res.on('error', (err) => resolve({ error: err.code }));
  }).on('error', (err) => resolve({ error: err.code }));
});

// A raw connection whose request is only partly written — the server has
// accepted the socket, but the request is not complete until `finish()`.
const openPartialRequest = async (port, path) => {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n`);
  let raw = '';
  socket.on('data', (chunk) => { raw += chunk; });
  const closed = new Promise((resolve) => socket.once('close', () => resolve(raw)));
  return { finish: () => { socket.write('\r\n'); return closed; } };
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('createHttpDrain', () => {
  it('lets an accepted request finish while both listeners refuse new requests', async () => {
    const handled = [];
    const release = deferred();
    const handler = async (req, res) => {
      handled.push(req.url);
      if (req.url === '/slow') await release.promise;
      res.end(`done ${req.url}`);
    };
    const primary = await listen(handler);
    const mirror = await listen(handler);
    const drain = createHttpDrain([primary.server, mirror.server, null]);

    // A keep-alive client, so the response must actively opt out of reuse.
    const keepAlive = new http.Agent({ keepAlive: true });
    const slow = request(primary.port, '/slow', keepAlive);
    const pending = await openPartialRequest(mirror.port, '/late');
    while (!handled.includes('/slow')) await new Promise((r) => setImmediate(r));

    let drained = null;
    drain.begin(5000).then((result) => { drained = result; });

    // New connections are refused on both listeners, and a request completed on
    // a socket accepted before the drain never reaches the handler.
    expect(await request(primary.port, '/new')).toEqual({ error: 'ECONNREFUSED' });
    expect(await request(mirror.port, '/new')).toEqual({ error: 'ECONNREFUSED' });
    const refused = await pending.finish();
    expect(refused).toMatch(/^HTTP\/1\.1 503 /);
    expect(refused).toMatch(/connection: close/i);
    expect(drained).toBeNull();

    release.resolve();
    expect(await slow).toEqual({ status: 200, connection: 'close', body: 'done /slow' });
    await new Promise((r) => setImmediate(r));
    expect(drained).toEqual({ remaining: 0 });
    expect(handled).toEqual(['/slow']);
    keepAlive.destroy();
  });

  it('drops event streams at once and stops waiting on stuck requests at the deadline', async () => {
    const { server, port } = await listen((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: hello\n\n');
      }
      // '/stuck' never answers.
    });
    const drain = createHttpDrain([server]);

    const events = new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
        res.once('data', () => resolve({ closed: new Promise((done) => res.once('close', done)) }));
      });
    });
    const { closed: streamClosed } = await events;
    const stuck = request(port, '/stuck');
    await new Promise((r) => setTimeout(r, 20));

    const drained = drain.begin(100);
    await streamClosed;
    expect(await drained).toEqual({ remaining: 1 });

    server.closeAllConnections();
    expect(await stuck).toEqual({ error: 'ECONNRESET' });
  });
});
