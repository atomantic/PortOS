import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const settingsDataRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'portos-settings-routes-'));
});
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy({
    ...actual,
    tryReadFileStrict: vi.fn(actual.tryReadFileStrict),
    atomicWrite: vi.fn(actual.atomicWrite),
  }, { dataRoot: settingsDataRoot });
});
afterAll(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(settingsDataRoot, { recursive: true, force: true });
});

const reconcileEidoverseRuntime = vi.hoisted(() => vi.fn(async () => ({ running: true })));
vi.mock('../services/eidoverseRuntime.js', () => ({ reconcileEidoverseRuntime }));

// In-memory settings store backing the mocked service.
let store = {};

vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn(async () => ({ id: 'evt' })) }));

vi.mock('../services/settings.js', async () => {
  const { EventEmitter } = await import('node:events');
  const settingsEvents = new EventEmitter();
  return {
    settingsEvents,
    getSettings: vi.fn(async () => ({ ...store })),
    getSettingsWithStatus: vi.fn(async () => ({ corrupt: false, settings: { ...store } })),
    updateSettings: vi.fn(async (patch) => {
      store = { ...store, ...patch };
      return { ...store };
    }),
    // The PUT handler uses updateSettingsWith so it can merge the multi-owner
    // federation slice per sub-key and re-inject persisted sub-keys this route
    // does not own but the patch omits (see mergeFederationSlice /
    // preserveExternallyOwnedKeys).
    updateSettingsWith: vi.fn(async (mutate) => {
      store = await mutate({ ...store });
      settingsEvents.emit('settings:updated');
      return { ...store };
    }),
  };
});
// Defaults and settings persistence stay real; inventory probes must not spawn
// CLIs or inspect the install's configured providers in a route test.
vi.mock('../services/codeReview.js', async (importOriginal) => ({
  ...await importOriginal(),
  getReviewerCliInstalled: vi.fn(async () => ({})),
  getProviderReviewUnsupported: vi.fn(async () => ({})),
}));
// The settings route now refuses a standing render route naming a peer that
// could never run it (see services/federatedMedia/routingPolicy.js), so this
// suite owns a peer registry. Mocked rather than real: the routing policy loads
// the registry lazily, and letting it fall through would read this developer's
// own data/instances.json.
let peers = [];
vi.mock('../services/instances.js', () => ({ getPeers: vi.fn(async () => peers) }));
vi.mock('../services/aiAssignments.js', () => ({
  getAiAssignments: vi.fn(async () => ({})),
  updateAiAssignment: vi.fn(async () => ({})),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  setCodexParallelLimit: vi.fn(),
  CODEX_PARALLEL_MIN: 1,
  CODEX_PARALLEL_MAX: 8,
  CODEX_PARALLEL_DEFAULT: 2,
}));
vi.mock('../services/datadog.js', () => ({
  hasConfiguredInstances: vi.fn(async () => false),
}));
vi.mock('../services/jira.js', () => ({
  hasConfiguredInstances: vi.fn(async () => false),
}));
vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => ({ isGithub: true, owner: 'example-owner' })),
}));
vi.mock('../services/eidoverse.js', () => ({
  DEFAULT_EIDOVERSE_WORLDS_REPO: 'https://github.com/anima-research/eidoverse-worlds',
  normalizeEidoverseWorldsRepo: vi.fn((url) => url),
  getEidoverseStatus: vi.fn(async () => ({ installed: false, bunAvailable: true, registryAvailable: true })),
  assertEidoverseInstalled: vi.fn(async () => ({ installed: true })),
  setEidoverseWorldsOrigin: vi.fn(async () => ({ appId: 'app-eidoverse' })),
  installEidoverse: vi.fn(async () => ({ installed: true })),
}));
vi.mock('../services/eidoverseHost.js', () => ({
  ensureEidoverseHost: vi.fn(async () => ({ running: true, protocol: 'https', port: 5563 })),
}));
vi.mock('../services/credentialInventory.js', () => ({
  getCredentialInventory: vi.fn(async () => ({ headline: 'Most of PortOS works with no key at all.', credentials: [] })),
}));
// The Beeper feature toggle now reconciles the sweep + realtime transport
// against the gate it just moved (fork issue #1). Mocked here because the real
// module reaches the whole Beeper service graph; what a reconcile actually does
// is covered by services/beeperArming.test.js.
vi.mock('../services/beeperArming.js', () => ({
  reconcileBeeperIngestion: vi.fn(async () => ({ armed: false, changed: false })),
}));
// The interval-change half of fork issue #79: a Beeper save that changes only
// `intervalMinutes` restarts the scheduler directly rather than going through
// `reconcileBeeperIngestion` (that stays reserved for an `enabled` flip). Mocked
// for the same reason `beeperArming.js` is above — what a restart actually does
// is covered by services/beeperScheduler.test.js.
// `isBeeperSchedulerRegistered` defaults to `false` (mimicking a scheduler
// that was never registered) so the existing interval-change tests below,
// which never set this, keep exercising that path; the fork issue #94 test
// under "beeper sync-toggle arming" overrides it to `true` for the
// already-registered case.
vi.mock('../services/beeperScheduler.js', () => ({
  restartBeeperScheduler: vi.fn(async () => {}),
  isBeeperSchedulerRegistered: vi.fn(() => false),
}));

// The iTerm2 bridge connects only while its feature is on (#8114); what a
// reconcile does is covered by services/itermBridge.test.js.
vi.mock('../services/itermBridge.js', () => ({
  reconcileItermBridge: vi.fn(async () => ({ enabled: false, connected: false })),
}));

import settingsRoutes from './settings.js';
import { hostControlBodyGate } from '../services/authGate.js';
import codeReviewRoutes from './codeReview.js';
import { reconcileBeeperIngestion } from '../services/beeperArming.js';
import { reconcileItermBridge } from '../services/itermBridge.js';
import { restartBeeperScheduler, isBeeperSchedulerRegistered } from '../services/beeperScheduler.js';
import { updateSettingsWith } from '../services/settings.js';
import { updateAiAssignment } from '../services/aiAssignments.js';
import { hasConfiguredInstances as hasConfiguredDatadogInstances } from '../services/datadog.js';
import { hasConfiguredInstances as hasConfiguredJiraInstances } from '../services/jira.js';
import { assertEidoverseInstalled, installEidoverse, setEidoverseWorldsOrigin } from '../services/eidoverse.js';
import { ensureEidoverseHost } from '../services/eidoverseHost.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  app.use('/api/code-review', codeReviewRoutes);
  return app;
};

describe('Settings routes — configured reviewer pins', () => {
  it('persists and clears provider model/effort defaults through settings and defaults readback', async () => {
    store = {};
    const app = buildApp();
    const codeReview = {
      reviewers: ['provider:example-reviewer', 'codex'],
      providerModels: { 'provider:example-reviewer': 'example-model' },
      providerEfforts: { 'provider:example-reviewer': 'high' },
      codexModel: 'gpt-5.6-sol', codexEffort: 'low',
    };
    const saved = await request(app).put('/api/settings').send({ codeReview });
    expect(saved.status).toBe(200);
    const defaults = await request(app).get('/api/code-review/defaults');
    expect(defaults.status).toBe(200);
    expect(defaults.body).toMatchObject(codeReview);

    const cleared = { ...codeReview, providerModels: {}, providerEfforts: {} };
    expect((await request(app).put('/api/settings').send({ codeReview: cleared })).status).toBe(200);
    expect((await request(app).get('/api/code-review/defaults')).body).toMatchObject(cleared);
    expect((await request(app).get('/api/settings')).body.codeReview).toEqual(cleared);
  });
});

// The operator-action ledger (#5594) distinguishes a human on the Settings page
// from every other settings writer purely by this argument, so the route has to
// keep passing it. The row it produces is asserted end-to-end in
// services/settings.userActions.test.js.
describe('Settings routes — operator-action actor (#5594)', () => {
  it('marks a settings PUT as a user action', async () => {
    const res = await request(buildApp()).put('/api/settings').send({ timezone: 'America/Los_Angeles' });
    expect(res.status).toBe(200);
    expect(updateSettingsWith).toHaveBeenCalledWith(expect.any(Function), { actor: 'user' });
  });
});

describe('Settings routes — untrusted-content policy', () => {
  beforeEach(() => { store = {}; vi.clearAllMocks(); });
  it('ships classifier-required defaults and persists source-specific constraints', async () => {
    const defaults = await request(buildApp()).get('/api/settings');
    expect(defaults.body.untrustedContent.defaults).toMatchObject({ classifierMode: 'required', minBenignScore: 0.9 });
    const policy = { defaults: { classifierMode: 'required' }, sources: { signal: { providerId: 'local-api', model: 'example-model', maxInputChars: 5000 }, 'github-issue': { classifierMode: 'optional' } } };
    const saved = await request(buildApp()).put('/api/settings').send({ untrustedContent: policy });
    expect(saved.status).toBe(200);
    expect(store.untrustedContent).toEqual(policy);
    const read = await request(buildApp()).get('/api/settings');
    expect(read.body.untrustedContent.sources).toEqual(policy.sources);
  });
  it('rejects invalid or weakening policy shapes before replacing the saved settings', async () => {
    store = { untrustedContent: { defaults: { classifierMode: 'required' } } };
    const previous = structuredClone(store);
    for (const patch of [
      { defaults: { classifierMode: 'off' } },
      { sources: { signal: { maxInputChars: 999999999 } } },
      { sources: { email: { providerId: {} } } },
      { defaults: { minBenignScore: 0.1 } },
      { sources: { unknown: {} } },
    ]) {
      const result = await request(buildApp()).put('/api/settings').send({ untrustedContent: patch });
      expect(result.status).toBe(400);
      expect(store).toEqual(previous);
    }
    expect(updateSettingsWith).not.toHaveBeenCalled();
  });
});

