import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/apiAccounts.js', () => ({
  getPlatformAccounts: vi.fn(),
  getAgentRateLimits: vi.fn(),
  getAgentSubmolts: vi.fn(),
  getAgentDrafts: vi.fn(),
  getAgentFeed: vi.fn(),
  getAgentRelevantPosts: vi.fn(),
  engageAgent: vi.fn(),
}));

import {
  getPlatformAccounts,
  getAgentRateLimits,
  getAgentSubmolts,
  getAgentDrafts,
  getAgentFeed,
} from '../../../services/apiAccounts.js';
import ToolsTab from './ToolsTab.jsx';

describe('ToolsTab draft loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatformAccounts.mockResolvedValue([{
      id: 'account-1', status: 'active', credentials: { username: 'example-user' },
    }]);
    getAgentRateLimits.mockResolvedValue({});
    getAgentSubmolts.mockResolvedValue([]);
  });

  it('reports a failed drafts read as an error and recovers on Retry instead of showing no drafts', async () => {
    getAgentDrafts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue([]);

    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);

    expect(await screen.findByText(/Could not load drafts/)).toBeInTheDocument();
    expect(getAgentDrafts).toHaveBeenLastCalledWith('agent-1', { silent: true });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(getAgentDrafts).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Could not load drafts/)).not.toBeInTheDocument();
  });
});

describe('ToolsTab submolt loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatformAccounts.mockResolvedValue([{
      id: 'account-1', status: 'active', credentials: { username: 'example-user' },
    }]);
    getAgentRateLimits.mockResolvedValue({});
    getAgentDrafts.mockResolvedValue([]);
  });

  it('reports a failed submolt read with Retry instead of offering only "general"', async () => {
    let resolveRetry;
    getAgentSubmolts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockReturnValueOnce(new Promise((resolve) => { resolveRetry = resolve; }));

    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);

    expect(await screen.findByText(/Could not load submolts — network unavailable/)).toBeInTheDocument();
    expect(getAgentSubmolts).toHaveBeenLastCalledWith('account-1', { silent: true });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    // Still failed while the retry is in flight, so the picker never reads as "only general".
    expect(screen.getByText(/Could not load submolts/)).toBeInTheDocument();
    await act(async () => { resolveRetry({ submolts: [{ name: 'example-community' }] }); });

    expect(screen.queryByText(/Could not load submolts/)).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'example-community' })).toBeInTheDocument();
    expect(getAgentRateLimits).toHaveBeenCalledTimes(1);
  });
});

describe('ToolsTab action failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPlatformAccounts.mockResolvedValue([{
      id: 'account-1', status: 'active', credentials: { username: 'example-user' },
    }]);
    getAgentRateLimits.mockResolvedValue({});
    getAgentSubmolts.mockResolvedValue([]);
    getAgentDrafts.mockResolvedValue([]);
  });

  it('re-enables feed actions after the request fails', async () => {
    getAgentFeed.mockRejectedValueOnce(new Error('feed unavailable'));

    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);
    const browse = await screen.findByRole('button', { name: 'Browse Feed' });

    await act(async () => { fireEvent.click(browse); });

    expect(browse).toBeEnabled();
    expect(browse).toHaveTextContent('Browse Feed');
    expect(getAgentFeed).toHaveBeenCalledWith({ accountId: 'account-1', sort: 'hot', limit: 25 });
  });

  it('wraps the feed toolbar and sizes compact actions for coarse pointers', async () => {
    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);
    const browse = await screen.findByRole('button', { name: 'Browse Feed' });
    expect(browse.className).toContain('pointer-coarse:min-h-11');
    expect(screen.getByRole('button', { name: 'Find Relevant' }).className).toContain('pointer-coarse:min-h-11');
    expect(browse.parentElement.parentElement.className).toContain('flex-wrap');
    expect(screen.getByLabelText('Sort feed').className).toContain('min-w-0');
    const composer = screen.getByLabelText('Submolt').parentElement;
    expect(composer.className).toContain('flex-wrap');
    expect(screen.getByLabelText('Submolt').className).toContain('min-w-0');
    expect(screen.getByRole('button', { name: 'Generate Post' }).className).not.toContain('whitespace-nowrap');
  });
});
