import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  augment: vi.fn(),
  listFoundations: vi.fn(),
  packageCandidate: vi.fn(),
  recordFoundation: vi.fn(),
  getFoundation: vi.fn(),
  ensurePresence: vi.fn(),
  getProjectionStatus: vi.fn(),
  getStatus: vi.fn(),
  project: vi.fn(),
  say: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('../services/eidoverseWorld.js', () => ({
  augmentEidoverseWorld: mocks.augment,
  ensureEidoverseWorldPresence: mocks.ensurePresence,
  getEidoverseWorldProjectionStatus: mocks.getProjectionStatus,
  getEidoverseWorldStatus: mocks.getStatus,
  projectEidoverseWorld: mocks.project,
  sayInEidoverseWorld: mocks.say,
  updateEidoverseWorldConfig: mocks.updateConfig,
}));

vi.mock('../services/eidoverseFoundationLedger.js', () => ({
  getEidoverseFoundation: mocks.getFoundation,
  listEidoverseFoundations: mocks.listFoundations,
  packageEidoverseFoundationCandidate: mocks.packageCandidate,
  recordEidoverseFoundation: mocks.recordFoundation,
}));

vi.mock('../services/instanceIdentity.js', () => ({ getInstanceId: () => Promise.resolve('instance-aaaa') }));

