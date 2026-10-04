import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'peer-admin-' });
vi.mock('../lib/fileUtils.js', async () => ({
  ...makeProxy(await vi.importActual('../lib/fileUtils.js')),
  dataPath: (...segments) => join(tempRoot, ...segments),
}));
const auth = vi.hoisted(() => ({ enabled: true }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => auth.enabled,
  verifyRequestSession: async req => req.headers.authorization === 'Bearer test-operator',
  verifyPassword: async () => true,
}));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}), settingsEvents: new EventEmitter() }));
vi.mock('../lib/peerHttpClient.js', async () => ({
  ...await vi.importActual('../lib/peerHttpClient.js'), peerFetch: vi.fn(),
}));
// Any accidental executor integration fails the no-active-interruption contract.
const execution = vi.hoisted(() => ({ update: vi.fn(), restart: vi.fn(), install: vi.fn() }));
vi.mock('../services/portosSelfUpdate.js', () => ({ startPortosSelfUpdate: execution.update }));
vi.mock('../services/localLlm.js', () => ({ installModel: execution.install }));
vi.mock('../services/pm2.js', () => ({ restartProcess: execution.restart }));

const { authGate, hostControlRouteGate } = await import('../services/authGate.js');
const { default: receiver } = await import('./peerAdministration.js');
const { default: peerAdminOperatorRoutes } = await import('./peerAdminOperator.js');
const { errorMiddleware } = await import('../lib/errorHandler.js');
const { derivePeerAuthToken, peerFetch } = await import('../lib/peerHttpClient.js');
const { signPeerAdmin } = await import('../services/peerAdministration.js');

const ROOT = '/api/federation/admin/v1';
let identity;
const app = express();
app.use((req, _res, next) => {
  Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.20', configurable: true });
  next();
});
app.use(express.json());
app.use(authGate);
app.use(hostControlRouteGate);
app.use(ROOT, receiver);
app.use('/api/peer-administration', peerAdminOperatorRoutes);
app.post('/api/update/execute', (_req, res) => res.json({ unexpected: true }));
app.use(errorMiddleware);

const persistIdentity = () => writeFileSync(join(tempRoot, 'instances.json'), JSON.stringify(identity));
const operator = (path, body) => request(app).post(path).set('Authorization', 'Bearer test-operator').send(body);
const peerRequest = (endpoint, body, peer = identity.peers[0]) => request(app).post(`${ROOT}/${endpoint}`)
  .set('X-PortOS-Instance-Id', peer.instanceId)
  .set('X-PortOS-Peer-Auth', derivePeerAuthToken(peer.syncSecret, peer.instanceId)).send(body);
const intent = { action: 'portos.restart' };
async function grant(action = intent.action, extra = {}) {
  return operator('/api/peer-administration/grants', {
    peerId: identity.peers[0].id, action,
    confirmedHostInstanceId: identity.self.instanceId, confirmedPeerInstanceId: identity.peers[0].instanceId,
    previousGrantId: null, expiresInMinutes: 60, allowPlanning: true, ...extra,
  });
}
async function preflight(target = intent) {
  const response = await peerRequest('preflight', { protocolVersion: 1, challenge: randomUUID(), intent: target });
  expect(response.status).toBe(200);
  return response.body.payload;
}
async function plan(target = intent) {
  const snapshot = await preflight(target);
  const input = { protocolVersion: 1, requestId: randomUUID(), preflightId: snapshot.preflightId, grantId: snapshot.grantId, intent: target };
  const response = await peerRequest('plans', input);
  expect(response.status).toBe(200);
  return { input, receipt: response.body.payload };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  auth.enabled = true;
  identity = { self: { instanceId: randomUUID() }, peers: [
    { id: randomUUID(), instanceId: randomUUID(), name: 'Example peer', enabled: true, syncSecret: 'a'.repeat(64), address: '192.0.2.10', port: 5555 },
    { id: randomUUID(), instanceId: randomUUID(), name: 'Example peer', enabled: true, syncSecret: 'b'.repeat(64) },
  ] };
  persistIdentity();
  writeFileSync(join(tempRoot, 'peer-admin-grants.json'), JSON.stringify({ schemaVersion: 1, grants: [] }));
});
afterAll(cleanup);

