import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getAlcoholSummary: vi.fn(),
  getDailyAlcohol: vi.fn(),
  getCustomDrinks: vi.fn(),
  updateAlcoholDrink: vi.fn().mockResolvedValue({}),
  removeAlcoholDrink: vi.fn().mockResolvedValue({}),
  removeCustomDrink: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../services/apiHealth.js', () => ({
  getAppleHealthCorrelation: vi.fn(),
}));
vi.mock('../AlcoholChart', () => ({ default: () => null }));
vi.mock('../AlcoholHrvCorrelation', () => ({ default: () => null }));
vi.mock('../StandardDrinkCalculator', () => ({ default: () => null }));

import {
  getAlcoholSummary,
  getCustomDrinks,
  getDailyAlcohol,
  updateAlcoholDrink,
  removeAlcoholDrink,
  removeCustomDrink,
} from '../../../services/apiMeatspace.js';
import { getAppleHealthCorrelation } from '../../../services/apiHealth.js';
import AlcoholTab from './AlcoholTab';

beforeEach(() => {
  getAlcoholSummary.mockResolvedValue(null);
  getCustomDrinks.mockResolvedValue([]);
  getAppleHealthCorrelation.mockResolvedValue(null);
});
afterEach(cleanup);

describe('AlcoholTab history load', () => {
  it('shows a retryable notice when the history read fails, then the history once it succeeds', async () => {
    getDailyAlcohol.mockRejectedValueOnce(new Error('boom'));
    render(<AlcoholTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load drink history');
    expect(screen.queryByText(/All Drink Entries/)).toBeNull();

    getDailyAlcohol.mockResolvedValue([{ date: '2026-03-01', alcohol: { drinks: [] } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/All Drink Entries \(1 days\)/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


it('sends the rendered event identity when editing and deleting a history row', async () => {
  getDailyAlcohol.mockResolvedValue([{ date: '2024-06-01', alcohol: { drinks: [{ id: 'event-id', name: 'Example', oz: 12, abv: 5, count: 1 }] } }]);
  render(<AlcoholTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit drink', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(updateAlcoholDrink).toHaveBeenCalledWith('2024-06-01', 0, expect.objectContaining({ id: 'event-id' })));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove drink', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
  await waitFor(() => expect(removeAlcoholDrink).toHaveBeenCalledWith('2024-06-01', 0, 'event-id'));
});

it('hides quick-add buttons and Manage when the button read fails, so a positional edit cannot hit a different stored button', async () => {
  getDailyAlcohol.mockResolvedValue([]);
  getCustomDrinks.mockRejectedValueOnce(new Error('boom'));
  render(<AlcoholTab />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your quick-add drink buttons');
  expect(screen.queryByRole('button', { name: /Manage/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Modelo/ })).toBeNull();
  expect(getCustomDrinks).toHaveBeenLastCalledWith({ silent: true });

  getCustomDrinks.mockResolvedValueOnce([{ name: 'Example Stout', oz: 12, abv: 5 }]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: /Example Stout/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Manage/ })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps the edit draft on the same drink when an earlier button is removed in place', async () => {
  getDailyAlcohol.mockResolvedValue([]);
  getCustomDrinks.mockResolvedValueOnce([{ name: 'Example Stout', oz: 12, abv: 5 }, { name: 'Example Lager', oz: 12, abv: 4 }]);
  removeCustomDrink.mockResolvedValue({ name: 'Example Stout', oz: 12, abv: 5 });
  render(<AlcoholTab />);
  fireEvent.click(await screen.findByRole('button', { name: /Manage/ }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
  expect(screen.getByLabelText('Drink button name')).toHaveValue('Example Lager');

  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
  const confirm = screen.getByRole('group', { name: 'Confirm remove quick-add button Example Stout' });
  fireEvent.click(within(confirm).getByRole('button', { name: /Remove/ }));
  await waitFor(() => expect(removeCustomDrink).toHaveBeenCalledWith(0));
  await waitFor(() => expect(screen.queryByText('Example Stout')).toBeNull());
  expect(screen.getByLabelText('Drink button name')).toHaveValue('Example Lager');
  expect(getCustomDrinks).toHaveBeenCalledTimes(1);
});
