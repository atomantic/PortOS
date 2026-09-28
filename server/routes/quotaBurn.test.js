import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Real authorization middleware; only credential/settings stores are synthetic.
const auth = vi.hoisted(() => ({
  isAuthEnabled: vi.fn(),
  verifyPassword: vi.fn(async password => password === 'example-password'),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
}));
vi.mock('../services/auth.js', () => auth);
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true,
    syncSecret: 'example-pair-secret-for-tests-only-123456',
  }] })),
}));

const peerHeaders = {
  [PEER_INSTANCE_HEADER]: 'example-instance',
  [PEER_AUTH_HEADER]: derivePeerAuthToken('example-pair-secret-for-tests-only-123456', 'example-instance'),
};

vi.mock('../services/quotaBurnStore.js', () => ({
  getQuotaBurnConfig: vi.fn(),
  saveQuotaBurnConfig: vi.fn(),
}));
vi.mock('../services/quotaBurnRunner.js', () => ({
  getQuotaBurnStatus: vi.fn(),
  runQuotaBurnCycle: vi.fn(),
}));
vi.mock('../services/quotaBurnCompletions.js', () => ({ clearQuotaBurnJobCompletion: vi.fn() }));
vi.mock('../services/quotaBurnConversion.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, convertLegacyQuotaBurnPatch: vi.fn(actual.convertLegacyQuotaBurnPatch) };
});
const jobsStore = vi.hoisted(() => ({ data: { version: 1, jobs: [] } }));
vi.mock('../services/autonomousJobs/store.js', () => ({
  loadJobs: vi.fn(async () => jobsStore.data),
  saveJobs: vi.fn(async data => { jobsStore.data = data; }),
  initJobs: vi.fn(async () => jobsStore.data),
  syncSkillTemplatesFromSample: vi.fn(async () => {}),
}));
vi.mock('../services/apps.js', () => ({ getActiveApps: vi.fn() }));
vi.mock('../services/providers.js', () => ({ listProviders: vi.fn() }));

import { clearQuotaBurnJobCompletion } from '../services/quotaBurnCompletions.js';
import { convertLegacyQuotaBurnPatch } from '../services/quotaBurnConversion.js';
import { getQuotaBurnConfig, saveQuotaBurnConfig } from '../services/quotaBurnStore.js';
import { getQuotaBurnStatus, runQuotaBurnCycle } from '../services/quotaBurnRunner.js';
import { getActiveApps } from '../services/apps.js';
import { listProviders } from '../services/providers.js';
import quotaBurnRoutes from './quotaBurn.js';

const buildApp = (address = '127.0.0.1') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use(hostControlBodyGate);
  app.use('/api/quota-burn', quotaBurnRoutes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthEnabled.mockResolvedValue(false);
  jobsStore.data = { version: 1, jobs: [] };
  getQuotaBurnStatus.mockResolvedValue({
    config: { enabled: false, checkIntervalMinutes: 30, families: {} },
    status: { running: false, families: [], runs: [] },
  });
  getActiveApps.mockResolvedValue([{ id: 'a1', name: 'App One', secret: 'do-not-leak' }]);
  listProviders.mockResolvedValue([{ id: 'claude-code', name: 'Claude Code', type: 'cli' }]);
});

describe('GET /api/quota-burn', () => {
  it('returns the plan and its live status', async () => {
    const res = await request(buildApp()).get('/api/quota-burn');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      config: { enabled: false, checkIntervalMinutes: 30, families: {} },
      status: { running: false, families: [], runs: [] },
    });
    // The status read carries the config, so the route must NOT read the file again.
    expect(getQuotaBurnConfig).not.toHaveBeenCalled();
    expect(getQuotaBurnStatus).toHaveBeenCalledWith({ refresh: false });
  });

  it('passes ?refresh through to the quota scrape', async () => {
    await request(buildApp()).get('/api/quota-burn?refresh=1');
    expect(getQuotaBurnStatus).toHaveBeenCalledWith({ refresh: true });
  });
});