describe('bounded administration through the real authority boundary', () => {
  it('defaults to deny and never elevates a peer to existing host control', async () => {
    const body = { protocolVersion: 1, challenge: randomUUID(), intent };
    expect((await peerRequest('preflight', body)).body.code).toBe('PEER_ADMIN_GRANT_REQUIRED');
    expect((await grant()).status).toBe(200);
    const peer = identity.peers[0];
    const denied = await request(app).post('/api/update/execute')
      .set('X-PortOS-Instance-Id', peer.instanceId)
      .set('X-PortOS-Peer-Auth', derivePeerAuthToken(peer.syncSecret, peer.instanceId)).send({});
    expect(denied.body.code).toBe('PEER_SCOPE_FORBIDDEN');
    expect((await peerRequest('preflight', body, identity.peers[1])).body.code).toBe('PEER_ADMIN_GRANT_REQUIRED');
    expect((await peerRequest('preflight', { ...body, intent: { action: 'portos.update' } })).body.code).toBe('PEER_ADMIN_GRANT_REQUIRED');
  });

  it('refuses anonymous, Basic, forged and peer setup callers with password on and off', async () => {
    for (const enabled of [true, false]) {
      auth.enabled = enabled;
      const body = { protocolVersion: 1, challenge: randomUUID(), intent };
      expect((await request(app).post(`${ROOT}/preflight`).send(body)).status).toBe(enabled ? 401 : 403);
      expect((await request(app).post(`${ROOT}/preflight`).set('Authorization', 'Basic OnBhc3M=').send(body)).status).toBe(403);
      expect((await request(app).post(`${ROOT}/preflight`).set('X-PortOS-Instance-Id', identity.peers[0].instanceId)
        .set('X-PortOS-Peer-Auth', 'forged').send(body)).status).toBe(enabled ? 401 : 403);
      const peer = identity.peers[0];
      const setup = await request(app).post('/api/peer-administration/grants')
        .set('X-PortOS-Instance-Id', peer.instanceId)
        .set('X-PortOS-Peer-Auth', derivePeerAuthToken(peer.syncSecret, peer.instanceId)).send({});
      expect(setup.status).toBe(403);
    }
  });

  it('requires exact operator-confirmed identities and CAS, redacts pair binding', async () => {
    expect((await grant(intent.action, { confirmedPeerInstanceId: identity.peers[1].instanceId })).body.code).toBe('PEER_ADMIN_IDENTITY_CHANGED');
    const saved = await grant();
    expect(saved.body.executionSupported).toBe(false);
    expect(saved.body.actions.find(row => row.action === intent.action).grant.authority).toBe('operator-session');
    expect(JSON.stringify(saved.body)).not.toContain('pairBinding');
    expect((await grant()).body.code).toBe('PEER_ADMIN_GRANT_CHANGED');
  });

  it('binds preflight to a single action, grant, identity and short lifetime', async () => {
    await grant();
    const snapshot = await preflight();
    const input = { protocolVersion: 1, requestId: randomUUID(), preflightId: snapshot.preflightId, grantId: snapshot.grantId, intent };
    const changed = await grant(intent.action, { previousGrantId: snapshot.grantId });
    expect(changed.status).toBe(200);
    expect((await peerRequest('plans', input)).body.code).toBe('PEER_ADMIN_GRANT_CHANGED');
    const next = await preflight();
    vi.spyOn(Date, 'now').mockReturnValue(next.expiresAt + 1);
    expect((await peerRequest('plans', { ...input, preflightId: next.preflightId, grantId: next.grantId })).body.code).toBe('PEER_ADMIN_PREFLIGHT_STALE');
  });

  it('suspends disabled peers and invalidates rotated pair credentials and grants', async () => {
    await grant();
    const old = structuredClone(identity.peers[0]);
    identity.peers[0].enabled = false;
    persistIdentity();
    expect((await peerRequest('preflight', { protocolVersion: 1, challenge: randomUUID(), intent }, old)).status).toBe(401);
    identity.peers[0].enabled = true;
    identity.peers[0].syncSecret = 'c'.repeat(64);
    persistIdentity();
    expect((await peerRequest('preflight', { protocolVersion: 1, challenge: randomUUID(), intent })).body.code).toBe('PEER_ADMIN_GRANT_REQUIRED');
  });

  it('reconciles identical retries, rejects changed replay and challenge reuse, and isolates receipts', async () => {
    await grant();
    const { input, receipt } = await plan();
    expect(receipt).toMatchObject({ state: 'planned', queued: false, inFlight: false, executionSupported: false });
    expect((await peerRequest('plans', input)).body.payload).toEqual(receipt);
    expect((await peerRequest('plans', { ...input, preflightId: randomUUID() })).body.code).toBe('PEER_ADMIN_REPLAY');
    expect((await peerRequest('plans', { ...input, requestId: randomUUID() })).body.code).toBe('PEER_ADMIN_PREFLIGHT_STALE');
    expect((await peerRequest('receipt', { requestId: input.requestId }, identity.peers[1])).status).toBe(404);
    const snapshot = await preflight();
    expect((await peerRequest('preflight', { protocolVersion: 1, challenge: snapshot.challenge, intent })).body.code).toBe('PEER_ADMIN_REPLAY');
    await grant(intent.action, { previousGrantId: input.grantId, allowPlanning: false });
    expect((await peerRequest('receipt', { requestId: input.requestId })).body.code).toBe('PEER_ADMIN_GRANT_REQUIRED');
  });

  it('rejects unsupported actions, free-form targets, injected inputs and gated catalog entries', async () => {
    for (const target of [ { action: 'shell', command: 'echo injected' }, { ...intent, path: '/tmp/anything' },
      { action: 'portos.update', tag: 'v1; echo injected' },
      { action: 'catalog.install', backend: 'ollama', catalogKey: '../../model' },
      { action: 'catalog.install', backend: 'ollama', catalogKey: 'example', url: 'https://example.com/code' } ]) {
      expect((await peerRequest('preflight', { protocolVersion: 1, challenge: randomUUID(), intent: target })).status).toBe(400);
    }
    await grant('catalog.install');
    expect((await peerRequest('preflight', { protocolVersion: 1, challenge: randomUUID(),
      intent: { action: 'catalog.install', backend: 'ollama', catalogKey: 'does-not-exist' } })).body.code).toBe('PEER_ADMIN_UNKNOWN_MODEL');
    expect((await peerRequest('preflight', { protocolVersion: 1, challenge: randomUUID(),
      intent: { action: 'catalog.install', backend: 'ollama', catalogKey: 'gemma3-4b-it' } })).body.code).toBe('PEER_ADMIN_MODEL_UNSUPPORTED');
    const model = await preflight({ action: 'catalog.install', backend: 'ollama', catalogKey: 'phi-4-mini' });
    expect(model.model).toMatchObject({ modelId: 'phi4-mini', sourceLicenseReview: 'required-locally' });
    expect(model.resources).toMatchObject({ destinationDiskChecked: false, runtimeMemoryChecked: false });
    expect(model.blockers).toContain('MODEL_SOURCE_LICENSE_REVIEW_REQUIRED');
  });

  it('cannot dispatch or interrupt active work because all executors remain unavailable', async () => {
    for (const action of ['portos.update', 'portos.restart']) {
      await grant(action);
      const { input } = await plan({ action });
      expect((await peerRequest('execute', { requestId: input.requestId })).body.code).toBe('PEER_ADMIN_EXECUTION_UNAVAILABLE');
    }
    expect(execution.update).not.toHaveBeenCalled();
    expect(execution.restart).not.toHaveBeenCalled();
    expect(execution.install).not.toHaveBeenCalled();
    expect(peerFetch).not.toHaveBeenCalled();
  });

  it('fails closed on unknown policy schemas instead of resetting grants', async () => {
    writeFileSync(join(tempRoot, 'peer-admin-grants.json'), '{"schemaVersion":99,"grants":[]}');
    const response = await grant();
    expect(response.body.code).toBe('PEER_ADMIN_STORE_UNAVAILABLE');
    expect(readFileSync(join(tempRoot, 'peer-admin-grants.json'), 'utf8')).toContain('99');
  });

  it('permits revocation while disabled and expires receipts without restarting work', async () => {
    await grant();
    const { input, receipt } = await plan();
    identity.peers[0].enabled = false;
    persistIdentity();
    expect((await grant(intent.action, { previousGrantId: input.grantId, allowPlanning: false })).status).toBe(200);
    identity.peers[0].enabled = true;
    persistIdentity();
    vi.spyOn(Date, 'now').mockReturnValue(receipt.expiresAt + 1);
    expect((await peerRequest('receipt', { requestId: input.requestId })).body.code).toBe('PEER_ADMIN_PLAN_NOT_FOUND');
    expect(execution.restart).not.toHaveBeenCalled();
  });

  it('completes only the signed preview exchange and does not retry an uncertain response', async () => {
    const preflightId = randomUUID();
    const grantId = randomUUID();
    peerFetch.mockImplementation(async (url, options, peer) => {
      const input = JSON.parse(options.body);
      const purpose = url.endsWith('/preflight') ? 'preflight' : 'plan';
      const payload = { protocolVersion: 1, scope: 'planning-v1',
        targetInstanceId: peer.instanceId, senderInstanceId: identity.self.instanceId,
        expiresAt: Date.now() + 60000, executionSupported: false, version: '1.0.0',
        preflightId, grantId, intent: input.intent,
        ...(purpose === 'preflight' ? { challenge: input.challenge, observedAt: Date.now() }
          : { requestId: input.requestId, state: 'planned', queued: false, inFlight: false }) };
      return { ok: true, json: async () => ({ payload, signature: signPeerAdmin(peer, purpose, payload) }) };
    });
    const response = await operator('/api/peer-administration/preview', { peerId: identity.peers[0].id, intent });
    expect(response.status).toBe(200);
    expect(response.body.plan).toMatchObject({ state: 'planned', queued: false, inFlight: false });
    expect(peerFetch).toHaveBeenCalledTimes(2);
    expect(peerFetch.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['preflight', 'plans']);
    peerFetch.mockClear().mockRejectedValueOnce(new Error('timeout with a private network path'));
    const failed = await operator('/api/peer-administration/preview', { peerId: identity.peers[0].id, intent });
    expect(failed.body.code).toBe('PEER_ADMIN_UNAVAILABLE');
    expect(JSON.stringify(failed.body)).not.toContain('private network path');
    expect(peerFetch).toHaveBeenCalledTimes(1);
  });

  it('requires signed fresh remote identity and sends only the scoped pair credential', async () => {
    peerFetch.mockImplementation(async (_url, options, peer) => {
      expect(peer.auth).toBeNull();
      expect(peer.peerAuthAccepted).toBe(true);
      expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
      const input = JSON.parse(options.body);
      const payload = { protocolVersion: 1, scope: 'planning-v1', challenge: input.challenge,
        targetInstanceId: randomUUID(), senderInstanceId: identity.self.instanceId,
        expiresAt: Date.now() + 60000, executionSupported: false };
      return { ok: true, json: async () => ({ payload, signature: signPeerAdmin(peer, 'preflight', payload) }) };
    });
    const result = await operator('/api/peer-administration/preview', { peerId: identity.peers[0].id, intent });
    expect(result.body.code).toBe('PEER_ADMIN_UNVERIFIED_RESPONSE');
    expect(peerFetch).toHaveBeenCalledTimes(1);
  });
});
