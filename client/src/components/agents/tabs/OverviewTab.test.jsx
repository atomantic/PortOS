import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { updateAgentPersonality } from '../../../services/apiPersonalities.js';
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
  expect(testButton.className).toContain('pointer-coarse:min-h-11');
  expect(testButton.parentElement.className).toContain('flex-wrap');
});

it('stacks personality fields below sm and wraps the tone row', async () => {
  render(<MemoryRouter><OverviewTab agentId="agent-1" agent={{ id: 'agent-1', name: 'Example Agent', enabled: true, personality: {}, avatar: {} }} /></MemoryRouter>);
  const nameGrid = (await screen.findByText('Name')).closest('.grid');
  expect(nameGrid.className).toContain('grid-cols-1');
  expect(nameGrid.className).toContain('sm:grid-cols-2');
  const tone = screen.getByText('Tone').closest('.flex');
  expect(tone.className).toContain('flex-wrap');
  expect(screen.getByText('Tone').parentElement.className).toContain('min-w-0');
});

describe('unsaved edit protection', () => {
  const activeAccount = { id: 'account-1', platform: 'moltbook', status: 'active', credentials: { username: 'example-user' } };
  const baseAgent = { id: 'agent-1', name: 'Example Agent', enabled: true, personality: {}, avatar: {}, aiConfig: {} };
  const renderTab = (agent = baseAgent) => render(
    <MemoryRouter><OverviewTab agentId="agent-1" agent={agent} onAgentUpdate={vi.fn()} /></MemoryRouter>,
  );

  it('saving AI config keeps unsaved Personality edits, even when the agent prop refreshes', async () => {
    updateAgentPersonality.mockResolvedValue({});
    const { rerender } = renderTab();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Renamed Draft' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Engagement' }), { target: { value: 'api-1' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save AI Config' })); });

    expect(updateAgentPersonality).toHaveBeenCalledWith('agent-1', { aiConfig: { engagement: { providerId: 'api-1' } } });
    rerender(<MemoryRouter><OverviewTab agentId="agent-1" agent={{ ...baseAgent, aiConfig: { engagement: { providerId: 'api-1' } } }} onAgentUpdate={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed Draft');
    expect(screen.getByRole('button', { name: 'Save AI Config' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('keeps Personality edits when the enabled flag changes on the agent prop', async () => {
    const { rerender } = renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Draft' } });
    rerender(<MemoryRouter><OverviewTab agentId="agent-1" agent={{ ...baseAgent, enabled: false }} onAgentUpdate={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft');
  });

  it('disables Quick Actions with an inline notice until edits are saved', async () => {
    getPlatformAccounts.mockResolvedValue([activeAccount]);
    updateAgentPersonality.mockResolvedValue({});
    renderTab();
    const engage = await screen.findByRole('button', { name: 'Engage Now' });
    await waitFor(() => expect(engage).toBeEnabled());
    expect(screen.queryByText(/Save your Personality and AI Provider changes/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft' } });
    expect(engage).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check Posts' })).toBeDisabled();
    expect(screen.getByText(/Save your Personality and AI Provider changes/)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); });
    expect(engage).toBeEnabled();
    expect(screen.queryByText(/Save your Personality and AI Provider changes/)).not.toBeInTheDocument();
  });

  it('shows busy state while saving and keeps the draft and Save enabled after a failure', async () => {
    let rejectSave;
    updateAgentPersonality.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
    renderTab();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); });
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();

    await act(async () => { rejectSave(new Error('save failed')); });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });
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
