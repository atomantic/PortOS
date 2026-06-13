/**
 * Tests for agentProviderResolution — the provider availability/fallback +
 * user-override + model-selection logic extracted out of spawnAgentForTask.
 *
 * The contract these pin: resolvable failures come back as { ok: false, ... }
 * (the caller turns them into cleanupOnError + an agent:error event) and the
 * fallback / user-override / model-validation branches pick the right
 * provider+model. spawnAgentForTask only sees this discriminated result, so a
 * regression here would otherwise surface as a confusing spawn failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn(), cosEvents: { emit: vi.fn() } }));
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getAllProviders: vi.fn(),
  getProviderById: vi.fn(),
}));
vi.mock('./providerStatus.js', () => ({
  isProviderAvailable: vi.fn(),
  getFallbackProvider: vi.fn(),
  getProviderStatus: vi.fn(),
}));
vi.mock('./agentModelSelection.js', () => ({ selectModelForTask: vi.fn() }));

import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { getActiveProvider, getAllProviders, getProviderById } from './providers.js';
import { isProviderAvailable, getFallbackProvider, getProviderStatus } from './providerStatus.js';
import { selectModelForTask } from './agentModelSelection.js';

const TASK = { id: 'task-1', metadata: {} };

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults: provider present + available, plain model selection.
  isProviderAvailable.mockReturnValue(true);
  selectModelForTask.mockResolvedValue({ model: 'm-default', tier: 'medium', reason: 'default' });
});

describe('resolveAgentProviderAndModel', () => {
  it('fails when no active provider is configured', async () => {
    getActiveProvider.mockResolvedValue(null);
    const r = await resolveAgentProviderAndModel(TASK);
    expect(r).toEqual({ ok: false, error: 'No active AI provider configured' });
  });

  it('resolves the active provider + selected model on the happy path', async () => {
    const provider = { id: 'p1', type: 'api', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(provider);
    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(provider);
    expect(r.selectedModel).toBe('m-default');
    expect(r.modelSelection.tier).toBe('medium');
  });

  it('fails with providerId + status when unavailable and no fallback exists', async () => {
    const provider = { id: 'p1', type: 'api' };
    getActiveProvider.mockResolvedValue(provider);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'usage-limit', reason: 'limit' });
    getAllProviders.mockResolvedValue({ providers: [provider] });
    getFallbackProvider.mockResolvedValue(null);

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no fallback available');
    expect(r.providerId).toBe('p1');
    expect(r.providerStatus).toEqual({ message: 'usage-limit', reason: 'limit' });
  });

  it('switches to the fallback provider and pins its model when one is available', async () => {
    const primary = { id: 'p1', type: 'api' };
    const fallback = { id: 'p2', type: 'api', models: ['fb-model'] };
    getActiveProvider.mockResolvedValue(primary);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'rate-limit', reason: 'rl' });
    getAllProviders.mockResolvedValue({ providers: [primary, fallback] });
    getFallbackProvider.mockResolvedValue({ provider: fallback, model: 'fb-model', source: 'provider' });

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(fallback);
    // The fallback's configured model pin wins over the normal selection.
    expect(r.selectedModel).toBe('fb-model');
  });

  it('honors a user-specified provider and clears any fallback pin', async () => {
    const active = { id: 'p1', type: 'api' };
    const chosen = { id: 'p-user', type: 'api', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(active);
    getProviderById.mockResolvedValue(chosen);

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { provider: 'p-user' } });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(chosen);
    // No fallback pin — the user's provider gets normal model selection.
    expect(r.selectedModel).toBe('m-default');
  });

  it('honors a pinned provider before the active-provider availability gate', async () => {
    // The active provider is down, but the task pins a different, healthy
    // provider. The pin must win without the active provider's unavailability
    // ever blocking the task (regression: the override used to run after the
    // active-provider availability check, so a pinned-but-healthy provider
    // still failed when the active one was down).
    const active = { id: 'p-active', type: 'api' };
    const chosen = { id: 'p-user', type: 'api', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(active);
    getProviderById.mockResolvedValue(chosen);
    isProviderAvailable.mockImplementation((id) => id === 'p-user'); // active down, pinned up

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { provider: 'p-user' } });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(chosen);
    expect(r.selectedModel).toBe('m-default');
    expect(getFallbackProvider).not.toHaveBeenCalled();
  });

  it('honors a pinned provider even when no active provider is configured', async () => {
    const chosen = { id: 'p-user', type: 'api', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(null); // no active provider at all
    getProviderById.mockResolvedValue(chosen);

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { provider: 'p-user' } });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(chosen);
  });

  it('falls back to the provider tier default when the selected model is not in the provider model list', async () => {
    const provider = { id: 'p1', type: 'api', models: ['only-this'], heavyModel: 'heavy-x' };
    getActiveProvider.mockResolvedValue(provider);
    selectModelForTask.mockResolvedValue({ model: 'not-listed', tier: 'heavy', reason: 'heavy task' });

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(true);
    expect(r.selectedModel).toBe('heavy-x');
  });
});
