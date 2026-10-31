import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../YoutubeIngestSettings', () => ({ default: () => null }));

const api = vi.hoisted(() => ({
  getBrainSettings: vi.fn(),
  getProviders: vi.fn(),
  getCosConfig: vi.fn(),
  getEmbeddingStatus: vi.fn(),
  updateBrainSettings: vi.fn(),
  updateCosConfig: vi.fn(),
  syncBrainData: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

import ConfigTab from './ConfigTab.jsx';

// Two providers whose model lists differ in the one way the seeding rules care
// about: `chat-only` lists no embedding-named model, `local` does — and its own
// default is a CHAT model, which is exactly the pin the embedding picker must
// refuse to inherit.
const PROVIDERS = [
  { id: 'chat-only', name: 'Chat Only', type: 'api', enabled: true, defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'local', name: 'Local', type: 'api', enabled: true, defaultModel: 'llama3.2:latest', models: ['llama3.2:latest', 'nomic-embed-text'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getBrainSettings.mockResolvedValue({ defaultProvider: '', defaultModel: '', confidenceThreshold: 0.6 });
  api.getProviders.mockResolvedValue({ providers: PROVIDERS });
  api.getCosConfig.mockResolvedValue({ embeddingProviderId: '', embeddingModel: '' });
  api.getEmbeddingStatus.mockResolvedValue(null);
});

describe('brain ConfigTab scheduled reviews opt-in', () => {
  it('names the provider/model and persists the toggle', async () => {
    api.getBrainSettings.mockResolvedValue({ defaultProvider: 'local', defaultModel: 'llama3.2:latest', confidenceThreshold: 0.6, scheduledReviewsEnabled: false });
    api.updateBrainSettings.mockResolvedValue({ scheduledReviewsEnabled: true });
    render(<ConfigTab />);

    const toggle = await screen.findByLabelText(/Run daily digest and weekly review automatically/);
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('llama3.2:latest', { selector: 'span' })).toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(screen.getAllByRole('button', { name: 'Save Changes' })[0]);

    expect(api.updateBrainSettings).toHaveBeenCalledWith(expect.objectContaining({ scheduledReviewsEnabled: true }), { silent: true });
  });
});

describe('brain ConfigTab provider pickers', () => {
  it('seeds the provider default into the classification model on a provider change', async () => {
    render(<ConfigTab />);

    await userEvent.selectOptions(await screen.findByLabelText('Default Provider'), 'chat-only');

    expect(screen.getByLabelText('Default Model')).toHaveValue('gpt-4o');
  });

  it('seeds an embedding-named model over the provider default', async () => {
    render(<ConfigTab />);

    await userEvent.selectOptions(await screen.findByLabelText('Embedding Provider'), 'local');

    // `llama3.2:latest` is the provider's own default and would embed nothing
    // usable — the embedding-named model in the same list wins.
    expect(screen.getByLabelText('Embedding Model')).toHaveValue('nomic-embed-text');
  });

  it('falls back to the provider default when nothing in the list is embedding-named', async () => {
    render(<ConfigTab />);

    await userEvent.selectOptions(await screen.findByLabelText('Embedding Provider'), 'chat-only');

    expect(screen.getByLabelText('Embedding Model')).toHaveValue('gpt-4o');
  });

  it('keeps the two pickers independent', async () => {
    render(<ConfigTab />);

    await userEvent.selectOptions(await screen.findByLabelText('Default Provider'), 'chat-only');
    await userEvent.selectOptions(screen.getByLabelText('Embedding Provider'), 'local');

    expect(screen.getByLabelText('Default Model')).toHaveValue('gpt-4o');
    expect(screen.getByLabelText('Embedding Model')).toHaveValue('nomic-embed-text');
  });
});

describe('brain ConfigTab provider list failure', () => {
  it('shows a retryable error instead of empty provider pickers, and recovers on retry', async () => {
    api.getBrainSettings.mockResolvedValue({ defaultProvider: 'local', defaultModel: 'llama3.2:latest', confidenceThreshold: 0.6 });
    api.getProviders.mockRejectedValueOnce(new Error('providers down'));
    render(<ConfigTab />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Could not load AI providers');
    expect(screen.queryByLabelText('Default Provider')).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);

    expect(await screen.findByLabelText('Default Provider')).toHaveValue('local');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('brain ConfigTab settings read failures', () => {
  it('shows a retryable error instead of default-valued controls when brain settings fail, and recovers', async () => {
    api.getBrainSettings
      .mockRejectedValueOnce(new Error('settings down'))
      .mockResolvedValue({ defaultProvider: 'local', defaultModel: 'llama3.2:latest', confidenceThreshold: 0.8, scheduledReviewsEnabled: false, dailyDigestTime: '07:30', weeklyReviewDay: 'friday', weeklyReviewTime: '18:00' });
    render(<ConfigTab />);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toHaveTextContent('Could not load Brain settings');
    expect(screen.queryByLabelText('Daily Digest Time')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Default Provider')).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);

    expect(await screen.findByLabelText('Daily Digest Time')).toHaveValue('07:30');
    expect(screen.getByLabelText('Default Provider')).toHaveValue('local');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of an empty embedding provider when the CoS config fails, and recovers', async () => {
    api.getCosConfig
      .mockRejectedValueOnce(new Error('cos down'))
      .mockResolvedValue({ embeddingProviderId: 'local', embeddingModel: 'nomic-embed-text' });
    render(<ConfigTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load CoS config');
    expect(screen.queryByLabelText('Embedding Provider')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save embedding config' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Embedding Provider')).toHaveValue('local');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
