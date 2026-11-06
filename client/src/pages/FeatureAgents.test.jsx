import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({ getFeatureAgents: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../components/feature-agents/FeatureAgentCard', () => ({
  default: ({ agent }) => <div>{agent.name}</div>,
}));

import FeatureAgents from './FeatureAgents';
import { getFeatureAgents } from '../services/api';
import toast from '../components/ui/Toast';

const renderPage = () => render(<MemoryRouter><FeatureAgents /></MemoryRouter>);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeatureAgents list loading', () => {
  it('shows inline retry after an initial failed read without showing an empty library or toast', async () => {
    getFeatureAgents.mockRejectedValueOnce(new Error('503'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load feature agents');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No Feature Agents')).toBeNull();
    expect(screen.getByRole('link', { name: 'New Agent' })).toBeInTheDocument();
    expect(getFeatureAgents).toHaveBeenCalledWith({ silent: true });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows create guidance for a successful empty read', async () => {
    getFeatureAgents.mockResolvedValueOnce([]);
    renderPage();

    expect(await screen.findByText('No Feature Agents')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create Feature Agent/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retains loaded cards and offers retry when a refresh fails', async () => {
    getFeatureAgents.mockResolvedValueOnce([{ id: 'a1', name: 'Example Agent', status: 'active' }]);
    renderPage();
    expect(await screen.findByText('Example Agent')).toBeInTheDocument();

    getFeatureAgents.mockRejectedValueOnce(new Error('503'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await Promise.resolve();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load feature agents');
    expect(screen.getByText('Example Agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