describe('Settings routes — apiAccess slice', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a valid apiAccess patch and persists it', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { voice: { exposed: true, requireAuth: false } } });
    expect(res.status).toBe(200);
    expect(res.body.apiAccess.voice.exposed).toBe(true);
  });

  it('rejects a non-boolean exposed flag', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { voice: { exposed: 'yes' } } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown keys inside an apiAccess entry (strict)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { voice: { open: true } } });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown API id (strict)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { elevenlabs: { exposed: true } } });
    expect(res.status).toBe(400);
  });

  it('GET returns apiAccess (not stripped like secrets)', async () => {
    store = { apiAccess: { sdapi: { exposed: true, requireAuth: false } } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.apiAccess.sdapi.exposed).toBe(true);
  });
});

describe('Settings routes — instance feature participation', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('lists local feature participation with the backward-compatible default', async () => {
    const res = await request(buildApp()).get('/api/settings/features');

    expect(res.status).toBe(200);
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'post', label: 'POST', enabled: true }));
    // Integration-backed features ride the same list; the suite pins their
    // detector responses so this default is independent of this host's setup.
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'datadog', enabled: false, source: 'auto' }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'jira', enabled: false, source: 'auto' }));
    expect(res.body.features).toContainEqual(expect.objectContaining({
      id: 'eidoverse',
      enabled: false,
      setup: expect.objectContaining({ installed: false }),
    }));
    // GSD and OpenClaw ship disabled by default; the install opts in.
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'gsd', enabled: false }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'cos-task-templates', enabled: false, source: 'default' }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'openclaw', enabled: false }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'health', enabled: true }));
    // #40 — iMessage and Signal join the comms group, defaulting to enabled
    // with no settings write, exactly like an existing install saw before.
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'imessage', enabled: true, group: 'comms' }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'signal', enabled: true, group: 'comms' }));
    expect(res.body.groups).toContainEqual(expect.objectContaining({ id: 'comms', enabled: true }));
  });

  it('lists an integration-backed feature as auto-enabled when its detector finds configuration', async () => {
    hasConfiguredDatadogInstances.mockResolvedValueOnce(true);

    const res = await request(buildApp()).get('/api/settings/features');

    expect(res.status).toBe(200);
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'datadog', enabled: true, source: 'auto' }));
  });

  it('detects each integration independently, so one configured integration does not enable another', async () => {
    hasConfiguredJiraInstances.mockResolvedValueOnce(true);

    const res = await request(buildApp()).get('/api/settings/features');

    expect(res.status).toBe(200);
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'jira', enabled: true, source: 'auto' }));
    // Detection is per-feature; a configured JIRA must not switch Datadog on.
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'datadog', enabled: false, source: 'auto' }));
  });

  it('keeps an explicit opt-out off even when the integration is configured', async () => {
    hasConfiguredJiraInstances.mockResolvedValueOnce(true);
    store = { instanceFeatures: { jira: { enabled: false } } };

    const res = await request(buildApp()).get('/api/settings/features');

    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'jira', enabled: false, source: 'explicit' }));
  });

  it('updates one feature without replacing unrelated settings', async () => {
    store = { theme: 'dark', instanceFeatures: { post: { enabled: true } } };

    const res = await request(buildApp())
      .put('/api/settings/features/post')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'post', enabled: false }));
    expect(store).toEqual({ theme: 'dark', instanceFeatures: { post: { enabled: false } } });
    // Only Beeper's own gate is reconciled; an unrelated toggle must not reach
    // into the Beeper service graph at all.
    expect(reconcileBeeperIngestion).not.toHaveBeenCalled();
  });

  it('reconciles Eidoverse when the general settings save changes its feature gate', async () => {
    const res = await request(buildApp()).put('/api/settings')
      .send({ instanceFeatures: { eidoverse: { enabled: true } } });
    expect(res.status).toBe(200);
    expect(store.instanceFeatures.eidoverse.enabled).toBe(true);
    expect(reconcileEidoverseRuntime).toHaveBeenCalledOnce();
  });

  // Fork issue #1, final live pass: the Beeper sweep + realtime transport arm on
  // the instance feature plus a token, and that gate was read at boot only — so
  // turning the feature on left both down until the next restart.
  it('reconciles Beeper ingestion when the Beeper feature is toggled', async () => {
    const res = await request(buildApp())
      .put('/api/settings/features/beeper')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledWith({ reason: 'feature-toggle' });
  });

  // #8114: turning iTerm2 sessions off must drop the live connection now, and a
  // reconcile failure must not turn the already-saved toggle into a 500.
  it('reconciles the iTerm2 bridge when its feature is toggled, without failing the save', async () => {
    reconcileItermBridge.mockRejectedValueOnce(new Error('bridge exploded'));
    const res = await request(buildApp())
      .put('/api/settings/features/iterm')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(reconcileItermBridge).toHaveBeenCalledWith({ reason: 'feature-toggle' });
  });

  // Beeper sits in the Comms group, so the group toggle moves the same gate.
  it('reconciles Beeper ingestion when the Comms group is toggled', async () => {
    const res = await request(buildApp())
      .put('/api/settings/features/groups/comms')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledWith({ reason: 'feature-group-toggle' });
  });

  it('installs and explicitly enables Eidoverse from its consent endpoint', async () => {
    const worldsRepoUrl = 'https://github.com/example-owner/eidoverse-worlds';
    const res = await request(buildApp())
      .post('/api/settings/features/eidoverse/install')
      .send({ worldsRepoUrl });

    expect(res.status).toBe(201);
    expect(installEidoverse).toHaveBeenCalledWith({ worldsRepoUrl });
    expect(store.instanceFeatures.eidoverse.enabled).toBe(true);
    expect(store.instanceFeatures.eidoverse.worldsRepoUrl).toBe(worldsRepoUrl);
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'eidoverse', enabled: true }));
  });

  it.each(['feature/worlds', ''])('persists and forwards clone branch %j', async (worldsBranch) => {
    const worldsRepoUrl = 'https://github.com/example-owner/eidoverse-worlds';
    const res = await request(buildApp())
      .post('/api/settings/features/eidoverse/install')
      .send({ worldsRepoUrl, worldsBranch });

    expect(res.status).toBe(201);
    expect(installEidoverse).toHaveBeenCalledWith({ worldsRepoUrl, worldsBranch });
    expect(store.instanceFeatures.eidoverse.worldsBranch).toBe(worldsBranch);
    expect(res.body.features.find(feature => feature.id === 'eidoverse').setup.worldsBranch).toBe(worldsBranch);
  });

  it('updates the installed Eidoverse source without changing feature participation', async () => {
    const worldsRepoUrl = 'git@github.com:example-owner/eidoverse-worlds.git';
    store = { instanceFeatures: { eidoverse: { enabled: true } } };

    const res = await request(buildApp())
      .put('/api/settings/features/eidoverse/source')
      .send({ worldsRepoUrl });

    expect(res.status).toBe(200);
    expect(setEidoverseWorldsOrigin).toHaveBeenCalledWith(worldsRepoUrl, undefined);
    expect(store.instanceFeatures.eidoverse).toMatchObject({ enabled: true, worldsRepoUrl });
  });

  it('rejects an invalid Eidoverse source update before mutating the checkout', async () => {
    const res = await request(buildApp())
      .put('/api/settings/features/eidoverse/source')
      .send({ worldsRepoUrl: 'https://example.com/not-github' });

    expect(res.status).toBe(400);
    expect(setEidoverseWorldsOrigin).not.toHaveBeenCalled();
  });

  it('opens the Eidoverse host bridge only after verifying the managed app installation', async () => {
    const res = await request(buildApp()).post('/api/settings/features/eidoverse/host');

    expect(res.status).toBe(200);
    expect(assertEidoverseInstalled).toHaveBeenCalledOnce();
    expect(ensureEidoverseHost).toHaveBeenCalledOnce();
    expect(res.body).toEqual({ running: true, protocol: 'https', port: 5563 });
  });

  it('rejects a non-GitHub Worlds repository', async () => {
    const res = await request(buildApp())
      .post('/api/settings/features/eidoverse/install')
      .send({ worldsRepoUrl: 'https://example.com/untrusted.git' });

    expect(res.status).toBe(400);
    expect(installEidoverse).not.toHaveBeenCalled();
  });

  it('rejects unexpected install payload fields', async () => {
    const res = await request(buildApp())
      .post('/api/settings/features/eidoverse/install')
      .send({
        worldsRepoUrl: 'https://github.com/example-owner/eidoverse-worlds',
        repository: 'unexpected',
      });

    expect(res.status).toBe(400);
    expect(installEidoverse).not.toHaveBeenCalled();
  });

  it('clears a grouped feature override back to inherit with enabled: null', async () => {
    store = { instanceFeatures: { facetime: { enabled: true } } };

    const res = await request(buildApp())
      .put('/api/settings/features/facetime')
      .send({ enabled: null });

    expect(res.status).toBe(200);
    expect(store).toEqual({ instanceFeatures: {} });
    // This suite doesn't mock voice/facetimeBridge.js, so only the storage and
    // the no-longer-`explicit` source are pinned — the resolved boolean depends
    // on the real (unmocked) detector's answer on the machine running the test.
    const facetime = res.body.features.find((f) => f.id === 'facetime');
    expect(facetime.source).not.toBe('explicit');
  });

  it('uses iMessage as a grouped feature with no override to prove the same clear-to-inherit path on a feature with no detector', async () => {
    store = { instanceFeatures: { imessage: { enabled: false } } };

    const res = await request(buildApp())
      .put('/api/settings/features/imessage')
      .send({ enabled: null });

    expect(res.status).toBe(200);
    expect(store).toEqual({ instanceFeatures: {} });
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'imessage', enabled: true, source: 'default' }));
  });

  it('toggles the comms feature group and reflects it on the group and member list', async () => {
    const res = await request(buildApp())
      .put('/api/settings/features/groups/comms')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(store).toEqual({ instanceFeatureGroups: { comms: { enabled: false } } });
    expect(res.body.groups).toContainEqual(expect.objectContaining({ id: 'comms', enabled: false }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'imessage', enabled: false, source: 'group-off' }));
  });

  it('lets an explicit per-feature override outrank an off group', async () => {
    store = { instanceFeatureGroups: { comms: { enabled: false } } };

    const res = await request(buildApp())
      .put('/api/settings/features/imessage')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'imessage', enabled: true, source: 'explicit' }));
    // Signal has no override of its own, so it stays hidden by the off group.
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'signal', enabled: false, source: 'group-off' }));
  });

  it('rejects an unknown feature group id and a non-boolean group enabled value', async () => {
    const unknown = await request(buildApp())
      .put('/api/settings/features/groups/not-registered')
      .send({ enabled: false });
    const malformed = await request(buildApp())
      .put('/api/settings/features/groups/comms')
      .send({ enabled: 'false' });
    // Unlike the per-feature route, a group has no inherit state of its own —
    // null is rejected rather than treated as a third value.
    const nullEnabled = await request(buildApp())
      .put('/api/settings/features/groups/comms')
      .send({ enabled: null });

    expect(unknown.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(nullEnabled.status).toBe(400);
    expect(unknown.body.code).toBe('VALIDATION_ERROR');
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
    expect(nullEnabled.body.code).toBe('VALIDATION_ERROR');
  });

  it('validates the instanceFeatureGroups slice on the generic settings PUT', async () => {
    const ok = await request(buildApp())
      .put('/api/settings')
      .send({ instanceFeatureGroups: { comms: { enabled: false } } });
    const malformed = await request(buildApp())
      .put('/api/settings')
      .send({ instanceFeatureGroups: { comms: { enabled: 'nope' } } });
    const unknownGroup = await request(buildApp())
      .put('/api/settings')
      .send({ instanceFeatureGroups: { 'not-a-group': { enabled: false } } });

    expect(ok.status).toBe(200);
    expect(store.instanceFeatureGroups).toEqual({ comms: { enabled: false } });
    expect(malformed.status).toBe(400);
    expect(unknownGroup.status).toBe(400);
  });

  it('rejects unknown feature ids and malformed enabled values', async () => {
    const unknown = await request(buildApp())
      .put('/api/settings/features/not-registered')
      .send({ enabled: false });
    const malformed = await request(buildApp())
      .put('/api/settings/features/post')
      .send({ enabled: 'false' });

    expect(unknown.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(unknown.body.code).toBe('VALIDATION_ERROR');
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });
});

