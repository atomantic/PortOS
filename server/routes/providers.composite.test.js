/**
 * The composition surface of `/api/providers` (#7564): the catalog, per-harness
 * enablement, bootstrap apps, one composite's verdict, readiness for a
 * composite, and the preset-only refusal on `PUT /active`. Services are
 * doubled; what is pinned here is the HTTP contract — status codes, the
 * sanitization every provider-bearing payload gets, and which service each
 * route reaches with what.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-composite-routes-') }));
afterAll(cleanupTempDataRoots);
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const compositeService = vi.hoisted(() => ({ describeCompositeProvider: vi.fn(), buildProviderCatalog: vi.fn() }));
vi.mock('../services/compositeProviders.js', () => compositeService);
const enablementService = vi.hoisted(() => ({ listHarnessEnablement: vi.fn(), setHarnessEnabled: vi.fn() }));
vi.mock('../services/harnessEnablement.js', () => enablementService);
const bootstrapService = vi.hoisted(() => ({ listCredentialBootstraps: vi.fn(), saveCredentialBootstraps: vi.fn() }));
vi.mock('../services/credentialBootstrapApps.js', () => bootstrapService);
const readinessService = vi.hoisted(() => ({ getProviderReadinessMap: vi.fn(), resetProviderReadinessCache: vi.fn() }));
vi.mock('../services/providerReadiness.js', async (importOriginal) => ({ ...(await importOriginal()), ...readinessService }));
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

const providerService = { getAllProviders: vi.fn(), getProviderById: vi.fn(), setActiveProvider: vi.fn() };
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
  providerService.getProviderById.mockImplementation(async (id) => (id === COMPOSITE ? materialized() : id === 'claude-code' ? PRESET : null));
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
