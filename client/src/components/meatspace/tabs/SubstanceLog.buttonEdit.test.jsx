import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as meatspace from '../../../services/apiMeatspace.js';
import toast from '../../ui/Toast';
import AlcoholTab from './AlcoholTab';
import NicotineTab from './NicotineTab';

vi.mock('../../../services/apiMeatspace.js', { spy: true });
vi.mock('../../../services/apiHealth.js', () => ({
  getAppleHealthCorrelation: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../ui/Toast', () => ({ default: { error: vi.fn() } }));
vi.mock('../AlcoholChart', () => ({ default: () => null }));
vi.mock('../AlcoholHrvCorrelation', () => ({ default: () => null }));
vi.mock('../StandardDrinkCalculator', () => ({ default: () => null }));
vi.mock('../NicotineChart', () => ({ default: () => null }));
vi.mock('../NicotineHealthCorrelation', () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  meatspace.getAlcoholSummary.mockResolvedValue(null);
  meatspace.getNicotineSummary.mockResolvedValue(null);
  meatspace.getDailyAlcohol.mockResolvedValue([]);
  meatspace.getDailyNicotine.mockResolvedValue([]);
});
afterEach(cleanup);

it.each([
  {
    Tab: AlcoholTab,
    label: 'drink',
    buttonName: 'Drink button name',
    removeLabel: 'Remove First sample',
    confirmLabel: 'Confirm remove quick-add button First sample',
    read: meatspace.getCustomDrinks,
    update: meatspace.updateCustomDrink,
    remove: meatspace.removeCustomDrink,
    dose: { oz: 12, abv: 5 },
  },
  {
    Tab: NicotineTab,
    label: 'product',
    buttonName: 'Product button name',
    removeLabel: 'Delete First sample',
    confirmLabel: 'Confirm remove product button First sample',
    read: meatspace.getCustomNicotineProducts,
    update: meatspace.updateCustomNicotineProduct,
    remove: meatspace.removeCustomNicotineProduct,
    dose: { mgPerUnit: 2 },
  },
])('retains a rejected $label button edit and retries it at the shifted index', async ({
  Tab, label, buttonName, removeLabel, confirmLabel, read, update, remove, dose,
}) => {
  const first = { name: 'First sample', ...dose };
  const second = { name: 'Second sample', ...dose };
  const edited = { name: 'Edited sample', ...dose };
  read.mockResolvedValue([first, second]);
  remove.mockResolvedValue(first);
  update.mockRejectedValueOnce(new Error('save failed')).mockResolvedValueOnce(edited);

  render(<Tab />);
  fireEvent.click(await screen.findByRole('button', { name: /Manage/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Second sample' }));
  fireEvent.change(screen.getByLabelText(buttonName), { target: { value: edited.name } });

  fireEvent.click(screen.getByRole('button', { name: removeLabel }));
  const confirm = screen.getByRole('group', { name: confirmLabel });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(screen.queryByText(first.name)).toBeNull());
  expect(remove).toHaveBeenCalledWith(0);
  expect(screen.getByLabelText(buttonName)).toHaveValue(edited.name);

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`Failed to update ${label} button`));
  expect(update).toHaveBeenNthCalledWith(1, 0, edited, { silent: true });
  expect(screen.getByLabelText(buttonName)).toHaveValue(edited.name);

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: 'Edit Edited sample' })).toBeVisible();
  expect(update).toHaveBeenNthCalledWith(2, 0, edited, { silent: true });
  expect(read).toHaveBeenCalledTimes(1);
});