// A peer that satisfies every durable gate the routing policy checks: enabled,
// enabled as a provider, allowlisted for the routed pair, and on the tailnet.
const routablePeer = (overrides = {}) => ({
  id: 'peer-1',
  name: 'Render Box',
  host: 'render-box.tailnet-example.ts.net',
  enabled: true,
  mediaProvider: { enabled: true, imageModels: [{ engine: 'ltx', modelId: 'ltx-1' }], videoModels: [] },
  ...overrides,
});

describe('Settings routes — agent context and federated media provider slices', () => {
  beforeEach(() => {
    store = {};
    peers = [];
    vi.clearAllMocks();
  });

  it('accepts and returns a strict disabled-by-default context configuration', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ agentContext: { enabled: true, profile: 'metadata', scopes: ['navigation', 'workspaces'] } });
    expect(res.status).toBe(200);
    expect(res.body.agentContext).toEqual({
      enabled: true,
      profile: 'metadata',
      scopes: ['navigation', 'workspaces'],
    });
  });

  it('rejects unknown, empty, duplicate, and misspelled scopes', async () => {
    for (const agentContext of [
      { enabled: true, scopes: [] },
      { enabled: true, scopes: ['brain', 'brain'] },
      { enabled: true, scopes: ['privacy-vault'] },
      { enabled: true, scopes: ['navigation'], extra: true },
    ]) {
      const res = await request(buildApp()).put('/api/settings').send({ agentContext });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts a disabled-by-default provider config and preserves future federation keys', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: {
        strictPullAuthorization: true,
        futureFederationField: 'preserve',
        mediaProvider: {
          enabled: false,
          maxQueuedJobs: 2,
          audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3', futureModelField: true }],
          futureProviderField: 'preserve',
        },
      } });
    expect(res.status).toBe(200);
    expect(res.body.federation.mediaProvider).toMatchObject({
      enabled: false,
      maxQueuedJobs: 2,
      futureProviderField: 'preserve',
    });
    expect(res.body.federation.futureFederationField).toBe('preserve');
  });

  // #4703 — Sharing owns federation.mediaProvider + strictPullAuthorization,
  // Instances owns federation.mediaRouting. Each now patches ONLY the sub-keys
  // it owns; the server carries the rest of the slice forward. Two saves issued
  // from the same stale page load must therefore both survive.
  it('merges federation sub-keys so two writes from the same stale page load both survive', async () => {
    const app = buildApp();
    store = { federation: { strictPullAuthorization: false } };
    const route = { peerId: 'peer-1', engine: 'ltx', modelId: 'ltx-1' };
    peers = [routablePeer()];

    const sharing = await request(app)
      .put('/api/settings')
      .send({ federation: { strictPullAuthorization: true } });
    expect(sharing.status).toBe(200);

    // Instances never saw the toggle above — it patches its own sub-key only.
    const routing = await request(app)
      .put('/api/settings')
      .send({ federation: { mediaRouting: { image: route } } });
    expect(routing.status).toBe(200);
    expect(routing.body.federation).toEqual({
      strictPullAuthorization: true,
      mediaRouting: { image: route },
    });
  });

  it('preserves unknown federation sub-keys a patch omits (mixed-version client)', async () => {
    store = { federation: { futureFederationField: 'preserve', strictPullAuthorization: true } };
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaProvider: { enabled: true } } });
    expect(res.status).toBe(200);
    expect(res.body.federation).toEqual({
      futureFederationField: 'preserve',
      strictPullAuthorization: true,
      mediaProvider: { enabled: true },
    });
  });

  it('applies an intentional federation sub-key clear rather than restoring the stored value', async () => {
    store = { federation: {
      mediaRouting: { image: { peerId: 'peer-1', engine: 'ltx', modelId: 'ltx-1' } },
      strictPullAuthorization: true,
    } };
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaRouting: {} } });
    expect(res.status).toBe(200);
    expect(res.body.federation).toEqual({ mediaRouting: {}, strictPullAuthorization: true });
  });

  // #4348 — a standing route is validated where it is SAVED, not only where it
  // is used. An unattended render has no human at the moment it fails, so a
  // route that can never run must not reach disk in the first place.
  it('saves a standing route to an allowlisted model on an enabled tailnet provider', async () => {
    peers = [routablePeer()];
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'ltx', modelId: 'ltx-1' } } } });
    expect(res.status).toBe(200);
    expect(res.body.federation.mediaRouting.image).toEqual({ peerId: 'peer-1', engine: 'ltx', modelId: 'ltx-1' });
  });

  it('refuses a standing route whose model was never allowlisted for that peer', async () => {
    peers = [routablePeer()];
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'ltx', modelId: 'not-allowlisted' } } } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MEDIA_PROVIDER_MODEL_NOT_ALLOWED');
    expect(store.federation).toBeUndefined();
  });

  it('refuses a standing route to a peer reachable outside the tailnet (ADR rule 5)', async () => {
    peers = [routablePeer({ host: undefined, address: '192.0.2.10' })];
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'ltx', modelId: 'ltx-1' } } } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MEDIA_ROUTING_PEER_NOT_TAILNET');
  });

  // Clearing must survive whatever happened to the peer, or a bad route becomes
  // permanent — the exact failure a save-time gate would otherwise create.
  it('still clears a route whose peer has since been unregistered', async () => {
    store = { federation: { mediaRouting: { image: { peerId: 'peer-1', engine: 'ltx', modelId: 'ltx-1' } } } };
    peers = [];
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaRouting: { image: null } } });
    expect(res.status).toBe(200);
    expect(res.body.federation.mediaRouting).toEqual({ image: null });
  });

  it('rejects invalid limits and duplicate engine/model pairs', async () => {
    const invalidLimit = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaProvider: { maxQueuedJobs: 0 } } });
    expect(invalidLimit.status).toBe(400);

    const duplicate = await request(buildApp())
      .put('/api/settings')
      .send({ federation: { mediaProvider: { audioModels: [
        { engine: 'musicgen', modelId: 'm' },
        { engine: 'musicgen', modelId: 'm' },
      ] } } });
    expect(duplicate.status).toBe(400);
  });
});

