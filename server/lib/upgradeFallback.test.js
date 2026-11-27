import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UPGRADE_TIMEOUT_MS,
  installUpgradeFallback,
  markUpgradeClaimed,
} from './upgradeFallback.js';

describe('upgradeFallback', () => {
  const servers = [];
  const sockets = [];
  const timeoutMs = 10;

  const listen = async (server) => {
    server.on('connection', (s) => sockets.push(s));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    return server.address().port;
  };

  afterEach(async () => {
    vi.useRealTimers();
    while (sockets.length > 0) {
      const socket = sockets.pop();
      try {
        socket?.destroy();
      } catch {}
    }
    while (servers.length > 0) {
      const server = servers.pop();
      server.closeAllConnections?.();
      await new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  });

  const sendRawUpgrade = (port, path = '/unclaimed') => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
      },
    });
    req.on('upgrade', (_res, socket) => {
      sockets.push(socket);
    });
    req.on('socket', (socket) => {
      sockets.push(socket);
    });
    req.on('error', () => {});
    req.end();
    return req;
  };

  it('exports the default timeout', () => {
    expect(DEFAULT_UPGRADE_TIMEOUT_MS).toBe(1000);
  });

  it('handles null or invalid server gracefully', () => {
    const cleanup1 = installUpgradeFallback(null);
    expect(typeof cleanup1).toBe('function');
    cleanup1();

    const cleanup2 = installUpgradeFallback({});
    expect(typeof cleanup2).toBe('function');
    cleanup2();
  });

  it('ends an unclaimed upgrade socket after timeout', async () => {
    const server = createServer();
    installUpgradeFallback(server, { timeoutMs });
    const port = await listen(server);

    const upgraded = once(server, 'upgrade');
    const req = sendRawUpgrade(port);
    const closed = new Promise(resolve => req.once('close', resolve));
    await upgraded;
    await closed;
    expect(req.socket.destroyed).toBe(true);
  });

  it('does not end a socket marked portosUpgradeClaimed', async () => {
    const server = createServer();
    server.on('upgrade', (_req, socket) => {
      markUpgradeClaimed(socket);
    });
    installUpgradeFallback(server, { timeoutMs });
    const port = await listen(server);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const upgraded = once(server, 'upgrade');
    sendRawUpgrade(port, '/claimed');
    const [, serverSocket] = await upgraded;

    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(serverSocket.destroyed).toBe(false);
    expect(serverSocket.writable).toBe(true);
    expect(serverSocket.writableEnded).toBe(false);
  });

  it('does not end a socket that has written bytes', async () => {
    const server = createServer();
    server.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    installUpgradeFallback(server, { timeoutMs });
    const port = await listen(server);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const upgraded = once(server, 'upgrade');
    await once(sendRawUpgrade(port, '/socket.io'), 'upgrade');
    const [, serverSocket] = await upgraded;

    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(serverSocket.bytesWritten).toBeGreaterThan(0);
    expect(serverSocket.destroyed).toBe(false);
    expect(serverSocket.writableEnded).toBe(false);
  });

  it('ends an unclaimed upgrade even on a keep-alive socket with previous bytesWritten', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': '4', Connection: 'keep-alive' });
      res.end('pong');
    });
    installUpgradeFallback(server, { timeoutMs });
    const port = await listen(server);

    const { createConnection } = await import('node:net');
    const socket = createConnection({ host: '127.0.0.1', port });
    sockets.push(socket);
    await once(socket, 'connect');

    // First, complete an ordinary HTTP request over the connection
    socket.write('GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    await once(socket, 'data');

    // Next, send an unclaimed upgrade over the same keep-alive socket
    const closed = once(socket, 'close');
    socket.write('GET /unclaimed HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');

    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it('prevents duplicate installation and cleans up properly', async () => {
    const server = createServer();
    const cleanup1 = installUpgradeFallback(server);
    const countBefore = server.listenerCount('upgrade');
    const cleanup2 = installUpgradeFallback(server);
    expect(server.listenerCount('upgrade')).toBe(countBefore);

    cleanup1();
    expect(server.listenerCount('upgrade')).toBe(countBefore - 1);
    cleanup2();
  });
});
