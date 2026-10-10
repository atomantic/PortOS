import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getPlatformAccounts: vi.fn(),
  getProviders: vi.fn(),
  getAgentActivityStats: vi.fn(),
  getAgentRateLimits: vi.fn(),
  updateAgentPersonality: vi.fn(),
}));

import { getPlatformAccounts, getProviders, getAgentActivityStats } from '../../../services/api';
import OverviewTab from './OverviewTab';

const providers = [
  { id: 'cli-1', name: 'Example CLI', type: 'cli', command: 'codex', enabled: true, models: ['example-cli'] },
  { id: 'api-1', name: 'Example API', type: 'api', endpoint: 'https://api.example.com/v1', enabled: true, models: ['example-text'] },
  { id: 'tui-1', name: 'Example TUI', type: 'tui', command: 'claude', enabled: true, models: ['example-tui'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  getPlatformAccounts.mockResolvedValue([]);
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
            aiConfig: { content: { providerId: 'cli-1' } },
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

    const challenge = screen.getByRole('combobox', { name: 'Challenge Solving' });
    expect(within(challenge).getByRole('option', { name: 'Example CLI' })).toBeEnabled();
    expect(within(challenge).getByRole('option', { name: 'Example TUI' })).toBeEnabled();
  });
});
