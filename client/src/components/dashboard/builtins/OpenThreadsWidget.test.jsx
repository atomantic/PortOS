import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// The widget owns only what to show from a fetched list; the polling belongs
// to useAutoRefetch, which has its own suite.
const mockUseAutoRefetch = vi.fn();
vi.mock('../../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: (...args) => mockUseAutoRefetch(...args),
}));
vi.mock('../../../services/api', () => ({ listThreads: vi.fn(), updateThread: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: { error: vi.fn() } }));

import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import OpenThreadsWidget from './OpenThreadsWidget';

const renderWidget = () => render(<MemoryRouter><OpenThreadsWidget /></MemoryRouter>);

describe('OpenThreadsWidget', () => {
  it('renders nothing until the first list arrives', () => {
    mockUseAutoRefetch.mockReturnValue({ data: null, loading: true });
    const { container } = renderWidget();
    expect(container.innerHTML).toBe('');
  });

  it('asks the server for the first page of open + waiting threads only', () => {
    mockUseAutoRefetch.mockReturnValue({ data: null, loading: true });
    renderWidget();
    const fetchFn = mockUseAutoRefetch.mock.calls.at(-1)[0];
    fetchFn();
    expect(api.listThreads).toHaveBeenCalledWith({ status: 'open,waiting', limit: 6, offset: 0 }, { silent: true });
  });

  it('shows the next action on each row and deep-links it to its drawer', () => {
    mockUseAutoRefetch.mockReturnValue({
      loading: false,
      data: {
        total: 2,
        threads: [
          { id: 'a b', title: 'Renew domain', status: 'open', nextAction: 'Log in to registrar', dueAt: '2000-01-01T00:00:00.000Z' },
          { id: 't2', title: 'Vendor quote', status: 'waiting', waitingOn: 'Acme Corp' },
        ],
      },
    });
    renderWidget();
    expect(screen.getByText('Renew domain').closest('a')).toHaveAttribute('href', '/brain/threads?thread=a%20b');
    expect(screen.getByText('Log in to registrar')).toBeTruthy();
    expect(screen.getByText('Waiting on Acme Corp')).toBeTruthy();
    expect(screen.getByText('2 open')).toBeTruthy();
  });

  it('links the overflow the page did not ship to the tab', () => {
    mockUseAutoRefetch.mockReturnValue({
      loading: false,
      data: { total: 8, threads: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: `Loop ${i}`, status: 'open' })) },
    });
    renderWidget();
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('+2 more').closest('a')).toHaveAttribute('href', '/brain/threads');
  });

  it('offers completion only for an unfinished thread with a positively closed source', () => {
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { threads: [
      { id: 'open', title: 'Open source', status: 'open', externalState: 'open' },
      { id: 'unknown', title: 'Unknown source', status: 'waiting', externalState: 'unknown' },
      { id: 'manual', title: 'Manual loop', status: 'open' },
      { id: 'done', title: 'Done loop', status: 'done', externalState: 'closed' },
      { id: 'archived', title: 'Archived loop', status: 'archived', externalState: 'closed' },
      { id: 'closed', title: 'Closed source', status: 'waiting', externalState: 'closed' },
    ] } });
    renderWidget();
    expect(screen.getAllByText('Source closed — mark done?')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Mark "Closed source" done' }).closest('a')).toBeNull();
    expect(api.updateThread).not.toHaveBeenCalled();
  });

  it('removes a completed row and updates the count without fetching, tolerating stale polls and later reopening', async () => {
    const thread = { id: 'closed', title: 'Closed source', status: 'waiting', externalState: 'closed', updatedAt: '2026-01-01T00:00:00.000Z' };
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { total: 8, threads: [thread] } });
    let finish;
    api.updateThread.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderWidget();
    const button = screen.getByRole('button', { name: 'Mark "Closed source" done' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(api.updateThread).toHaveBeenCalledTimes(1);
    expect(api.updateThread).toHaveBeenCalledWith('closed', { status: 'done' }, { silent: true });
    await act(async () => { finish({ ...thread, status: 'done', updatedAt: '2026-01-02T00:00:00.000Z' }); });
    expect(screen.queryByText('Closed source')).toBeNull();
    expect(screen.getByText('7 open')).toBeTruthy();
    expect(screen.queryByText(/No open loops/)).toBeNull();
    expect(api.listThreads).not.toHaveBeenCalled();
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { total: 8, threads: [{ ...thread }] } });
    view.rerender(<MemoryRouter><OpenThreadsWidget /></MemoryRouter>);
    expect(screen.queryByText('Closed source')).toBeNull();
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { total: 8, threads: [{ ...thread, updatedAt: '2026-01-03T00:00:00.000Z' }] } });
    view.rerender(<MemoryRouter><OpenThreadsWidget /></MemoryRouter>);
    expect(screen.getByText('Closed source')).toBeTruthy();
    expect(screen.getByText('8 open')).toBeTruthy();
  });

  it('keeps the row after a failed completion, reports the error once and permits retry', async () => {
    const thread = { id: 'closed', title: 'Closed source', status: 'open', externalState: 'closed' };
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { total: 1, threads: [thread] } });
    api.updateThread.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({ ...thread, status: 'done', updatedAt: '2026-01-02T00:00:00.000Z' });
    renderWidget();
    const button = screen.getByRole('button', { name: 'Mark "Closed source" done' });
    fireEvent.click(button);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Connection lost'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('Closed source')).toBeNull());
    expect(api.updateThread).toHaveBeenCalledTimes(2);
  });

  it('offers to track one when the list is empty', () => {
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { total: 0, threads: [] } });
    renderWidget();
    expect(screen.getByText('Track one').closest('a')).toHaveAttribute('href', '/brain/threads');
  });
});
