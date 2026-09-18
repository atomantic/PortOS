import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  augment: vi.fn(),
  listFoundations: vi.fn(),
  packageCandidate: vi.fn(),
  promoteFoundation: vi.fn(),
  listContributions: vi.fn(),
  recordFoundation: vi.fn(),
  getFoundation: vi.fn(),
  withdrawFoundation: vi.fn(),
  deleteFoundation: vi.fn(),
  ensurePresence: vi.fn(),
  getProjectionStatus: vi.fn(),
  getStatus: vi.fn(),
  project: vi.fn(),
  say: vi.fn(),
  updateConfig: vi.fn(),
  describeControllerDefinitions: vi.fn(),
  listControllers: vi.fn(),
  installController: vi.fn(),
  retireController: vi.fn(),
  armController: vi.fn(),
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
  promoteEidoverseFoundation: mocks.promoteFoundation,
  recordEidoverseFoundation: mocks.recordFoundation,
  withdrawEidoverseFoundation: mocks.withdrawFoundation,
  deleteEidoverseFoundation: mocks.deleteFoundation,
}));

vi.mock('../services/eidoverseResilienceContributions.js', () => ({
  listRegisteredContributionIds: mocks.listContributions,
}));

vi.mock('../services/instanceIdentity.js', () => ({ ensureInstanceId: () => Promise.resolve('instance-aaaa') }));

vi.mock('../services/eidoverseControllerRegistry.js', () => ({
  describeControllerDefinitions: mocks.describeControllerDefinitions,
}));

