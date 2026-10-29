import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getNicotineSummary: vi.fn(),
  getDailyNicotine: vi.fn(),
  getCustomNicotineProducts: vi.fn(),
  getAppleHealthCorrelation: vi.fn(),
  updateNicotineEntry: vi.fn().mockResolvedValue({}),
  removeNicotineEntry: vi.fn().mockResolvedValue({}),
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


it('sends the rendered event identity when editing and deleting a history row', async () => {
  api.getDailyNicotine.mockResolvedValue([{ date: '2024-06-01', nicotine: { items: [{ id: 'event-id', product: 'Example', mgPerUnit: 3, count: 1 }] } }]);
  render(<NicotineTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(api.updateNicotineEntry).toHaveBeenCalledWith('2024-06-01', 0, expect.objectContaining({ id: 'event-id' })));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
  await waitFor(() => expect(api.removeNicotineEntry).toHaveBeenCalledWith('2024-06-01', 0, 'event-id'));
});
