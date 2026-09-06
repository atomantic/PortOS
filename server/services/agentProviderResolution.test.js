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
vi.mock('./agentModelSelection.js', () => ({ selectModelForTask: vi.fn(), selectModelForRole: vi.fn() }));

import { resolveAgentProviderAndModel } from './agentProviderResolution.js';
import { getActiveProvider, getAllProviders, getProviderById } from './providers.js';
import { isProviderAvailable, getFallbackProvider, getProviderStatus } from './providerStatus.js';
import { selectModelForRole, selectModelForTask } from './agentModelSelection.js';

const TASK = { id: 'task-1', metadata: {} };

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults: provider present + available, plain model selection.
  isProviderAvailable.mockReturnValue(true);
  selectModelForTask.mockResolvedValue({ model: 'm-default', tier: 'medium', reason: 'default' });
  // The ordinary path resolves through the ARCHITECT role (#5992); with no
  // profile that is `selectModelForTask` verbatim, which is what the real
  // module does and what every selection assertion below is written against.
  selectModelForRole.mockImplementation((task, _role, provider, agent) => selectModelForTask(task, provider, agent));
});

describe('resolveAgentProviderAndModel', () => {
  it('blocks pre-upgrade issue-watcher prompts before selecting any agent provider', async () => {
    expect(await resolveAgentProviderAndModel({ id: 'legacy', metadata: { analysisType: 'issue-watcher', provider: 'cli' } }))
      .toMatchObject({ ok: false, permanent: true, error: expect.stringContaining('tool-free') });
    expect(getActiveProvider).not.toHaveBeenCalled();
    expect(getProviderById).not.toHaveBeenCalled();
  });
  it('blocks old trusted-maintenance tasks that predate author and discussion screening', async () => {
    for (const analysisType of ['pr-watcher', 'issue-reconcile']) {
      expect(await resolveAgentProviderAndModel({ id: 'legacy', metadata: { analysisType } })).toMatchObject({ ok: false, permanent: true });
    }
    expect(getActiveProvider).not.toHaveBeenCalled();
  });

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
    // A provider that's merely down stays transient — it may recover.
    expect(r.permanent).toBeFalsy();
  });

  it('keeps a down api provider with no fallback TRANSIENT (a null fallback may be a momentarily-down CLI fallback)', async () => {
    // Permanence is decided by provider TYPE at the harness check (reached once the
    // provider is available), NOT inferred from a transient unavailable + null
    // fallback here — a null fallback can mean a configured CLI/TUI fallback is
    // merely down, which must stay retryable. The down api provider retries cheaply
    // and self-heals to a permanent block the moment it's reachable.
    const provider = { id: 'ollama', type: 'api' };
    getActiveProvider.mockResolvedValue(provider);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'daemon-down', reason: 'down' });
    getAllProviders.mockResolvedValue({ providers: [provider] });
    getFallbackProvider.mockResolvedValue(null);

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('ollama');
    expect(r.permanent).toBeFalsy();
  });

  it('marks an AVAILABLE api provider permanent (harness check, self-heal target for a once-down api)', async () => {
    // The self-heal path for the transient case above: once the api provider is
    // reachable, resolution reaches the harness check and blocks permanently.
    const provider = { id: 'ollama', type: 'api' };
    getActiveProvider.mockResolvedValue(provider);
    isProviderAvailable.mockReturnValue(true);

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no file-writing harness');
    expect(r.permanent).toBe(true);
  });

  it('drops a model pin when the requested provider disappeared before the task ran', async () => {
    const active = { id: 'codex', type: 'cli', models: ['gpt-5'], defaultModel: 'gpt-5' };
    getProviderById.mockResolvedValue(null);
    getActiveProvider.mockResolvedValue(active);
    selectModelForTask.mockResolvedValue({
      model: 'claude-sonnet',
      tier: 'user-specified',
      reason: 'user-preference',
    });

    const r = await resolveAgentProviderAndModel({
      id: 't',
      metadata: { provider: 'claude-code', model: 'claude-sonnet' },
    });

    expect(r.ok).toBe(true);
    expect(r.provider).toBe(active);
    expect(r.selectedModel).toBe('gpt-5');
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
    // Marked permanent so the spawn caller retires the task instead of leaving
    // it pending to silently re-fail on every re-dispatch.
    expect(r.permanent).toBe(true);
    // Guard fires before model selection — never spawns.
    expect(selectModelForTask).not.toHaveBeenCalled();
  });

  it('rejects an api fallback from a CLI primary but keeps it retryable (transient)', async () => {
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
    // NOT permanent: the directly-resolved primary was a CLI provider that was only
    // momentarily unavailable and may recover, so the task must stay retryable.
    expect(r.permanent).toBe(false);
  });

  it('marks an api fallback from an api primary PERMANENT (no CLI path can ever resolve)', async () => {
    const apiPrimary = { id: 'ollama', type: 'api', models: ['q'] };
    const apiFallback = { id: 'lmstudio', type: 'api', models: ['m'] };
    getActiveProvider.mockResolvedValue(apiPrimary);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'down', reason: 'x' });
    getAllProviders.mockResolvedValue({ providers: [apiPrimary, apiFallback] });
    getFallbackProvider.mockResolvedValue({ provider: apiFallback, model: 'm', source: 'provider' });

    const r = await resolveAgentProviderAndModel(TASK);
    expect(r.ok).toBe(false);
    expect(r.providerId).toBe('lmstudio');
    // Both primary and fallback are api — no harness is reachable no matter how
    // often it retries, so it must be retired, not left pending forever.
    expect(r.permanent).toBe(true);
  });

  it('drops a user model pin when a fallback swap moved the task onto a DIFFERENT provider', async () => {
    // Regression: a task pinned provider `antigravity-tui` + model
    // `gemini-3.6-flash`. That provider hit an auth outage, the fallback chain
    // swapped to `claude-code`, and the CLI-pass-through exemption honored the
    // now-meaningless pin — shipping `claude --model gemini-3.6-flash`, which the
    // CLI rejects instantly on every retry until the task blocks.
    const pinned = { id: 'antigravity-tui', type: 'tui', models: ['gemini-3.6-flash-high'] };
    const fallback = { id: 'claude-code', type: 'cli', models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5' };
    getProviderById.mockResolvedValue(pinned);
    getActiveProvider.mockResolvedValue(pinned);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'auth-error', reason: 'auth-error' });
    getAllProviders.mockResolvedValue({ providers: [pinned, fallback] });
    // No configured fallback MODEL pin — the case that let the stale pin through.
    getFallbackProvider.mockResolvedValue({ provider: fallback, model: null, source: 'system' });
    selectModelForTask.mockResolvedValue({ model: 'gemini-3.6-flash', tier: 'user-specified', reason: 'user-preference' });

    const r = await resolveAgentProviderAndModel({
      id: 't', metadata: { provider: 'antigravity-tui', model: 'gemini-3.6-flash' }
    });
    expect(r.ok).toBe(true);
    expect(r.provider).toBe(fallback);
    expect(r.selectedModel).toBe('claude-sonnet-5'); // NOT the antigravity pin
  });

  it('drops a swap-invalidated pin even when the fallback provider enumerates no models', async () => {
    // The model-list check can't fire at all here, so the swap guard must own it.
    const pinned = { id: 'antigravity-tui', type: 'tui', models: ['gemini-3.6-flash-high'] };
    const fallback = { id: 'opencode', type: 'cli', defaultModel: 'oc-default' }; // no `models`
    getActiveProvider.mockResolvedValue(pinned);
    getProviderById.mockResolvedValue(pinned);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'down', reason: 'x' });
    getAllProviders.mockResolvedValue({ providers: [pinned, fallback] });
    getFallbackProvider.mockResolvedValue({ provider: fallback, model: null, source: 'system' });
    selectModelForTask.mockResolvedValue({ model: 'gemini-3.6-flash', tier: 'user-specified', reason: 'user-preference' });

    const r = await resolveAgentProviderAndModel({
      id: 't', metadata: { provider: 'antigravity-tui', model: 'gemini-3.6-flash' }
    });
    expect(r.ok).toBe(true);
    expect(r.selectedModel).toBe('oc-default');
  });

  it('keeps a user model pin across a swap when the fallback provider DOES list it', async () => {
    // Sibling providers share ids (claude-code / claude-code-tui) — a swap between
    // them must not throw away a pin the new provider can honor.
    const pinned = { id: 'claude-code', type: 'cli', models: ['claude-opus-5'] };
    const fallback = { id: 'claude-code-tui', type: 'tui', models: ['claude-opus-5'], defaultModel: 'claude-sonnet-5' };
    getActiveProvider.mockResolvedValue(pinned);
    isProviderAvailable.mockReturnValue(false);
    getProviderStatus.mockReturnValue({ message: 'down', reason: 'x' });
    getAllProviders.mockResolvedValue({ providers: [pinned, fallback] });
    getFallbackProvider.mockResolvedValue({ provider: fallback, model: null, source: 'system' });
    selectModelForTask.mockResolvedValue({ model: 'claude-opus-5', tier: 'user-specified', reason: 'user-preference' });

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { model: 'claude-opus-5' } });
    expect(r.ok).toBe(true);
    expect(r.selectedModel).toBe('claude-opus-5');
  });

  it('still honors an out-of-list user pin when NO provider swap happened', async () => {
    // Guards the swap fix against over-reach: the CLI pass-through exemption must
    // survive for the unavailable-provider-recovered / no-fallback path.
    const provider = { id: 'claude-code', type: 'cli', models: ['claude-opus-5'], defaultModel: 'claude-opus-5' };
    getActiveProvider.mockResolvedValue(provider);
    isProviderAvailable.mockReturnValue(true);
    selectModelForTask.mockResolvedValue({ model: 'claude-haiku-4-5', tier: 'user-specified', reason: 'user-preference' });

    const r = await resolveAgentProviderAndModel({ id: 't', metadata: { model: 'claude-haiku-4-5' } });
    expect(r.selectedModel).toBe('claude-haiku-4-5');
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

// ─── public-review stages ───────────────────────────────────────────────────
//
// A public-review stage must NOT go through the ordinary pin → active →
// fallback chain: that chain can swap onto any healthy provider, and running
// untrusted contributor content on a provider with no enforced posture is the
// exact failure this branch exists to prevent. These pin that the eligible set
// comes from the install's own enabled providers instead.
describe('resolveAgentProviderAndModel — public-review stages', () => {
  const CLAUDE = { id: 'claude-code', type: 'cli', command: 'claude' };
  const GROK = { id: 'grok-cli', type: 'cli', command: 'grok' };
  const OPENCODE = { id: 'opencode', type: 'cli', command: 'opencode' };
  const gateTask = (metadata = {}) => ({
    id: 'task-pr',
    metadata: { executionProfile: 'public-review-gate', ...metadata },
  });

  it('resolves onto the only eligible provider an install actually has', async () => {
    getAllProviders.mockResolvedValue({ providers: [OPENCODE, GROK], activeProvider: { id: 'opencode' } });
    const r = await resolveAgentProviderAndModel(gateTask());
    expect(r).toMatchObject({ ok: true, provider: { id: 'grok-cli' } });
    // Never consults the ordinary fallback chain.
    expect(getFallbackProvider).not.toHaveBeenCalled();
  });

  it('blocks queued legacy PR review tasks before any unsafe provider selection', async () => {
    const result = await resolveAgentProviderAndModel({ id: 'old-pr', metadata: { analysisType: 'pr-reviewer', executionProfile: 'public-review-actions' } });
    expect(result).toMatchObject({ ok: false, permanent: true });
    expect(getAllProviders).not.toHaveBeenCalled();
  });

  it('ignores a stage pin that is not eligible for the posture', async () => {
    getAllProviders.mockResolvedValue({ providers: [OPENCODE, CLAUDE], activeProvider: null });
    const r = await resolveAgentProviderAndModel(gateTask({ provider: 'opencode' }));
    expect(r).toMatchObject({ ok: true, provider: { id: 'claude-code' } });
  });

  // `selectModelForTask`'s real precedence: `task.metadata.model` wins outright
  // over everything else. The suite's flat `m-default` default cannot observe a
  // pin that leaks through it, so the tests below that assert a pin was DROPPED
  // install this instead — otherwise they pass no matter what the code does.
  const useRealisticModelSelection = () => selectModelForTask.mockImplementation(async (task, provider) => (
    task?.metadata?.model
      ? { model: task.metadata.model, tier: 'user-specified', reason: 'user-preference' }
      : { model: provider?.defaultModel || 'm-default', tier: 'medium', reason: 'default' }
  ));

  it('keeps a model pin only on the provider it was chosen for', async () => {
    useRealisticModelSelection();
    getAllProviders.mockResolvedValue({ providers: [CLAUDE, GROK], activeProvider: null });
    await expect(resolveAgentProviderAndModel(gateTask({ provider: 'grok-cli', model: 'grok-4' })))
      .resolves.toMatchObject({ provider: { id: 'grok-cli' }, selectedModel: 'grok-4' });
    // Pinned for a DIFFERENT provider — falls back to that provider's own model.
    // The posture swap above landed on claude-code, and grok's model id must not
    // ride along with it; leaving the pin on the task let `selectModelForTask`
    // hand it straight back, so the swap silently kept the foreign model.
    await expect(resolveAgentProviderAndModel(gateTask({ provider: 'opencode', model: 'grok-4' })))
      .resolves.toMatchObject({ provider: { id: 'claude-code' }, selectedModel: 'm-default' });
  });

  // A stage pin outlives edits to the provider's own model list: the live
  // pr-reviewer gate sat pinned to an id its provider no longer offered, so
  // every run spawned a CLI that could not serve the model, produced no
  // output, and was retried — matching the provider is not enough on its own.
  it('drops a model pin the matching provider no longer offers', async () => {
    const CURATED = { id: 'grok-cli', type: 'cli', command: 'grok', models: ['grok-4'], defaultModel: 'grok-4' };
    getAllProviders.mockResolvedValue({ providers: [CURATED], activeProvider: null });

    // Still listed → honored.
    await expect(resolveAgentProviderAndModel(gateTask({ provider: 'grok-cli', model: 'grok-4' })))
      .resolves.toMatchObject({ provider: { id: 'grok-cli' }, selectedModel: 'grok-4' });

    // Retired from the list → the provider's own selection wins instead.
    await expect(resolveAgentProviderAndModel(gateTask({ provider: 'grok-cli', model: 'grok-3-retired' })))
      .resolves.toMatchObject({ provider: { id: 'grok-cli' }, selectedModel: 'm-default' });
  });

  // The drop above has to survive model selection, which is where it used to
  // be undone: `selectModelForTask` answers `metadata.model` verbatim as its
  // highest-priority tier, so a resolution that left the rejected pin on the
  // task got the same id back and spawned the CLI with it — while logging that
  // it was "using its default instead". The mock is given the real precedence
  // here on purpose; the flat `m-default` default cannot observe the bug.
  it('does not let model selection hand the rejected pin back', async () => {
    useRealisticModelSelection();
    const CURATED = { id: 'grok-cli', type: 'cli', command: 'grok', models: ['grok-4'], defaultModel: 'grok-4' };
    getAllProviders.mockResolvedValue({ providers: [CURATED], activeProvider: null });

    const r = await resolveAgentProviderAndModel(gateTask({ provider: 'grok-cli', model: 'grok-3-retired' }));
    expect(r.selectedModel).toBe('grok-4');
  });

  // A LOCAL runtime's `models` array is a cached snapshot of what the daemon
  // had; the daemon itself is the authority, and the stage picker offers what
  // it reports. Judging the pin against the snapshot rejected a model that was
  // installed and serving — the live pr-reviewer gate logged "not offered by
  // provider" for a freshly pulled Ollama model on every dispatch.
  it('honors a model pin on a local-runtime provider whose cached list omits it', async () => {
    const LOCAL = {
      id: 'grok-ollama', type: 'cli', command: 'grok', ollamaBacked: true,
      models: ['qwen3-coder:30b'], defaultModel: 'qwen3-coder:30b',
    };
    getAllProviders.mockResolvedValue({ providers: [LOCAL], activeProvider: null });
    await expect(resolveAgentProviderAndModel(gateTask({ provider: 'grok-ollama', model: 'gemma3:27b' })))
      .resolves.toMatchObject({ provider: { id: 'grok-ollama' }, selectedModel: 'gemma3:27b' });
  });

  // A provider that enumerates no models is a pass-through, so the pin stands.
  it('honors a model pin on a provider that enumerates no models', async () => {
    getAllProviders.mockResolvedValue({ providers: [GROK], activeProvider: null });
    await expect(resolveAgentProviderAndModel(gateTask({ provider: 'grok-cli', model: 'anything-goes' })))
      .resolves.toMatchObject({ provider: { id: 'grok-cli' }, selectedModel: 'anything-goes' });
  });

  it('blocks PERMANENTLY when no enabled provider can enforce the posture', async () => {
    getAllProviders.mockResolvedValue({ providers: [OPENCODE], activeProvider: { id: 'opencode' } });
    const r = await resolveAgentProviderAndModel(gateTask());
    expect(r.ok).toBe(false);
    expect(r.permanent).toBe(true);
    expect(r.error).toMatch(/no-tool/);
  });

  it('requires a maintained actions recipe for binary providers and rejects API spawns', async () => {
    const OPENCODE = { id: 'opencode', type: 'cli', command: 'opencode' };
    getAllProviders.mockResolvedValue({ providers: [OPENCODE], activeProvider: { id: 'opencode' } });
    // opencode has no no-tool recipe, so the gate fails closed; the actions
    // stage still runs headless in the disposable worktree.
    await expect(resolveAgentProviderAndModel({ id: 't', metadata: { executionProfile: 'public-review-gate' } }))
      .resolves.toMatchObject({ ok: false, permanent: true });
    await expect(resolveAgentProviderAndModel({ id: 't', metadata: { executionProfile: 'public-review-actions' } }))
      .resolves.toMatchObject({ ok: false, permanent: true });

    getAllProviders.mockResolvedValue({ providers: [{ id: 'ollama', type: 'api' }], activeProvider: { id: 'ollama' } });
    await expect(resolveAgentProviderAndModel({ id: 't', metadata: { executionProfile: 'public-review-actions' } }))
      .resolves.toMatchObject({ ok: false, permanent: true });
  });
});

describe('orchestration profiles (#5992)', () => {
  it('resolves the architect provider pin instead of the active provider', async () => {
    const architectProvider = { id: 'p-architect', type: 'cli', defaultModel: 'm-architect', models: ['m-architect'] };
    getProviderById.mockResolvedValue(architectProvider);
    getActiveProvider.mockResolvedValue({ id: 'p-active', type: 'cli', defaultModel: 'm-active' });
    selectModelForRole.mockResolvedValue({ model: 'm-architect', tier: 'user-specified', reason: 'orchestration-role-architect' });

    const result = await resolveAgentProviderAndModel({
      id: 'task-orchestrated',
      metadata: {
        orchestrationMode: 'orchestrated',
        orchestrationProfile: { architect: { provider: 'p-architect', model: 'm-architect' } },
      },
    });

    expect(getProviderById).toHaveBeenCalledWith('p-architect');
    expect(result.ok).toBe(true);
    expect(result.provider.id).toBe('p-architect');
    expect(result.selectedModel).toBe('m-architect');
  });

  it('leaves a direct-mode task on its own metadata provider pin', async () => {
    getProviderById.mockResolvedValue({ id: 'p-pinned', type: 'cli', defaultModel: 'm-pinned' });
    getActiveProvider.mockResolvedValue({ id: 'p-active', type: 'cli', defaultModel: 'm-active' });

    const result = await resolveAgentProviderAndModel({
      id: 'task-direct',
      metadata: {
        provider: 'p-pinned',
        orchestrationProfile: { architect: { provider: 'p-architect' } },
      },
    });

    expect(getProviderById).toHaveBeenCalledWith('p-pinned');
    expect(result.provider.id).toBe('p-pinned');
  });
});
