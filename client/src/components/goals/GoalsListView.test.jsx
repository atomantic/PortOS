import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { toastError, toastSuccess, organizeGoals, createGoal, applyGoalOrganization } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  organizeGoals: vi.fn(),
  createGoal: vi.fn(),
  applyGoalOrganization: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(() => {}, { error: toastError, success: toastSuccess }),
}));
vi.mock('../../services/api', () => ({
  createGoal,
  organizeGoals,
  applyGoalOrganization,
}));
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'provider-1', name: 'Example Provider' }],
    selectedProviderId: 'provider-1',
    selectedModel: 'example-model',
    availableModels: ['example-model'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

import GoalsListView from './GoalsListView';

// Invented placeholder goals — never real records from a running install.
const GOALS = [
  { id: 'g1', title: 'Sail across an ocean', category: 'mastery', horizon: 'lifetime', goalType: 'apex', children: [] },
  { id: 'g2', title: 'Restore the boat', category: 'creative', horizon: '3-year', children: [] },
];
// The Organize button only renders once there are >= 2 goals to reorganize.
const DATA = { roots: GOALS, flat: GOALS };

const renderList = async (onRefresh = vi.fn()) => {
  render(<GoalsListView data={DATA} onRefresh={onRefresh} />);
  await act(async () => {});
  return onRefresh;
};

// A minimal suggestion that forces applyOrganizationSuggestion down the "create a new
// apex first" branch, so a rejected createGoal makes it return false.
const NEW_APEX_SUGGESTION = {
  apexGoal: { existingId: null, suggestedTitle: 'Example apex', suggestedDescription: '' },
  organization: [{ id: 'g1', goalType: 'sub-apex', suggestedParentId: '__new_apex__' }],
  suggestedSubApex: [],
};

const clickOrganize = async (user) => {
  await user.click(screen.getByRole('button', { name: /organize/i }));
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleOrganize error toasting', () => {
  // Guards #3515: this handler owns the "Failed to organize goals" toast, so the
  // request helper must be told to stay quiet — otherwise a failed AI run stacks
  // two error toasts on top of each other.
  it('asks the API helper to stay silent and toasts the failure exactly once', async () => {
    const user = userEvent.setup();
    organizeGoals.mockRejectedValue(new Error('Organization failed'));
    await renderList();

    await clickOrganize(user);

    expect(organizeGoals).toHaveBeenCalledWith(
      { providerId: 'provider-1', model: 'example-model' },
      { silent: true },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed to organize goals');
  });
});

describe('handleOrganize apply-failure path', () => {
  // Guards #3516: applyOrganizationSuggestion folds every API failure into a `false`
  // return. Ignoring it toasted "Goal hierarchy applied" over a backend that never
  // took the change.
  it('toasts an error and no success when applying the hierarchy fails', async () => {
    const user = userEvent.setup();
    organizeGoals.mockResolvedValue(NEW_APEX_SUGGESTION);
    createGoal.mockRejectedValue(new Error('apex create failed'));
    const onRefresh = await renderList();

    await clickOrganize(user);

    // The apply helper stays silent so this handler is the only toast source.
    expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ goalType: 'apex' }), { silent: true });
    expect(applyGoalOrganization).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed to apply goal hierarchy');
    // Still refreshed — a partial apply must not leave a stale list on screen.
    expect(onRefresh).toHaveBeenCalled();
  });

  it('toasts success and refreshes when the hierarchy applies cleanly', async () => {
    const user = userEvent.setup();
    organizeGoals.mockResolvedValue(NEW_APEX_SUGGESTION);
    createGoal.mockResolvedValue({ id: 'apex-1' });
    applyGoalOrganization.mockResolvedValue(true);
    const onRefresh = await renderList();

    await clickOrganize(user);

    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('Goal hierarchy applied');
    expect(onRefresh).toHaveBeenCalled();
  });
});
