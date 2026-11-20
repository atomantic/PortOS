import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/apiMeatspace.js', () => ({
  getNicotineSummary: vi.fn(),
  getDailyNicotine: vi.fn(),
  getCustomNicotineProducts: vi.fn(),
  updateNicotineEntry: vi.fn().mockResolvedValue({}),
  removeNicotineEntry: vi.fn().mockResolvedValue({}),
  addCustomNicotineProduct: vi.fn(),
  removeCustomNicotineProduct: vi.fn(),
}));
vi.mock('../../../services/apiHealth.js', () => ({
  getAppleHealthCorrelation: vi.fn(),
}));
vi.mock('../NicotineChart', () => ({ default: () => null }));
vi.mock('../NicotineHealthCorrelation', () => ({ default: () => null }));

import {
  getNicotineSummary,
  getCustomNicotineProducts,
  getDailyNicotine,
  updateNicotineEntry,
  removeNicotineEntry,
  addCustomNicotineProduct,
  removeCustomNicotineProduct,
} from '../../../services/apiMeatspace.js';
import { getAppleHealthCorrelation } from '../../../services/apiHealth.js';
import NicotineTab from './NicotineTab';

beforeEach(() => {
  getNicotineSummary.mockResolvedValue(null);
  getCustomNicotineProducts.mockResolvedValue([]);
  getAppleHealthCorrelation.mockResolvedValue(null);
});
afterEach(cleanup);

describe('NicotineTab history load', () => {
  it('shows a retryable notice when the history read fails, then the history once it succeeds', async () => {
    getDailyNicotine.mockRejectedValueOnce(new Error('boom'));
    render(<NicotineTab />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load nicotine history');
    expect(screen.queryByText(/History \(/)).toBeNull();

    getDailyNicotine.mockResolvedValue([{ date: '2026-03-01', nicotine: { items: [] } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/History \(1 days\)/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


it('sends the rendered event identity when editing and deleting a history row', async () => {
  getDailyNicotine.mockResolvedValue([{ date: '2024-06-01', nicotine: { items: [{ id: 'event-id', product: 'Example', mgPerUnit: 3, count: 1 }] } }]);
  render(<NicotineTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(updateNicotineEntry).toHaveBeenCalledWith('2024-06-01', 0, expect.objectContaining({ id: 'event-id' })));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
  await waitFor(() => expect(removeNicotineEntry).toHaveBeenCalledWith('2024-06-01', 0, 'event-id'));
});

it('hides Manage when the product button read fails and recovers on retry', async () => {
  getDailyNicotine.mockResolvedValue([]);
  getCustomNicotineProducts.mockRejectedValueOnce(new Error('boom'));
  render(<NicotineTab />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your quick-add product buttons');
  expect(screen.queryByRole('button', { name: /Manage/ })).toBeNull();
  expect(getCustomNicotineProducts).toHaveBeenLastCalledWith({ silent: true });

  getCustomNicotineProducts.mockResolvedValueOnce([{ name: 'Example Pouch', mgPerUnit: 6 }]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: /Example Pouch/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Manage/ })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('applies an added and a removed product button in place without re-reading the list', async () => {
  getDailyNicotine.mockResolvedValue([]);
  getCustomNicotineProducts.mockResolvedValue([{ name: 'Example Pouch', mgPerUnit: 6 }]);
  addCustomNicotineProduct.mockResolvedValue({ name: 'Sample Gum', mgPerUnit: 2 });
  removeCustomNicotineProduct.mockResolvedValue({ name: 'Example Pouch', mgPerUnit: 6 });
  render(<NicotineTab />);
  fireEvent.click(await screen.findByRole('button', { name: /Manage/ }));

  fireEvent.change(screen.getByLabelText('New product button name'), { target: { value: 'Sample Gum' } });
  fireEvent.change(screen.getByLabelText('New product button milligrams per unit'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add product' }));
  await waitFor(() => expect(addCustomNicotineProduct).toHaveBeenCalled());
  expect(await screen.findByText('Sample Gum')).toBeTruthy();

  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
  await waitFor(() => expect(removeCustomNicotineProduct).toHaveBeenCalledWith(0));
  await waitFor(() => expect(screen.queryByText('Example Pouch')).toBeNull());
  expect(screen.getByText('Sample Gum')).toBeTruthy();
  expect(getCustomNicotineProducts).toHaveBeenCalledTimes(1);
});
