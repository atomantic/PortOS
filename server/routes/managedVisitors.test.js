import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createManagedVisitorBroker, managedVisitorContract } from '../services/managedVisitorBroker.js';
import { request } from '../lib/testHelper.js';
const shared = vi.hoisted(() => ({ enabled: false, broker: null }));
vi.mock('../services/auth.js', () => ({ isAuthEnabled: async () => shared.enabled, extractToken: req => req.headers.authorization?.slice(7),
  verifySession: async token => token === 'owner-session', verifyPassword: async () => false }));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}), settingsEvents: new EventEmitter() }));
vi.mock('../services/managedVisitors.js', async () => {
  const actual = await vi.importActual('../services/managedVisitors.js');
  return { ...actual, getManagedVisitorBroker: () => shared.broker,
    authenticateManagedVisitorRequest: req => actual.authenticateManagedVisitorRequest(req, shared.broker) };
});
import { authGate } from '../services/authGate.js';
import { createManagedVisitorRoutes, createManagedVisitorAdminRoutes } from './managedVisitors.js';
let directory, app, clock, host, credentials, count, delayed;
const appId = 'managed-app', individualId = 'individual-a', individualSessionId = 'runtime-a', worldId = 'quiet-garden';
const admission = { individualId, individualSessionId, worldId, body: 'fly-v1', ttlMs: 30000 };
const credentialInput = { individualIds: [individualId], worldIds: [worldId], ttlMs: 60000 };
const scope = visit => ({ individualId, individualSessionId, worldId, epoch: visit.epoch });
const authHeader = () => `Bearer ${credentials.credential}`;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'portos-managed-visitor-')); clock = Date.now(); shared.enabled = false; delayed = null; count = 0;
  host = {
    capabilities: vi.fn(async () => ({ managedVisitors: managedVisitorContract })),
    admit: vi.fn(async body => {
      if (delayed) await delayed;
      return { version: 1, appId: body.appId, individualId: body.individualId, individualSessionId: body.individualSessionId,
        worldId: body.worldId, epoch: 'host-epoch', sessionId: `host-${count++}`, expiresAt: clock + body.ttlMs, status: 'paused', pose: { x: 0, z: 0, yaw: 0 } };
    }),
    observe: vi.fn(async (id, body) => ({ version: 1, ...body, sessionId: id, frameId: 0, capturedAtMs: clock,
      camera: 'controller', sensorySource: 'engineered-gentle-patch-spatial-proxy-v1', width: 8, height: 4, rgb: Array(96).fill(0), pose: { x: 0, z: 0, yaw: 0 } })),
    action: vi.fn(async (id, { sequence, action, ...body }) => ({ version: 1, ...body, sessionId: id, sequence, expiresAt: clock + admission.ttlMs,
      status: { start: 'running', pause: 'paused', rest: 'resting', move: 'running', leave: 'left' }[action.type], pose: { x: 0, z: 0, yaw: 0 } })),
    leave: vi.fn(async () => ({ status: 'left' })),
  };
  shared.broker = createManagedVisitorBroker({ path: join(directory, 'credentials.json'), getApp: async id => id === appId ? { id } : null, host, now: () => clock });
  app = express(); app.use(express.json()); app.use(authGate);
  app.use('/api/managed-visitors/v1', createManagedVisitorRoutes(() => shared.broker));
  app.use('/api/managed-visitor-admin', createManagedVisitorAdminRoutes(() => shared.broker));
  app.get('/api/private', (_req, res) => res.json({ private: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.code || 'error' }));
  const response = await request(app).post(`/api/managed-visitor-admin/${appId}/credential`).send(credentialInput);
  expect(response.status).toBe(200); credentials = response.body;
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('requires separate app credentials with optional password off/on and grants no owner or protected ordinary API authority', async () => {
  for (const enabled of [false, true]) {
    shared.enabled = enabled;
    expect((await request(app).get('/api/managed-visitors/v1/capabilities')).status).toBe(401);
    expect((await request(app).get('/api/managed-visitors/v1/capabilities').set('Authorization', 'Bearer owner-session')).status).toBe(401);
    expect((await request(app).get('/api/managed-visitors/v1/capabilities').set('Authorization', authHeader())).body.available).toBe(true);
    expect((await request(app).get('/api/managed-visitor-admin').set('Authorization', authHeader())).status).not.toBe(200);
  }
  expect((await request(app).get('/api/private').set('Authorization', authHeader())).status).toBe(401);
  expect((await request(app).get('/api/private').set('Authorization', 'Bearer owner-session')).status).toBe(200);
  expect(await readFile(join(directory, 'credentials.json'), 'utf8')).not.toContain(credentials.credential);
  expect(JSON.stringify(await shared.broker.listCredentials())).not.toMatch(/digest|mv1_/);
});
it('denies unsupported hosts and out-of-scope/private admission fields before any world mutation', async () => {
  host.capabilities.mockResolvedValue({ guestEntry: 1 });
  expect((await request(app).post('/api/managed-visitors/v1/admissions').set('Authorization', authHeader()).send(admission)).status).toBe(409);
  expect(host.admit).not.toHaveBeenCalled(); host.capabilities.mockResolvedValue({ managedVisitors: managedVisitorContract });
  for (const body of [{ ...admission, worldId: 'other-world' }, { ...admission, individualId: 'other-person' }, { ...admission, neuralState: [1] }]) {
    expect((await request(app).post('/api/managed-visitors/v1/admissions').set('Authorization', authHeader()).send(body)).status).toBeGreaterThanOrEqual(400);
  }
  expect(host.admit).not.toHaveBeenCalled();
});
it('starts paused and enforces observed scope, action sequence, epoch and expiration', async () => {
  const result = await request(app).post('/api/managed-visitors/v1/admissions').set('Authorization', authHeader()).send(admission);
  expect(result.status).toBe(200); const visit = result.body; expect(visit.status).toBe('paused'); expect(visit.sessionId).not.toBe('host-0');
  const path = `/api/managed-visitors/v1/sessions/${visit.sessionId}`;
  const observed = await request(app).post(`${path}/observations`).set('Authorization', authHeader()).send(scope(visit));
  expect(observed.body.rgb).toHaveLength(96); expect(observed.body.sessionId).toBe(visit.sessionId);
  const command = { ...scope(visit), sequence: 0, action: { type: 'start' } };
  expect((await request(app).post(`${path}/actions`).set('Authorization', authHeader()).send(command)).body.status).toBe('running');
  expect((await request(app).post(`${path}/actions`).set('Authorization', authHeader()).send(command)).status).toBe(409);
  expect((await request(app).post(`${path}/actions`).set('Authorization', authHeader()).send({ ...command, sequence: 1, epoch: 'other' })).status).toBe(403);
  expect(host.action).toHaveBeenCalledTimes(1); clock += 30001;
  expect((await request(app).post(`${path}/observations`).set('Authorization', authHeader()).send(scope(visit))).status).toBe(403);
});
it('rotation closes visits and rejects late admission authority issued for a revoked credential', async () => {
  const auth = await shared.broker.authenticate(credentials.credential), visit = await shared.broker.admit(auth, admission);
  await shared.broker.provision(appId, credentialInput);
  await expect(shared.broker.observe(auth, visit.sessionId, scope(visit))).rejects.toThrow(/revoked/); expect(host.leave).toHaveBeenCalledTimes(1);
  credentials = await shared.broker.provision(appId, credentialInput);
  const newAuth = await shared.broker.authenticate(credentials.credential); let release;
  delayed = new Promise(resolve => { release = resolve; }); const pending = shared.broker.admit(newAuth, admission);
  await vi.waitFor(() => expect(host.admit).toHaveBeenCalledTimes(2));
  await shared.broker.revoke(appId); release();
  await expect(pending).rejects.toThrow(/changed/); expect(host.leave).toHaveBeenCalledTimes(2);
});
it('denies cross-origin provisioning and nonloopback broker callers even without password auth', async () => {
  expect((await request(app).post(`/api/managed-visitor-admin/${appId}/credential`).set('Origin', 'https://unrelated.invalid').send(credentialInput)).status).toBe(403);
  const { authenticateManagedVisitorRequest } = await vi.importActual('../services/managedVisitors.js');
  await expect(authenticateManagedVisitorRequest({ socket: { remoteAddress: '192.0.2.1' }, headers: { authorization: authHeader() } }, shared.broker)).rejects.toThrow(/local/);
});
it('revokes malformed/private host outputs instead of forwarding or retrying uncertain operations', async () => {
  const auth = await shared.broker.authenticate(credentials.credential), visit = await shared.broker.admit(auth, admission);
  host.observe.mockImplementationOnce(async (id, body) => ({ version: 1, ...body, sessionId: id, neuralState: ['private'] }));
  await expect(shared.broker.observe(auth, visit.sessionId, scope(visit))).rejects.toThrow(/revoked/); expect(host.leave).toHaveBeenCalled();
  await expect(shared.broker.action(auth, visit.sessionId, { ...scope(visit), sequence: 0, action: { type: 'start' } })).rejects.toThrow(/scope/);
  expect(host.action).not.toHaveBeenCalled();
});