describe('Settings routes — imageGen.grok slice (#2859)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a valid grok slice and persists it', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { enabled: true, grokPath: '/usr/local/bin/grok', aspectRatio: '16:9' } } });
    expect(res.status).toBe(200);
    expect(res.body.imageGen.grok.enabled).toBe(true);
    expect(res.body.imageGen.grok.aspectRatio).toBe('16:9');
  });

  it('accepts empty-string UI sentinels for path and ratio', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { enabled: false, grokPath: '', aspectRatio: '' } } });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed aspect ratio (would land verbatim in the grok prompt)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { aspectRatio: '16:9; rm -rf /' } } });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean enabled gate', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { enabled: 'yes' } } });
    expect(res.status).toBe(400);
  });

  it('leaves an imageGen patch without a grok key unvalidated (polymorphic parent)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { mode: 'local' } });
    expect(res.status).toBe(200);
  });
});

describe('Settings routes — imageGen.agy slice', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a valid Agy slice and persists the selected model', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { agy: { enabled: true, agyPath: '/usr/local/bin/agy', model: 'gemini/image-v2' } } });
    expect(res.status).toBe(200);
    expect(res.body.imageGen.agy).toEqual(expect.objectContaining({
      enabled: true,
      model: 'gemini/image-v2',
    }));
  });

  it('accepts empty-string UI sentinels for path and model', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { agy: { enabled: false, agyPath: '', model: '' } } });
    expect(res.status).toBe(200);
  });

  it('rejects a model id containing shell syntax', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { agy: { model: 'gemini; rm -rf /' } } });
    expect(res.status).toBe(400);
  });
});

describe('Settings routes — imageGen.local.pythonPath (#8751)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('refuses a pythonPath that is not a python interpreter, persisting nothing', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { local: { pythonPath: '/bin/sh' } } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PYTHON_PATH');
    expect(store.imageGen).toBeUndefined();
  });

  it('accepts a venv interpreter and a cleared value', async () => {
    for (const pythonPath of ['/opt/example/.venv/bin/python3.12', '']) {
      const res = await request(buildApp())
        .put('/api/settings')
        .send({ imageGen: { local: { pythonPath } } });
      expect(res.status).toBe(200);
    }
  });
});

describe('Settings routes — renderDefaults slice (#3231)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts per-target backend + model pins and persists them', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ renderDefaults: {
        'universe-bible': { imageMode: 'codex' },
        'sprite-reference': { imageMode: 'agy', imageModel: 'gemini-3.6-flash-low' },
      } });
    expect(res.status).toBe(200);
    expect(res.body.renderDefaults).toEqual({
      'universe-bible': { imageMode: 'codex' },
      'sprite-reference': { imageMode: 'agy', imageModel: 'gemini-3.6-flash-low' },
    });
  });

  it('tolerates and preserves unknown target keys (forward compat after rollback)', async () => {
    // A newer build's target (or field) must not 400 every Image Gen save on
    // an older build — the UI round-trips the whole stored object. Unknown
    // keys pass validation and persist raw, so the newer pins survive.
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ renderDefaults: { 'future-target': { imageMode: 'codex' }, 'universe-bible': { imageMode: 'codex', futureField: 'x' } } });
    expect(res.status).toBe(200);
    expect(res.body.renderDefaults['future-target']).toEqual({ imageMode: 'codex' });
    expect(res.body.renderDefaults['universe-bible'].futureField).toBe('x');
  });

  it('rejects a non-queueable backend and a shell-syntax model id', async () => {
    const external = await request(buildApp())
      .put('/api/settings')
      .send({ renderDefaults: { 'universe-bible': { imageMode: 'external' } } });
    expect(external.status).toBe(400);
    const shell = await request(buildApp())
      .put('/api/settings')
      .send({ renderDefaults: { 'universe-bible': { imageModel: 'x; rm -rf /' } } });
    expect(shell.status).toBe(400);
  });

  it('accepts a per-target video backend pin and rejects a non-video backend (#3231 Phase 4)', async () => {
    const ok = await request(buildApp())
      .put('/api/settings')
      .send({ renderDefaults: { 'music-video': { videoMode: 'grok' } } });
    expect(ok.status).toBe(200);
    expect(ok.body.renderDefaults['music-video']).toEqual({ videoMode: 'grok' });
    const bad = await request(buildApp())
      .put('/api/settings')
      .send({ renderDefaults: { 'music-video': { videoMode: 'codex' } } });
    expect(bad.status).toBe(400);
  });
});

describe('Settings routes — videoGen slice (#3231 Phase 4)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts the install-wide video pin fields and the null clear', async () => {
    // NOTE: the settings PUT replaces top-level slices wholesale, so sibling-key
    // preservation (defaultModelId surviving a mode-only save) is the CLIENT's
    // job — ImageGenTab round-trips the loaded slice (videoGenSliceRef); the
    // client suite pins that wire body. This test only pins schema acceptance.
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ videoGen: { mode: 'grok', defaultModelId: 'ltx23_distilled_q4' } });
    expect(res.status).toBe(200);
    expect(res.body.videoGen).toEqual({ mode: 'grok', defaultModelId: 'ltx23_distilled_q4' });
    // Clearing via null is the intentional no-pin state.
    const cleared = await request(buildApp())
      .put('/api/settings')
      .send({ videoGen: { mode: null } });
    expect(cleared.status).toBe(200);
  });

  it('rejects a non-video backend as the install-wide video pin', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ videoGen: { mode: 'codex' } });
    expect(res.status).toBe(400);
  });

  // Restricted-model license acknowledgements are owned by
  // /api/video-gen/model-terms. Losing them to an unrelated Settings save would
  // silently start 403ing every gated render again.
  it('preserves acceptedModelTerms when a settings save replaces the videoGen slice without it', async () => {
    store = { videoGen: { mode: null, acceptedModelTerms: ['minimax-h3-community-license-2026-08-02'] } };
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ videoGen: { mode: 'grok' } });
    expect(res.status).toBe(200);
    expect(res.body.videoGen).toEqual({
      mode: 'grok',
      acceptedModelTerms: ['minimax-h3-community-license-2026-08-02'],
    });
  });

  // /api/video-gen/model-terms is where an id is checked against a model that
  // actually declares it, so this route can't be a second write path — it would
  // let arbitrary strings accumulate in the list that authorizes renders.
  it('ignores an acceptedModelTerms written through the settings patch', async () => {
    store = { videoGen: { acceptedModelTerms: ['recorded-license'] } };
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ videoGen: { acceptedModelTerms: ['smuggled-license'] } });
    expect(res.status).toBe(200);
    expect(res.body.videoGen.acceptedModelTerms).toEqual(['recorded-license']);
  });

  it('does not let a settings patch mint the list on an install that has accepted nothing', async () => {
    store = { videoGen: { mode: null } };
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ videoGen: { mode: 'local', acceptedModelTerms: ['smuggled-license'] } });
    expect(res.status).toBe(200);
    expect(res.body.videoGen).toEqual({ mode: 'local' });
  });
});

describe('Settings routes — beeper slice (#30)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a valid beeper slice and persists it', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 10, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 } });
    expect(res.status).toBe(200);
    expect(res.body.beeper).toEqual({ enabled: true, intervalMinutes: 10, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 });
  });

  it('rejects a non-boolean enabled gate', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: 'yes' } });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range interval', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { intervalMinutes: 0 } });
    expect(res.status).toBe(400);
  });

  // The security-load-bearing case (#30/#31): this slice must never add a
  // plaintext write path for the token, and `.strict()` is what enforces it —
  // a client attempting to smuggle one through the generic settings route
  // gets a 400, not a silent write to disk.
  it('rejects a beeper patch that carries a token — no plaintext write path through this route', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, token: 'smuggled-token' } });
    expect(res.status).toBe(400);
  });

  it('never echoes a stored beeper token back on GET /api/settings', async () => {
    store = { beeper: { enabled: true, token: 'super-secret-token' } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.beeper.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/super-secret-token/);
  });

  // Without this, the generic top-level shallow merge would REPLACE
  // current.beeper wholesale and silently wipe out a token stored by another
  // write path (#31's vault, or a hand-edited settings.json) the instant the
  // user saves an unrelated field like `enabled` from this slice's settings
  // card — same posture as imageGen.hfToken / civitai.apiKey above. The
  // ordinary ingestion-config fields (baseUrl, intervalMinutes,
  // attachmentBudgetGb) follow the existing iMessage/Signal convention
  // instead: the settings card always PUTs its complete known slice, so
  // there's no separate "don't drop this on a partial patch" guard for them.
  it('preserves a stored token across a beeper patch that only touches other fields', async () => {
    store = { beeper: { enabled: false, token: 'existing-token' } };
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true } });
    expect(res.status).toBe(200);
    // The response itself redacts the token (see the GET test above); assert
    // against the mocked store, which reflects what was actually persisted.
    expect(store.beeper).toEqual({ enabled: true, token: 'existing-token' });
  });
});

