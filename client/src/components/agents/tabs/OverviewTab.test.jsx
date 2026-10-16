import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getPlatformAccounts: vi.fn(),
  getProviders: vi.fn(),
  getAgentActivityStats: vi.fn(),
  getAgentRateLimits: vi.fn(),
  testPlatformAccount: vi.fn(),
  updateAgentPersonality: vi.fn(),
}));

import { getPlatformAccounts, getProviders, getAgentActivityStats, getAgentRateLimits, testPlatformAccount } from '../../../services/api';
import OverviewTab from './OverviewTab';

const providers = [
  { id: 'cli-1', name: 'Example CLI', type: 'cli', command: 'codex', enabled: true, models: ['example-cli'] },
  { id: 'api-1', name: 'Example API', type: 'api', endpoint: 'https://api.example.com/v1', enabled: true, models: ['example-text'] },
  { id: 'tui-1', name: 'Example TUI', type: 'tui', command: 'claude', enabled: true, models: ['example-tui'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  getPlatformAccounts.mockResolvedValue([]);
  getAgentRateLimits.mockResolvedValue({});
  getProviders.mockResolvedValue({ providers });
  getAgentActivityStats.mockResolvedValue(null);
});

describe('agent AI provider pickers', () => {
  it('offers only text API providers for Moltbook content and engagement', async () => {
    render(
      <MemoryRouter>
        <OverviewTab
          agentId="agent-1"
          agent={{
            id: 'agent-1',
            name: 'Example Agent',
            enabled: true,
            aiConfig: {
              content: { providerId: 'cli-1' },
              challenge: { providerId: 'cli-1' },
            },
          }}
        />
      </MemoryRouter>,
    );

    const content = await screen.findByRole('combobox', { name: 'Content Generation' });
    expect(within(content).getByRole('option', { name: 'Example CLI (not permitted here)' })).toBeDisabled();
    expect(within(content).getByRole('option', { name: 'Example API' })).toBeEnabled();
    expect(within(content).queryByRole('option', { name: 'Example TUI' })).not.toBeInTheDocument();

    const engagement = screen.getByRole('combobox', { name: 'Engagement' });
    expect(within(engagement).getByRole('option', { name: 'Example API' })).toBeEnabled();
    expect(within(engagement).queryByRole('option', { name: 'Example CLI' })).not.toBeInTheDocument();
    expect(within(engagement).queryByRole('option', { name: 'Example TUI' })).not.toBeInTheDocument();

    expect(screen.getByText(/System Default sends comments, replies, and verification challenges to an eligible Abuse Guard text API provider/)).toBeInTheDocument();

    const challenge = screen.getByRole('combobox', { name: 'Challenge Solving' });
    expect(within(challenge).getByRole('option', { name: 'Example CLI (not permitted here)' })).toBeDisabled();
    expect(within(challenge).getByRole('option', { name: 'Example API' })).toBeEnabled();
    expect(within(challenge).queryByRole('option', { name: 'Example TUI' })).not.toBeInTheDocument();
  });
});

it('shows a failed account test inline and releases the Test button for retry', async () => {
  getPlatformAccounts.mockResolvedValue([{
    id: 'account-1', platform: 'moltbook', status: 'active', credentials: { username: 'example-user' },
  }]);
  testPlatformAccount.mockRejectedValueOnce(new Error('Platform unavailable'));

  render(<MemoryRouter><OverviewTab agentId="agent-1" agent={{ id: 'agent-1', name: 'Example Agent', enabled: true }} /></MemoryRouter>);
  const testButton = await screen.findByRole('button', { name: 'Test' });

  await act(async () => { fireEvent.click(testButton); });

  expect(await screen.findByText('Platform unavailable')).toBeInTheDocument();
  expect(testButton).toBeEnabled();
  expect(testPlatformAccount).toHaveBeenCalledWith('account-1', { silent: true });
});
