import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getPlatformAccounts: vi.fn(),
  getAgentPublished: vi.fn(),
}));

import * as api from '../../../services/api';
import PublishedTab from './PublishedTab.jsx';

describe('PublishedTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPlatformAccounts.mockResolvedValue([{
      id: 'account-1', status: 'active', credentials: { username: 'example-user' },
    }]);
  });

  it('shows a retryable error and releases Refresh after a failed published-content load', async () => {
    api.getAgentPublished.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue({ posts: [], comments: [] });

    render(<PublishedTab agentId="agent-1" />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh).toBeEnabled();
    expect(api.getAgentPublished).toHaveBeenLastCalledWith(
      { agentId: 'agent-1', accountId: 'account-1', days: 7 },
      { silent: true },
    );

    await act(async () => { fireEvent.click(retry); });

    expect(await screen.findByText(/No published content in the last 7 days/)).toBeInTheDocument();
    expect(api.getAgentPublished).toHaveBeenCalledTimes(2);
  });
});
