import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  provider: null,
  available: true,
  status: { message: 'offline' },
}));

vi.mock('../provider/providers.js', () => ({
  getProviderById: vi.fn(async () => mocks.provider),
}));
vi.mock('../provider/providerStatus.js', () => ({
  isProviderAvailable: vi.fn(() => mocks.available),
  getProviderStatus: vi.fn(() => mocks.status),
}));

const moa = vi.hoisted(() => ({ record: null, refusals: [] }));
vi.mock('../moaPresets.js', () => ({
  resolveMoaProvider: vi.fn(async () => moa.record),
  getMoaPreset: vi.fn(async () => ({ id: 'council' })),
  moaPresetRefusals: vi.fn(async () => moa.refusals),
}));

const { resolvePersistentMindProfile, resolvePersistentMindThinkingSession } = await import('./persistentMindProfile.js');
const { persistentMindHarnessInfo } = await import('./persistentMindAdapter.js');

const profile = { enabled: true, providerId: 'local', model: 'reasoner', effort: '', thinkingInterface: 'text' };

describe('resolvePersistentMindProfile', () => {
  beforeEach(() => {
    mocks.provider = { id: 'local', type: 'api', models: ['reasoner'] };
    mocks.available = true;
    mocks.status = { message: 'offline' };
  });

  it('resolves an API provider for text reasoning without treating it as a file-writing harness', async () => {
    await expect(resolvePersistentMindProfile(profile)).resolves.toMatchObject({
      ok: true,
      provider: { id: 'local', type: 'api' },
      model: 'reasoner',
      thinkingInterface: 'text',
    });
  });

  it('fails closed for a missing, unhealthy, or catalog-drifted pin', async () => {
    mocks.provider = null;
    await expect(resolvePersistentMindProfile(profile)).resolves.toMatchObject({ ok: false, error: /unavailable/ });

    mocks.provider = { id: 'local', models: ['reasoner'] };
    mocks.available = false;
    await expect(resolvePersistentMindProfile(profile)).resolves.toEqual({ ok: false, error: 'offline' });

    mocks.available = true;
    await expect(resolvePersistentMindProfile({ ...profile, model: 'removed-model' })).resolves
      .toMatchObject({ ok: false, error: /not available/ });
  });

  it('refuses a saved route whose provider cannot run tool-free, and admits a tool-free CLI (#13840)', async () => {
    for (const provider of [
      { id: 'local', type: 'cli', command: 'codex', models: ['reasoner'] },
      { id: 'local', type: 'tui', command: 'claude', models: ['reasoner'] },
    ]) {
      mocks.provider = provider;
      await expect(resolvePersistentMindProfile(profile)).resolves
        .toMatchObject({ ok: false, error: /cannot run without host shell and file tools/ });
    }
    mocks.provider = { id: 'local', type: 'cli', command: 'claude', models: ['reasoner'] };
    await expect(resolvePersistentMindProfile(profile)).resolves.toMatchObject({ ok: true });
  });

  it('requires a complete enabled pin and rejects effort a provider cannot accept', async () => {
    await expect(resolvePersistentMindProfile({ ...profile, model: '' })).resolves
      .toEqual({ ok: false, error: 'Persistent mind profile requires a provider and model' });
    await expect(resolvePersistentMindProfile({ ...profile, effort: 'high' })).resolves
      .toMatchObject({ ok: false, error: /not supported/ });
  });
});