const { default: eidoverseWorldRoutes } = await import('./eidoverseWorldRoutes.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/eidoverse/world', eidoverseWorldRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('Eidoverse world routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatus.mockResolvedValue({ world: 'portos', identity: { name: 'example-user' } });
    mocks.getProjectionStatus.mockResolvedValue({
      design: { reconciliation: { status: 'applying', checkpoint: 'applying-live' } },
      projection: { lastRunAt: '2026-01-01T00:00:00.000Z' },
    });
    mocks.updateConfig.mockResolvedValue({ world: 'portos', human: { name: 'example-user' } });
    mocks.ensurePresence.mockResolvedValue({ connected: true, role: 'owner' });
    mocks.project.mockResolvedValue({ success: true, summary: { operationCount: 0 } });
    mocks.augment.mockResolvedValue({ success: true, applied: 1 });
    mocks.say.mockResolvedValue({ success: true });
  });

  it('returns private world status from the service boundary', async () => {
    const res = await request(makeApp()).get('/api/eidoverse/world/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ world: 'portos', identity: { name: 'example-user' } });
    expect(mocks.getStatus).toHaveBeenCalledOnce();
  });

  it('returns lightweight persisted projection progress', async () => {
    const res = await request(makeApp()).get('/api/eidoverse/world/projection/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      design: { reconciliation: { checkpoint: 'applying-live' } },
    });
    expect(mocks.getProjectionStatus).toHaveBeenCalledOnce();
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it('validates and persists a configuration patch', async () => {
    const res = await request(makeApp()).put('/api/eidoverse/world/config').send({ humanName: 'Example User' });
    expect(res.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith({ humanName: 'Example User' });
  });

  it('accepts explicit opaque-key aliases and rejects raw identities and unbounded text', async () => {
    const key = 'app-0123456789ab';
    const valid = await request(makeApp()).put('/api/eidoverse/world/config').send({ labelAliases: { [key]: '  Example observatory  ' } });
    expect(valid.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenLastCalledWith({ labelAliases: { [key]: 'Example observatory' } });
    const clear = await request(makeApp()).put('/api/eidoverse/world/config').send({ labelAliases: {} });
    expect(clear.status).toBe(200);
    mocks.updateConfig.mockClear();
    for (const labelAliases of [
      { 'Example private app': 'Alias' }, { [key]: 'x'.repeat(73) }, { [key]: '' }, { [key]: 'line\nbreak' },
      Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`app-${i.toString(16).padStart(12, '0')}`, 'Alias'])),
    ]) {
      const rejected = await request(makeApp()).put('/api/eidoverse/world/config').send({ labelAliases });
      expect(rejected.status).toBe(400);
    }
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it('validates scoped reset and asset-refresh actions', async () => {
    const district = await request(makeApp()).put('/api/eidoverse/world/config').send({
      reset: { scope: 'district', districtId: 'apps' },
    });
    const assets = await request(makeApp()).put('/api/eidoverse/world/config').send({ refreshAssets: true });
    const invalid = await request(makeApp()).put('/api/eidoverse/world/config').send({ reset: { scope: 'district' } });
    const custom = await request(makeApp()).put('/api/eidoverse/world/config').send({
      reset: { scope: 'district', districtId: 'example-unknown-district' },
    });
    const malformed = await request(makeApp()).put('/api/eidoverse/world/config').send({
      reset: { scope: 'district', districtId: 'Example Unknown District' },
    });

    expect(district.status).toBe(200);
    expect(assets.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith({ reset: { scope: 'district', districtId: 'apps' } });
    expect(mocks.updateConfig).toHaveBeenCalledWith({ reset: { scope: 'district', districtId: 'example-unknown-district' } });
    expect(mocks.updateConfig).toHaveBeenCalledWith({ refreshAssets: true });
    expect(invalid.status).toBe(400);
    expect(custom.status).toBe(200);
    expect(malformed.status).toBe(400);
  });

  it('accepts explicit install-local asset overrides without making them portable defaults', async () => {
    const payload = {
      assetOverrides: {
        app: 'store/example-local-asset',
        desk: 'store/example-desk',
        barrel: 'store/example-barrel',
        tree: 'store/example-tree',
        operations: 'eidoverse/assets/models/example-legacy-operations.glb',
      },
    };
    const response = await request(makeApp()).put('/api/eidoverse/world/config').send(payload);

    expect(response.status).toBe(200);
    expect(mocks.updateConfig).toHaveBeenCalledWith(payload);
  });

  it('rejects verbs outside the bounded augmentation contract', async () => {
    const res = await request(makeApp()).post('/api/eidoverse/world/augment').send({
      operations: [{ verb: 'behavior', args: {} }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(mocks.augment).not.toHaveBeenCalled();
  });

  it('passes valid augmentation and chat requests to the service', async () => {
    const operations = [{ verb: 'spawn', args: { id: 'example-prop', lib: 'eidoverse/assets/models/example.glb' } }];
    const augmentResponse = await request(makeApp()).post('/api/eidoverse/world/augment').send({ operations });
    const sayResponse = await request(makeApp()).post('/api/eidoverse/world/say').send({ text: 'Example message' });

    expect(augmentResponse.status).toBe(200);
    expect(mocks.augment).toHaveBeenCalledWith(operations);
    expect(sayResponse.status).toBe(200);
    expect(mocks.say).toHaveBeenCalledWith('Example message');
  });

  // #7455 — the promote path's HTTP boundary. What matters here is that the
  // ownership layer and the assay verdict are NOT things a caller can assert.
  it('records a foundation without letting the caller name its ownership layer', async () => {
    const authored = {
      id: 'tide-beacon',
      kind: 'controller',
      title: 'Tide Beacon',
      summary: 'A beacon that keeps pulsing between mind wakes.',
      contributionId: 'beacon-relay-demo',
      body: { affordance: { inspect: 'reads the pulse count' } },
    };
    mocks.recordFoundation.mockResolvedValue({ ...authored, layer: 'vernacular' });

    const accepted = await request(makeApp()).post('/api/eidoverse/world/foundations').send(authored);
    const claimed = await request(makeApp()).post('/api/eidoverse/world/foundations').send({ ...authored, layer: 'baseline' });

    expect(accepted.status).toBe(200);
    expect(mocks.recordFoundation).toHaveBeenCalledWith(expect.objectContaining({ id: 'tide-beacon' }), { originInstanceId: 'instance-aaaa' });
    expect(claimed.status).toBe(400);
    expect(mocks.recordFoundation).toHaveBeenCalledTimes(1);
  });

  it('returns a promote refusal as a verdict, not as a request error', async () => {
    mocks.packageCandidate.mockResolvedValue({ outcome: 'refused', candidate: null, assay: { pass: false }, reasons: ['the agent-free resilience assay failed'], findings: [] });

    const response = await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/candidate');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: false, outcome: 'refused' });
    expect(response.body.reasons[0]).toContain('resilience assay failed');
  });

  it('404s a promote or read for a foundation this install never authored', async () => {
    mocks.packageCandidate.mockResolvedValue({ outcome: 'unknown-foundation', candidate: null, assay: null, reasons: ['no foundation'], findings: [] });
    mocks.getFoundation.mockResolvedValue(null);

    expect((await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/candidate')).status).toBe(404);
    expect((await request(makeApp()).get('/api/eidoverse/world/foundations/tide-beacon')).status).toBe(404);
    // A path that could never be an id must not reach the service at all.
    expect((await request(makeApp()).get('/api/eidoverse/world/foundations/Not An Id')).status).toBe(400);
  });
});
