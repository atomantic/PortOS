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
    const provider = { id: 'p1', type: 'cli', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(provider);
    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(provider);
    expect(r.selectedModel).toBe('m-default');
    expect(r.modelSelection.tier).toBe('medium');
  });

  it('fails with providerId + status when unavailable and no fallback exists', async () => {
    const provider = { id: 'p1', type: 'cli' };
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
    const primary = { id: 'p1', type: 'cli' };
    const fallback = { id: 'p2', type: 'cli', models: ['fb-model'] };
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
    const active = { id: 'p1', type: 'cli' };
    const chosen = { id: 'p-user', type: 'cli', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(active);
    getProviderById.mockResolvedValue(chosen);

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { provider: 'p-user' } });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(chosen);
    // No fallback pin — the user's provider gets normal model selection.
    expect(r.selectedModel).toBe('m-default');
  });

  it('honors an explicit user-specified model even when it is not in the provider list (no silent downgrade)', async () => {
    // Regression: claude-code-tui lists the DATED haiku id, so an undated
    // `claude-haiku-4-5` pin failed the includes() check and silently
    // downgraded to the provider default (opus, the heaviest model).
    const provider = { id: 'claude-code-tui', type: 'tui', models: ['claude-haiku-4-5-20251001', 'claude-opus-4-8'], defaultModel: 'claude-opus-4-8', heavyModel: 'claude-opus-4-8' };
    getActiveProvider.mockResolvedValue(provider);
    selectModelForTask.mockResolvedValue({ model: 'claude-haiku-4-5', tier: 'user-specified', reason: 'user-preference' });

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { model: 'claude-haiku-4-5' } });
    expect(r.ok).toBe(true);
    expect(r.selectedModel).toBe('claude-haiku-4-5'); // honored, NOT downgraded to opus
  });

  it('still downgrades an AUTO-selected model that is not in the provider list to the tier default', async () => {
    const provider = { id: 'p1', type: 'cli', models: ['m-default'], defaultModel: 'm-default', heavyModel: 'm-heavy' };
    getActiveProvider.mockResolvedValue(provider);
    selectModelForTask.mockResolvedValue({ model: 'bogus-auto', tier: 'heavy', reason: 'complex-task' });

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(true);
    expect(r.selectedModel).toBe('m-heavy'); // auto-selected invalid model → tier fallback
  });

  it('honors a pinned provider before the active-provider availability gate', async () => {
    // The active provider is down, but the task pins a different, healthy
    // provider. The pin must win without the active provider's unavailability
    // ever blocking the task (regression: the override used to run after the
    // active-provider availability check, so a pinned-but-healthy provider
    // still failed when the active one was down).
    const active = { id: 'p-active', type: 'cli' };
    const chosen = { id: 'p-user', type: 'cli', models: ['m-default'] };
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
    const chosen = { id: 'p-user', type: 'cli', models: ['m-default'] };
    getActiveProvider.mockResolvedValue(null); // no active provider at all
    getProviderById.mockResolvedValue(chosen);

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { provider: 'p-user' } });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(chosen);
  });

  it('rejects an api-type provider (no file-writing harness) with a clear error', async () => {
    // Ollama / LM Studio over HTTP return plain text and can't run file-writing
    // agent tasks. Guard so they never reach the CLI spawn path.
    const provider = { id: 'ollama', type: 'api', models: ['qwen2.5:7b'] };
    getActiveProvider.mockResolvedValue(provider);

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('ollama');
    expect(r.error).toContain('no file-writing harness');
    // Guard fires before model selection — never spawns.
    expect(selectModelForTask).not.toHaveBeenCalled();
  });

  it('rejects an api-type provider even when reached via the fallback chain', async () => {
    const primary = { id: 'p1', type: 'cli' };
    const apiFallback = { id: 'lmstudio', type: 'api', models: ['m'] };
    getActiveProvider.mockResolvedValue(primary);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'down', reason: 'x' });
    getAllProviders.mockResolvedValue({ providers: [primary, apiFallback] });
    getFallbackProvider.mockResolvedValue({ provider: apiFallback, model: 'm', source: 'provider' });

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('lmstudio');
    expect(r.error).toContain('no file-writing harness');
  });

  it('falls back to the provider tier default when the selected model is not in the provider model list', async () => {
    const provider = { id: 'p1', type: 'cli', models: ['only-this'], heavyModel: 'heavy-x' };
    getActiveProvider.mockResolvedValue(provider);
    selectModelForTask.mockResolvedValue({ model: 'not-listed', tier: 'heavy', reason: 'heavy task' });

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(true);
    expect(r.selectedModel).toBe('heavy-x');
  });
});