describe('resolvePersistentMindThinkingSession', () => {
  const config = {
    persistentMindProfile: profile,
    persistentMindThinkingPresets: {
      presets: [
        { id: 'deep', label: 'Deep pass', providerId: 'local', model: 'reasoner', effort: '' },
        { id: 'retired', label: 'Retired', providerId: 'local', model: 'removed-model', effort: '' },
        { id: 'strained', label: 'Strained', providerId: 'local', model: 'reasoner', effort: 'high' },
      ],
    },
  };

  beforeEach(() => {
    mocks.provider = { id: 'local', type: 'api', models: ['reasoner'] };
    mocks.available = true;
    mocks.status = { message: 'offline' };
  });

  it('borrows one exact alternate route while the mind keeps its own identity', async () => {
    await expect(resolvePersistentMindThinkingSession({ presetId: 'deep', selection: config.persistentMindThinkingPresets.presets[0], config })).resolves.toMatchObject({
      ok: true,
      temporary: true,
      presetId: 'deep',
      presetLabel: 'Deep pass',
      provider: { id: 'local' },
      model: 'reasoner',
      effort: null,
      thinkingInterface: 'text',
    });
  });

  it('refuses instead of quietly answering on the default the user stepped away from', async () => {
    await expect(resolvePersistentMindThinkingSession({ presetId: 'removed', config })).resolves
      .toEqual({ ok: false, requiresResubmission: true, error: 'Temporary thinking preset "removed" is no longer available' });
    await expect(resolvePersistentMindThinkingSession({ presetId: 'retired', selection: config.persistentMindThinkingPresets.presets[1], config })).resolves
      .toMatchObject({ ok: false, error: /not available from provider/ });
    await expect(resolvePersistentMindThinkingSession({ presetId: 'strained', selection: config.persistentMindThinkingPresets.presets[2], config })).resolves
      .toMatchObject({ ok: false, error: /not supported/ });

    mocks.available = false;
    await expect(resolvePersistentMindThinkingSession({ presetId: 'deep', selection: config.persistentMindThinkingPresets.presets[0], config })).resolves
      .toEqual({ ok: false, error: 'offline' });
  });

  it('borrows a model, never authority: a disabled profile admits no temporary session', async () => {
    await expect(resolvePersistentMindThinkingSession({
      presetId: 'deep',
      config: { ...config, persistentMindProfile: { ...profile, enabled: false } },
    })).resolves.toEqual({ ok: false, error: 'Persistent mind profile is disabled' });
  });

  it('refuses missing/malformed consent, route edits, and an empty provider catalog', async () => {
    const selection = config.persistentMindThinkingPresets.presets[0];
    for (const changed of [
      undefined,
      { ...selection, effort: 'invalid' },
      { ...selection, providerId: 'another-provider' },
      { ...selection, model: 'another-model' },
      { ...selection, effort: 'high' },
    ]) {
      await expect(resolvePersistentMindThinkingSession({ presetId: 'deep', selection: changed, config }))
        .resolves.toMatchObject({ ok: false });
    }
    mocks.provider.models = [];
    await expect(resolvePersistentMindThinkingSession({ presetId: 'deep', selection, config }))
      .resolves.toMatchObject({ ok: false, error: /no available model catalog/ });
  });
});

describe('a Mixture of Agents thinking preset (#17386)', () => {
  const council = { id: 'council', label: 'Council', providerId: 'moa:council', model: 'agg-big', effort: '' };
  const config = { persistentMindProfile: profile, persistentMindThinkingPresets: { presets: [council] } };
  const borrow = (preset = council) => resolvePersistentMindThinkingSession({ presetId: preset.id, selection: preset, config: { ...config, persistentMindThinkingPresets: { presets: [preset] } } });

  beforeEach(() => {
    mocks.provider = null;
    moa.record = { id: 'moa:council', type: 'moa', enabled: true, defaultModel: 'agg-big', models: ['agg-big'], moaPresetId: 'council' };
    moa.refusals = [];
  });

  it('borrows the preset as a tool-free route on its aggregator model', async () => {
    await expect(borrow()).resolves.toMatchObject({ ok: true, temporary: true, provider: { id: 'moa:council', type: 'moa' }, model: 'agg-big', effort: null });
    expect(persistentMindHarnessInfo(moa.record)).toMatchObject({ label: 'Mixture of Agents', recommendation: 'supported' });
  });

  it('refuses a missing preset, an aggregator that cannot run, another model, or an effort pin', async () => {
    moa.refusals = [{ role: 'reference', index: 0, refusal: 'provider "x" is disabled' }];
    await expect(borrow()).resolves.toMatchObject({ ok: true });

    moa.refusals = [{ role: 'aggregator', index: 0, refusal: 'provider "agg" is disabled' }];
    await expect(borrow()).resolves.toMatchObject({ ok: false, error: /aggregator provider "agg" is disabled/ });

    moa.refusals = [];
    await expect(borrow({ ...council, model: 'other' })).resolves.toMatchObject({ ok: false, error: /not the aggregator model/ });
    await expect(borrow({ ...council, effort: 'high' })).resolves.toMatchObject({ ok: false, error: /not supported by an MoA preset/ });

    moa.record = null;
    await expect(borrow()).resolves.toMatchObject({ ok: false, error: /"moa:council" is unavailable/ });
  });
});
