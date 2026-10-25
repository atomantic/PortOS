import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { createRemoteDesktopBroker } from './remoteDesktop.js';
import { isRemoteRequest } from '../lib/requestOrigin.js';
import { ca, cert, key, rotatedCert } from '../test/fixtures/remoteDesktopTls.js';

vi.mock('../lib/ports.js', () => ({ PORTS: { TAILCAT_INGRESS: 0 } }));
import { configureTailcatIngress, ensureTailcatIngress, stopTailcatIngress } from './tailcatIngress.js';

const cleanups = [];
afterEach(async () => {
  stopTailcatIngress();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listen = async (server) => {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
};

const open = async (url, options = {}) => {
  const client = new WebSocket(url, options);
  cleanups.push(() => client.terminate());
  await once(client, 'open');
  return client;
};

const echo = async (client) => {
  const message = once(client, 'message');
  client.send(Buffer.from('RFB 003.008\n'));
  expect(Buffer.from((await message)[0]).toString()).toBe('RFB 003.008\n');
};

it.each([false, true])('bridges and replaces a managed ingress with isolated teardown (TLS: %s)', async (httpsEnabled) => {
  const sockets = new Set();
  const vnc = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await listen(vnc);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => vnc.close(resolve));
  });
  let now = Date.now();
  const broker = createRemoteDesktopBroker({ port: vnc.address().port, now: () => now, probeFn: async () => true });
  const tokenOf = async () => new URL((await broker.createSession()).viewerPath, 'http://example.invalid').searchParams.get('token');
  const main = createHttpServer();
  const unmountMain = broker.mountWebSocket(main);
  expect(broker.mountWebSocket(main)).toBe(unmountMain);
  await listen(main);
  cleanups.push(async () => {
    unmountMain();
    await new Promise((resolve) => main.close(resolve));
  });
  const mainViewer = await open(`ws://127.0.0.1:${main.address().port}/remote-desktop/ws?token=${await tokenOf()}`);
  await echo(mainViewer);

  let certDir;
  if (httpsEnabled) {
    certDir = await mkdtemp(join(tmpdir(), 'desktop-ingress-'));
    cleanups.push(() => rm(certDir, { recursive: true, force: true }));
    await writeFile(join(certDir, 'cert.pem'), cert);
    await writeFile(join(certDir, 'key.pem'), key);
  }
  const io = new Server({ destroyUpgrade: false });
  cleanups.push(() => new Promise((resolve) => io.close(resolve)));
  const attach = vi.spyOn(io, 'attach');
  const app = (_req, res) => res.end('fixture');
  const config = { app, io, broker, certDir, httpsEnabled };
  configureTailcatIngress(config);
  await Promise.all([ensureTailcatIngress(), ensureTailcatIngress()]);
  expect(attach).toHaveBeenCalledTimes(1);
  const ingress = attach.mock.calls[0][0];
  const remoteUpgrades = [];
  ingress.on('upgrade', (req) => remoteUpgrades.push(isRemoteRequest(req)));
  const wsBase = `${httpsEnabled ? 'wss' : 'ws'}://127.0.0.1:${ingress.address().port}`;
  const tls = httpsEnabled ? { ca } : {};
  const viewer = await open(`${wsBase}/remote-desktop/ws?token=${await tokenOf()}&host=192.0.2.1&port=1`, tls);
  await echo(viewer);
  expect(remoteUpgrades).toEqual([true]);
  const socketIo = await open(`${wsBase}/socket.io/?EIO=4&transport=websocket`, tls);
  expect(remoteUpgrades).toEqual([true, true]);
  await vi.waitFor(() => expect(sockets.size).toBe(2));

  // Normal certificate verification is enabled; rotation must affect new handshakes.
  if (httpsEnabled) {
    const reloaded = vi.spyOn(ingress, 'setSecureContext');
    await writeFile(join(certDir, 'cert.pem'), rotatedCert);
    await vi.waitFor(() => expect(reloaded).toHaveBeenCalled(), { timeout: 3000 });
    const rotated = await open(`${wsBase}/remote-desktop/ws?token=${await tokenOf()}`, tls);
    expect(rotated._socket.getPeerCertificate().serialNumber).toBe('02');
    await echo(rotated);
    const closed = once(rotated, 'close');
    rotated.close();
    await closed;
  }

  const rejected = async (token = '') => {
    const client = new WebSocket(`${wsBase}/remote-desktop/ws?token=${token}`, tls);
    cleanups.push(() => client.terminate());
    const [request, response] = await once(client, 'unexpected-response');
    expect(response.statusCode).toBe(401);
    response.resume();
    request.destroy();
    client.on('error', () => {});
  };
  await rejected();
  const expired = await tokenOf();
  now += 5 * 60 * 1000;
  await rejected(expired);

  const viewerClosed = once(viewer, 'close');
  const socketIoClosed = once(socketIo, 'close');
  const ingressClosed = once(ingress, 'close');
  configureTailcatIngress(config);
  await Promise.all([viewerClosed, socketIoClosed, ingressClosed]);
  await vi.waitFor(() => expect(sockets.size).toBe(1));
  expect(mainViewer.readyState).toBe(WebSocket.OPEN);
  await echo(mainViewer);

  await ensureTailcatIngress();
  await ensureTailcatIngress();
  expect(attach).toHaveBeenCalledTimes(2);
  const replacement = attach.mock.calls[1][0];
  const newBase = `${httpsEnabled ? 'wss' : 'ws'}://127.0.0.1:${replacement.address().port}`;
  const revoked = await tokenOf();
  broker.revokeAll();
  const denied = new WebSocket(`${newBase}/remote-desktop/ws?token=${revoked}`, tls);
  cleanups.push(() => denied.terminate());
  const [request, response] = await once(denied, 'unexpected-response');
  expect(response.statusCode).toBe(401);
  response.resume();
  request.destroy();
  denied.on('error', () => {});
  const fresh = await open(`${newBase}/remote-desktop/ws?token=${await tokenOf()}`, tls);
  await echo(fresh);
  const freshClosed = once(fresh, 'close');
  const replacementClosed = once(replacement, 'close');
  stopTailcatIngress();
  await Promise.all([freshClosed, replacementClosed]);
  await vi.waitFor(() => expect(sockets.size).toBe(0));
});

it('cancels a starting listener without letting its rejection stop the replacement, then retries failed attachment', async () => {
  const io = { attach: vi.fn() };
  const config = { app: (_req, res) => res.end(), io, httpsEnabled: false };
  configureTailcatIngress(config);
  const cancelled = expect(ensureTailcatIngress()).rejects.toThrow('stopped during startup');
  stopTailcatIngress();
  const replacement = ensureTailcatIngress();
  await cancelled;
  await replacement;
  expect(io.attach).toHaveBeenCalledTimes(1);
  expect(io.attach.mock.calls[0][0].listening).toBe(true);
  stopTailcatIngress();

  io.attach.mockImplementationOnce(() => { throw new Error('fixture attachment failed'); });
  await expect(ensureTailcatIngress()).rejects.toThrow('fixture attachment failed');
  await ensureTailcatIngress();
  expect(io.attach.mock.calls.at(-1)[0].listening).toBe(true);
});
