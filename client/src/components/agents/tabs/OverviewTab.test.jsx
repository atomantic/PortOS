import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiAccounts.js', () => ({
  getPlatformAccounts: vi.fn(),
  getAgentRateLimits: vi.fn(),
  testPlatformAccount: vi.fn(),
  deletePlatformAccount: vi.fn(),
  registerPlatformAccount: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({
  getProviders: vi.fn(),
}));
vi.mock('../../../services/apiAgents.js', () => ({
  getAgentActivityStats: vi.fn(),
}));
vi.mock('../../../services/apiPersonalities.js', () => ({
  updateAgentPersonality: vi.fn(),
}));

import { getPlatformAccounts, getAgentRateLimits, testPlatformAccount, deletePlatformAccount, registerPlatformAccount } from '../../../services/apiAccounts.js';
import { getProviders } from '../../../services/apiProviders.js';
import { getAgentActivityStats } from '../../../services/apiAgents.js';
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

describe('agent load failures', () => {
  it('shows a retryable account error instead of an endless loading message, and recovers on Retry', async () => {
    getPlatformAccounts
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue([]);

    render(
      <MemoryRouter>
        <OverviewTab agentId="agent-1" agent={{ id: 'agent-1', enabled: true, aiConfig: {} }} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Could not load platform accounts/)).toBeInTheDocument();
    expect(screen.queryByText('Loading accounts...')).not.toBeInTheDocument();
    expect(getPlatformAccounts).toHaveBeenLastCalledWith('agent-1', null, { silent: true });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    expect(await screen.findByText('No platform accounts linked to this agent')).toBeInTheDocument();
    expect(getPlatformAccounts).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed provider read instead of an empty provider list', async () => {
    getProviders.mockRejectedValueOnce(new Error('network unavailable'));

    render(
      <MemoryRouter>
        <OverviewTab agentId="agent-1" agent={{ id: 'agent-1', enabled: true, aiConfig: {} }} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Could not load AI providers/)).toBeInTheDocument();
    expect(getProviders).toHaveBeenLastCalledWith({ silent: true });
  });
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

it('confirms account deletion and drops the row locally without refetching', async () => {
  getPlatformAccounts.mockResolvedValue([{
    id: 'account-1', platform: 'moltbook', status: 'active', credentials: { username: 'example-user' },
  }]);
  deletePlatformAccount.mockResolvedValue({ success: true });

  render(<MemoryRouter><OverviewTab agentId="agent-1" agent={{ id: 'agent-1', name: 'Example Agent', enabled: true, aiConfig: {} }} /></MemoryRouter>);
  await screen.findByText('example-user');
  const loads = getPlatformAccounts.mock.calls.length;

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(deletePlatformAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel account deletion' }));
  expect(screen.getByText('example-user')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delete example-user' })); });
  expect(deletePlatformAccount).toHaveBeenCalledWith('account-1');
  expect(screen.queryByText('example-user')).toBeNull();
  expect(getPlatformAccounts).toHaveBeenCalledTimes(loads);
});

it('keeps the register form when account creation fails', async () => {
  registerPlatformAccount.mockRejectedValue(new Error('register failed'));
  render(<MemoryRouter><OverviewTab agentId="agent-1" agent={{ id: 'agent-1', name: 'Example Agent', enabled: true, aiConfig: {} }} /></MemoryRouter>);
  await screen.findByText('No platform accounts linked to this agent');
  fireEvent.click(screen.getByRole('button', { name: '+ Link Account' }));
  fireEvent.change(screen.getByPlaceholderText('Display name on platform'), { target: { value: 'Example Name' } });
  const submit = screen.getByRole('button', { name: 'Register Account' });
  await act(async () => { fireEvent.click(submit); });
  expect(submit).toBeEnabled();
  expect(screen.getByPlaceholderText('Display name on platform')).toHaveValue('Example Name');
});
