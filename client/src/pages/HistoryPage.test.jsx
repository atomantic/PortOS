import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getHistoryStats: vi.fn(),
  getHistoryActions: vi.fn(),
  clearHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
}));

vi.mock('../services/apiHistory.js', () => ({
  getHistory: api.getHistory,
  getHistoryStats: api.getHistoryStats,
  getHistoryActions: api.getHistoryActions,
  clearHistory: api.clearHistory,
  deleteHistoryEntry: api.deleteHistoryEntry,
}));

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

  it('gives row disclosure and deletion independent keyboard controls', async () => {
    api.getHistoryActions.mockResolvedValue(['command']);
    api.getHistory.mockResolvedValue({
      entries: [{
        id: 'example-1', action: 'command', targetName: 'Example target',
        success: true, timestamp: '2026-08-20T00:00:00Z', details: { output: 'Example output' },
      }],
    });
    api.deleteHistoryEntry.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<HistoryPage />);

    const disclosure = await screen.findByRole('button', { name: 'Expand command details for Example target' });
    const remove = screen.getByRole('button', { name: /^Delete command entry/ });
    for (const action of [disclosure, remove]) {
      expect(action.parentElement.closest('button, [role="button"], [role="link"]')).toBeNull();
    }
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    disclosure.focus();
    await user.keyboard('{Enter}');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Example output')).toBeInTheDocument();

    remove.focus();
    await user.keyboard('{Enter}');
    expect(api.deleteHistoryEntry).toHaveBeenCalledExactlyOnceWith('example-1');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    disclosure.focus();
    await user.keyboard('[Space]');
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Example output')).not.toBeInTheDocument();
  });

  it('shows empty option when history actions list is empty', async () => {
    api.getHistoryActions.mockResolvedValue([]);

    render(<HistoryPage />);

    const select = await screen.findByLabelText('Filter by action type');
    expect(within(select).getByRole('option', { name: 'No actions available' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Action History' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
