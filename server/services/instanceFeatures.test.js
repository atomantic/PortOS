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
  riggingReady: false,
  riggingThrows: false,
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

// The rigging detector probes a machine-local runtime rather than a config file, so
// the real module would spawn a Blender import on a machine that happens to have the
// env provisioned. Mocked here to keep the suite deterministic on any host.
vi.mock('./rigging/readiness.js', () => ({
  getRiggingReadiness: vi.fn(async () => {
    if (mock.riggingThrows) throw new Error('probe exploded');
    return { ready: mock.riggingReady, reason: mock.riggingReady ? null : 'runtime-not-installed' };
  }),
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
  resolveInstanceFeatureGroups,
  updateInstanceFeature,
  updateInstanceFeatureGroup,
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
    mock.riggingReady = false;
    mock.riggingThrows = false;
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

    // Rigging inverts the fail-open policy above, on purpose. Its detector probes a
    // machine-local RUNTIME, not a config file: "we could not tell" there means the
    // Blender module may simply not exist, and enabling the feature on such a host
    // trades a named blocker for a spawn error the first time a user clicks.
    it('enables rigging only when the runtime probe says it is ready', async () => {
      mock.riggingReady = true;
      expect((await detectFeatureConfiguration()).rigging).toBe(true);
      expect(byId((await getInstanceFeatures()).features, 'rigging')).toMatchObject({
        enabled: true,
        source: 'auto',
      });
      expect(await isInstanceFeatureEnabled('rigging')).toBe(true);
    });

    it('keeps rigging off on an install with no runtime', async () => {
      expect((await detectFeatureConfiguration()).rigging).toBe(false);
      expect(byId((await getInstanceFeatures()).features, 'rigging')).toMatchObject({
        enabled: false,
        source: 'auto',
      });
    });

    it('fails CLOSED when the rigging probe cannot answer', async () => {
      mock.riggingThrows = true;
      expect((await detectFeatureConfiguration()).rigging).toBe(false);
      expect(byId((await getInstanceFeatures()).features, 'rigging')).toMatchObject({
        enabled: false,
        source: 'auto',
      });
      expect(await isInstanceFeatureEnabled('rigging')).toBe(false);
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
    expect(Object.fromEntries(features.map((f) => [f.id, f.enabled]))).toEqual({
      post: true, datadog: true, jira: false, eidoverse: false, gsd: false, openclaw: false, health: true,
      rigging: false, facetime: false, imessage: true, signal: true, x: true, 'stacker-news': true, beeper: false,
    });
  });

  it('rejects an unknown feature id', async () => {
    await expect(updateInstanceFeature('nope', true)).rejects.toMatchObject({ status: 404 });
    expect(await isInstanceFeatureEnabled('nope')).toBe(false);
  });

  // #40 — Comms feature group: FaceTime Audio, iMessage and Signal bucketed
  // under a `comms` group toggle with per-feature tri-state overrides. Nested
  // inside this describe (rather than a sibling) so it inherits the shared
  // `beforeEach` that resets `mock.settings` between tests.
  describe('instance feature groups (#40)', () => {
  it('parity: an install with no stored group state resolves exactly as before this change', async () => {
    // No instanceFeatureGroups key at all — the shape every existing install has
    // today. iMessage and Signal must resolve enabled with no settings write.
    const { features, groups } = await getInstanceFeatures();
    expect(byId(features, 'imessage')).toMatchObject({ enabled: true, source: 'default' });
    expect(byId(features, 'signal')).toMatchObject({ enabled: true, source: 'default' });
    expect(byId(features, 'x')).toMatchObject({ enabled: true, source: 'default' });
    expect(byId(features, 'stacker-news')).toMatchObject({ enabled: true, source: 'default' });
    expect(await isInstanceFeatureEnabled('imessage')).toBe(true);
    expect(await isInstanceFeatureEnabled('signal')).toBe(true);
    expect(await isInstanceFeatureEnabled('x')).toBe(true);
    expect(await isInstanceFeatureEnabled('stacker-news')).toBe(true);
    // FaceTime Audio keeps answering to its own detector exactly as before
    // grouping existed — a group with no stored state never overrides it. This
    // suite doesn't mock voice/facetimeBridge.js, so the source depends on
    // whatever the real probe finds on the machine running the test.
    expect(['auto', 'default', 'detect-failed']).toContain(byId(features, 'facetime').source);

    expect(byId(groups, 'comms')).toMatchObject({ id: 'comms', enabled: true });
  });

  it('lists every registered group, defaulting to enabled', async () => {
    expect(resolveInstanceFeatureGroups({})).toEqual([
      { id: 'comms', label: 'Comms', description: expect.any(String), enabled: true },
    ]);
  });

  // Resolver truth table: group on/off × feature override inherit/on/off ×
  // feature default true/false (imessage defaults true; facetime's detector
  // answer is pinned via an explicit `detected` map — resolveInstanceFeatures
  // is a pure function of its `detected` argument, so this doesn't depend on
  // whatever the real facetimeBridge probe finds on the test machine).
  describe('resolver truth table', () => {
    const detected = { facetime: false };

    it('group on, override inherit → feature default', () => {
      const settings = {};
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'imessage')).toMatchObject({ enabled: true, source: 'default' });
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'facetime')).toMatchObject({ enabled: false, source: 'auto' });
    });

    it('group on, override on → on regardless of default', () => {
      const settings = { instanceFeatures: { facetime: { enabled: true } } };
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'facetime')).toMatchObject({ enabled: true, source: 'explicit' });
    });

    it('group on, override off → off regardless of default', () => {
      const settings = { instanceFeatures: { imessage: { enabled: false } } };
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'imessage')).toMatchObject({ enabled: false, source: 'explicit' });
    });

    it('group off, override inherit → off (hidden), for every default', () => {
      const settings = { instanceFeatureGroups: { comms: { enabled: false } } };
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'imessage')).toMatchObject({ enabled: false, source: 'group-off' });
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'signal')).toMatchObject({ enabled: false, source: 'group-off' });
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'facetime')).toMatchObject({ enabled: false, source: 'group-off' });
    });

    it('group off, override on → the override wins, hands the feature back', () => {
      const settings = {
        instanceFeatureGroups: { comms: { enabled: false } },
        instanceFeatures: { imessage: { enabled: true } },
      };
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'imessage')).toMatchObject({ enabled: true, source: 'explicit' });
      // A sibling with no override of its own stays hidden.
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'signal')).toMatchObject({ enabled: false, source: 'group-off' });
    });

    it('group off, override off → off (redundant with the group, still explicit)', () => {
      const settings = {
        instanceFeatureGroups: { comms: { enabled: false } },
        instanceFeatures: { signal: { enabled: false } },
      };
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'signal')).toMatchObject({ enabled: false, source: 'explicit' });
    });

    it('ungrouped features are unaffected by group state', () => {
      const settings = { instanceFeatureGroups: { comms: { enabled: false } } };
      expect(byId(resolveInstanceFeatures(settings, { detected }), 'post')).toMatchObject({ enabled: true, source: 'default' });
    });
  });

  it('fails closed for a malformed group flag', () => {
    const settings = { instanceFeatureGroups: { comms: { enabled: 'nope' } } };
    expect(byId(resolveInstanceFeatures(settings), 'imessage')).toMatchObject({ enabled: false, source: 'group-off' });
    expect(resolveInstanceFeatureGroups(settings)).toContainEqual(
      expect.objectContaining({ id: 'comms', enabled: false }),
    );
  });

  it('fails closed for every feature and every group when settings cannot be read', async () => {
    mock.corrupt = true;
    const { groups } = await getInstanceFeatures();
    expect(byId(groups, 'comms')).toMatchObject({ enabled: false });
  });

  it('clears a per-feature override back to inherit rather than writing a third sentinel value', async () => {
    mock.settings = { instanceFeatures: { facetime: { enabled: true } } };

    const result = await updateInstanceFeature('facetime', null);

    expect(mock.settings).toEqual({ instanceFeatures: {} });
    // Storage is what this test pins; facetime's resolved source afterward
    // depends on the real (unmocked) detector, asserted separately above.
    expect(byId(result.features, 'facetime').source).not.toBe('explicit');
  });

  it('keeps a co-stored key when clearing just the enabled override', async () => {
    // Not a real shape any grouped feature stores today, but the merge must not
    // assume `enabled` is the only key ever co-stored under a feature id.
    mock.settings = { instanceFeatures: { facetime: { enabled: true, note: 'keep' } } };

    await updateInstanceFeature('facetime', null);

    expect(mock.settings).toEqual({ instanceFeatures: { facetime: { note: 'keep' } } });
  });

  it('toggles a group and reports it back on both features and groups', async () => {
    const result = await updateInstanceFeatureGroup('comms', false);

    expect(mock.settings).toEqual({ instanceFeatureGroups: { comms: { enabled: false } } });
    expect(byId(result.groups, 'comms')).toMatchObject({ enabled: false });
    expect(mock.updateSettingsWith).toHaveBeenCalledWith(expect.any(Function), { actor: 'user', skipUserAction: true });
    expect(recordUserAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'instance-feature-group.toggle', actor: 'user', target: 'comms',
      payload: { id: 'comms', enabled: false },
    }));
    expect(byId(result.features, 'imessage')).toMatchObject({ enabled: false, source: 'group-off' });
    expect(await isInstanceFeatureEnabled('imessage')).toBe(false);
  });

  it('rejects an unknown group id', async () => {
    await expect(updateInstanceFeatureGroup('nope', false)).rejects.toMatchObject({ status: 404 });
  });
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
