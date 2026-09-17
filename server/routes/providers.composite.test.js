/**
 * The composition surface of `/api/providers` (#7564): the catalog, per-harness
 * enablement, bootstrap apps, one composite's verdict, readiness for a
 * composite, and the preset-only refusal on `PUT /active` — plus the preset
 * surface (#7565): "Save as preset", "Convert to derived preset", the
 * derived-aware save on PUT /:id and POST /, and the `presetKind` /
 * `presetDerivable` decoration. Services are doubled; what is pinned here is
 * the HTTP contract — status codes, the sanitization every provider-bearing
 * payload gets, and which service each route reaches with what. One file for
 * both because they mount the same router (server/AGENTS.md "Import scoping").
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-composite-routes-') }));
afterAll(cleanupTempDataRoots);
import express, { Router } from 'express';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const compositeService = vi.hoisted(() => ({ describeCompositeProvider: vi.fn(), buildProviderCatalog: vi.fn() }));
vi.mock('../services/compositeProviders.js', () => compositeService);
const enablementService = vi.hoisted(() => ({ listHarnessEnablement: vi.fn(), setHarnessEnabled: vi.fn() }));
vi.mock('../services/harnessEnablement.js', () => enablementService);
const bootstrapService = vi.hoisted(() => ({ listCredentialBootstraps: vi.fn(), saveCredentialBootstraps: vi.fn() }));
vi.mock('../services/credentialBootstrapApps.js', () => bootstrapService);
const readinessService = vi.hoisted(() => ({ getProviderReadinessMap: vi.fn(), resetProviderReadinessCache: vi.fn() }));
vi.mock('../services/providerReadiness.js', async (importOriginal) => ({ ...(await importOriginal()), ...readinessService }));
const presetService = vi.hoisted(() => ({
  createPresetFromComposite: vi.fn(), derivePreset: vi.fn(), materializeStoredPreset: vi.fn(), savesAsDerivedPreset: vi.fn(), storableProviderRecord: vi.fn(),
}));
vi.mock('../services/providerPresets.js', () => presetService);
import { createPortOSProviderRoutes } from './providers.js';

const COMPOSITE = 'pi.tui@nvidia-nim';
const materialized = () => {
  const record = {
    id: COMPOSITE, name: 'Pi · NVIDIA NIM', type: 'tui', command: 'pi', args: ['--approve', '--provider', 'nvidia'], enabled: true,
    harnessId: 'pi', method: 'tui', serviceId: 'nvidia-nim', servicePlan: 'free', models: ['nvidia/example'], defaultModel: 'nvidia/example',
    envVars: { NVIDIA_API_KEY: 'nim-key' }, secretEnvVars: ['NVIDIA_API_KEY'], gatewayBacked: 'nvidia-nim', endpoint: 'https://integrate.api.nvidia.com/v1',
  };
  Object.defineProperty(record, 'apiKey', { value: 'nim-key', enumerable: false, configurable: true });
  return record;
};
const PRESET = { id: 'claude-code', name: 'Claude', type: 'cli', command: 'claude', enabled: true, apiKey: 'preset-secret', envVars: {}, secretEnvVars: [] };
// A stored DERIVED preset and a LEGACY one the server reports convertible (#7565).
const DERIVED = { id: 'pi-tui-nvidia-nim-free', name: 'Pi · NIM', type: 'tui', command: 'pi', harnessId: 'pi', method: 'tui', serviceId: 'nvidia-nim-free', enabled: true, apiKey: '', envVars: { NVIDIA_API_KEY: 'nim-key' }, secretEnvVars: ['NVIDIA_API_KEY'], models: ['nvidia/example'] };
const LEGACY = { id: 'claude-ollama', name: 'Claude', type: 'cli', command: 'claude', ollamaBacked: true, enabled: true, apiKey: '', envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' }, secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'], models: [] };

const providerService = { getAllProviders: vi.fn(), getProviderById: vi.fn(), setActiveProvider: vi.fn(), updateProvider: vi.fn(), createProvider: vi.fn() };
const app = () => {
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes({ services: { providers: providerService, providerStatus: {} }, routes: { providers: Router() } }));
  server.use(errorMiddleware);
  return server;
};

beforeEach(() => {
  vi.clearAllMocks();
  providerService.getAllProviders.mockResolvedValue({ activeProvider: 'claude-code', providers: [PRESET] });
  providerService.getProviderById.mockImplementation(async (id) => (id === COMPOSITE ? materialized() : [PRESET, DERIVED, LEGACY].find((record) => record.id === id) ?? null));
  providerService.updateProvider.mockImplementation(async (id, updates) => ({ ...(await providerService.getProviderById(id)), ...updates }));
  providerService.createProvider.mockImplementation(async (body) => ({ ...body }));
  presetService.savesAsDerivedPreset.mockImplementation((candidate) => Boolean(candidate.harnessId && candidate.method && candidate.serviceId));
  presetService.materializeStoredPreset.mockImplementation(async (candidate) => ({ ...candidate, rederived: true }));
  // The real one-liner, over the doubles above, so the route's choice of path stays observable.
  presetService.storableProviderRecord.mockImplementation((candidate, updates) =>
    (presetService.savesAsDerivedPreset(candidate) ? presetService.materializeStoredPreset(candidate, { updates }) : Promise.resolve(updates)));
});

describe('PUT /api/providers/active', () => {
  it('refuses a composite with a 400 that names the preset-only rule, and never reaches the store', async () => {
    const res = await request(app()).put('/api/providers/active').send({ id: COMPOSITE });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.context.details)).toMatch(/preset provider id/);
    expect(providerService.setActiveProvider).not.toHaveBeenCalled();
  });
});

describe('GET /api/providers/catalog', () => {
  it('hands the sanitized presets to the catalog builder and returns its answer', async () => {
    compositeService.buildProviderCatalog.mockResolvedValue({ harnesses: [], services: [], bootstraps: [], compatibility: {}, effortLevels: {}, effortLevelsByModel: {}, presets: [] });
    const res = await request(app()).get('/api/providers/catalog');
    expect(res.status).toBe(200);
    expect(compositeService.buildProviderCatalog).toHaveBeenCalledWith();
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0]).toMatchObject({ id: 'claude-code', hasApiKey: true });
    expect(JSON.stringify(res.body)).not.toContain('preset-secret');
  });
});

describe('GET /api/providers/composites/:id', () => {
  it('publishes the verdict with the record sanitized like a stored one — never the key', async () => {
    compositeService.describeCompositeProvider.mockResolvedValue({
      id: COMPOSITE, eligible: true, code: null, reason: null, parts: { harnessId: 'pi', method: 'tui', serviceSlug: 'nvidia-nim', bootstrapSlug: null }, record: materialized(),
    });
    const res = await request(app()).get(`/api/providers/composites/${encodeURIComponent(COMPOSITE)}`);
    expect(res.status).toBe(200);
    expect(compositeService.describeCompositeProvider).toHaveBeenCalledWith(COMPOSITE);
    expect(res.body).toMatchObject({ id: COMPOSITE, eligible: true, parts: { harnessId: 'pi' } });
    expect(res.body.provider).toMatchObject({ id: COMPOSITE, hasApiKey: true, harnessId: 'pi', envVars: { NVIDIA_API_KEY: '***' } });
    expect(res.body.provider).not.toHaveProperty('apiKey');
    expect(JSON.stringify(res.body)).not.toContain('nim-key');
  });

  it('carries an ineligible composite\'s reason with no provider', async () => {
    compositeService.describeCompositeProvider.mockResolvedValue({ id: COMPOSITE, eligible: false, code: 'harness-disabled', reason: 'Pi is switched off', parts: null, record: null });
    const res = await request(app()).get(`/api/providers/composites/${encodeURIComponent(COMPOSITE)}`);
    expect(res.body).toEqual({ id: COMPOSITE, eligible: false, code: 'harness-disabled', reason: 'Pi is switched off', parts: null, provider: null });
  });
});

describe('GET /api/providers/readiness?providerId=', () => {
  it('answers for one composite through the same lookup the run paths use', async () => {
    readinessService.getProviderReadinessMap.mockImplementation(async (providers) => Object.fromEntries(providers.map((p) => [p.id, { ready: true }])));
    const res = await request(app()).get(`/api/providers/readiness?providerId=${encodeURIComponent(COMPOSITE)}`);
    expect(res.status).toBe(200);
    expect(providerService.getProviderById).toHaveBeenCalledWith(COMPOSITE);
    expect(res.body).toEqual({ readiness: { [COMPOSITE]: { ready: true } } });
    expect(providerService.getAllProviders).not.toHaveBeenCalled();
  });

  it('answers an empty map for a composite that does not resolve', async () => {
    const res = await request(app()).get(`/api/providers/readiness?providerId=${encodeURIComponent('claude.cli@nowhere')}`);
    expect(res.body).toEqual({ readiness: {} });
    expect(readinessService.getProviderReadinessMap).not.toHaveBeenCalled();
  });
});

describe('harnesses and bootstraps', () => {
  it('GET /harnesses lists the verdicts; PUT /harnesses/:id records one flip and refuses an unknown id', async () => {
    enablementService.listHarnessEnablement.mockResolvedValue([{ id: 'pi', enabled: true, source: 'detected' }]);
    enablementService.setHarnessEnabled.mockResolvedValue({ enabled: false, source: 'setting', detected: true, version: '1.0.0' });
    expect((await request(app()).get('/api/providers/harnesses')).body).toEqual({ harnesses: [{ id: 'pi', enabled: true, source: 'detected' }] });

    const res = await request(app()).put('/api/providers/harnesses/pi').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(enablementService.setHarnessEnabled).toHaveBeenCalledWith('pi', false);
    expect(res.body).toEqual({ harness: { id: 'pi', enabled: false, source: 'setting', detected: true, version: '1.0.0' } });

    expect((await request(app()).put('/api/providers/harnesses/gui').send({ enabled: false })).status).toBe(400);
    expect((await request(app()).put('/api/providers/harnesses/pi').send({ enabled: 'no' })).status).toBe(400);
    expect(enablementService.setHarnessEnabled).toHaveBeenCalledTimes(1);
  });

  it('GET /bootstraps reads the table; PUT /bootstraps validates before saving and never spawns', async () => {
    const apps = { 'corp-auth': { label: 'Corp auth', command: 'corp-auth', args: ['run'], harnessNames: { claude: 'claude-code' } } };
    bootstrapService.listCredentialBootstraps.mockResolvedValue(apps);
    bootstrapService.saveCredentialBootstraps.mockImplementation(async (value) => value);
    expect((await request(app()).get('/api/providers/bootstraps')).body).toEqual({ bootstraps: apps });

    const saved = await request(app()).put('/api/providers/bootstraps').send({ bootstraps: apps });
    expect(saved.status).toBe(200);
    expect(bootstrapService.saveCredentialBootstraps).toHaveBeenCalledWith(apps);
    expect(saved.body).toEqual({ bootstraps: apps });

    const bad = await request(app()).put('/api/providers/bootstraps').send({ bootstraps: { 'Corp Auth': apps['corp-auth'] } });
    expect(bad.status).toBe(400);
    expect(bootstrapService.saveCredentialBootstraps).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/providers — preset structure (#7565)', () => {
  it('decorates every record with its preset kind and whether it can be converted', async () => {
    providerService.getAllProviders.mockResolvedValue({ activeProvider: 'claude-ollama', providers: [DERIVED, LEGACY] });
    const res = await request(app()).get('/api/providers');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.providers.map((provider) => [provider.id, provider]));
    expect(byId['pi-tui-nvidia-nim-free']).toMatchObject({ presetKind: 'derived', presetDerivable: false, serviceId: 'nvidia-nim-free', envVars: { NVIDIA_API_KEY: '***' } });
    expect(byId['claude-ollama']).toMatchObject({ presetKind: 'legacy', presetDerivable: true });
    expect(JSON.stringify(res.body)).not.toContain('nim-key');
  });
});

describe('POST /api/providers/presets', () => {
  it('validates the body, hands it to the service, and answers the created preset sanitized', async () => {
    presetService.createPresetFromComposite.mockResolvedValue({ ...DERIVED, apiKey: 'nim-key' });
    const res = await request(app()).post('/api/providers/presets').send({ compositeId: 'pi.tui@nvidia-nim-free', model: 'nvidia/example', effort: 'high' });
    expect(res.status).toBe(201);
    expect(presetService.createPresetFromComposite).toHaveBeenCalledWith({ compositeId: 'pi.tui@nvidia-nim-free', model: 'nvidia/example', effort: 'high' });
    expect(res.body).toMatchObject({ id: 'pi-tui-nvidia-nim-free', presetKind: 'derived', hasApiKey: true, envVars: { NVIDIA_API_KEY: '***' } });
    expect(JSON.stringify(res.body)).not.toContain('nim-key');
  });

  it('refuses a preset id where a composite is required, and a stray key, before the service is reached', async () => {
    expect((await request(app()).post('/api/providers/presets').send({ compositeId: 'claude-code' })).status).toBe(400);
    expect((await request(app()).post('/api/providers/presets').send({ compositeId: 'pi.tui@nvidia-nim-free', apiKey: 'x' })).status).toBe(400);
    expect(presetService.createPresetFromComposite).not.toHaveBeenCalled();
  });

  it('publishes the resolver\'s refusal as the service raised it', async () => {
    presetService.createPresetFromComposite.mockRejectedValue(new ServerError('Pi is switched off', { status: 400, code: 'harness-disabled' }));
    const res = await request(app()).post('/api/providers/presets').send({ compositeId: 'pi.tui@nvidia-nim-free' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'harness-disabled' });
  });
});

describe('POST /api/providers/:id/derive', () => {
  it('converts through the service and answers the stamped record', async () => {
    presetService.derivePreset.mockResolvedValue({ ...LEGACY, harnessId: 'claude', method: 'cli', serviceId: 'ollama' });
    const res = await request(app()).post('/api/providers/claude-ollama/derive');
    expect(res.status).toBe(200);
    expect(presetService.derivePreset).toHaveBeenCalledWith('claude-ollama');
    expect(res.body).toMatchObject({ presetKind: 'derived', serviceId: 'ollama', envVars: { ANTHROPIC_AUTH_TOKEN: '***' } });
  });

  it('carries a refusal with its reason', async () => {
    presetService.derivePreset.mockRejectedValue(new ServerError('cannot be derived (drift:command)', { status: 409, code: 'PRESET_NOT_DERIVABLE', context: { reason: 'drift:command' } }));
    const res = await request(app()).post('/api/providers/claude-ollama/derive');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PRESET_NOT_DERIVABLE' });
  });
});

describe('PUT /api/providers/:id on a derived preset', () => {
  it('stores what the service re-derives from the merged record, with redacted secrets restored first', async () => {
    const res = await request(app()).put('/api/providers/pi-tui-nvidia-nim-free').send({ effort: 'low', envVars: { NVIDIA_API_KEY: '***' } });
    expect(res.status).toBe(200);
    const [candidate, { updates }] = presetService.materializeStoredPreset.mock.calls[0];
    expect(candidate).toMatchObject({ id: 'pi-tui-nvidia-nim-free', effort: 'low', envVars: { NVIDIA_API_KEY: 'nim-key' }, serviceId: 'nvidia-nim-free' });
    expect(updates).toMatchObject({ effort: 'low', envVars: { NVIDIA_API_KEY: 'nim-key' } });
    expect(providerService.updateProvider).toHaveBeenCalledWith('pi-tui-nvidia-nim-free', expect.objectContaining({ rederived: true, effort: 'low' }));
    expect(res.body).toMatchObject({ effort: 'low', presetKind: 'derived' });
  });

  it('publishes a refused connection-owned edit as the service raised it, storing nothing', async () => {
    presetService.materializeStoredPreset.mockRejectedValue(new ServerError('command is derived', { status: 400, code: 'PRESET_FIELD_DERIVED', context: { fields: ['command'] } }));
    const res = await request(app()).put('/api/providers/pi-tui-nvidia-nim-free').send({ command: '/opt/bin/pi' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PRESET_FIELD_DERIVED' });
    expect(providerService.updateProvider).not.toHaveBeenCalled();
  });

  it('leaves a legacy preset on the plain update path', async () => {
    await request(app()).put('/api/providers/claude-ollama').send({ effort: 'low' });
    expect(presetService.materializeStoredPreset).not.toHaveBeenCalled();
    expect(providerService.updateProvider).toHaveBeenCalledWith('claude-ollama', expect.objectContaining({ effort: 'low' }));
  });
});

describe('POST /api/providers with preset structure', () => {
  it('materializes a body naming a harness, method and service before it is stored', async () => {
    const body = { name: 'Claude · local', type: 'cli', command: 'claude', harnessId: 'claude', method: 'cli', serviceId: 'ollama' };
    const res = await request(app()).post('/api/providers').send(body);
    expect(res.status).toBe(201);
    expect(presetService.materializeStoredPreset).toHaveBeenCalledWith(expect.objectContaining(body), { updates: expect.objectContaining(body) });
    expect(providerService.createProvider).toHaveBeenCalledWith(expect.objectContaining({ rederived: true }));
  });
});
