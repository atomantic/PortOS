import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// In-memory settings store backing the mocked service.
let store = {};

vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn(async () => ({ id: 'evt' })) }));

vi.mock('../services/settings.js', () => ({
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
    return { ...store };
  }),
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

import settingsRoutes from './settings.js';
import { reconcileBeeperIngestion } from '../services/beeperArming.js';
import { restartBeeperScheduler, isBeeperSchedulerRegistered } from '../services/beeperScheduler.js';
import { updateSettingsWith } from '../services/settings.js';
import { hasConfiguredInstances as hasConfiguredDatadogInstances } from '../services/datadog.js';
import { hasConfiguredInstances as hasConfiguredJiraInstances } from '../services/jira.js';
import { assertEidoverseInstalled, installEidoverse, setEidoverseWorldsOrigin } from '../services/eidoverse.js';
import { ensureEidoverseHost } from '../services/eidoverseHost.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  return app;
};

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

  it('updates the installed Eidoverse source without changing feature participation', async () => {
    const worldsRepoUrl = 'git@github.com:example-owner/eidoverse-worlds.git';
    store = { instanceFeatures: { eidoverse: { enabled: true } } };

    const res = await request(buildApp())
      .put('/api/settings/features/eidoverse/source')
      .send({ worldsRepoUrl });

    expect(res.status).toBe(200);
    expect(setEidoverseWorldsOrigin).toHaveBeenCalledWith(worldsRepoUrl);
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