// The general settings PUT persists `settings.beeper.enabled` but, unlike the
// feature and comms-group toggles above, used to never reconcile arming — so a
// save made right after connecting (enabled still false at that point) left
// the sweep unregistered until the next restart. These pin the fix: reconcile
// only fires when the effective (boolean-coerced) value actually changes.
describe('Settings routes — beeper sync-toggle arming', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('reconnects after a saved endpoint change without requiring a sync-toggle change', async () => {
    store = { beeper: { enabled: true, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373' } };
    const res = await request(buildApp()).put('/api/settings').send({
      beeper: { ...store.beeper, baseUrl: 'http://127.0.0.1:23374' },
    });
    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledWith({ reason: 'connection-settings', restartSocket: true });
    expect(updateSettingsWith.mock.invocationCallOrder[0]).toBeLessThan(reconcileBeeperIngestion.mock.invocationCallOrder[0]);
  });

  it('reconciles a group gate changed through the general settings route', async () => {
    store = { instanceFeatureGroups: { comms: { enabled: true } } };
    const res = await request(buildApp()).put('/api/settings').send({
      instanceFeatureGroups: { comms: { enabled: false } },
    });
    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledWith({ reason: 'connection-settings', restartSocket: false });
  });

  it('reconciles once, after the settings are persisted, when enabled flips false→true', async () => {
    store = { beeper: { enabled: false, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 5 } });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledTimes(1);
    expect(reconcileBeeperIngestion).toHaveBeenCalledWith({ reason: 'sync-toggle' });
    // Ordering: the write must land before the reconcile fires, so the
    // scheduler's own settings re-read (and the reconcile itself) see the
    // value that was actually persisted, not the request body.
    const [writeOrder] = updateSettingsWith.mock.invocationCallOrder;
    const [reconcileOrder] = reconcileBeeperIngestion.mock.invocationCallOrder;
    expect(writeOrder).toBeLessThan(reconcileOrder);
  });

  // Registering the scheduler is `reconcileBeeperArming`'s job; stopping it on
  // a true→false flip is not — `reconcileBeeperIngestion` only disarms on the
  // feature+token gate, not on this opt-in (see beeperArming.js), so it is the
  // scheduler's own per-tick `getBeeperSyncConfig()` re-read that actually
  // stops runs here. This still calls reconcile, for symmetry and so the
  // transition is logged/serialized on the same tail as every other trigger.
  it('reconciles once when enabled flips true→false', async () => {
    store = { beeper: { enabled: true, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: false, intervalMinutes: 5 } });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledTimes(1);
    expect(reconcileBeeperIngestion).toHaveBeenCalledWith({ reason: 'sync-toggle' });
  });

  it('does not reconcile arming when a save leaves enabled unchanged (interval-only)', async () => {
    store = { beeper: { enabled: true, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 15 } });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).not.toHaveBeenCalled();
  });

  it('does not fail the PUT when the reconcile rejects', async () => {
    reconcileBeeperIngestion.mockRejectedValueOnce(new Error('boom'));
    store = { beeper: { enabled: false, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 5 } });

    expect(res.status).toBe(200);
    expect(res.body.beeper.enabled).toBe(true);
  });

  // Fork issue #94: a true→false save leaves the scheduler registered (see
  // "reconciles once when enabled flips true→false" above) — it just gates
  // per tick — so a false→true flip right after finds
  // `isBeeperSchedulerRegistered()` already true and the reconcile is a no-op
  // for the scheduler. When this save also changes the interval, the still-
  // registered event is holding the stale `intervalMs`, so the route has to
  // restart the scheduler explicitly, after reconciling, to pick up what was
  // just persisted.
  it('restarts the scheduler, after reconciling, when enabled flips and the interval changes on an already-registered scheduler', async () => {
    isBeeperSchedulerRegistered.mockReturnValueOnce(true);
    store = { beeper: { enabled: false, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 15 } });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledTimes(1);
    expect(restartBeeperScheduler).toHaveBeenCalledTimes(1);
    const [reconcileOrder] = reconcileBeeperIngestion.mock.invocationCallOrder;
    const [restartOrder] = restartBeeperScheduler.mock.invocationCallOrder;
    expect(reconcileOrder).toBeLessThan(restartOrder);
  });
});

// Fork issue #79's other half: an interval-only save (no `enabled` flip) used
// to take effect only at the next process restart, because the registered
// event's `intervalMs` is locked in at `schedule()` time and
// `startBeeperScheduler()` deliberately no-ops once `beeper-sync` is already
// registered. `restartBeeperScheduler()` (cancel, then register fresh) is the
// fix; this describe block pins WHEN the route calls it, not what it does —
// that lives in services/beeperScheduler.test.js.
describe('Settings routes — beeper interval change', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('restarts the scheduler, after the settings are persisted, when only the interval changes', async () => {
    store = { beeper: { enabled: true, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 15 } });

    expect(res.status).toBe(200);
    expect(restartBeeperScheduler).toHaveBeenCalledTimes(1);
    expect(reconcileBeeperIngestion).not.toHaveBeenCalled();
    // Same ordering requirement as the arming reconcile: the restart has to
    // read the interval AFTER it lands on disk, or a fast save/restart race
    // could re-register against the value that was about to be overwritten.
    const [writeOrder] = updateSettingsWith.mock.invocationCallOrder;
    const [restartOrder] = restartBeeperScheduler.mock.invocationCallOrder;
    expect(writeOrder).toBeLessThan(restartOrder);
  });

  it('does not restart the scheduler when the interval is unchanged', async () => {
    store = { beeper: { enabled: true, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 5 } });

    expect(res.status).toBe(200);
    expect(restartBeeperScheduler).not.toHaveBeenCalled();
  });

  // With the scheduler not yet registered (`isBeeperSchedulerRegistered()`
  // defaults to `false` in this file's mock — a fresh install / first
  // enable), the `enabled`-flip branch's reconcile does the fresh
  // registration itself and picks up the just-persisted interval, so
  // restarting the scheduler too would just cancel and re-register a second
  // time for nothing. When the scheduler IS already registered going in, the
  // route restarts it explicitly — see the "already-registered scheduler"
  // test under "beeper sync-toggle arming" above (fork issue #94).
  it('does not also restart the scheduler when enabled flips, even if the interval changed in the same save', async () => {
    store = { beeper: { enabled: false, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 15 } });

    expect(res.status).toBe(200);
    expect(reconcileBeeperIngestion).toHaveBeenCalledTimes(1);
    expect(restartBeeperScheduler).not.toHaveBeenCalled();
  });

  it('does not fail the PUT when the scheduler restart rejects', async () => {
    restartBeeperScheduler.mockRejectedValueOnce(new Error('boom'));
    store = { beeper: { enabled: true, intervalMinutes: 5 } };

    const res = await request(buildApp())
      .put('/api/settings')
      .send({ beeper: { enabled: true, intervalMinutes: 20 } });

    expect(res.status).toBe(200);
    expect(res.body.beeper.intervalMinutes).toBe(20);
  });
});

describe('Settings routes — credential inventory', () => {
  it('returns presence and source without secret values', async () => {
    const { getCredentialInventory } = await import('../services/credentialInventory.js');
    getCredentialInventory.mockResolvedValueOnce({
      headline: 'Most of PortOS works with no key at all.',
      credentials: [{
        id: 'huggingface',
        label: 'Hugging Face',
        unlocks: 'Downloads',
        tier: 'free',
        getUrl: 'https://huggingface.co/settings/tokens',
        configurePath: '/media/image?settings=1',
        feature: null,
        configured: true,
        source: 'settings',
        unavailableFeatures: [],
      }],
    });
    const res = await request(buildApp()).get('/api/settings/credentials');
    expect(res.status).toBe(200);
    expect(res.body.headline).toMatch(/no key at all/i);
    expect(res.body.credentials[0]).toMatchObject({ id: 'huggingface', configured: true, source: 'settings' });
    expect(JSON.stringify(res.body)).not.toMatch(/hf_|sk-|ghp_/);
  });
});

