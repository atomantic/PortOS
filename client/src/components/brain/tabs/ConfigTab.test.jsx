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
