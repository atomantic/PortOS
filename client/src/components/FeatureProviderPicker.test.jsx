import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FeatureProviderPicker from './FeatureProviderPicker';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../services/apiProviders.js', () => ({ getProviders: api.getProviders }));
vi.mock('../services/apiSystem.js', () => ({ getSettings: api.getSettings, updateSettings: api.updateSettings }));
vi.mock('./ui/Toast');

describe('FeatureProviderPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails into an error row with Retry instead of "No enabled CLI providers"', async () => {
    api.getProviders.mockRejectedValueOnce(new Error('providers 503'));
    api.getSettings.mockResolvedValue({});
    render(<MemoryRouter><FeatureProviderPicker featureKey="autofixer" /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load AI providers — providers 503');
    expect(screen.queryByText(/No enabled CLI providers/)).not.toBeInTheDocument();

    api.getProviders.mockResolvedValue({ providers: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/No enabled CLI providers/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AI Providers' })).toHaveAttribute('href', '/ai/presets');
  });

  it('offers and persists only enabled CLI presets', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'claude-code', name: 'Claude Code', type: 'cli', models: ['m1'], defaultModel: 'm1' },
        { id: 'codex', name: 'Codex', type: 'cli', defaultModel: 'm2' },
        { id: 'api', name: 'API', type: 'api', defaultModel: 'm3' },
        { id: 'disabled', name: 'Disabled CLI', type: 'cli', enabled: false },
      ],
    });
    api.getSettings.mockResolvedValue({});
    api.updateSettings.mockResolvedValue({});
    render(<MemoryRouter><FeatureProviderPicker featureKey="autofixer" /></MemoryRouter>);

    const codex = await screen.findByRole('option', { name: /Codex/ });
    expect(screen.queryByRole('option', { name: /Custom combination|^API$|Disabled CLI/ })).not.toBeInTheDocument();
    fireEvent.change(codex.closest('select'), { target: { value: 'codex' } });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ autofixer: { providerId: 'codex', model: 'm2' } }));
  });

  it('does not seed the picker from defaults when only the settings read fails', async () => {
    api.getProviders.mockResolvedValue({ providers: [{ id: 'claude-code', type: 'cli', models: ['m1'], defaultModel: 'm1' }] });
    api.getSettings.mockRejectedValueOnce(new Error('settings 500'));
    render(<MemoryRouter><FeatureProviderPicker featureKey="autofixer" /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('settings 500');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
