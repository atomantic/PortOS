import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getHistoryStats: vi.fn(),
  getHistoryActions: vi.fn(),
  clearHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
}));

vi.mock('../services/api', () => api);

import { HistoryPage } from './HistoryPage';

describe('HistoryPage list resources (#12171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getHistory.mockResolvedValue({ entries: [] });
    api.getHistoryStats.mockResolvedValue({ total: 0, successRate: 100, last24h: 0, byAction: {} });
  });

  it('shows error row with Retry when history actions fail to load, and recovers on retry', async () => {
    api.getHistoryActions.mockRejectedValueOnce(new Error('actions backend offline'));

    render(<HistoryPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load history actions — actions backend offline');

    api.getHistoryActions.mockResolvedValueOnce(['start', 'stop', 'restart']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    const select = screen.getByLabelText('Filter by action type');
    expect(within(select).getByRole('option', { name: 'start' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'stop' })).toBeInTheDocument();
  });

  it('shows empty option when history actions list is empty', async () => {
    api.getHistoryActions.mockResolvedValue([]);

    render(<HistoryPage />);

    const select = await screen.findByLabelText('Filter by action type');
    expect(within(select).getByRole('option', { name: 'No actions available' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
