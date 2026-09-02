import { describe, expect, it, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({
  settings: {},
  corrupt: false,
  updateSettingsWith: vi.fn(),
  datadogConfigured: false,
  jiraConfigured: false,
  datadogThrows: false,
  eidoverseInstalled: false,
  portosOrigin: { isGithub: true, isUpstream: false, owner: 'example-owner' },
  assertEidoverseInstalled: vi.fn(),
  setEidoverseWorldsOrigin: vi.fn(),
}));

const recordUserAction = vi.hoisted(() => vi.fn(async () => ({ id: 'evt' })));
vi.mock('./userActions.js', () => ({ recordUserAction }));

vi.mock('./settings.js', () => ({
  getSettings: vi.fn(async () => structuredClone(mock.settings)),
  getSettingsWithStatus: vi.fn(async () => ({ corrupt: mock.corrupt, settings: structuredClone(mock.settings) })),
  updateSettingsWith: mock.updateSettingsWith,
}));

vi.mock('./datadog.js', () => ({
  hasConfiguredInstances: vi.fn(async () => {
    if (mock.datadogThrows) throw new Error('datadog.json unreadable');
    return mock.datadogConfigured;
  }),
}));

vi.mock('./jira.js', () => ({
  hasConfiguredInstances: vi.fn(async () => mock.jiraConfigured),
}));

vi.mock('../lib/gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => mock.portosOrigin),
}));

vi.mock('./eidoverse.js', () => ({
  DEFAULT_EIDOVERSE_WORLDS_REPO: 'https://github.com/anima-research/eidoverse-worlds',
  normalizeEidoverseWorldsRepo: vi.fn((url) => url),
  getEidoverseStatus: vi.fn(async ({ worldsRepoUrl } = {}) => ({
    installed: mock.eidoverseInstalled,
    worldsRepoUrl,
    bunAvailable: true,
    registryAvailable: true,
  })),
  assertEidoverseInstalled: mock.assertEidoverseInstalled,
  setEidoverseWorldsOrigin: mock.setEidoverseWorldsOrigin,
}));

import {
  detectFeatureConfiguration,
  getInstanceFeatures,
  isInstanceFeatureEnabled,
  resolveInstanceFeatures,
  updateInstanceFeature,
  updateEidoverseWorldsSource,
} from './instanceFeatures.js';

const byId = (features, id) => features.find((feature) => feature.id === id);

