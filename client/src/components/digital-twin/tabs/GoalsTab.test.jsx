import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/apiGoals.js', () => ({
  getGoals: vi.fn(),
  getLongevity: vi.fn(),
  deriveLongevity: vi.fn(),
}));

import { getGoals, getLongevity, deriveLongevity } from '../../../services/apiGoals.js';
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
});
