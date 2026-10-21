import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getNicotineSummary: vi.fn(),
  getDailyNicotine: vi.fn(),
  getCustomNicotineProducts: vi.fn(),
  getAppleHealthCorrelation: vi.fn(),
}));
vi.mock('../NicotineChart', () => ({ default: () => null }));
vi.mock('../NicotineHealthCorrelation', () => ({ default: () => null }));

import * as api from '../../../services/api';
import NicotineTab from './NicotineTab';

beforeEach(() => {
  api.getNicotineSummary.mockResolvedValue(null);
  api.getCustomNicotineProducts.mockResolvedValue(null);
  api.getAppleHealthCorrelation.mockResolvedValue(null);
});
afterEach(cleanup);

describe('NicotineTab history load', () => {
  it('shows a retryable notice when the history read fails, then the history once it succeeds', async () => {
    api.getDailyNicotine.mockRejectedValueOnce(new Error('boom'));
    render(<NicotineTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load nicotine history');
    expect(screen.queryByText(/History \(/)).toBeNull();

    api.getDailyNicotine.mockResolvedValue([{ date: '2026-03-01', nicotine: { items: [] } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/History \(1 days\)/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