describe('GET /api/quota-burn/catalog', () => {
  it('projects apps and providers, and nothing an app record should not leak', async () => {
    const res = await request(buildApp()).get('/api/quota-burn/catalog');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      apps: [{ id: 'a1', name: 'App One' }],
      providers: [{ id: 'claude-code', name: 'Claude Code', type: 'cli' }],
    });
  });

  it('no longer serves the legacy job catalog or the prompt presets', async () => {
    // #6381 froze both as compatibility-and-migration inputs. Serving them would
    // invite a client to author work that has no executor any more.
    const res = await request(buildApp()).get('/api/quota-burn/catalog');
    expect(res.body.jobTypes).toBeUndefined();
    expect(res.body.presets).toBeUndefined();
  });

  it('still renders when the provider list is unavailable', async () => {
    listProviders.mockRejectedValue(new Error('store down'));
    const res = await request(buildApp()).get('/api/quota-burn/catalog');
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([]);
  });
});

describe('PUT /api/quota-burn', () => {
  it('saves a partial plan', async () => {
    saveQuotaBurnConfig.mockResolvedValue({ enabled: true });
    const jobs = [{ taskRef: { kind: 'builtin', taskType: 'ux', appId: 'a1' } }];
    const res = await request(buildApp()).put('/api/quota-burn')
      .send({ families: { grok: { enabled: true, jobs } } });
    expect(res.status).toBe(200);
    expect(saveQuotaBurnConfig).toHaveBeenCalledWith({ families: { grok: { enabled: true, jobs } } });
  });

  it('accepts the unlimited dispatch cap, which sits below the field\'s own minimum', async () => {
    saveQuotaBurnConfig.mockResolvedValue({ enabled: true });
    const res = await request(buildApp()).put('/api/quota-burn')
      .send({ families: { grok: { maxDispatchesPerWindow: -1 } } });
    expect(res.status).toBe(200);
  });

  it('rejects a dispatch cap of 0 — "never burn" is the family switch, not a cap', async () => {
    const res = await request(buildApp()).put('/api/quota-burn')
      .send({ families: { grok: { maxDispatchesPerWindow: 0 } } });
    expect(res.status).toBe(400);
    expect(saveQuotaBurnConfig).not.toHaveBeenCalled();
  });

  it('rejects an unknown family, an unknown job type, and an out-of-range interval', async () => {
    const app = buildApp();
    expect((await request(app).put('/api/quota-burn').send({ families: { nope: { enabled: true } } })).status).toBe(400);
    expect((await request(app).put('/api/quota-burn').send({ families: { grok: { jobs: [{ jobType: 'rm-rf' }] } } })).status).toBe(400);
    expect((await request(app).put('/api/quota-burn').send({ checkIntervalMinutes: 1 })).status).toBe(400);
    expect(saveQuotaBurnConfig).not.toHaveBeenCalled();
  });

  it('saves a scheduled-task reference step with per-invocation overrides', async () => {
    saveQuotaBurnConfig.mockResolvedValue({ enabled: true });
    const jobs = [{
      id: 'step-1', label: 'Nightly UX sweep', runOnce: true,
      taskRef: { kind: 'builtin', taskType: 'ux', appId: 'a1' },
      overrides: { providerId: 'claude-code-tui', model: 'opus', effort: 'high', params: { fileIssues: true } },
    }];
    const res = await request(buildApp()).put('/api/quota-burn').send({ families: { claude: { enabled: true, jobs } } });
    expect(res.status).toBe(200);
    expect(saveQuotaBurnConfig).toHaveBeenCalledWith({ families: { claude: { enabled: true, jobs } } });
  });

  it('names the offending field when a reference is malformed', async () => {
    const app = buildApp();
    const reject = async (families) => {
      const res = await request(app).put('/api/quota-burn').send({ families });
      expect(res.status).toBe(400);
      return (res.body.context?.details || []).map((d) => d.path);
    };
    // A type that only makes sense against one managed app, with none named.
    expect(await reject({ claude: { jobs: [{ taskRef: { kind: 'builtin', taskType: 'pr-reviewer' } }] } }))
      .toContain('families.claude.jobs.0.taskRef.appId');
    // A custom reference addressed by something that is not a job id.
    expect(await reject({ claude: { jobs: [{ taskRef: { kind: 'custom', jobId: 7 } }] } }))
      .toContain('families.claude.jobs.0.taskRef.jobId');
    // A pin on another family's subscription — the runner would spend it.
    expect(await reject({ claude: { jobs: [{ taskRef: { kind: 'custom', jobId: 'j1' }, overrides: { providerId: 'codex-tui' } }] } }))
      .toContain('families.claude.jobs.0.overrides.providerId');
    // A step that names no work at all, and one that names two kinds of it.
    expect(await reject({ claude: { jobs: [{ label: 'orphan' }] } }))
      .toContain('families.claude.jobs.0.taskRef');
    expect(await reject({ claude: { jobs: [{ jobType: 'agent-prompt', taskRef: { kind: 'custom', jobId: 'j1' } }] } }))
      .toContain('families.claude.jobs.0.jobType');
    expect(saveQuotaBurnConfig).not.toHaveBeenCalled();
  });

  it('accepts an in-family pin, and one whose id names no family at all', async () => {
    // Only an id that unambiguously names ANOTHER family is rejected: the binary
    // decides the family, and a schema cannot read the provider list.
    saveQuotaBurnConfig.mockResolvedValue({ enabled: true });
    const app = buildApp();
    for (const providerId of ['claude-code-tui', 'my-own-wrapper']) {
      const res = await request(app).put('/api/quota-burn')
        .send({ families: { claude: { jobs: [{ taskRef: { kind: 'custom', jobId: 'j1' }, overrides: { providerId } }] } } });
      expect(res.status, providerId).toBe(200);
    }
  });
});

