/**
 * Credential pool management end to end (#17384): real Express route → real
 * Zod schema → the real `providerCredentialPools` / `providerGraph` services
 * and the real in-memory ledger → a doubled store.
 *
 * Pins what only this boundary can: no response carries a key value; a stored
 * key binds to the service's origin and is withheld (and re-bindable) after
 * the endpoint moves; an env reference may only name the definition's own
 * variables; a sign-in service refuses a pool; the status GET is a peek.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const store = {
  readGraph: vi.fn(),
  writeGraph: vi.fn().mockResolvedValue({ connections: 1, bindings: 0, routes: 0 }),
  applyReconciliation: vi.fn().mockResolvedValue(undefined),
  applyServiceColumnBackfill: vi.fn().mockResolvedValue(undefined),
  commitPendingProjection: vi.fn().mockResolvedValue(undefined),
  acknowledgeProjection: vi.fn().mockResolvedValue(undefined),
  deleteConnection: vi.fn(),
  mergeServiceInstances: vi.fn().mockResolvedValue(undefined),
  saveConnectionSettings: vi.fn(),
  saveBindingSettings: vi.fn().mockResolvedValue(2),
};
vi.mock('../services/provider/providerGraphStore.js', () => store);

const providerService = {
  getAllProviders: vi.fn(),
  applyProviderPatches: vi.fn(),
  refreshProviderModelsBatch: vi.fn(),
  fetchProviderModels: vi.fn(),
  getProviderById: vi.fn(),
  refreshProviderModels: vi.fn(),
};
vi.mock('../lib/aiToolkitState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requireToolkit: () => ({ services: { providers: providerService } }),
}));

const graph = await import('../services/provider/providerGraph.js');
const { openCredentialSession, resetCredentialPoolRuntime } = await import('../services/provider/credentialPoolRuntime.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const NIM = '33333333-3333-4333-8333-333333333333';
const CLAUDE_SUB = '55555555-5555-4555-8555-555555555555';
const PRIMARY = 'example-nim-primary-0001';
const EXTRA = 'example-nim-extra-key-0002';
const NIM_URL = 'https://integrate.api.nvidia.com/v1';

// One mutable row the doubled store reads and writes, so a sequence of
// requests sees its own edits the way the real table would.
let rows;
const fixture = () => ([
  {
    id: NIM, revision: 1, kind: 'gateway:nvidia-nim', label: 'NIM', slug: 'nvidia-nim', definitionId: 'nvidia-nim', plan: 'paid',
    transports: { openai: { baseUrl: NIM_URL } }, credentials: { apiKey: PRIMARY }, catalog: { state: 'unknown', models: [] },
    enabled: true, credentialVia: 'stored',
  },
  {
    id: CLAUDE_SUB, revision: 1, kind: 'vendor', label: 'Claude', slug: 'claude-subscription', definitionId: 'claude-subscription', plan: 'subscription',
    transports: {}, credentials: {}, catalog: { state: 'unknown', models: [] }, enabled: true, credentialVia: 'cli-login',
  },
]);

function app() {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
}

const nimRow = () => rows.find((row) => row.id === NIM);
const providerOnNim = (endpoint = NIM_URL) => ({ id: 'nim-preset', type: 'api', serviceId: 'nvidia-nim', endpoint, apiKey: PRIMARY });

beforeEach(async () => {
  vi.clearAllMocks();
  rows = fixture();
  graph.resetProviderGraphState();
  resetCredentialPoolRuntime();
  store.readGraph.mockImplementation(async () => ({ connections: structuredClone(rows), bindings: [], routes: [] }));
  store.saveConnectionSettings.mockImplementation(async (next) => {
    const row = rows.find((candidate) => candidate.id === next.id);
    Object.assign(row, structuredClone(next), { revision: row.revision + 1 });
    return row.revision;
  });
  providerService.getAllProviders.mockResolvedValue({ activeProvider: null, providers: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await graph.initProviderGraph();
});

afterEach(() => vi.restoreAllMocks());

describe('credential pool routes', () => {
  it('adds a stored key bound to the service origin and never echoes it', async () => {
    const res = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ label: 'Second', apiKey: EXTRA });
    expect(res.status).toBe(201);
    expect(res.text).not.toContain(EXTRA);
    expect(res.text).not.toContain(PRIMARY);
    expect(res.body).toMatchObject({ service: 'nvidia-nim', strategy: 'fill_first', active: true });
    expect(res.body.entries.map((entry) => [entry.id === 'primary' ? 'primary' : entry.label, entry.fingerprint, entry.withheld]))
      .toEqual([['primary', '…0001', null], ['Second', '…0002', null]]);
    expect(nimRow().credentials.credentialPool.entries[0]).toMatchObject({ source: 'stored', apiKey: EXTRA, origin: 'https://integrate.api.nvidia.com' });
    // The primary key the routes project is untouched.
    expect(nimRow().credentials.apiKey).toBe(PRIMARY);

    const dup = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ apiKey: PRIMARY });
    expect(dup.status).toBe(409);
  });

  it('stores an env reference by name only, and refuses an unrelated variable', async () => {
    const res = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ envVar: 'NVIDIA_API_KEY_9' });
    expect(res.status).toBe(201);
    expect(nimRow().credentials.credentialPool.entries[0]).toEqual(expect.objectContaining({ source: 'env', envVar: 'NVIDIA_API_KEY_9' }));
    expect(nimRow().credentials.credentialPool.entries[0]).not.toHaveProperty('apiKey');

    const refused = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ envVar: 'PGPASSWORD' });
    expect(refused.status).toBe(400);
    const both = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ envVar: 'NVIDIA_API_KEY_2', apiKey: EXTRA });
    expect(both.status).toBe(400);
  });

  it('withholds a bound key after the endpoint moves, until it is explicitly re-bound', async () => {
    const added = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ apiKey: EXTRA });
    const extraId = added.body.entries.find((entry) => entry.id !== 'primary').id;
    nimRow().transports = { openai: { baseUrl: 'https://nim-proxy.example.com/v1' } };

    const moved = await request(app()).get('/api/providers/services/nvidia-nim/credential-pool');
    expect(moved.body.entries.find((entry) => entry.id === extraId)).toMatchObject({ withheld: 'origin-mismatch', boundOrigin: 'https://integrate.api.nvidia.com' });
    expect(moved.body.active).toBe(false);
    expect(await openCredentialSession(providerOnNim('https://nim-proxy.example.com/v1'), 'm', { env: {} })).toBeNull();

    const rebound = await request(app()).patch(`/api/providers/services/nvidia-nim/credential-pool/keys/${extraId}`).send({ rebindOrigin: true });
    expect(rebound.status).toBe(200);
    expect(rebound.body.entries.find((entry) => entry.id === extraId).withheld).toBeNull();
  });

  it('reorders, switches strategy, removes, and resets cooldowns', async () => {
    const added = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ apiKey: EXTRA });
    const extraId = added.body.entries.find((entry) => entry.id !== 'primary').id;

    const ordered = await request(app()).patch('/api/providers/services/nvidia-nim/credential-pool').send({ strategy: 'round_robin', order: [extraId, 'primary'] });
    expect(ordered.status).toBe(200);
    expect(ordered.body.strategy).toBe('round_robin');
    expect(ordered.body.entries.map((entry) => entry.id)).toEqual([extraId, 'primary']);
    expect((await request(app()).patch('/api/providers/services/nvidia-nim/credential-pool').send({ order: ['key-nope'] })).status).toBe(400);
    expect((await request(app()).patch('/api/providers/services/nvidia-nim/credential-pool').send({ strategy: 'random' })).status).toBe(400);

    // Bench the extra key through a real session, then clear it from the route.
    const session = await openCredentialSession(providerOnNim(), 'm', { env: {} });
    expect(session.credentialId).toBe(extraId);
    await session.onFailure({ status: 402, body: '' });
    const benched = await request(app()).get('/api/providers/services/nvidia-nim/credential-pool');
    expect(benched.body.entries.find((entry) => entry.id === extraId).cooldown).toMatchObject({ reason: 'quota' });
    const reset = await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/reset').send({ credentialId: extraId });
    expect(reset.body.entries.find((entry) => entry.id === extraId).cooldown).toBeNull();

    expect((await request(app()).delete('/api/providers/services/nvidia-nim/credential-pool/keys/primary')).status).toBe(409);
    const removed = await request(app()).delete(`/api/providers/services/nvidia-nim/credential-pool/keys/${extraId}`);
    expect(removed.body.entries.map((entry) => entry.id)).toEqual(['primary']);
    expect(nimRow().credentials.credentialPool).toMatchObject({ entries: [] });
  });

  it('peeks without rotating: repeated status reads leave the next pick unchanged', async () => {
    await request(app()).post('/api/providers/services/nvidia-nim/credential-pool/keys').send({ apiKey: EXTRA });
    await request(app()).patch('/api/providers/services/nvidia-nim/credential-pool').send({ strategy: 'round_robin' });
    for (let i = 0; i < 3; i += 1) await request(app()).get('/api/providers/services/nvidia-nim/credential-pool');
    expect((await openCredentialSession(providerOnNim(), 'm', { env: {} })).credentialId).toBe('primary');
    expect(store.saveConnectionSettings).toHaveBeenCalledTimes(2);
  });

  it('refuses a pool on a service that signs in', async () => {
    const res = await request(app()).post('/api/providers/services/claude-subscription/credential-pool/keys').send({ apiKey: EXTRA });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDENTIAL_POOL_UNSUPPORTED');
  });

  it('keeps a pool-only row "without credentials" for readiness', async () => {
    nimRow().credentials = { credentialPool: { strategy: 'fill_first', entries: [{ id: 'key-1', source: 'stored', apiKey: EXTRA, origin: 'https://integrate.api.nvidia.com', enabled: true }] } };
    const res = await request(app()).get('/api/providers/services/nvidia-nim');
    expect(res.body.service.hasCredentials).toBe(false);
    expect(res.text).not.toContain(EXTRA);
  });
});
