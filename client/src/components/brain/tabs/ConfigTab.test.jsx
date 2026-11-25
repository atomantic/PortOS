import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../../ui/Toast');
vi.mock('../YoutubeIngestSettings', () => ({ default: () => null }));

const api = vi.hoisted(() => ({
  getBrainSettings: vi.fn(),
  getProviders: vi.fn(),
  getEmbeddingStatus: vi.fn(),
  getEmbeddingConfig: vi.fn(),
  updateBrainSettings: vi.fn(),
  syncBrainData: vi.fn(),
}));
vi.mock('../../../services/apiBrain.js', () => ({
  getBrainSettings: api.getBrainSettings,
  updateBrainSettings: api.updateBrainSettings,
  syncBrainData: api.syncBrainData,
}));
vi.mock('../../../services/apiProviders.js', () => ({ getProviders: api.getProviders }));
vi.mock('../../../services/apiMemory.js', () => ({
  getEmbeddingStatus: api.getEmbeddingStatus,
  getEmbeddingConfig: api.getEmbeddingConfig,
}));

import BrainConfigTab from './ConfigTab.jsx';

// The embeddings notice links to Models → Embeddings, so it needs a router.
const ConfigTab = (props) => <MemoryRouter><BrainConfigTab {...props} /></MemoryRouter>;

const PROVIDERS = [
  { id: 'chat-only', name: 'Chat Only', type: 'api', enabled: true, defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini'] },
  { id: 'local', name: 'Local', type: 'api', enabled: true, defaultModel: 'llama3.2:latest', models: ['llama3.2:latest', 'nomic-embed-text'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getBrainSettings.mockResolvedValue({ defaultProvider: '', defaultModel: '', confidenceThreshold: 0.6 });
  api.getProviders.mockResolvedValue({ providers: PROVIDERS });
  api.getEmbeddingStatus.mockResolvedValue(null);
  api.getEmbeddingConfig.mockResolvedValue({ source: 'settings', provider: 'ollama', model: 'nomic-embed-text', endpoint: 'http://192.0.2.10:11434/v1/embeddings', disabled: false });
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
});

describe('brain ConfigTab embeddings (#18296)', () => {
  it('shows the shared settings.embeddings backend and links to it instead of a second picker', async () => {
    render(<ConfigTab />);

    expect(await screen.findByText(/Catalog and memory embed with/)).toHaveTextContent('Ollama · nomic-embed-text');
    expect(screen.getByRole('link', { name: 'Configure embeddings' })).toHaveAttribute('href', '/models/embeddings');
    expect(screen.queryByLabelText('Embedding Provider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save embedding config' })).not.toBeInTheDocument();
  });

  it('names the legacy CoS backend while settings.embeddings is unsaved', async () => {
    api.getEmbeddingConfig.mockResolvedValue({ source: 'legacy', provider: 'lmstudio', model: 'text-embedding-nomic-embed-text-v2-moe', endpoint: null, disabled: false });
    render(<ConfigTab />);

    expect(await screen.findByText(/legacy Chief of Staff embedding provider/)).toHaveTextContent('LM Studio · text-embedding-nomic-embed-text-v2-moe');
  });

  it('disables reprocessing while embeddings are disabled', async () => {
    api.getEmbeddingStatus.mockResolvedValue({ available: false, disabled: true, error: 'Embeddings are disabled on Models → Embeddings' });
    api.getEmbeddingConfig.mockResolvedValue({ source: 'settings', provider: 'none', model: null, endpoint: null, disabled: true });
    render(<ConfigTab />);

    expect(await screen.findByText(/for the catalog and memory/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprocess all embeddings' })).toBeDisabled();
  });
});

describe('brain ConfigTab provider list failure', () => {
  it('shows a retryable error instead of empty provider pickers, and recovers on retry', async () => {
    api.getBrainSettings.mockResolvedValue({ defaultProvider: 'local', defaultModel: 'llama3.2:latest', confidenceThreshold: 0.6 });
    api.getProviders.mockRejectedValueOnce(new Error('providers down'));
    render(<ConfigTab />);

    // Only the classification picker reads providers; embeddings live on Models → Embeddings.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
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
});