describe('POST /api/quota-burn/run', () => {
  it('evaluates now with no body', async () => {
    runQuotaBurnCycle.mockResolvedValue({ dispatched: false, reason: 'nothing' });
    const res = await request(buildApp()).post('/api/quota-burn/run').send({});
    expect(res.status).toBe(200);
    expect(runQuotaBurnCycle).toHaveBeenCalledWith({ trigger: 'manual', familyId: null, jobId: null, force: false });
  });

  it('refuses force without a family', async () => {
    // force bypasses a SPECIFIC family's quota gates; unscoped it would mean
    // "ignore every gate on every family", which no button should be able to ask for.
    const res = await request(buildApp()).post('/api/quota-burn/run').send({ force: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUOTA_BURN_FORCE_NEEDS_FAMILY');
    expect(runQuotaBurnCycle).not.toHaveBeenCalled();
  });
});

describe('POST /api/quota-burn/rearm', () => {
  it('re-arms one named step and returns the fresh status', async () => {
    const res = await request(buildApp()).post('/api/quota-burn/rearm').send({ familyId: 'grok', jobId: 'job-1' });
    expect(res.status).toBe(200);
    expect(clearQuotaBurnJobCompletion).toHaveBeenCalledWith('grok', 'job-1');
    // The page swaps its badges from this response rather than re-fetching, and
    // re-arming says nothing about the provider's numbers — so no scrape.
    expect(getQuotaBurnStatus).toHaveBeenCalledWith();
    expect(res.body.status).toEqual({ running: false, families: [], runs: [] });
  });

  it('re-arms the whole family when no step is named', async () => {
    await request(buildApp()).post('/api/quota-burn/rearm').send({ familyId: 'grok' });
    expect(clearQuotaBurnJobCompletion).toHaveBeenCalledWith('grok', null);
  });

  it('refuses an unscoped or unknown-family re-arm', async () => {
    // A bare "clear everything" would silently re-queue every one-shot job on
    // the install — real spend nobody asked for.
    const app = buildApp();
    expect((await request(app).post('/api/quota-burn/rearm').send({})).status).toBe(400);
    expect((await request(app).post('/api/quota-burn/rearm').send({ familyId: 'nope' })).status).toBe(400);
    expect(clearQuotaBurnJobCompletion).not.toHaveBeenCalled();
  });

  it('never dispatches anything', async () => {
    await request(buildApp()).post('/api/quota-burn/rearm').send({ familyId: 'grok' });
    expect(runQuotaBurnCycle).not.toHaveBeenCalled();
  });
});

it('accepts a strict claim-drain sequence and rejects non-drainable or repeating steps', async () => {
  saveQuotaBurnConfig.mockResolvedValue({ enabled: true });
  const job = { id: 'claim', runOnce: true, drain: true, taskRef: { kind: 'builtin', taskType: 'claim-issue', appId: 'example-app' } };
  const body = { families: { codex: { sequence: true, jobs: [job] } } };
  expect((await request(buildApp()).put('/api/quota-burn').send(body)).status).toBe(200);
  expect(saveQuotaBurnConfig).toHaveBeenCalledWith(body);
  job.runOnce = false;
  expect((await request(buildApp()).put('/api/quota-burn').send(body)).status).toBe(400);
  job.runOnce = true;
  job.taskRef.taskType = 'documentation';
  expect((await request(buildApp()).put('/api/quota-burn').send(body)).status).toBe(400);
});

describe('Quota Burn operator authority (#9030)', () => {
  const legacy = { families: { grok: { enabled: true, jobs: [{
    id: 'example-step', jobType: 'agent-prompt',
    params: { appId: 'example-app', prompt: 'Review the example app.' },
  }] } } };
  const writes = [
    ['put', '/api/quota-burn', legacy],
    ['post', '/api/quota-burn/run', { familyId: 'grok', jobId: 'example-step', force: true }],
    ['post', '/api/quota-burn/rearm', { familyId: 'grok', jobId: 'example-step' }],
  ];
  const call = (app, [method, path, body], headers = {}) => {
    const req = request(app)[method](path);
    for (const [key, value] of Object.entries(headers)) req.set(key, value);
    return req.send(body);
  };
  const expectNoEffects = () => {
    expect(convertLegacyQuotaBurnPatch).not.toHaveBeenCalled();
    expect(saveQuotaBurnConfig).not.toHaveBeenCalled();
    expect(jobsStore.data.jobs).toEqual([]);
    expect(clearQuotaBurnJobCompletion).not.toHaveBeenCalled();
    expect(runQuotaBurnCycle).not.toHaveBeenCalled();
  };

  it('refuses remote and Vite-relayed callers before conversion or execution in every route spelling', async () => {
    for (const [address, headers] of [
      ['192.0.2.10', {}],
      ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
    ]) {
      for (const [method, path, body] of writes) {
        for (const spelling of [path, path.toUpperCase(), path + '/', path + '//']) {
          const res = await call(buildApp(address), [method, spelling, body], headers);
          expect(res.status, spelling).toBe(403);
          expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
          expectNoEffects();
        }
      }
    }
  });

  it('refuses anonymous, valid legacy Basic and scoped peer credentials when a password is set', async () => {
    auth.isAuthEnabled.mockResolvedValue(true);
    for (const [headers, status, code] of [
      [{}, 401, 'AUTH_REQUIRED'],
      [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [peerHeaders, 403, 'PEER_SCOPE_FORBIDDEN'],
    ]) {
      for (const write of writes) {
        const res = await call(buildApp('192.0.2.10'), write, headers);
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
        expectNoEffects();
      }
    }
  });

  it.each(['local', 'operator session'])('preserves legacy conversion, forced dispatch and rearming for %s', async mode => {
    const session = mode === 'operator session';
    auth.isAuthEnabled.mockResolvedValue(session);
    const app = buildApp(session ? '192.0.2.10' : '127.0.0.1');
    const headers = session ? { Authorization: 'Bearer example-session' } : {};
    saveQuotaBurnConfig.mockImplementation(async patch => patch);
    for (const write of writes) expect((await call(app, write, headers)).status).toBe(200);
    expect(convertLegacyQuotaBurnPatch).toHaveBeenCalledWith(legacy);
    expect(jobsStore.data.jobs).toEqual([expect.objectContaining({
      id: 'job-burn-grok-example-step', appId: 'example-app', type: 'agent',
      enabled: true, autonomyLevel: 'yolo', promptTemplate: 'Review the example app.',
    })]);
    expect(saveQuotaBurnConfig).toHaveBeenCalledWith(expect.objectContaining({
      families: { grok: expect.objectContaining({ jobs: [expect.objectContaining({
        taskRef: { kind: 'custom', jobId: 'job-burn-grok-example-step' },
      })] }) },
    }));
    expect(runQuotaBurnCycle).toHaveBeenCalledWith({
      trigger: 'manual', familyId: 'grok', jobId: 'example-step', force: true,
    });
    expect(clearQuotaBurnJobCompletion).toHaveBeenCalledWith('grok', 'example-step');
  });

  it('keeps status and catalog reads available remotely without a password', async () => {
    const app = buildApp('192.0.2.10');
    for (const path of ['/api/quota-burn', '/api/quota-burn/catalog']) {
      expect((await request(app).get(path)).status).toBe(200);
    }
    expectNoEffects();
  });
});
