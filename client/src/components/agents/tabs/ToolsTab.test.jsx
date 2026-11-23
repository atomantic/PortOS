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
  deleteAgentDraft: vi.fn(),
}));

import {
  getPlatformAccounts,
  getAgentRateLimits,
  getAgentSubmolts,
  getAgentDrafts,
  getAgentFeed,
  deleteAgentDraft,
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

  it('confirms draft deletion and removes the row locally without refetching', async () => {
    getAgentDrafts.mockResolvedValue([{
      id: 'draft-1', type: 'post', status: 'draft', title: 'Example draft', content: 'Body', createdAt: '2026-08-23T00:00:00.000Z',
    }]);
    deleteAgentDraft.mockResolvedValue({ success: true });

    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);
    expect(await screen.findByRole('button', { name: 'Delete draft Example draft' })).toHaveClass('pointer-coarse:min-h-11');
    const loads = getAgentDrafts.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Delete draft Example draft' }));
    expect(deleteAgentDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel draft deletion' }));
    expect(screen.getByText('Example draft')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete draft Example draft' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete draft' })); });
    expect(deleteAgentDraft).toHaveBeenCalledWith('agent-1', 'draft-1');
    expect(screen.queryByText('Example draft')).toBeNull();
    expect(getAgentDrafts).toHaveBeenCalledTimes(loads);
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

describe('ToolsTab account loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentRateLimits.mockResolvedValue({});
    getAgentSubmolts.mockResolvedValue([]);
    getAgentDrafts.mockResolvedValue([]);
  });

  it('shows a retryable error instead of "No active Moltbook account" when the account read fails', async () => {
    getPlatformAccounts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue([{ id: 'account-1', status: 'active', credentials: { username: 'example-user' } }]);

    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);

    expect(await screen.findByText(/Could not load Moltbook account — network unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No active Moltbook account')).not.toBeInTheDocument();
    expect(getPlatformAccounts).toHaveBeenLastCalledWith('agent-1', 'moltbook', { silent: true });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(await screen.findByText('example-user')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load Moltbook account/)).not.toBeInTheDocument();
  });
});
