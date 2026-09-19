import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// The widget owns only what to show from a fetched list; the polling belongs
// to useAutoRefetch, which has its own suite.
const mockUseAutoRefetch = vi.fn();
vi.mock('../../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: (...args) => mockUseAutoRefetch(...args),
}));
vi.mock('../../../services/api', () => ({ listThreads: vi.fn() }));

import * as api from '../../../services/api';
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

  it('offers to track one when the list is empty', () => {
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { total: 0, threads: [] } });
    renderWidget();
    expect(screen.getByText('Track one').closest('a')).toHaveAttribute('href', '/brain/threads');
  });
});