it('rejects duplicate host observation frames and invalidates the visitor rather than delivering a replay', async () => {
  const auth = await shared.broker.authenticate(credentials.credential), visit = await shared.broker.admit(auth, admission);
  await shared.broker.observe(auth, visit.sessionId, scope(visit));
  await expect(shared.broker.observe(auth, visit.sessionId, scope(visit))).rejects.toThrow(/revoked/);
  expect(host.leave).toHaveBeenCalledTimes(1);
});

it('rejects malformed negotiation shapes and cleans up malformed admission acknowledgements with original scope only', async () => {
  const auth = await shared.broker.authenticate(credentials.credential);
  for (const invalid of [{ ...managedVisitorContract, bodies: 'fly-v1' }, { ...managedVisitorContract, actions: 'start pause rest move leave' },
    { ...managedVisitorContract, bodies: {} }]) {
    host.capabilities.mockResolvedValue({ managedVisitors: invalid });
    expect((await shared.broker.capabilities(auth)).available).toBe(false);
    await expect(shared.broker.admit(auth, admission)).rejects.toThrow(/capability/);
  }
  expect(host.admit).not.toHaveBeenCalled(); host.capabilities.mockResolvedValue({ managedVisitors: managedVisitorContract });
  const normal = host.admit.getMockImplementation();
  host.admit.mockImplementationOnce(async body => ({ ...await normal(body), privateHistory: ['not forwarded'], individualId: 'other-person' }));
  await expect(shared.broker.admit(auth, admission)).rejects.toThrow(/invalid/);
  expect(host.leave).toHaveBeenCalledWith('host-0', { appId, individualId, individualSessionId, worldId, epoch: 'host-epoch' });
});

