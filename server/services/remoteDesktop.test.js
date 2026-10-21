import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createRemoteDesktopBroker } from './remoteDesktop.js';

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
    const client = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/remote-desktop/ws?token=${token}`);
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

  it('revokeAll drops every token and closes live bridges, refusing reconnects', async () => {
    const vncSockets = [];
    const vncServer = createServer((socket) => { vncSockets.push(socket); socket.pipe(socket); });
    servers.push(vncServer);
    await new Promise((resolve) => vncServer.listen(0, '127.0.0.1', resolve));
    const broker = createRemoteDesktopBroker({ port: vncServer.address().port });
    const tokenOf = async () => new URL((await broker.createSession()).viewerPath, 'http://portos.invalid').searchParams.get('token');
    const liveToken = await tokenOf();
    const idleToken = await tokenOf();
    const httpServer = createHttpServer();
    broker.mountWebSocket(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const url = (token) => `ws://127.0.0.1:${httpServer.address().port}/remote-desktop/ws?token=${token}`;
    const client = new WebSocket(url(liveToken));
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const probeCount = vncSockets.length;
    await vi.waitFor(() => expect(vncSockets).toHaveLength(probeCount + 1));
    const bridgeVnc = vncSockets[probeCount];

    const closed = new Promise((resolve) => client.once('close', (code) => resolve(code)));
    broker.revokeAll('PortOS sessions revoked');

    expect(await closed).toBe(1008);
    expect(broker.hasSession(liveToken)).toBe(false);
    expect(broker.hasSession(idleToken)).toBe(false);
    await vi.waitFor(() => expect(bridgeVnc.destroyed).toBe(true));
    const rejected = new WebSocket(url(liveToken));
    const status = await new Promise((resolve) => rejected.once('unexpected-response', (_req, res) => resolve(res.statusCode)));
    expect(status).toBe(401);

    const fresh = await tokenOf();
    const reopened = new WebSocket(url(fresh));
    await new Promise((resolve, reject) => { reopened.once('open', resolve); reopened.once('error', reject); });
    reopened.close();
    await new Promise((resolve) => reopened.once('close', resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('server boot revokes the broker whenever PortOS sessions are revoked', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(source).toMatch(/authEvents\.on\('sessions:revoked-all',[^;]*remoteDesktopBroker\.revokeAll\(/);
  });
});
