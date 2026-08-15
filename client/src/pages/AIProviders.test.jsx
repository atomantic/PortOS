import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getRuns: vi.fn(),
  getProviderStatuses: vi.fn(),
  getSampleProviders: vi.fn(),
  createProvider: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({
  default: toast,
}));
vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));
vi.mock('../hooks/useLocalModels', () => ({
  default: () => ({ ctxById: {} }),
}));
vi.mock('../components/settings/SettingsTabsHeader', () => ({
  default: () => <div data-testid="settings-tabs-header" />,
}));
vi.mock('../components/providers/CodeReviewDefaultsPanel', () => ({
  default: () => <div data-testid="code-review-defaults-panel" />,
}));

import AIProviders from './AIProviders';

const renderPage = () => render(
  <MemoryRouter>
    <AIProviders />
  </MemoryRouter>
);

describe('AIProviders page load error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getRuns.mockResolvedValue({ runs: [] });
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
  });

  it('renders provider list when api.getProviders succeeds with data', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'p1', name: 'OpenAI', type: 'api', enabled: true, endpoint: 'https://api.openai.com', models: ['gpt-4'] }
      ],
      activeProvider: 'p1',
    });

    renderPage();

    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
  });

  it('renders EmptyState when api.getProviders succeeds with 0 items', async () => {
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText('No providers configured')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
  });

  it('renders Banner with Retry button when api.getProviders rejects and does not show EmptyState', async () => {
    api.getProviders.mockRejectedValue(new Error('Network error'));

    renderPage();

    expect(await screen.findByText('Failed to load AI providers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
  });

  it('re-fetches when Retry button is clicked and displays providers upon success', async () => {
    api.getProviders
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        providers: [
          { id: 'p1', name: 'Claude', type: 'api', enabled: true, endpoint: 'https://api.anthropic.com', models: ['claude-3'] }
        ],
        activeProvider: 'p1',
      });

    renderPage();

    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

describe('handleAddSample error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getRuns.mockResolvedValue({ runs: [] });
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });
    api.getSampleProviders.mockResolvedValue({
      providers: [
        { id: 'sample-1', name: 'Sample AI', type: 'api', enabled: true, endpoint: 'https://api.sample.com', models: ['model-1'] }
      ]
    });
  });

  it('resets addingSample state and re-enables button if api.createProvider rejects', async () => {
    api.createProvider.mockRejectedValue(new Error('Failed to create provider'));

    renderPage();

    const loadSamplesBtn = await screen.findByRole('button', { name: 'Load Samples' });
    fireEvent.click(loadSamplesBtn);

    const addBtn = await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(addBtn);

    expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'sample-1' }));

    const reEnabledAddBtn = await screen.findByRole('button', { name: 'Add' });
    expect(reEnabledAddBtn).not.toBeDisabled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to add provider: Failed to create provider'));
  });
});

describe('handleAddAllSamples partial failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getRuns.mockResolvedValue({ runs: [] });
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });
    api.getSampleProviders.mockResolvedValue({
      providers: [
        { id: 'sample-1', name: 'Sample AI 1', type: 'api', enabled: true, endpoint: 'https://api.sample1.com', models: ['model-1'] },
        { id: 'sample-2', name: 'Sample AI 2', type: 'api', enabled: true, endpoint: 'https://api.sample2.com', models: ['model-2'] },
        { id: 'sample-3', name: 'Sample AI 3', type: 'api', enabled: true, endpoint: 'https://api.sample3.com', models: ['model-3'] },
      ]
    });
  });

  it('handles partial failure when adding all samples', async () => {
    api.createProvider
      .mockResolvedValueOnce({ id: 'sample-1' })
      .mockRejectedValueOnce(new Error('Creation failed'))
      .mockResolvedValueOnce({ id: 'sample-3' });

    renderPage();

    const loadSamplesBtn = await screen.findByRole('button', { name: 'Load Samples' });
    fireEvent.click(loadSamplesBtn);

    const addAllBtn = await screen.findByRole('button', { name: 'Add All (3)' });
    fireEvent.click(addAllBtn);

    expect(await screen.findByText('Sample AI 2')).toBeInTheDocument();
    expect(screen.queryByText('Sample AI 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Sample AI 3')).not.toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledWith('Added 2 providers, 1 failed');
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

describe('CoS Agent Runner allowlist warning', () => {
  const cliProvider = (command) => ({
    id: 'p1', name: 'Custom Agent', type: 'cli', enabled: true, command, args: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getRuns.mockResolvedValue({ runs: [] });
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
  });

  it('badges a provider whose command is off the published allowlist', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('my-custom-agent')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    renderPage();

    expect(await screen.findByText('NO AGENT RUNNER')).toBeInTheDocument();
  });

  it('does not badge a provider whose command IS on the allowlist', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('/usr/local/bin/claude')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    renderPage();

    expect(await screen.findByText('Custom Agent')).toBeInTheDocument();
    expect(screen.queryByText('NO AGENT RUNNER')).not.toBeInTheDocument();
  });

  // A server that predates #4143 omits `runnerAllowedCommands`; an unfetchable
  // list must read as "can't tell", never as "nothing is allowed".
  it('stays silent when the server omits runnerAllowedCommands', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('my-custom-agent')],
      activeProvider: 'p1',
    });

    renderPage();

    expect(await screen.findByText('Custom Agent')).toBeInTheDocument();
    expect(screen.queryByText('NO AGENT RUNNER')).not.toBeInTheDocument();
  });

  it('warns inline in the editor as the command is typed, without blocking Save', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('claude')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const commandInput = await screen.findByDisplayValue('claude');
    expect(screen.queryByText(/command allowlist/)).not.toBeInTheDocument();

    fireEvent.change(commandInput, { target: { value: 'my-custom-agent' } });

    expect(await screen.findByText(/command allowlist/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

