import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getDigitalTwinImportSources: vi.fn(),
  analyzeDigitalTwinImport: vi.fn(),
  openDigitalTwinSpotifyBrowser: vi.fn(),
  importDigitalTwinSpotifyBrowser: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({
  getProviders: vi.fn(),
}));
vi.mock('../../ui/Toast');
vi.mock('../TwinProviderPicker.jsx', () => ({
  default: ({ providers, selected }) => (
    <div data-testid="provider-picker">{providers.map((p) => p.id).join(',')}|{selected?.providerId ?? 'none'}</div>
  ),
}));

import ImportTab from './ImportTab';
import { getDigitalTwinImportSources } from '../../../services/apiDigitalTwin.js';
import { getProviders } from '../../../services/apiProviders.js';

const SOURCE = { id: 'spotify', name: 'Spotify', format: 'zip', description: 'Listening history' };
const PROVIDER = { id: 'example-provider', enabled: true, defaultModel: 'example-model' };

describe('ImportTab failed loads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDigitalTwinImportSources.mockResolvedValue({ sources: [SOURCE] });
    getProviders.mockResolvedValue({ providers: [PROVIDER, { id: 'off', enabled: false }] });
  });

  it('shows a retryable error instead of an empty source grid, then the sources after Retry', async () => {
    getDigitalTwinImportSources.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    render(<ImportTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load import sources');
    expect(screen.queryByText('Spotify')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Spotify')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a provider load error with Retry, keeps Spotify import blocked, and seeds the first enabled provider on retry', async () => {
    getProviders.mockRejectedValueOnce(new Error('providers down'));
    const user = userEvent.setup();
    render(<ImportTab />);

    await user.click(await screen.findByText('Spotify'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load AI providers');
    expect(screen.queryByTestId('provider-picker')).toBeNull();
    expect(screen.getByRole('button', { name: /Request and import history/ })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('provider-picker')).toHaveTextContent('example-provider|example-provider');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /Request and import history/ })).toBeEnabled();
  });
});
