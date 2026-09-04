import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  provider: null,
  available: true,
  status: { message: 'offline' },
}));

vi.mock('./providers.js', () => ({
  getProviderById: vi.fn(async () => mocks.provider),
}));
vi.mock('./providerStatus.js', () => ({
  isProviderAvailable: vi.fn(() => mocks.available),
  getProviderStatus: vi.fn(() => mocks.status),
}));

const { resolvePersistentMindProfile, resolvePersistentMindThinkingSession } = await import('./persistentMindProfile.js');

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
    await expect(resolvePersistentMindThinkingSession({ presetId: 'deep', config })).resolves.toMatchObject({
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
      .toEqual({ ok: false, error: 'Temporary thinking preset "removed" is no longer available' });
    await expect(resolvePersistentMindThinkingSession({ presetId: 'retired', config })).resolves
      .toMatchObject({ ok: false, error: /not available from provider/ });
    await expect(resolvePersistentMindThinkingSession({ presetId: 'strained', config })).resolves
      .toMatchObject({ ok: false, error: /not supported/ });

    mocks.available = false;
    await expect(resolvePersistentMindThinkingSession({ presetId: 'deep', config })).resolves
      .toEqual({ ok: false, error: 'offline' });
  });

  it('borrows a model, never authority: a disabled profile admits no temporary session', async () => {
    await expect(resolvePersistentMindThinkingSession({
      presetId: 'deep',
      config: { ...config, persistentMindProfile: { ...profile, enabled: false } },
    })).resolves.toEqual({ ok: false, error: 'Persistent mind profile is disabled' });
  });
});