describe('Settings routes — hideFirstRunCard (#5640)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a boolean durable suppress on the general settings record', async () => {
    const res = await request(buildApp()).put('/api/settings').send({ hideFirstRunCard: true });
    expect(res.status).toBe(200);
    expect(res.body.hideFirstRunCard).toBe(true);
  });

  it('rejects a non-boolean hideFirstRunCard', async () => {
    const res = await request(buildApp()).put('/api/settings').send({ hideFirstRunCard: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('Settings routes — orchestration profiles (#5992)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('GET /api/settings/orchestration-profiles returns profiles including built-ins', async () => {
    const res = await request(buildApp()).get('/api/settings/orchestration-profiles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(p => p.id === 'heavy-planner')).toBe(true);
  });

  it('POST /api/settings/orchestration-profiles saves a valid profile', async () => {
    const payload = {
      id: 'custom-team',
      name: 'Custom Team',
      description: 'Opus + Sonnet',
      profile: {
        architect: { provider: 'anthropic', model: 'claude-3-opus', effort: 'max' },
        implementer: { provider: 'anthropic', model: 'claude-3-5-sonnet', effort: 'low' },
      },
    };
    const res = await request(buildApp()).post('/api/settings/orchestration-profiles').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('custom-team');
    expect(store.orchestrationProfiles?.some(p => p.id === 'custom-team')).toBe(true);
  });

  it('POST rejects an invalid role reasoning effort', async () => {
    const payload = {
      id: 'bad-effort',
      name: 'Bad',
      profile: {
        architect: { effort: 'invalid-rung' },
      },
    };
    const res = await request(buildApp()).post('/api/settings/orchestration-profiles').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /api/settings validates orchestrationProfiles array', async () => {
    const res = await request(buildApp()).put('/api/settings').send({
      orchestrationProfiles: [{
        id: 'valid',
        name: 'Valid Profile',
        profile: {
          architect: { effort: 'high' },
        },
      }],
    });
    expect(res.status).toBe(200);
  });
});


it('accepts only registered private keys and never returns the submitted secret', async () => {
  const { getCredentialInventory } = await import('../services/credentialInventory.js');
  getCredentialInventory.mockResolvedValue({ credentials: [{ id: 'artificial-analysis', configured: true, source: 'settings', editable: true }] });
  const app = buildApp();
  const result = await request(app).put('/api/settings/credentials/artificial-analysis').send({ value: 'example-private-key' });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ configured: true });
  expect(JSON.stringify(result.body)).not.toContain('example-private-key');
  expect(store.secrets.artificialAnalysis.apiKey).toBe('example-private-key');
  const publicSettings = await request(app).get('/api/settings');
  expect(JSON.stringify(publicSettings.body)).not.toContain('example-private-key');
  expect((await request(app).put('/api/settings/credentials/auth').send({ value: 'example' })).status).toBe(400);
  expect((await request(app).put('/api/settings/credentials/civitai').send({ value: {}, extra: true })).status).toBe(400);
  await request(app).put('/api/settings/credentials/artificial-analysis').send({ value: '' });
  expect(store.secrets.artificialAnalysis.apiKey).toBe('');
});

describe('Settings routes — optional networking preference', () => {
  beforeEach(() => { store = {}; vi.clearAllMocks(); });
  it('persists all supported choices and rejects invalid preferences without replacing the saved choice', async () => {
    for (const networkSetupPreference of ['tailscale', 'tailcat', 'none']) {
      const saved = await request(buildApp()).put('/api/settings').send({ networkSetupPreference });
      expect(saved.status).toBe(200);
      const loaded = await request(buildApp()).get('/api/settings');
      expect(loaded.body.networkSetupPreference).toBe(networkSetupPreference);
    }
    const invalid = await request(buildApp()).put('/api/settings').send({ networkSetupPreference: 'invalid' });
    expect(invalid.status).toBe(400);
    expect(store.networkSetupPreference).toBe('none');
  });
});

