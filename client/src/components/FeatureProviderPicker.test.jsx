import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FeatureProviderPicker from './FeatureProviderPicker';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('./ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

describe('FeatureProviderPicker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails into an error row with Retry instead of "No enabled CLI providers"', async () => {
    api.getProviders.mockRejectedValueOnce(new Error('providers 503'));
    api.getSettings.mockResolvedValue({});
    render(<FeatureProviderPicker featureKey="autofixer" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load AI providers — providers 503');
    expect(screen.queryByText(/No enabled CLI providers/)).not.toBeInTheDocument();

    api.getProviders.mockResolvedValue({ providers: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText(/No enabled CLI providers/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not seed the picker from defaults when only the settings read fails', async () => {
    api.getProviders.mockResolvedValue({ providers: [{ id: 'claude-code', type: 'cli', models: ['m1'], defaultModel: 'm1' }] });
    api.getSettings.mockRejectedValueOnce(new Error('settings 500'));
    render(<FeatureProviderPicker featureKey="autofixer" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('settings 500');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