// `summarizeControllerInstall` stays the REAL, pure projection from
// `lib/eidoverseControllers.js` — it is the one thing #7488 requires the route
// not re-implement, so doubling it here would hide the exact drift the issue
// is guarding against.
vi.mock('../services/eidoverseControllerRuntime.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listEidoverseControllers: mocks.listControllers,
    installEidoverseController: mocks.installController,
    retireEidoverseController: mocks.retireController,
    setEidoverseControllerArmed: mocks.armController,
  };
});

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
    expect(response.body).toMatchObject({ outcome: 'refused' });
    expect(response.body.reasons[0]).toContain('resilience assay failed');
  });

  it('404s a promote or read for a foundation this install never authored', async () => {
    mocks.packageCandidate.mockResolvedValue({ outcome: 'unknown-foundation', candidate: null, assay: null, reasons: ['no foundation'], findings: [] });
    mocks.promoteFoundation.mockResolvedValue({ outcome: 'unknown-foundation', promoted: false, foundation: null, candidate: null, assay: null, reasons: ['no foundation'], findings: [] });
    mocks.getFoundation.mockResolvedValue(null);

    expect((await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/candidate')).status).toBe(404);
    expect((await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/promote')).status).toBe(404);
    expect((await request(makeApp()).get('/api/eidoverse/world/foundations/tide-beacon')).status).toBe(404);
    // A path that could never be an id must not reach the service at all.
    expect((await request(makeApp()).get('/api/eidoverse/world/foundations/Not An Id')).status).toBe(400);
  });
it('reports a promote refusal as a verdict and never moves the layer itself', async () => {
    mocks.promoteFoundation.mockResolvedValue({
      outcome: 'refused', promoted: false, foundation: null, candidate: null, assay: { pass: true },
      reasons: ['already part of the shared baseline'], findings: [],
    });

    const response = await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/promote');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'refused', promoted: false });
    // The route delegates the decision whole — it must not read the id and
    // flip a layer of its own, which would bypass every gate in the service.
    expect(mocks.promoteFoundation).toHaveBeenCalledWith('tide-beacon');
  });

  // #7632 — withdrawal and deletion, the directions promotion never had.
  it('reports a withdrawal as a verdict and delegates the decision whole', async () => {
    mocks.withdrawFoundation.mockResolvedValue({
      outcome: 'withdrawn', foundation: { id: 'tide-beacon', layer: 'vernacular', promotedAt: null }, reasons: [],
    });

    const response = await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/withdraw');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'withdrawn', foundation: { layer: 'vernacular' } });
    expect(mocks.withdrawFoundation).toHaveBeenCalledWith('tide-beacon');
  });

  it('reports a refused withdrawal as a 200 verdict, and an unknown id as a 404', async () => {
    mocks.withdrawFoundation.mockResolvedValueOnce({ outcome: 'refused', foundation: null, reasons: ['inherited copy'] });
    expect((await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/withdraw')).status).toBe(200);

    mocks.withdrawFoundation.mockResolvedValueOnce({ outcome: 'unknown-foundation', foundation: null, reasons: ['no foundation'] });
    expect((await request(makeApp()).post('/api/eidoverse/world/foundations/tide-beacon/withdraw')).status).toBe(404);
  });

  it('deletes a local record by bare id and an inherited copy by its origin', async () => {
    mocks.deleteFoundation.mockResolvedValue({ outcome: 'deleted', foundation: { id: 'tide-beacon' }, withdrawn: true });

    expect((await request(makeApp()).delete('/api/eidoverse/world/foundations/tide-beacon')).status).toBe(200);
    // A bare id means LOCAL work; the inherited copy needs its origin named,
    // because the two id spaces legitimately overlap.
    expect(mocks.deleteFoundation).toHaveBeenLastCalledWith('tide-beacon', { originInstanceId: null });

    await request(makeApp()).delete('/api/eidoverse/world/foundations/tide-beacon?originInstanceId=instance-aaaa');
    expect(mocks.deleteFoundation).toHaveBeenLastCalledWith('tide-beacon', { originInstanceId: 'instance-aaaa' });
  });

  it('rejects a malformed origin before it can be assembled into a storage key', async () => {
    const res = await request(makeApp()).delete('/api/eidoverse/world/foundations/tide-beacon?originInstanceId=not%20an%20id');

    expect(res.status).toBe(400);
    expect(mocks.deleteFoundation).not.toHaveBeenCalled();
  });

  it('serves the registered assay contributions on their own path, where no foundation id can shadow them', async () => {
    mocks.listContributions.mockResolvedValue(['beacon-relay-demo']);
    mocks.getFoundation.mockResolvedValue(null);

    const response = await request(makeApp()).get('/api/eidoverse/world/contributions');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ contributions: ['beacon-relay-demo'] });
    expect(mocks.getFoundation).not.toHaveBeenCalled();
  });

  // --- Controllers: the install surface beside the mind tool (#7488) -------
  describe('controllers', () => {
    const install = (overrides = {}) => ({
      id: 'tide-beacon',
      controllerId: 'resource-tick',
      tickIntervalMs: 300000,
      placement: { districtId: null, anchorEntityId: null },
      config: {},
      deliverEffects: false,
      armed: true,
      note: null,
      installedBy: 'user',
      installedAt: '2026-03-04T05:06:07.000Z',
      updatedAt: '2026-03-04T05:06:07.000Z',
      state: { count: 0 },
      tick: 0,
      nextTickAt: '2026-03-04T05:11:07.000Z',
      lastTickAt: null,
      lastOutcome: null,
      recentEffects: [],
      consecutiveFailures: 0,
      disarmedReason: null,
      ...overrides,
    });

    it('reads the shipped registry and the install list from the same projection the mind tool uses', async () => {
      mocks.describeControllerDefinitions.mockResolvedValue([{ id: 'resource-tick', title: 'Resource tick', summary: 'Ticks a counter.', exampleConfig: {} }]);
      mocks.listControllers.mockResolvedValue({ counts: { total: 1, armed: 1, delivering: 0 }, installs: [install()] });

      const response = await request(makeApp()).get('/api/eidoverse/world/controllers');

      expect(response.status).toBe(200);
      expect(response.body.available).toEqual([{ id: 'resource-tick', title: 'Resource tick', summary: 'Ticks a counter.', exampleConfig: {} }]);
      expect(response.body.counts).toEqual({ total: 1, armed: 1, delivering: 0 });
      expect(response.body.installs).toEqual([expect.objectContaining({ id: 'tide-beacon', armed: true })]);
      // The list projection is state-free — only an install just authored gets it.
      expect(response.body.installs[0].state).toBeUndefined();
    });

    it('refuses an install naming a controller id this version does not ship, with the reason beside the request', async () => {
      mocks.installController.mockResolvedValue({ outcome: 'refused', install: null, reasons: ['no controller is registered under "ghost-controller"'] });

      const response = await request(makeApp()).post('/api/eidoverse/world/controllers').send({ id: 'tide-beacon', controllerId: 'ghost-controller' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'refused', install: null });
      expect(response.body.reasons[0]).toContain('ghost-controller');
      expect(mocks.installController).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tide-beacon', controllerId: 'ghost-controller' }),
        { installedBy: 'user' },
      );
    });

    it('refuses a bad config with its field-level reason before the service is asked to resolve a definition', async () => {
      const response = await request(makeApp()).post('/api/eidoverse/world/controllers').send({ id: 'tide-beacon', controllerId: 'resource-tick', config: 'not-an-object' });

      expect(response.status).toBe(400);
      expect(mocks.installController).not.toHaveBeenCalled();
    });

    it('installs and returns state only on a successful install, through the shared projection', async () => {
      mocks.installController.mockResolvedValue({ outcome: 'installed', install: install(), reasons: [] });

      const response = await request(makeApp()).post('/api/eidoverse/world/controllers').send({ id: 'tide-beacon', controllerId: 'resource-tick' });

      expect(response.status).toBe(200);
      expect(response.body.outcome).toBe('installed');
      expect(response.body.install).toMatchObject({ id: 'tide-beacon', controllerId: 'resource-tick' });
      expect(response.body.install.state).toEqual({ count: 0 });
    });

    it('arms and disarms an install by id, and 404s an unknown install id', async () => {
      mocks.armController.mockResolvedValueOnce({ outcome: 'updated', install: install({ armed: false }), reasons: [] });
      mocks.armController.mockResolvedValueOnce({ outcome: 'unknown-install', install: null, reasons: ['no controller is installed under "ghost-install"'] });

      const armed = await request(makeApp()).patch('/api/eidoverse/world/controllers/tide-beacon').send({ armed: false });
      const unknown = await request(makeApp()).patch('/api/eidoverse/world/controllers/ghost-install').send({ armed: true });

      expect(armed.status).toBe(200);
      expect(armed.body.install).toMatchObject({ armed: false });
      expect(mocks.armController).toHaveBeenCalledWith('tide-beacon', false);
      expect(unknown.status).toBe(404);
    });

    it('renders a supervisor-disarmed reason verbatim through the arm response', async () => {
      mocks.armController.mockResolvedValue({ outcome: 'updated', install: install({ armed: false, disarmedReason: 'failed 3 consecutive ticks: step() threw' }), reasons: [] });

      const response = await request(makeApp()).patch('/api/eidoverse/world/controllers/tide-beacon').send({ armed: false });

      expect(response.body.install.disarmedReason).toBe('failed 3 consecutive ticks: step() threw');
    });

    it('retires an install by id and 404s an unknown install id', async () => {
      mocks.retireController.mockResolvedValueOnce({ outcome: 'retired', install: install(), reasons: [] });
      mocks.retireController.mockResolvedValueOnce({ outcome: 'unknown-install', install: null, reasons: ['no controller is installed under "ghost-install"'] });

      const retired = await request(makeApp()).delete('/api/eidoverse/world/controllers/tide-beacon');
      const unknown = await request(makeApp()).delete('/api/eidoverse/world/controllers/ghost-install');

      expect(retired.status).toBe(200);
      expect(retired.body.outcome).toBe('retired');
      expect(mocks.retireController).toHaveBeenCalledWith('tide-beacon');
      expect(unknown.status).toBe(404);
    });
  });
});