describe('Settings routes — backup schedule resolution (#6632)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  // The stored slice is sparse — the user only ever typed a destination. The
  // screen used to read that as "disabled, 02:00" while the scheduler read it as
  // "enabled, midnight", so the screen's next save cancelled a running schedule.
  it('projects the scheduler-compatible effective schedule for a destination-only config', async () => {
    store = { backup: { destPath: '/example-backups' } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.body.backup).toMatchObject({
      destPath: '/example-backups',
      enabled: true,
      cronExpression: '0 0 * * *'
    });
  });

  it('leaves an explicit disable and a custom cron untouched', async () => {
    store = { backup: { destPath: '/example-backups', enabled: false, cronExpression: '0 3 * * *' } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.body.backup).toMatchObject({ enabled: false, cronExpression: '0 3 * * *' });
  });

  it('resolves a null destination when none is configured', async () => {
    const res = await request(buildApp()).get('/api/settings');
    expect(res.body.backup).toMatchObject({ destPath: null, enabled: true, cronExpression: '0 0 * * *' });
  });

  // #8334: an install that predates the retention setting has no stored value —
  // that must resolve to unlimited (null), never to the new-install default of
  // 30. A migration/reference-seed is what gives a genuinely new install 30 on
  // disk; the resolver itself must never invent that default for an absence.
  it('resolves retentionCount to null (unlimited) when absent', async () => {
    store = { backup: { destPath: '/example-backups' } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.body.backup.retentionCount).toBeNull();
  });

  it('preserves an explicitly stored retentionCount', async () => {
    store = { backup: { destPath: '/example-backups', retentionCount: 14 } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.body.backup.retentionCount).toBe(14);
  });

  it('rejects an out-of-range retentionCount on save', async () => {
    const res = await request(buildApp()).put('/api/settings').send({ backup: { retentionCount: 366 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('accepts an explicit null retentionCount (operator choosing Unlimited) on save', async () => {
    store = { backup: { destPath: '/example-backups', retentionCount: 30 } };
    const res = await request(buildApp()).put('/api/settings').send({ backup: { retentionCount: null } });
    expect(res.status).toBe(200);
    expect(store.backup.retentionCount).toBeNull();
  });

  // Resolution is read-time only: the sparse shape survives on disk, so an older
  // peer/client reading settings.json still sees exactly what it wrote.
  it('does not persist the resolved values back into the store', async () => {
    store = { backup: { destPath: '/example-backups' } };
    await request(buildApp()).get('/api/settings');
    expect(store.backup).toEqual({ destPath: '/example-backups' });
  });

  // The round trip the bug actually took: read the effective values, edit only an
  // exclusion, save. The saved slice must still register the same schedule.
  it('keeps schedule eligibility when only an exclusion is edited and saved back', async () => {
    store = { backup: { destPath: '/example-backups' } };
    const loaded = await request(buildApp()).get('/api/settings');
    const saved = await request(buildApp())
      .put('/api/settings')
      .send({ backup: { ...loaded.body.backup, excludePaths: ['/scratch'] } });
    expect(saved.status).toBe(200);
    expect(store.backup).toMatchObject({ enabled: true, cronExpression: '0 0 * * *', destPath: '/example-backups' });
  });
});

describe('Settings routes — backup excludePaths bounds (#7241)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  // These are rsync filter patterns handed straight to `--exclude`. A `..`
  // segment walks out of the data root and a NUL truncates the argument, so the
  // boundary rejects rather than sanitizes — a silently-trimmed pattern would
  // exclude something other than what the user typed.
  it.each([
    ['a parent-directory escape', ['../../etc']],
    ['a nested parent-directory escape', ['a/../../b']],
    ['a NUL byte', [`repos${String.fromCharCode(0)}/etc`]],
    ['a blank entry', ['']],
    ['a pattern that overflows the cap once anchored', ['x'.repeat(256)]],
    ['a pattern far past the cap', ['/'.padEnd(300, 'x')]],
  ])('rejects %s', async (_label, excludePaths) => {
    const res = await request(buildApp()).put('/api/settings').send({ backup: { excludePaths } });
    expect(res.status).toBe(400);
    expect(store.backup).toBeUndefined();
  });

  it('accepts anchored and wildcard-led patterns and stores them as typed', async () => {
    const excludePaths = ['/repos/', '**/raw/', 'cache/'];
    const res = await request(buildApp()).put('/api/settings').send({ backup: { excludePaths } });
    expect(res.status).toBe(200);
    // Stored verbatim — anchoring is a read-time concern in
    // `computeEffectiveExcludes`, so nothing is rewritten under the user.
    expect(store.backup.excludePaths).toEqual(excludePaths);
  });
});

it('generic settings updates cannot replace the password-risk revision', async () => {
  store = { passwordRiskRevision: 'current-revision' };
  const res = await request(buildApp()).put('/api/settings').send({ passwordRiskRevision: 'old-revision' });
  expect(res.status).toBe(200);
  expect(store.passwordRiskRevision).toBe('current-revision');
});

describe('autofixer settings slice', () => {
  it('round-trips promotion options without losing provider selection on independent saves', async () => {
    const app = buildApp();
    expect((await request(app).put('/api/settings').send({ autofixer: { providerId: 'example-cli', model: 'example-model' } })).status).toBe(200);
    expect((await request(app).put('/api/settings').send({ autofixer: { autoPromote: true, verifyCommand: 'npm test' } })).status).toBe(200);
    expect((await request(app).put('/api/settings').send({ autofixer: { model: 'another-model' } })).status).toBe(200);
    const loaded = await request(app).get('/api/settings');
    expect(loaded.body.autofixer).toEqual({ providerId: 'example-cli', model: 'another-model', autoPromote: true, verifyCommand: 'npm test' });
    expect((await request(app).put('/api/settings').send({ autofixer: { autoPromote: 'true' } })).status).toBe(400);
    expect((await request(app).get('/api/settings')).body.autofixer).toEqual(loaded.body.autofixer);
  });
});


// Real queued persistence through HTTP: a mock merge cannot prove independent
// requests retain each other's changes or refuse corrupt on-disk snapshots.
describe('Settings routes — atomic partial saves (#11045)', () => {
  let actual;
  let fs;
  let settingsFile;
  let fileUtils;
  let originalMutation;
  beforeEach(async () => {
    actual = await vi.importActual('../services/settings.js');
    fs = await import('node:fs');
    settingsFile = (await import('node:path')).join(settingsDataRoot, 'settings.json');
    fileUtils = await import('../lib/fileUtils.js');
    originalMutation = updateSettingsWith.getMockImplementation();
    updateSettingsWith.mockImplementation(actual.updateSettingsWith);
    vi.clearAllMocks();
    fs.writeFileSync(settingsFile, JSON.stringify({
      localLlm: { ollama: { disabled: true }, mtplx: { launch: { model: 'example-model' }, idleMinutes: 20 } },
      imageGen: { local: { pythonPath: '/example/python3', denoise: true }, codex: { enabled: true } },
      pipeline: { videoGen: { mode: 'i2v' } },
      secrets: { example: 'private-placeholder' },
      timezone: 'UTC',
    }));
    actual.__resetSettingsCache();
  });
  afterEach(() => {
    updateSettingsWith.mockImplementation(originalMutation);
    fileUtils.tryReadFileStrict.mockRestore();
    fileUtils.atomicWrite.mockRestore();
  });
  const patch = (app, slicePath, partial) => request(app).patch('/api/settings/slice').send({ slicePath, partial });
  const persisted = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

  it('retains sibling runtimes and keys when separate clients patch concurrently', async () => {
    const emitted = vi.fn();
    actual.settingsEvents.on('settings:updated', emitted);
    try {
      const responses = await Promise.all([
        patch(buildApp(), 'localLlm.ollama', { disabled: false }),
        patch(buildApp(), 'localLlm.mtplx', { idleMinutes: 5 }),
        patch(buildApp(), 'localLlm.mtplx', { keepLoaded: true }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
      expect(persisted()).toMatchObject({
        localLlm: { ollama: { disabled: false }, mtplx: { launch: { model: 'example-model' }, idleMinutes: 5, keepLoaded: true } },
        timezone: 'UTC',
      });
      expect(emitted).toHaveBeenCalledTimes(3);
      await actual.flushSettingsLedger();
      const { recordUserAction } = await import('../services/userActions.js');
      expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings.update', actor: 'user' }));
    } finally {
      actual.settingsEvents.off('settings:updated', emitted);
    }
  });

  it('keeps unrelated fields, permits explicit clearing, and reconciles saved settings', async () => {
    const app = buildApp();
    expect((await patch(app, 'imageGen.local', { pythonPath: null })).status).toBe(200);
    expect((await patch(app, 'localLlm.mtplx', { launch: {} })).status).toBe(200);
    expect((await patch(app, 'pipeline', { imageGen: { mode: 'external', quantize: '5', cfgScale: 7, steps: '' } })).status).toBe(200);
    expect((await patch(app, 'pipeline', { imageGen: null })).status).toBe(200);
    expect((await patch(app, 'seriesAutopilot', { schedules: [] })).status).toBe(200);
    expect(persisted()).toMatchObject({
      imageGen: { local: { pythonPath: null, denoise: true }, codex: { enabled: true } },
      localLlm: { mtplx: { launch: {}, idleMinutes: 20 } },
      pipeline: { imageGen: null, videoGen: { mode: 'i2v' } },
      seriesAutopilot: { schedules: [] },
    });
    const { setCodexParallelLimit } = await import('../services/mediaJobQueue/index.js');
    expect(setCodexParallelLimit).toHaveBeenCalled();
    const saved = await actual.getSettings();
    expect(saved.secrets.example).toBe('private-placeholder');
  });

  // The Media settings drawer saves one slice per changed field group; a
  // sibling panel's later write to a field the drawer did not touch must
  // survive, and a cleared render-target pin travels as an explicit null.
  it('merges the Media drawer slices per field and clears a render-target pin with null', async () => {
    const app = buildApp();
    expect((await patch(app, 'imageGen.codex', { model: 'gpt-example', parallelLimit: 4 })).status).toBe(200);
    expect((await patch(app, 'imageGen', { mode: 'codex' })).status).toBe(200);
    expect((await patch(app, 'imageGen.local', { modelId: 'example-model', cleanC2PA: false })).status).toBe(200);
    expect((await patch(app, 'imageGen.expose', { a1111: true })).status).toBe(200);
    expect((await patch(app, 'renderDefaults', { 'universe-bible': { imageMode: 'codex' }, 'sprite-reference': { imageMode: 'agy' } })).status).toBe(200);
    expect((await patch(app, 'renderDefaults', { 'universe-bible': null })).status).toBe(200);
    expect((await patch(app, 'videoGen', { defaultModelId: 'example-video', displaySleep: true })).status).toBe(200);
    expect((await patch(app, 'videoGen', { mode: 'grok' })).status).toBe(200);
    expect(persisted()).toMatchObject({
      imageGen: {
        mode: 'codex',
        local: { pythonPath: '/example/python3', denoise: true, modelId: 'example-model', cleanC2PA: false },
        codex: { enabled: true, model: 'gpt-example', parallelLimit: 4 },
        expose: { a1111: true },
      },
      renderDefaults: { 'universe-bible': null, 'sprite-reference': { imageMode: 'agy' } },
      videoGen: { mode: 'grok', defaultModelId: 'example-video', displaySleep: true },
    });
  });

  // Each music panel and the LoRA caption picker patch only the keys they own,
  // so a save from one never drops a sibling's prefs or the hand-set knobs.
  it('merges the music and LoRA caption prefs into their owned sub-slices', async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({
      music: { designer: { describeTemplate: 'Example describe', lyricsTemplate: 'Example lyrics' }, chiptune: { publishSubdir: 'game/assets/music' } },
      loraTraining: { displaySleep: false, segmentation: false, defaults: { steps: 1200 } },
    }));
    actual.__resetSettingsCache();
    const app = buildApp();
    expect((await patch(app, 'music.chiptune', { providerId: 'example-provider', model: 'example-model' })).status).toBe(200);
    expect((await patch(app, 'music.designer', { describeTemplate: 'Example revised' })).status).toBe(200);
    expect((await patch(app, 'loraTraining', { captionProviderId: 'example-provider', captionModel: 'example-vision' })).status).toBe(200);
    expect(persisted()).toMatchObject({
      music: {
        designer: { describeTemplate: 'Example revised', lyricsTemplate: 'Example lyrics' },
        chiptune: { publishSubdir: 'game/assets/music', providerId: 'example-provider', model: 'example-model' },
      },
      loraTraining: {
        displaySleep: false, segmentation: false, defaults: { steps: 1200 }, captionProviderId: 'example-provider', captionModel: 'example-vision',
      },
    });
  });

  it('rejects invalid values, unapproved paths and credential/prototype keys without writes', async () => {
    const before = fs.readFileSync(settingsFile, 'utf8');
    for (const [path, partial] of [
      ['secrets.auth', { enabled: false }],
      ['imageGen', { hfToken: 'example-token' }],
      ['imageGen', { mode: 'not-a-backend' }],
      ['imageGen.local', { hfToken: 'example-token' }],
      ['imageGen.local', { pythonPath: '/example/sh' }],
      ['imageGen.codex', { parallelLimitBounds: { min: 1, max: 1 } }],
      ['imageGen.grok', { aspectRatio: 'wide' }],
      ['renderDefaults', { 'universe-bible': { imageMode: 'not-a-backend' } }],
      ['videoGen', { acceptedModelTerms: [] }],
      ['videoGen', { mode: 'not-a-backend' }],
      ['localLlm.mtplx', { idleMinutes: -1 }],
      ['localLlm.mtplx', { launch: { model: [] } }],
      ['autoUpdate', { enabled: 'yes' }],
      ['pipeline', { imageGen: { width: 'invalid' } }],
      ['pipelineEditorialChecks', { enabled: 'yes' }],
      ['seriesAutopilot', { schedules: [{ seriesId: 'example', cron: '99 99 * * *' }] }],
      ['localLlm.__proto__', {}],
      ['pipeline', JSON.parse('{"imageGen":{"constructor":{}}}')],
      ['pipeline', JSON.parse('{"__proto__":{"polluted":true}}')],
      ['pipeline', { imageGen: { steps: 'not-a-number' } }],
      ['music.chiptune', { describeTemplate: 'Example template' }],
      ['music.designer', { describeTemplate: 'x'.repeat(8001) }],
      ['loraTraining', { displaySleep: true }],
    ]) {
      expect((await patch(buildApp(), path, partial)).status, path).toBe(400);
    }
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(before);
    expect(fileUtils.atomicWrite).not.toHaveBeenCalled();
  });

  it('refuses malformed or unreadable persisted settings and recovers on a later valid read', async () => {
    const before = fs.readFileSync(settingsFile, 'utf8');
    fs.writeFileSync(settingsFile, '{ truncated');
    expect((await patch(buildApp(), 'localLlm.mtplx', { keepLoaded: true })).status).toBe(500);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ truncated');
    fs.writeFileSync(settingsFile, before);
    fileUtils.tryReadFileStrict.mockResolvedValueOnce({ ok: false, value: null });
    expect((await patch(buildApp(), 'localLlm.mtplx', { keepLoaded: true })).status).toBe(500);
    expect(fileUtils.atomicWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(before);
    expect((await patch(buildApp(), 'localLlm.mtplx', { keepLoaded: true })).status).toBe(200);
    expect(persisted().localLlm.mtplx.launch.model).toBe('example-model');
  });

  it('propagates persistence failures without emitting success or replacing state', async () => {
    const before = fs.readFileSync(settingsFile, 'utf8');
    const emitted = vi.fn();
    actual.settingsEvents.on('settings:updated', emitted);
    fileUtils.atomicWrite.mockRejectedValueOnce(new Error('Synthetic write failure'));
    try {
      expect((await patch(buildApp(), 'localLlm.mtplx', { keepLoaded: true })).status).toBe(500);
      expect(fs.readFileSync(settingsFile, 'utf8')).toBe(before);
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      actual.settingsEvents.off('settings:updated', emitted);
    }
  });

  it('creates missing slices on a fresh install without spreading malformed parent values', async () => {
    fs.unlinkSync(settingsFile);
    expect((await patch(buildApp(), 'localLlm.mtplx', { idleMinutes: 5 })).status).toBe(200);
    expect(persisted().localLlm).toEqual({ mtplx: { idleMinutes: 5 } });
    fs.writeFileSync(settingsFile, JSON.stringify({ imageGen: 'legacy-malformed-parent' }));
    expect((await patch(buildApp(), 'imageGen.local', { pythonPath: '' })).status).toBe(200);
    expect(persisted().imageGen).toEqual({ local: { pythonPath: '' } });
  });

  it('keeps legacy PUT slice replacement semantics', async () => {
    const response = await request(buildApp()).put('/api/settings').send({ localLlm: { mtplx: { idleMinutes: 5 } } });
    expect(response.status).toBe(200);
    expect(persisted().localLlm).toEqual({ mtplx: { idleMinutes: 5 } });
  });
});

const guardedSettingsApp = (authority) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: authority === 'local' ? '127.0.0.1' : '192.0.2.10', configurable: true });
    // authGate supplies this verified context for both human and agent sessions.
    req.portosAuthContext = authority === 'session'
      ? { enabled: true, authenticated: true, method: 'session' }
      : { enabled: false, authenticated: false, method: null };
    next();
  });
  app.use(hostControlBodyGate);
  app.use('/api/settings', settingsRoutes);
  return app;
};

