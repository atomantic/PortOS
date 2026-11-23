import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/apiGoals.js', () => ({
  getGoals: vi.fn(),
  getLongevity: vi.fn(),
  deriveLongevity: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  deleteGoal: vi.fn(),
  setBirthDate: vi.fn(),
  addGoalMilestone: vi.fn(),
  completeGoalMilestone: vi.fn(),
}));

import { getGoals, getLongevity, deriveLongevity, createGoal, updateGoal } from '../../../services/apiGoals.js';
import GoalsTab from './GoalsTab.jsx';

describe('GoalsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGoals.mockResolvedValue({ birthDate: '1990-01-01', goals: [] });
    getLongevity.mockResolvedValue(null);
  });

  it('re-enables longevity derivation after the request fails', async () => {
    deriveLongevity.mockRejectedValueOnce(new Error('derive unavailable'));

    render(<GoalsTab />);
    const derive = await screen.findByRole('button', { name: 'Re-derive' });

    await act(async () => { fireEvent.click(derive); });

    expect(derive).toBeEnabled();
    expect(derive).toHaveTextContent('Re-derive');
  });

  it('distinguishes a failed goals read from a successful empty response', async () => {
    getGoals.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ goals: [] });
    render(<GoalsTab />);

    expect(await screen.findByText('Could not load goals.')).toBeInTheDocument();
    expect(screen.queryByText(/No goals yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No goals yet/)).toBeInTheDocument();
  });

  it('keeps the new-goal draft when create fails, and submits once while in flight', async () => {
    let reject;
    createGoal.mockReturnValueOnce(new Promise((_, rej) => { reject = rej; }));
    render(<GoalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Add Goal/ }));
    fireEvent.change(screen.getByLabelText('Goal title'), { target: { value: 'Learn piano' } });
    const create = screen.getByRole('button', { name: 'Create' });

    fireEvent.click(create);
    fireEvent.click(create);
    expect(createGoal).toHaveBeenCalledTimes(1);
    expect(create).toBeDisabled();

    await act(async () => { reject(new Error('offline')); });
    expect(screen.getByLabelText('Goal title')).toHaveValue('Learn piano');
    expect(create).toBeEnabled();
  });

  it('guards goal status updates against double-submit and swallows a rejection', async () => {
    getGoals.mockResolvedValue({
      birthDate: '1990-01-01',
      goals: [{ id: 'g1', title: 'Ship it', category: 'mastery', horizon: '5-year', status: 'active', milestones: [] }],
    });
    let reject;
    updateGoal.mockReturnValueOnce(new Promise((_, rej) => { reject = rej; }));
    render(<GoalsTab />);
    fireEvent.click(await screen.findByText('Ship it'));
    const complete = await screen.findByRole('button', { name: /Complete/ });

    fireEvent.click(complete);
    fireEvent.click(complete);
    expect(updateGoal).toHaveBeenCalledTimes(1);
    expect(complete).toBeDisabled();

    await act(async () => { reject(new Error('offline')); });
    expect(complete).toBeEnabled();
  });
});
