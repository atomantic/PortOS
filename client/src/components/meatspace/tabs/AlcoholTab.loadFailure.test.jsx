import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getAlcoholSummary: vi.fn(),
  getDailyAlcohol: vi.fn(),
  getCustomDrinks: vi.fn(),
  logAlcoholDrink: vi.fn(),
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
  logAlcoholDrink,
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
    await waitFor(() => expect(screen.getByText(/All Drink Entries \(1 day\)/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


it('sends the rendered event identity when editing and deleting a history row', async () => {
  getDailyAlcohol.mockResolvedValue([{ date: '2024-06-01', alcohol: { drinks: [{ id: 'event-id', name: 'Example', oz: 12, abv: 5, count: 1 }] } }]);
  render(<AlcoholTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Example entry for 2024-06-01', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(updateAlcoholDrink).toHaveBeenCalledWith('2024-06-01', 0, expect.objectContaining({ id: 'event-id' })));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Example entry for 2024-06-01', exact: true }));
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
  fireEvent.click(screen.getAllByRole('button', { name: /Edit Example/ })[1]);
  expect(screen.getByLabelText('Drink button name')).toHaveValue('Example Lager');

  fireEvent.click(screen.getAllByRole('button', { name: /^Remove Example/ })[0]);
  const confirm = screen.getByRole('group', { name: 'Confirm remove quick-add button Example Stout' });
  fireEvent.click(within(confirm).getByRole('button', { name: /Remove/ }));
  await waitFor(() => expect(removeCustomDrink).toHaveBeenCalledWith(0));
  await waitFor(() => expect(screen.queryByText('Example Stout')).toBeNull());
  expect(screen.getByLabelText('Drink button name')).toHaveValue('Example Lager');
  expect(getCustomDrinks).toHaveBeenCalledTimes(1);
});

it('keeps a custom drink draft when the log rejects, and clears it once a log resolves', async () => {
  getDailyAlcohol.mockResolvedValueOnce([]);
  logAlcoholDrink.mockRejectedValueOnce(new Error('boom'));
  render(<AlcoholTab />);
  await screen.findByRole('button', { name: 'Log' });

  fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Hazy IPA' } });
  fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('ABV %'), { target: { value: '6.5' } });
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Log' }));

  await waitFor(() => expect(logAlcoholDrink).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Name (optional)')).toHaveValue('Hazy IPA');
  expect(screen.getByLabelText('Volume')).toHaveValue(12);
  expect(screen.getByLabelText('ABV %')).toHaveValue(6.5);
  expect(screen.getByLabelText('Count')).toHaveValue(2);
  expect(screen.getByLabelText('Date')).toHaveValue('2026-03-02');
  expect(getDailyAlcohol).toHaveBeenCalledTimes(1);

  getDailyAlcohol.mockResolvedValueOnce([{
    date: '2026-03-02',
    alcohol: { drinks: [{ id: 'logged', name: 'Hazy IPA', oz: 12, abv: 6.5, count: 2 }] },
  }]);
  logAlcoholDrink.mockResolvedValueOnce({ id: 'logged' });
  fireEvent.click(screen.getByRole('button', { name: 'Log' }));

  await waitFor(() => expect(screen.getByText('Hazy IPA')).toBeTruthy());
  expect(screen.getByLabelText('Name (optional)')).toHaveValue('');
  expect(screen.getByLabelText('Volume')).toHaveValue(null);
  expect(screen.getByLabelText('ABV %')).toHaveValue(null);
  expect(logAlcoholDrink).toHaveBeenCalledTimes(2);
});

it('leaves the drink editor open when the update rejects', async () => {
  getDailyAlcohol.mockResolvedValue([{
    date: '2024-06-01',
    alcohol: { drinks: [{ id: 'event-id', name: 'Example', oz: 12, abv: 5, count: 1 }] },
  }]);
  updateAlcoholDrink.mockRejectedValueOnce(new Error('boom'));
  render(<AlcoholTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Example entry for 2024-06-01', exact: true }));
  fireEvent.change(screen.getByLabelText('Entry name'), { target: { value: 'Corrected' } });
  const readsBeforeSave = getDailyAlcohol.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(updateAlcoholDrink).toHaveBeenCalled());
  expect(screen.getByLabelText('Entry name')).toHaveValue('Corrected');
  expect(getDailyAlcohol.mock.calls.length).toBe(readsBeforeSave);
});
