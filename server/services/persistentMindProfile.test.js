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

const { resolvePersistentMindProfile } = await import('./persistentMindProfile.js');

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
