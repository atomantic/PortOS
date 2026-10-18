import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UPGRADE_TIMEOUT_MS,
  installUpgradeFallback,
  markUpgradeClaimed,
  mountUpgradeFallback,
} from './upgradeFallback.js';

describe('upgradeFallback', () => {
  const servers = [];
  const sockets = [];

  const listen = async (server) => {
    server.on('connection', (s) => sockets.push(s));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    return server.address().port;
  };

  afterEach(async () => {
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

  it('exports default timeout and aliases', () => {
    expect(DEFAULT_UPGRADE_TIMEOUT_MS).toBe(1000);
    expect(mountUpgradeFallback).toBe(installUpgradeFallback);
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
    installUpgradeFallback(server, { timeoutMs: 50 });
    const port = await listen(server);

    let clientSocket = null;
    await new Promise((resolve) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/unknown-upgrade',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
        },
      });
      req.on('socket', (s) => {
        clientSocket = s;
        sockets.push(s);
      });
      req.on('close', resolve);
      req.on('error', resolve);
      req.end();
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(clientSocket?.destroyed ?? true).toBe(true);
  });

  it('does not end a socket marked portosUpgradeClaimed', async () => {
    const server = createServer();
    let serverSocket = null;
    server.on('upgrade', (_req, socket) => {
      serverSocket = socket;
      markUpgradeClaimed(socket);
    });
    installUpgradeFallback(server, { timeoutMs: 50 });
    const port = await listen(server);

    sendRawUpgrade(port, '/claimed');

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(serverSocket).not.toBeNull();
    expect(serverSocket.destroyed).toBe(false);
    expect(serverSocket.writable).toBe(true);
  });

  it('does not end a socket that has written bytes', async () => {
    const server = createServer();
    let serverSocket = null;
    server.on('upgrade', (_req, socket) => {
      serverSocket = socket;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    installUpgradeFallback(server, { timeoutMs: 50 });
    const port = await listen(server);

    sendRawUpgrade(port, '/socket.io');

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(serverSocket.bytesWritten).toBeGreaterThan(0);
    expect(serverSocket.destroyed).toBe(false);
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
