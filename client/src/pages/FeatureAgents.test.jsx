import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/apiAgents.js', () => ({
  getFeatureAgents: vi.fn(),
}));
vi.mock('../components/ui/Toast');
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../components/feature-agents/FeatureAgentCard', () => ({
  default: ({ agent }) => <div>{agent.name}</div>,
}));

import FeatureAgents from './FeatureAgents';
import { getFeatureAgents } from '../services/apiAgents.js';
import socket from '../services/socket';
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

  it('refreshes the list when a feature-agent status event arrives', async () => {
    getFeatureAgents.mockResolvedValueOnce([{ id: 'a1', name: 'Example Agent', status: 'active' }]);
    renderPage();
    expect(await screen.findByText('Example Agent')).toBeInTheDocument();

    getFeatureAgents.mockResolvedValueOnce([{ id: 'a1', name: 'Renamed Agent', status: 'paused' }]);
    const [, onStatus] = socket.on.mock.calls.find(([event]) => event === 'cos:feature-agent:status');
    await act(async () => { onStatus({ id: 'a1' }); });

    expect(await screen.findByText('Renamed Agent')).toBeInTheDocument();
  });
});