// Regression: generic settings writes must not let a remote caller repoint,
// disable or prune the backups that hold the install's private records.
describe('backup settings operator authority', () => {
  beforeEach(() => { store = { backup: { destPath: '/example-backups', enabled: true } }; vi.clearAllMocks(); });


  it.each([{ destPath: '/example-other-backups' }, { enabled: false }, { retentionCount: 1 }, null])(
    'refuses unauthorized backup policy changes before persistence: %j', async (backup) => {
      const previous = structuredClone(store);
      const res = await request(guardedSettingsApp('remote')).put('/api/settings').send({ backup });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      expect(updateSettingsWith).not.toHaveBeenCalled();
      expect(store).toEqual(previous);
    },
  );

  it.each(['local', 'session'])('preserves authorized backup configuration: %s', async (authority) => {
    const res = await request(guardedSettingsApp(authority)).put('/api/settings').send({ backup: { destPath: '/example-other-backups' } });
    expect(res.status).toBe(200);
    expect(store.backup.destPath).toBe('/example-other-backups');
  });
});

// A generic settings PUT replaces the whole voice root. Even an empty or null
// value can reset protected instructions; it is not the dedicated deep-merge API.
describe('generic voice settings operator authority', () => {
  const original = { stt: { endpoint: 'https://example.com/trusted-stt' }, llm: { systemPrompt: 'Synthetic trusted instructions', tools: { enabled: false } }, tts: { rate: 1 } };
  beforeEach(() => { store = { voice: structuredClone(original) }; vi.clearAllMocks(); });

  it.each([
    { stt: { endpoint: 'https://example.com/other-stt' } },
    { llm: { systemPrompt: 'Synthetic replacement', tools: { enabled: true } } },
    {},
    null,
  ])('refuses an unauthorized root replacement or reset before persistence: %j', async voice => {
    const res = await request(guardedSettingsApp('remote')).put('/api/settings').send({ voice });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(updateSettingsWith).not.toHaveBeenCalled();
    expect(store.voice).toEqual(original);
  });

  it.each(['local', 'session'])('preserves authorized voice replacement: %s', async authority => {
    const voice = { ...original, stt: { endpoint: 'https://example.com/other-stt' } };
    const res = await request(guardedSettingsApp(authority)).put('/api/settings').send({ voice });
    expect(res.status).toBe(200);
    expect(store.voice).toEqual(voice);
  });

  it('keeps unrelated generic settings writes open without changing voice policy', async () => {
    const res = await request(guardedSettingsApp('remote')).put('/api/settings').send({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(store.voice).toEqual(original);
  });
});


// A remote policy write must not become a trusted shell command on a later
// Autofixer repair, or turn a staged patch into an automatic live promotion.
describe('autofixer settings operator authority', () => {
  const original = { providerId: 'example-cli', model: 'example-model', verifyCommand: 'npm test', autoPromote: false };
  beforeEach(() => { store = { autofixer: { ...original } }; vi.clearAllMocks(); });

  it('refuses command, promotion, provider and clearing writes before persistence', async () => {
    for (const autofixer of [
      { verifyCommand: 'echo example-verification' },
      { autoPromote: true },
      { providerId: 'another-cli' },
      { verifyCommand: '' },
      {},
      null,
    ]) {
      const response = await request(guardedSettingsApp('remote')).put('/api/settings').send({ autofixer });
      expect([response.status, response.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(store.autofixer).toEqual(original);
    }
    expect(updateSettingsWith).not.toHaveBeenCalled();
  });

  it.each(['local', 'session'])('preserves %s repair policy updates and explicit clears', async authority => {
    const app = guardedSettingsApp(authority);
    const response = await request(app).put('/api/settings').send({ autofixer: { verifyCommand: 'echo example-verification', autoPromote: true } });
    expect(response.status).toBe(200);
    expect(store.autofixer).toEqual({ ...original, verifyCommand: 'echo example-verification', autoPromote: true });
    expect((await request(app).put('/api/settings').send({ autofixer: { verifyCommand: '', autoPromote: false } })).status).toBe(200);
    expect(store.autofixer).toEqual({ ...original, verifyCommand: '' });
  });

  it('gates the assignment facade that can replace the same repair policy', async () => {
    const body = { providerId: 'example-cli', model: 'another-model' };
    for (const id of ['settings.autofixer', 'settings%2Eautofixer']) {
      const denied = await request(guardedSettingsApp('remote')).put(`/api/settings/ai-assignments/${id}`).send(body);
      expect([denied.status, denied.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expect(updateAiAssignment).not.toHaveBeenCalled();
    for (const authority of ['local', 'session']) {
      expect((await request(guardedSettingsApp(authority)).put('/api/settings/ai-assignments/settings.autofixer').send(body)).status).toBe(200);
    }
    expect(updateAiAssignment).toHaveBeenCalledTimes(2);
    expect(updateAiAssignment).toHaveBeenLastCalledWith('settings.autofixer', body);
  });

  it('keeps unrelated remote settings saves open without changing deferred repair policy', async () => {
    expect((await request(guardedSettingsApp('remote')).put('/api/settings').send({ theme: 'dark' })).status).toBe(200);
    expect(store.autofixer).toEqual(original);
  });
});

describe('Settings routes — saved film looks', () => {
  beforeEach(() => { store = {}; vi.clearAllMocks(); });
  it('stores named looks and refuses a malformed one without touching the saved list', async () => {
    const presets = [{ id: 'dusk-ab12', label: 'Dusk', look: { preset: 'custom', warmth: 0.3, grain: 0.2 } }];
    const saved = await request(buildApp()).put('/api/settings').send({ filmLookPresets: presets });
    expect(saved.status).toBe(200);
    expect(store.filmLookPresets).toEqual(presets);
    for (const bad of [
      [{ id: 'x', label: 'Out of range', look: { warmth: 5 } }],
      [{ id: 'x', label: 'Typo', look: { warmht: 0.2 } }],
      [{ id: 'Bad Id', label: 'Id', look: {} }],
      [{ id: 'x', label: '', look: {} }],
    ]) {
      const result = await request(buildApp()).put('/api/settings').send({ filmLookPresets: bad });
      expect(result.status).toBe(400);
      expect(store.filmLookPresets).toEqual(presets);
    }
  });
});
