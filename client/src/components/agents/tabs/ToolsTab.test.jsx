import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getPlatformAccounts: vi.fn(),
  getAgentRateLimits: vi.fn(),
  getAgentSubmolts: vi.fn(),
  getAgentDrafts: vi.fn(),
  getAgentFeed: vi.fn(),
  getAgentRelevantPosts: vi.fn(),
  engageAgent: vi.fn(),
}));

import * as api from '../../../services/api';
import ToolsTab from './ToolsTab.jsx';

describe('ToolsTab action failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPlatformAccounts.mockResolvedValue([{
      id: 'account-1', status: 'active', credentials: { username: 'example-user' },
    }]);
    api.getAgentRateLimits.mockResolvedValue({});
    api.getAgentSubmolts.mockResolvedValue([]);
    api.getAgentDrafts.mockResolvedValue([]);
  });

  it('re-enables feed actions after the request fails', async () => {
    api.getAgentFeed.mockRejectedValueOnce(new Error('feed unavailable'));

    render(<ToolsTab agentId="agent-1" agent={{ id: 'agent-1', aiConfig: {} }} />);
    const browse = await screen.findByRole('button', { name: 'Browse Feed' });

    await act(async () => { fireEvent.click(browse); });

    expect(browse).toBeEnabled();
    expect(browse).toHaveTextContent('Browse Feed');
    expect(api.getAgentFeed).toHaveBeenCalledWith({ accountId: 'account-1', sort: 'hot', limit: 25 });
  });
});
