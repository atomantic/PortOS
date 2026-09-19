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

import OpenThreadsWidget from './OpenThreadsWidget';

const renderWidget = () => render(<MemoryRouter><OpenThreadsWidget /></MemoryRouter>);

describe('OpenThreadsWidget', () => {
  it('renders nothing until the first list arrives', () => {
    mockUseAutoRefetch.mockReturnValue({ data: null, loading: true });
    const { container } = renderWidget();
    expect(container.innerHTML).toBe('');
  });

  it('shows only the working set, with the next action, and deep-links each row to its drawer', () => {
    mockUseAutoRefetch.mockReturnValue({
      loading: false,
      data: {
        threads: [
          { id: 'a b', title: 'Renew domain', status: 'open', nextAction: 'Log in to registrar', dueAt: '2000-01-01T00:00:00.000Z' },
          { id: 't2', title: 'Vendor quote', status: 'waiting', waitingOn: 'Acme Corp' },
          { id: 't3', title: 'Someday idea', status: 'someday', nextAction: 'x' },
          { id: 't4', title: 'Finished', status: 'done' },
        ],
      },
    });
    renderWidget();
    expect(screen.getByText('Renew domain').closest('a')).toHaveAttribute('href', '/brain/threads?thread=a%20b');
    expect(screen.getByText('Log in to registrar')).toBeTruthy();
    expect(screen.getByText('Waiting on Acme Corp')).toBeTruthy();
    expect(screen.queryByText('Someday idea')).toBeNull();
    expect(screen.queryByText('Finished')).toBeNull();
    expect(screen.getByText('2 open')).toBeTruthy();
  });

  it('caps the list and links the overflow to the tab', () => {
    mockUseAutoRefetch.mockReturnValue({
      loading: false,
      data: { threads: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, title: `Loop ${i}`, status: 'open' })) },
    });
    renderWidget();
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('+2 more').closest('a')).toHaveAttribute('href', '/brain/threads');
  });

  it('offers to track one when the list is empty', () => {
    mockUseAutoRefetch.mockReturnValue({ loading: false, data: { threads: [] } });
    renderWidget();
    expect(screen.getByText('Track one').closest('a')).toHaveAttribute('href', '/brain/threads');
  });
});
