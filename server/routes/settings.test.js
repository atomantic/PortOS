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

import settingsRoutes from './settings.js';
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
    // GSD remains enabled by default so existing app planning tabs stay
    // available unless the install explicitly opts out.
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'gsd', enabled: true }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'openclaw', enabled: true }));
    expect(res.body.features).toContainEqual(expect.objectContaining({ id: 'health', enabled: true }));
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