it('a backward broker clock revokes active authority even if wall time later recovers', async () => {
  const auth = await shared.broker.authenticate(credentials.credential), visit = await shared.broker.admit(auth, admission);
  clock -= 1; await expect(shared.broker.observe(auth, visit.sessionId, scope(visit))).rejects.toThrow(/clock/);
  clock += 1; await expect(shared.broker.observe(auth, visit.sessionId, scope(visit))).rejects.toThrow(/scope/);
  expect(host.leave).toHaveBeenCalledTimes(1);
});
it('revocation during a pending action discards its late response and admission latency cannot extend the broker deadline', async () => {
  const auth = await shared.broker.authenticate(credentials.credential), visit = await shared.broker.admit(auth, admission);
  let release; const normal = host.action.getMockImplementation();
  host.action.mockImplementationOnce(async (...args) => { await new Promise(resolve => { release = resolve; }); return normal(...args); });
  const action = shared.broker.action(auth, visit.sessionId, { ...scope(visit), sequence: 0, action: { type: 'start' } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await shared.broker.revoke(appId); release(); await expect(action).rejects.toThrow(/revoked/);
  expect(host.leave).toHaveBeenCalled();
  credentials = await shared.broker.provision(appId, credentialInput);
  const current = await shared.broker.authenticate(credentials.credential), admitNormally = host.admit.getMockImplementation();
  host.admit.mockImplementationOnce(async body => { clock += 1001; return admitNormally(body); });
  await expect(shared.broker.admit(current, { ...admission, ttlMs: 1000 })).rejects.toThrow(/expired/);
});
