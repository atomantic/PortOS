import { EventEmitter } from 'node:events';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { derivePeerAuthToken } from '../lib/peerHttpClient.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'catalog-identity-route-' });
vi.mock('../lib/fileUtils.js', async original => makeProxy(await original()));
afterAll(cleanup);
const fixture = vi.hoisted(() => ({ enabled: false, calls: [], peer: {
  id: 'fixture-peer-record', instanceId: 'fixture-peer', enabled: true, syncEnabled: true,
  syncSecret: 'fake-test-pair-secret-only-used-in-fixtures', directions: ['inbound', 'outbound'], syncCategories: { catalog: true },
} }));
vi.mock('../services/auth.js', () => ({ isAuthEnabled: async () => fixture.enabled,
  verifyPassword: async () => false,
  verifyRequestSession: async ({ headers }) => headers.authorization === 'Bearer fixture-operator' ? { fixture: true } : null,
}));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}), settingsEvents: new EventEmitter() }));
vi.mock('../services/instanceIdentity.js', () => ({
  getInstanceId: async () => 'fixture-local', UNKNOWN_INSTANCE_ID: 'unknown', loadData: async () => ({ peers: [fixture.peer] }),
}));
vi.mock('../services/sharing/peerSyncShared.js', () => ({
  findPeerById: async id => id === fixture.peer.instanceId ? fixture.peer : null,
  peerAllowsOutbound: peer => peer.enabled && peer.syncEnabled && peer.directions.includes('outbound'),
  peerAllowsCategoryPull: peer => peer.syncCategories.catalog === true,
}));
vi.mock('../services/catalogIdentity/index.js', () => ({
  listIdentityOperations: async input => { fixture.calls.push(input); return { items: [], nextOffset: null }; },
  getIdentityOperation: async id => ({ id }),
  previewIdentity: async input => { fixture.calls.push(input); return { conflicts: [], planHash: 'a'.repeat(64) }; },
  createIdentity: async input => ({ id: input.operationId, sourceId: input.sourceId, survivorId: input.survivorId }),
  importIdentity: async () => ({}), acceptIdentity: async () => ({}), advanceIdentity: async () => ({}),
  abortIdentity: async () => ({}), prepareIdentityRecovery: async () => ({}),
  ownerSnapshot: async id => ({ ingredients: [{ id, origin_instance_id: 'fixture-local' }] }),
  peerIdentityStatus: async id => ({ id, state: 'prepared' }),
}));
const { authGate } = await import('../services/authGate.js');
const { default: routes } = await import('./catalogIdentity.js');
function app() {
  const value = express();
  value.use((req, _res, next) => {
    // A remote socket identity, not a spoofable client header.
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.5' }); next();
  });
  value.use(express.json()); value.use(authGate);
  value.use('/api/catalog/identity', routes); value.use(errorMiddleware); return value;
}
function authed(api, headers) {
  return Object.fromEntries(['get', 'post'].map(method => [method, path => {
    const builder = request(api)[method](path);
    for (const [name, value] of Object.entries(headers)) builder.set(name, value);
    return builder;
  }]));
}
const peerHeaders = () => ({ 'X-PortOS-Instance-Id': fixture.peer.instanceId,
  'X-PortOS-Peer-Auth': derivePeerAuthToken(fixture.peer.syncSecret, fixture.peer.instanceId) });
beforeEach(() => { fixture.enabled = false; fixture.calls.length = 0; fixture.peer.syncCategories.catalog = true; });

describe('canonical identity authorization and route contract', () => {
  it('admits only paired challenge-bound evidence reads; a scoped peer cannot mutate or inspect operator receipts', async () => {
    const api = app(); const headers = peerHeaders();
    const read = await authed(api, headers).get(`/api/catalog/identity/peer/status?operationId=fixture-operation&challenge=${'a'.repeat(64)}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ owner: 'fixture-local', audience: 'fixture-peer', kind: 'status', target: 'fixture-operation', challenge: 'a'.repeat(64) });
    expect(read.body.mac).toMatch(/^[a-f0-9]{64}$/);
    expect((await authed(api, headers).post('/api/catalog/identity/fixture-operation/accept').send({ planHash: 'a'.repeat(64) })).status).toBe(403);
    expect((await authed(api, headers).get('/api/catalog/identity')).status).toBe(403);
    expect((await request(api).get(`/api/catalog/identity/peer/snapshot?ingredientId=fixture&challenge=${'a'.repeat(64)}`)).status).toBe(403);
    fixture.peer.syncCategories.catalog = false;
    expect((await authed(api, headers).get(`/api/catalog/identity/peer/status?operationId=fixture-operation&challenge=${'a'.repeat(64)}`)).status).toBe(403);
    expect(fixture.calls).toEqual([]);
  });
  it('preserves operator session authority and validates pagination, operation UUID and exact acceptance hash', async () => {
    fixture.enabled = true; const api = app(); const headers = { Authorization: 'Bearer fixture-operator' };
    const list = await authed(api, headers).get('/api/catalog/identity?ingredientId=fixture&limit=5&offset=2');
    expect(list.status).toBe(200); expect(fixture.calls[0]).toEqual({ ingredientId: 'fixture', limit: 5, offset: 2 });
    expect((await authed(api, headers).get('/api/catalog/identity?limit=10000')).status).toBe(400);
    expect((await authed(api, headers).post('/api/catalog/identity/preview').send({ sourceId: 's', survivorId: 't' })).status).toBe(400);
    const valid = await authed(api, headers).post('/api/catalog/identity/preview').send({
      operationId: 'd0e9bbda-a271-4387-898b-ae6772e28973', sourceId: 's', survivorId: 't', fieldChoices: {},
    });
    expect(valid.status).toBe(200);
    expect((await authed(api, headers).post('/api/catalog/identity/fixture/accept').send({ planHash: 'bad' })).status).toBe(400);
  });
});
