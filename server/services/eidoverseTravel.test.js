import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';

const mocks = vi.hoisted(() => ({ peers: [], feature: true, protocol: true, connections: [], admission: vi.fn() }));
vi.mock('./instances.js', () => ({ getPeers: async () => mocks.peers, getInstanceId: async () => 'origin-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./instanceFeatures.js', () => ({ getInstanceFeatures: async () => ({ features: [{ id: 'eidoverse', enabled: mocks.feature }] }) }));
vi.mock('./eidoverseHost.js', () => ({ ensureEidoverseHost: async () => ({ protocol: 'http', port: 5563, running: true }) }));
vi.mock('./eidoverseWorld.js', () => ({ supportsEidoverseGuestEntry: async () => mocks.protocol, getEidoverseWorldStatus: async () => ({ setup: { installed: true, runtimeStatus: 'online', worldDataReady: true }, cos: { enabled: true } }), admitEidoverseGuest: (...args) => mocks.admission(...args) }));

import router from '../routes/eidoverseTravelRoutes.js';
import { eidoversePeerId } from './eidoverseWorldSources.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { eidoverseVisitChat, getEidoverseGuestDescriptor, leaveEidoversePeer, listEidoverseDestinations, receiveEidoverseChat, receiveEidoverseLeave, visitEidoversePeer } from './eidoverseTravel.js';

let server;
let base;
let destination;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/eidoverse/travel', router);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/eidoverse/travel`;
});
afterAll(async () => {
  if (!server) return;
  server.close();
  await once(server, 'close');
});
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.feature = true;
  mocks.protocol = true;
  destination = { id: 'destination-peer', instanceId: 'destination-instance', address: '127.0.0.1', port: server.address().port, name: 'Example destination', status: 'online', enabled: true };
  mocks.peers = [destination, { id: 'origin-peer', instanceId: 'origin-instance', status: 'offline', enabled: true }];
  mocks.admission.mockReset().mockImplementation(async ({ agent }) => {
    const messages = [];
    const identity = { world: 'example-world', name: 'guest-example', avatar: 'eidoverse/assets/vrms/claude.vrm' };
    const connection = {
      isOpen: () => true,
      sendVerb: vi.fn(async (_verb, { text }) => { messages.push({ seq: messages.length, actor: identity.name, text }); }),
      readChat: (after) => {
        const unread = messages.filter((message) => message.seq > after);
        return { messages: unread, cursor: unread.at(-1)?.seq ?? after, hasMore: false, truncated: false };
      },
      close: vi.fn(async () => {}), messages,
    };
    mocks.connections.push(connection);
    return { identity, ...(agent ? { connection } : {}) };
  });
});
const post = (path, body, instanceId = 'origin-instance') => fetch(`${base}/federation${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PortOS-Instance-Id': instanceId }, body: JSON.stringify(body),
});

describe('registered-peer Eidoverse guest workflow over HTTP', () => {
  it('discovers a destination, joins as a visitor, exchanges live chat, and leaves', async () => {
    const peerId = eidoversePeerId(destination);
    expect(await listEidoverseDestinations()).toEqual({ destinations: [{ peerId, label: 'Example destination' }] });
    const visit = await visitEidoversePeer({ peerId });
    expect(mocks.admission).toHaveBeenCalledWith({ agent: true });
    const sent = await eidoverseVisitChat({ visitId: visit.visitId, text: 'Hello from the example visitor.' });
    expect(sent.messages).toEqual([{ seq: 0, actor: 'guest-example', text: 'Hello from the example visitor.' }]);
    const connection = mocks.connections.at(-1);
    connection.messages.push({ seq: 1, actor: 'example-resident', text: 'Welcome to the example world.' });
    expect(await eidoverseVisitChat({ visitId: visit.visitId, after: sent.cursor })).toMatchObject({ messages: [{ seq: 1, text: 'Welcome to the example world.' }], cursor: 1 });
    await leaveEidoversePeer({ visitId: visit.visitId });
    expect(connection.close).toHaveBeenCalledOnce();
    await expect(eidoverseVisitChat({ visitId: visit.visitId })).rejects.toMatchObject({ status: 404 });
  });

  it('limits browser tickets to visitor metadata and pins agent sessions to the originating peer', async () => {
    const { url } = await visitEidoversePeer({ peerId: eidoversePeerId(destination), agent: false });
    const ticket = new URL(url).hash.slice(1);
    expect(new URL(url).pathname).toBe('/eidoverse/guest');
    const response = await fetch(`${base}/guest`, { headers: { 'X-Eidoverse-Guest': ticket } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      identity: { world: 'example-world', name: 'guest-example', avatar: 'eidoverse/assets/vrms/claude.vrm' },
      host: { protocol: 'http', port: 5563, running: true }, expiresAt: expect.any(Number),
    });
    await expect(receiveEidoverseChat('origin-instance', { sessionId: ticket, text: 'No agent connection' })).rejects.toMatchObject({ status: 409 });
    const admission = await (await post('/visit', { agent: true })).json();
    await expect(getEidoverseGuestDescriptor(admission.sessionId)).rejects.toMatchObject({ status: 404 });
    await expect(receiveEidoverseChat('destination-instance', { sessionId: admission.sessionId, text: 'Wrong peer' })).rejects.toMatchObject({ status: 404 });
    expect((await post('/visit', { agent: true }, 'unregistered-instance')).status).toBe(403);
    expect((await post('/chat', { sessionId: admission.sessionId, text: 'x'.repeat(2001) })).status).toBe(400);
    await receiveEidoverseLeave('origin-instance', { sessionId: admission.sessionId });
    await receiveEidoverseLeave('origin-instance', { sessionId: ticket });
  });

  it('rechecks revocation, expiry, feature availability, and renderer compatibility', async () => {
    const visit = await visitEidoversePeer({ peerId: eidoversePeerId(destination) });
    destination.enabled = false;
    await expect(eidoverseVisitChat({ visitId: visit.visitId, text: 'Must not send' })).rejects.toMatchObject({ status: 403 });
    destination.enabled = true;
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    await expect(eidoverseVisitChat({ visitId: visit.visitId })).rejects.toMatchObject({ status: 404 });
    time.mockRestore();
    await leaveEidoversePeer({ visitId: visit.visitId });
    expect(mocks.connections.at(-1).sendVerb).not.toHaveBeenCalled();
    mocks.protocol = false;
    await expect(listEidoverseDestinations()).rejects.toMatchObject({ status: 409 });
    mocks.protocol = true;
    mocks.feature = false;
    expect(await (await fetch(`${base}/federation/capabilities`)).json()).toEqual({ version: 1, available: false });
    expect((await post('/visit', { agent: true })).status).toBe(409);
    mocks.feature = true;
  });
});
