import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../lib/ports.js', () => ({ PORTS: { TAILCAT_INGRESS: 0 } }));
import { configureTailcatIngress, createTailcatIngressServer, ensureTailcatIngress, stopTailcatIngress } from './tailcatIngress.js';
import { isRemoteRequest } from '../lib/requestOrigin.js';

afterEach(() => stopTailcatIngress());

it('refuses a plaintext fallback when the main API is using HTTPS', () => {
  expect(() => createTailcatIngressServer(() => {}, { httpsEnabled: true }))
    .toThrow('Tailcat ingress requires the active API TLS certificate');
  const plain = createTailcatIngressServer(() => {}, { httpsEnabled: false });
  expect(plain.httpsEnabled).toBe(false);
  expect(plain.mirror).toBe(null);
});

it('binds one loopback listener on demand and marks requests independently of headers', async () => {
  const io = { attach: vi.fn() };
  configureTailcatIngress({ app: (req, res) => res.end(JSON.stringify({ remote: isRemoteRequest(req) })), io });
  expect(io.attach).not.toHaveBeenCalled();
  await Promise.all([ensureTailcatIngress(), ensureTailcatIngress()]);
  expect(io.attach).toHaveBeenCalledTimes(1);
  const server = io.attach.mock.calls[0][0];
  expect(server.address().address).toBe('127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { 'X-PortOS-Local': 'true' } });
  expect(await response.json()).toEqual({ remote: true });
  await ensureTailcatIngress();
  expect(io.attach).toHaveBeenCalledTimes(1);
});

it('marks the handshake requests Socket.IO intercepts before the app handler', async () => {
  // Mirrors engine.io's attach: it replaces the server's request listeners and
  // answers its own path itself, and takes the websocket upgrade directly.
  const io = {
    attach: vi.fn((server) => {
      const listeners = server.listeners('request').slice(0);
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        if (req.url.startsWith('/socket.io/')) return res.end(JSON.stringify({ remote: isRemoteRequest(req) }));
        for (const listener of listeners) listener.call(server, req, res);
      });
      server.on('upgrade', (req, socket) => {
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ remote: isRemoteRequest(req) })}`);
      });
    }),
  };
  configureTailcatIngress({ app: (req, res) => res.end(JSON.stringify({ remote: isRemoteRequest(req), app: true })), io });
  await ensureTailcatIngress();
  const { port } = io.attach.mock.calls[0][0].address();
  const polling = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`);
  expect(await polling.json()).toEqual({ remote: true });
  const plain = await fetch(`http://127.0.0.1:${port}/api/system/health`);
  expect(await plain.json()).toEqual({ remote: true, app: true });

  const { connect } = await import('node:net');
  const upgrade = await new Promise((resolve, reject) => {
    const client = connect(port, '127.0.0.1', () => {
      client.write('GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    let raw = '';
    client.on('data', (chunk) => { raw += chunk; });
    client.on('end', () => resolve(raw));
    client.on('error', reject);
  });
  expect(JSON.parse(upgrade.slice(upgrade.indexOf('\r\n\r\n') + 4))).toEqual({ remote: true });
});
