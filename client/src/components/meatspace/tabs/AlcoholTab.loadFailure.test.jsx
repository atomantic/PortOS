import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getAlcoholSummary: vi.fn(),
  getDailyAlcohol: vi.fn(),
  getCustomDrinks: vi.fn(),
  getAppleHealthCorrelation: vi.fn(),
}));
vi.mock('../AlcoholChart', () => ({ default: () => null }));
vi.mock('../AlcoholHrvCorrelation', () => ({ default: () => null }));
vi.mock('../StandardDrinkCalculator', () => ({ default: () => null }));

import * as api from '../../../services/api';
import AlcoholTab from './AlcoholTab';

beforeEach(() => {
  api.getAlcoholSummary.mockResolvedValue(null);
  api.getCustomDrinks.mockResolvedValue(null);
  api.getAppleHealthCorrelation.mockResolvedValue(null);
});
afterEach(cleanup);

describe('AlcoholTab history load', () => {
  it('shows a retryable notice when the history read fails, then the history once it succeeds', async () => {
    api.getDailyAlcohol.mockRejectedValueOnce(new Error('boom'));
    render(<AlcoholTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load drink history');
    expect(screen.queryByText(/All Drink Entries/)).toBeNull();

    api.getDailyAlcohol.mockResolvedValue([{ date: '2026-03-01', alcohol: { drinks: [] } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/All Drink Entries \(1 days\)/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