describe('instance features', () => {
  beforeEach(() => {
    mock.settings = {};
    mock.corrupt = false;
    mock.datadogConfigured = false;
    mock.jiraConfigured = false;
    mock.datadogThrows = false;
    mock.eidoverseInstalled = false;
    mock.portosOrigin = { isGithub: true, isUpstream: false, owner: 'example-owner' };
    mock.assertEidoverseInstalled.mockReset().mockResolvedValue({ installed: true });
    mock.setEidoverseWorldsOrigin.mockReset().mockResolvedValue({ appId: 'app-eidoverse' });
    mock.updateSettingsWith.mockReset();
    mock.updateSettingsWith.mockImplementation(async (mutate) => {
      mock.settings = await mutate(structuredClone(mock.settings));
      return structuredClone(mock.settings);
    });
  });

  it('keeps POST enabled by default for existing installs', async () => {
    expect(await isInstanceFeatureEnabled('post')).toBe(true);
    expect(byId((await getInstanceFeatures()).features, 'post')).toMatchObject({ id: 'post', enabled: true });
  });

  it('keeps Eidoverse opt-in and exposes its install state separately from the flag', async () => {
    expect(byId((await getInstanceFeatures()).features, 'eidoverse')).toMatchObject({
      enabled: false,
      source: 'default',
      setup: {
        installed: false,
        bunAvailable: true,
        worldsRepoUrl: 'https://github.com/anima-research/eidoverse-worlds',
        sourceOwners: { self: 'example-owner', upstream: 'anima-research' },
      },
    });
  });

  it('preserves an SSH source and omits Self when the PortOS origin is not GitHub', async () => {
    mock.settings = { instanceFeatures: { eidoverse: { worldsRepoUrl: 'git@github.com:example-owner/eidoverse-worlds.git' } } };
    mock.portosOrigin = { isGithub: false, isUpstream: false, owner: 'example-owner' };

    expect(byId((await getInstanceFeatures()).features, 'eidoverse')).toMatchObject({
      setup: {
        worldsRepoUrl: 'git@github.com:example-owner/eidoverse-worlds.git',
        sourceOwners: { self: null, upstream: 'anima-research' },
      },
    });
  });

  it('omits Self when this install tracks the canonical upstream', async () => {
    mock.portosOrigin = { isGithub: true, isUpstream: true, owner: 'atomantic' };

    expect(byId((await getInstanceFeatures()).features, 'eidoverse')).toMatchObject({
      setup: {
        sourceOwners: { self: null, upstream: 'anima-research' },
      },
    });
  });

  it('persists a normalized Worlds fork without enabling the feature', async () => {
    const selected = 'https://github.com/example-owner/eidoverse-worlds';
    const { updateEidoverseWorldsRepo } = await import('./instanceFeatures.js');

    await expect(updateEidoverseWorldsRepo(selected)).resolves.toBe(selected);
    expect(mock.settings).toEqual({ instanceFeatures: { eidoverse: { worldsRepoUrl: selected } } });
  });

  it('requires a completed Eidoverse install before enabling it', async () => {
    mock.assertEidoverseInstalled.mockRejectedValueOnce(Object.assign(new Error('not installed'), { status: 409 }));

    await expect(updateInstanceFeature('eidoverse', true)).rejects.toMatchObject({ status: 409 });
    expect(mock.updateSettingsWith).not.toHaveBeenCalled();
  });

  it('changes the installed source before persisting the normalized setting', async () => {
    const selected = 'https://github.com/example-owner/eidoverse-worlds';

    await expect(updateEidoverseWorldsSource(selected)).resolves.toBe(selected);
    expect(mock.setEidoverseWorldsOrigin).toHaveBeenCalledWith(selected);
    expect(mock.settings.instanceFeatures.eidoverse.worldsRepoUrl).toBe(selected);
  });

  it('resolves an explicit disable without changing POST configuration', () => {
    expect(byId(resolveInstanceFeatures({ instanceFeatures: { post: { enabled: false } } }), 'post')).toMatchObject({
      id: 'post',
      enabled: false,
      source: 'explicit',
    });
  });

  it('fails closed for malformed persisted feature flags', async () => {
    const settings = { instanceFeatures: { post: { enabled: 'false' } } };

    expect(byId(resolveInstanceFeatures(settings), 'post')).toMatchObject({ id: 'post', enabled: false });
    mock.settings = settings;
    expect(await isInstanceFeatureEnabled('post')).toBe(false);
  });

  it('fails closed when settings cannot be read or parsed', async () => {
    mock.corrupt = true;

    expect(byId(resolveInstanceFeatures({}, { corrupt: true }), 'post')).toMatchObject({ id: 'post', enabled: false });
    expect(await isInstanceFeatureEnabled('post')).toBe(false);
    expect(byId((await getInstanceFeatures()).features, 'post')).toMatchObject({ id: 'post', enabled: false });
  });

  it('updates one feature inside the instance-local settings slice', async () => {
    mock.settings = { theme: 'dark', instanceFeatures: { post: { enabled: true, future: 'keep' } } };

    const result = await updateInstanceFeature('post', false);

    expect(mock.settings).toEqual({
      theme: 'dark',
      instanceFeatures: { post: { enabled: false, future: 'keep' } },
    });
    expect(byId(result.features, 'post')).toMatchObject({ id: 'post', enabled: false });
    expect(await isInstanceFeatureEnabled('post')).toBe(false);
  });

  describe('auto-detection for integration-backed features', () => {
    it('keeps DataDog and JIRA off on an install with no instances configured', async () => {
      const { features } = await getInstanceFeatures();
      expect(byId(features, 'datadog')).toMatchObject({ enabled: false, source: 'auto' });
      expect(byId(features, 'jira')).toMatchObject({ enabled: false, source: 'auto' });
      expect(await isInstanceFeatureEnabled('jira')).toBe(false);
    });

    it('turns a feature on once its integration is configured', async () => {
      mock.jiraConfigured = true;

      const { features } = await getInstanceFeatures();
      expect(byId(features, 'jira')).toMatchObject({ enabled: true, source: 'auto' });
      expect(byId(features, 'datadog')).toMatchObject({ enabled: false });
      expect(await isInstanceFeatureEnabled('jira')).toBe(true);
    });

    it('lets an explicit disable outrank a configured integration', async () => {
      mock.jiraConfigured = true;
      mock.settings = { instanceFeatures: { jira: { enabled: false } } };

      expect(byId((await getInstanceFeatures()).features, 'jira')).toMatchObject({
        enabled: false,
        source: 'explicit',
      });
      expect(await isInstanceFeatureEnabled('jira')).toBe(false);
    });

    it('lets an explicit enable outrank an unconfigured integration', async () => {
      mock.settings = { instanceFeatures: { datadog: { enabled: true } } };

      expect(byId((await getInstanceFeatures()).features, 'datadog')).toMatchObject({
        enabled: true,
        source: 'explicit',
      });
      expect(await isInstanceFeatureEnabled('datadog')).toBe(true);
    });

    // A PRESENT-but-corrupt config file is the case that fails silently. The
    // detector throws, and the gate must then fail OPEN: the file exists, so the
    // integration is probably configured, and /devtools/jira is itself where the
    // user goes to fix it — hiding it there strands them.
    it('fails OPEN when detection cannot answer, rather than hiding the page', async () => {
      mock.datadogThrows = true;
      mock.settings = {};

      expect((await detectFeatureConfiguration()).datadog).toBeNull();
      expect(byId((await getInstanceFeatures()).features, 'datadog')).toMatchObject({
        enabled: true,
        source: 'detect-failed',
      });
      expect(await isInstanceFeatureEnabled('datadog')).toBe(true);
    });

    it('still lets an explicit disable win over a failed probe', async () => {
      mock.datadogThrows = true;
      mock.settings = { instanceFeatures: { datadog: { enabled: false } } };

      expect(byId((await getInstanceFeatures()).features, 'datadog')).toMatchObject({
        enabled: false,
        source: 'explicit',
      });
    });

    // A feature with NO detector reads null for a different reason — nothing was
    // ever probed — so it must keep taking its shipped default, not fail open.
    it('reports no detection for a feature with no detector', async () => {
      expect(await detectFeatureConfiguration()).toMatchObject({ post: null });
      expect(byId((await getInstanceFeatures()).features, 'post')).toMatchObject({
        enabled: true,
        source: 'default',
      });
    });
  });

  it('answers for every registered feature, so nothing is silently ungated', async () => {
    mock.datadogConfigured = true;

    const { features } = await getInstanceFeatures();
    expect(Object.fromEntries(features.map((f) => [f.id, f.enabled])))
      .toEqual({ post: true, datadog: true, jira: false, eidoverse: false, gsd: true, openclaw: true, health: true, facetime: false });
  });

  it('rejects an unknown feature id', async () => {
    await expect(updateInstanceFeature('nope', true)).rejects.toMatchObject({ status: 404 });
    expect(await isInstanceFeatureEnabled('nope')).toBe(false);
  });

  it('records instance-feature.toggle with { id, enabled } and skips settings.update', async () => {
    await updateInstanceFeature('post', false);
    expect(mock.updateSettingsWith).toHaveBeenCalledWith(expect.any(Function), { actor: 'user', skipUserAction: true });
    expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'instance-feature.toggle',
      actor: 'user',
      target: 'post',
      payload: { id: 'post', enabled: false },
    }));
  });
});
