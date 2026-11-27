import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { logSecurityEvent } from '../lib/securityAuditLog.js';
import { createRemoteDesktopBroker } from './remoteDesktop.js';
import { registerSessionRevocation } from '../sessionRevocation.js';

vi.mock('../lib/securityAuditLog.js', () => ({ logSecurityEvent: vi.fn() }));

const servers = [];

const listen = async () => {
  const server = createServer();
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('remote desktop broker', () => {
  it('reports whether a loopback VNC server is configured', async () => {
    const port = await listen();
    const broker = createRemoteDesktopBroker({ port });

    await expect(broker.status()).resolves.toMatchObject({ configured: true, port });
  });

  it('issues short-lived viewer paths only after a successful VNC probe', async () => {
    const port = await listen();
    const broker = createRemoteDesktopBroker({ port, now: () => 1_000 });

    const session = await broker.createSession();

    expect(session.viewerPath).toMatch(/^\/remote-desktop\?token=[A-Za-z0-9_-]+$/);
    expect(session.expiresAt).toBe(new Date(1_000 + 5 * 60 * 1000).toISOString());
    const token = new URL(session.viewerPath, 'http://portos.invalid').searchParams.get('token');
    expect(broker.hasSession(token)).toBe(true);
    expect(broker.hasSession('not-a-session-token')).toBe(false);
  });

  it('probes reachability through the injected probeFn, at the timeout this caller sets', async () => {
    // The probe and the VNC data socket are two separate seams (#6451). A refactor
    // that folds them together drops one of them silently: the bridge keeps
    // working while reachability stops being injectable, or vice versa. Pin the
    // probe seam here — including the 750ms budget, which is deliberately NOT the
    // 500ms isPortReachable default nor the eidoverse bridge's 300ms.
    const probeFn = vi.fn().mockResolvedValue(false);
    const broker = createRemoteDesktopBroker({ port: 5900, probeFn });

    await expect(broker.createSession()).rejects.toMatchObject({ code: 'VNC_NOT_CONFIGURED' });
    expect(probeFn).toHaveBeenCalledWith({ host: '127.0.0.1', port: 5900, timeoutMs: 750 });
  });

  it('refuses sessions when no loopback VNC server is listening', async () => {
    const temporaryServer = createServer();
    await new Promise((resolve) => temporaryServer.listen(0, '127.0.0.1', resolve));
    const port = temporaryServer.address().port;
    await new Promise((resolve) => temporaryServer.close(resolve));

    const broker = createRemoteDesktopBroker({ port });
    await expect(broker.createSession()).rejects.toMatchObject({ code: 'VNC_NOT_CONFIGURED' });
  });

  it.each([
    ['localhost', 'https://example.invalid', 'CROSS_ORIGIN_BLOCKED'],
    ['example.invalid', 'https://example.invalid', 'HOST_NOT_ALLOWED'],
  ])('refuses browser upgrades for Host %s and Origin %s before session lookup', async (host, origin, code) => {
    const now = vi.fn(() => 1000);
    const connect = vi.fn();
    const broker = createRemoteDesktopBroker({ connect, now, probeFn: async () => true });
    const { viewerPath } = await broker.createSession();
    const token = new URL(viewerPath, 'http://portos.invalid').searchParams.get('token');
    const server = createHttpServer();
    const unmount = broker.mountWebSocket(server);
    const socket = { write: vi.fn(), destroy: vi.fn() };
    now.mockClear();

    server.emit('upgrade', {
      url: `/remote-desktop/ws?token=${token}`,
      method: 'GET',
      headers: { host, origin },
      socket,
    }, socket, Buffer.alloc(0));
    unmount();

    expect(socket.portosUpgradeClaimed).toBe(true);
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(now).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(logSecurityEvent).toHaveBeenLastCalledWith('remote-desktop.refused', {
      refused: true, code, ip: undefined, method: 'GET', path: '/remote-desktop/ws', origin, host,
    });
  });

  it('bridges binary WebSocket frames to the loopback VNC socket', async () => {
    const vncServer = createServer((socket) => socket.pipe(socket));
    servers.push(vncServer);
    await new Promise((resolve) => vncServer.listen(0, '127.0.0.1', resolve));
    const broker = createRemoteDesktopBroker({ port: vncServer.address().port });
    const session = await broker.createSession();
    const token = new URL(session.viewerPath, 'http://portos.invalid').searchParams.get('token');
    const httpServer = createHttpServer();
    broker.mountWebSocket(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${httpServer.address().port}`;
    const client = new WebSocket(`ws://${host}/remote-desktop/ws?token=${token}`, { origin: `http://${host}` });
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    const echoed = new Promise((resolve) => client.once('message', resolve));
    client.send(Buffer.from('RFB 003.008\n'));

    expect(Buffer.from(await echoed).toString()).toBe('RFB 003.008\n');
    client.close();
    await new Promise((resolve) => client.once('close', resolve));
    await vi.waitFor(() => expect(broker.hasSession(token)).toBe(true));

    const reconnected = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/remote-desktop/ws?token=${token}`);
    await new Promise((resolve, reject) => {
      reconnected.once('open', resolve);
      reconnected.once('error', reject);
    });
    reconnected.close();
    await new Promise((resolve) => reconnected.once('close', resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('closes an active connection when its maximum session lifetime elapses', async () => {
    const vncServer = createServer((socket) => socket.pipe(socket));
    servers.push(vncServer);
    await new Promise((resolve) => vncServer.listen(0, '127.0.0.1', resolve));
    const broker = createRemoteDesktopBroker({
      port: vncServer.address().port,
      connectedSessionTtlMs: 25,
    });
    const session = await broker.createSession();
    const token = new URL(session.viewerPath, 'http://portos.invalid').searchParams.get('token');
    const httpServer = createHttpServer();
    broker.mountWebSocket(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/remote-desktop/ws?token=${token}`);

    const close = new Promise((resolve, reject) => {
      client.once('close', resolve);
      client.once('error', reject);
    });
    await close;

    await vi.waitFor(() => expect(broker.hasSession(token)).toBe(false));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('drops every token and closes live bridges when PortOS sessions are revoked', async () => {
    const vncSockets = [];
    const vncServer = createServer((socket) => { vncSockets.push(socket); socket.pipe(socket); });
    servers.push(vncServer);
    await new Promise((resolve) => vncServer.listen(0, '127.0.0.1', resolve));
    const broker = createRemoteDesktopBroker({ port: vncServer.address().port, probeFn: async () => true });
    const tokenOf = async () => new URL((await broker.createSession()).viewerPath, 'http://portos.invalid').searchParams.get('token');
    const liveToken = await tokenOf();
    const idleToken = await tokenOf();
    const httpServer = createHttpServer();
    servers.push(httpServer);
    const unmount = broker.mountWebSocket(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

    const nextEvent = (client, event) => once(client, event, { signal: AbortSignal.timeout(3000) });
    const url = (token) => `ws://127.0.0.1:${httpServer.address().port}/remote-desktop/ws?token=${token}`;
    try {
      const client = new WebSocket(url(liveToken));
      await nextEvent(client, 'open');
      await vi.waitFor(() => expect(vncSockets).toHaveLength(1));
      const [bridgeVnc] = vncSockets;

      const authEvents = new EventEmitter();
      registerSessionRevocation({ authEvents, remoteDesktopBroker: broker, revokeAllHostedSessions: vi.fn() });
      const closed = nextEvent(client, 'close');
      authEvents.emit('sessions:revoked-all');

      const [code, reason] = await closed;
      expect(code).toBe(1008);
      expect(reason.toString()).toBe('PortOS sessions revoked');
      expect(broker.hasSession(liveToken)).toBe(false);
      expect(broker.hasSession(idleToken)).toBe(false);
      await vi.waitFor(() => expect(bridgeVnc.destroyed).toBe(true));

      const rejected = new WebSocket(url(liveToken));
      const [, response] = await nextEvent(rejected, 'unexpected-response');
      response.resume();
      expect(response.statusCode).toBe(401);

      const reopened = new WebSocket(url(await tokenOf()));
      await nextEvent(reopened, 'open');
      const reopenedClosed = nextEvent(reopened, 'close');
      reopened.close();
      await reopenedClosed;
    } finally {
      unmount();
    }
  });
});
