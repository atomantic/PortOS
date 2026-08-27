import { describe, expect, it, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({
  settings: {},
  corrupt: false,
  updateSettingsWith: vi.fn(),
  datadogConfigured: false,
  jiraConfigured: false,
  datadogThrows: false,
}));

vi.mock('./settings.js', () => ({
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

import {
  detectFeatureConfiguration,
  getInstanceFeatures,
  isInstanceFeatureEnabled,
  resolveInstanceFeatures,
  updateInstanceFeature,
} from './instanceFeatures.js';

const byId = (features, id) => features.find((feature) => feature.id === id);

describe('instance features', () => {
  beforeEach(() => {
    mock.settings = {};
    mock.corrupt = false;
    mock.datadogConfigured = false;
    mock.jiraConfigured = false;
    mock.datadogThrows = false;
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
      .toEqual({ post: true, datadog: true, jira: false, gsd: true });
  });

  it('rejects an unknown feature id', async () => {
    await expect(updateInstanceFeature('nope', true)).rejects.toMatchObject({ status: 404 });
    expect(await isInstanceFeatureEnabled('nope')).toBe(false);
  });
});
