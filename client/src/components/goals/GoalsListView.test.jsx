import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { toastError, organizeGoals } = vi.hoisted(() => ({
  toastError: vi.fn(),
  organizeGoals: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(() => {}, { error: toastError, success: () => {} }),
}));
vi.mock('../../services/api', () => ({
  createGoal: vi.fn(),
  organizeGoals,
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

const renderList = async () => {
  render(<GoalsListView data={DATA} onRefresh={vi.fn()} />);
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

    await user.click(screen.getByRole('button', { name: /organize/i }));
    await act(async () => {});

    expect(organizeGoals).toHaveBeenCalledWith(
      { providerId: 'provider-1', model: 'example-model' },
      { silent: true },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith('Failed to organize goals');
  });
});
