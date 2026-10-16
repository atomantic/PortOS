import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getGoals: vi.fn(),
  getLongevity: vi.fn(),
  deriveLongevity: vi.fn(),
}));

import * as api from '../../../services/api';
import GoalsTab from './GoalsTab.jsx';

describe('GoalsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getGoals.mockResolvedValue({ birthDate: '1990-01-01', goals: [] });
    api.getLongevity.mockResolvedValue(null);
  });

  it('re-enables longevity derivation after the request fails', async () => {
    api.deriveLongevity.mockRejectedValueOnce(new Error('derive unavailable'));

    render(<GoalsTab />);
    const derive = await screen.findByRole('button', { name: 'Re-derive' });

    await act(async () => { fireEvent.click(derive); });

    expect(derive).toBeEnabled();
    expect(derive).toHaveTextContent('Re-derive');
  });
});
