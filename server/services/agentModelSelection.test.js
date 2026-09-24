import { describe, it, expect, vi, beforeEach } from 'vitest';

// The learning store is mocked only to prove selection never consults it: a
// proven `medium` suggestion used to swap a "default model" task onto the
// provider's lighter mediumModel with no trace (#8148).
vi.mock('./taskLearning.js', () => ({
  suggestModelTier: vi.fn()
}));

import { selectModelForRole, selectModelForTask } from './agentModelSelection.js';
import { suggestModelTier } from './taskLearning.js';

const PROVIDER = {
  defaultModel: 'default-model',
  mediumModel: 'medium-model',
  heavyModel: 'heavy-model',
  lightModel: 'light-model'
};

const benignTask = { description: 'organize the weekly digest', taskType: 'user' };

describe('selectModelForTask — no implicit tier routing (#8149)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs an unpinned task on the provider default even when learning would suggest another tier', async () => {
    suggestModelTier.mockResolvedValue({ suggested: 'medium', reason: 'proven' });
    const result = await selectModelForTask({ ...benignTask, metadata: { analysisType: 'claim-issue' } }, PROVIDER);
    expect(result).toEqual({ model: 'default-model', tier: 'default', reason: 'provider-default' });
    expect(suggestModelTier).not.toHaveBeenCalled();
  });

  it('ignores description, priority and context size — none of them pick a tier', async () => {
    const tasks = [
      { description: 'architect and refactor the security audit screenshot', priority: 'CRITICAL' },
      { description: 'fix typo in readme', priority: 'LOW' },
      { description: 'simple task', metadata: { context: 'x'.repeat(5000) } },
    ];
    for (const task of tasks) {
      expect(await selectModelForTask(task, PROVIDER)).toMatchObject({ model: 'default-model', tier: 'default' });
    }
  });

  it('resolves an explicit tier on the given provider, with Ultra falling back to heavy', async () => {
    const task = { description: 'plan', metadata: { model: 'ultra' } };
    expect(await selectModelForTask(task, { ...PROVIDER, ultraModel: 'frontier-model' }))
      .toMatchObject({ model: 'frontier-model', tier: 'ultra' });
    expect(await selectModelForTask(task, PROVIDER)).toMatchObject({ model: 'heavy-model', tier: 'ultra' });
    expect(await selectModelForTask({ ...task, metadata: { model: 'light' } }, { defaultModel: 'only-default' }))
      .toMatchObject({ model: 'only-default', tier: 'light' });
  });

  it('passes an explicit model id through as a user pin with its provider', async () => {
    expect(await selectModelForTask({ description: 'x', metadata: { model: 'exact-model', provider: 'codex' } }, PROVIDER))
      .toEqual({ model: 'exact-model', tier: 'user-specified', reason: 'user-preference', userProvider: 'codex' });
  });
});

describe('selectModelForRole — orchestration profiles (#5992)', () => {
  const orchestratedTask = (profile) => ({
    ...benignTask,
    metadata: { orchestrationMode: 'orchestrated', orchestrationProfile: profile },
  });

  it('honors the role model pin', async () => {
    const result = await selectModelForRole(
      orchestratedTask({ implementer: { model: 'cheap-model', provider: 'codex' } }),
      'implementer',
      PROVIDER
    );
    expect(result.model).toBe('cheap-model');
    expect(result.tier).toBe('user-specified');
    expect(result.reason).toBe('orchestration-role-implementer');
    expect(result.userProvider).toBe('codex');
  });

  it('resolves role capability independently from reasoning effort', async () => {
    const result = await selectModelForRole(
      orchestratedTask({ architect: { model: 'ultra', effort: 'low' } }),
      'architect', { ...PROVIDER, ultraModel: 'frontier' },
    );
    expect(result).toMatchObject({ model: 'frontier', tier: 'ultra', orchestrationEffort: 'low' });
  });

  it('falls through to selectModelForTask for a role the profile does not pin', async () => {
    const task = orchestratedTask({ architect: { model: 'opus' } });
    const direct = await selectModelForTask(task, PROVIDER);
    const role = await selectModelForRole(task, 'reviewer', PROVIDER);
    expect(role.model).toBe(direct.model);
    expect(role.reason).toBe(direct.reason);
    expect(role.orchestrationRole).toBeUndefined();
  });

  it('carries a role effort default forward even when only the model falls through', async () => {
    const result = await selectModelForRole(
      orchestratedTask({ reviewer: { effort: 'low' } }),
      'reviewer',
      PROVIDER
    );
    expect(result.model).toBe(PROVIDER.defaultModel);
    expect(result.orchestrationRole).toBe('reviewer');
    expect(result.orchestrationEffort).toBe('low');
  });

  it('is byte-identical to selectModelForTask on a direct-mode task, profile or not', async () => {
    const task = {
      ...benignTask,
      metadata: { orchestrationProfile: { architect: { model: 'opus' } } },
    };
    expect(await selectModelForRole(task, 'architect', PROVIDER))
      .toEqual(await selectModelForTask(task, PROVIDER));
  });

  it('ignores an unknown role rather than treating it as unpinned config', async () => {
    const result = await selectModelForRole(
      orchestratedTask({ architect: { model: 'opus' } }),
      'saboteur',
      PROVIDER
    );
    expect(result.model).toBe(PROVIDER.defaultModel);
    expect(result.orchestrationRole).toBeUndefined();
  });
});
