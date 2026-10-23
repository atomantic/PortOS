import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({ getFeatureAgents: vi.fn() }));
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../components/feature-agents/FeatureAgentCard', () => ({
  default: ({ agent }) => <div>{agent.name}</div>,
}));

import FeatureAgents from './FeatureAgents';
import { getFeatureAgents } from '../services/api';

const renderPage = () => render(<MemoryRouter><FeatureAgents /></MemoryRouter>);

afterEach(cleanup);

describe('FeatureAgents create actions', () => {
  it('shows the empty-state link as the only create control for an empty list', async () => {
    getFeatureAgents.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No Feature Agents')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create Feature Agent/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New Agent/ })).toBeNull();
  });

  it('keeps the header New Agent action while loading, after a failed read, and with agents', async () => {
    getFeatureAgents.mockRejectedValueOnce(new Error('503'));
    const failed = renderPage();
    expect(screen.getByRole('link', { name: /New Agent/ })).toBeInTheDocument();
    await screen.findByText('No Feature Agents');
    expect(screen.getByRole('link', { name: /New Agent/ })).toBeInTheDocument();
    failed.unmount();

    getFeatureAgents.mockResolvedValue([{ id: 'a1', name: 'Example Agent', status: 'active' }]);
    renderPage();
    expect(await screen.findByText('Example Agent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New Agent/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Create Feature Agent/ })).toBeNull();
  });
});
