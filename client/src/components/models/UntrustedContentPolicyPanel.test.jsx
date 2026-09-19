import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({
  providers: [
    { id: 'local-api', name: 'Local example', type: 'api', endpoint: 'http://127.0.0.1:11434/v1', models: ['example-model'] },
    { id: 'cloud-api', name: 'Cloud example', type: 'api', endpoint: 'https://example.com/v1', models: ['example-model'] },
  ], loading: false,
}) }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));

import { getSettings, updateSettings } from '../../services/api';
import UntrustedContentPolicyPanel from './UntrustedContentPolicyPanel';

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({ untrustedContent: {
    defaults: { classifierMode: 'required', minBenignScore: 0.95 },
    sources: { 'github-pr': { maxInputChars: 50000 } },
  } });
  updateSettings.mockResolvedValue({});
});

describe('content safety policy configuration', () => {
  it('saves a private source override while preserving other policies and excluding cloud providers', async () => {
    render(<UntrustedContentPolicyPanel />);
    fireEvent.change(await screen.findByLabelText('Source'), { target: { value: 'email' } });
    const provider = screen.getByLabelText('Analysis API provider');
    expect(within(provider).queryByRole('option', { name: 'Cloud example' })).not.toBeInTheDocument();
    fireEvent.change(provider, { target: { value: 'local-api' } });
    fireEvent.change(screen.getByLabelText('Classifier requirement'), { target: { value: 'optional' } });
    expect(screen.getByText(/Those checks miss attacks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save content policies' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ untrustedContent: {
      defaults: { classifierMode: 'required', minBenignScore: 0.95 },
      sources: {
        'github-pr': { maxInputChars: 50000 },
        email: { providerId: 'local-api', model: null, classifierMode: 'optional' },
      },
    } }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save content policies' })).toBeDisabled());
  });

  it('requires loaded settings before editing and supports a failed-read retry', async () => {
    getSettings.mockRejectedValueOnce(new Error('unavailable'));
    render(<UntrustedContentPolicyPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.queryByRole('button', { name: 'Save content policies' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Source')).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('shows message-family defaults for private channels and resets a source back to that inheritance', async () => {
    getSettings.mockResolvedValueOnce({ untrustedContent: {
      defaults: { providerId: 'cloud-api', model: 'cloud-model', minBenignScore: 0.9 },
      sources: {
        messages: { providerId: 'local-api', classifierMode: 'required', minBenignScore: 0.98 },
        signal: { classifierMode: 'optional' },
      },
    } });
    render(<UntrustedContentPolicyPanel />);
    fireEvent.change(await screen.findByLabelText('Source'), { target: { value: 'signal' } });
    expect(screen.getByLabelText('Analysis API provider')).toHaveValue('local-api');
    expect(screen.getByLabelText('Minimum benign score')).toHaveValue(0.98);
    fireEvent.click(screen.getByRole('button', { name: 'Use message defaults for this source' }));
    expect(screen.getByLabelText('Classifier requirement')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Inherit message defaults (required)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save content policies' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ untrustedContent: {
      defaults: { providerId: 'cloud-api', model: 'cloud-model', minBenignScore: 0.9 },
      sources: { messages: { providerId: 'local-api', classifierMode: 'required', minBenignScore: 0.98 } },
    } }));
  });

  it('saves a per-source scorer mode and margin, and warns about the skip posture', async () => {
    render(<UntrustedContentPolicyPanel />);
    fireEvent.change(await screen.findByLabelText('Source'), { target: { value: 'github-issue' } });
    fireEvent.change(screen.getByLabelText('Local scorer'), { target: { value: 'prefer' } });
    expect(screen.queryByText(/Skipped items are reported/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Local scorer'), { target: { value: 'only' } });
    // The skip posture is the one an operator can misread as "no action needed".
    expect(screen.getByText(/Skipped items are reported/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Minimum decision margin'), { target: { value: '0.4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save content policies' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ untrustedContent: {
      defaults: { classifierMode: 'required', minBenignScore: 0.95 },
      sources: {
        'github-pr': { maxInputChars: 50000 },
        'github-issue': { jevMode: 'only', jevMinMargin: 0.4 },
      },
    } }));
  });

  it('drops a cleared scorer field instead of pinning an empty value', async () => {
    getSettings.mockResolvedValueOnce({ untrustedContent: {
      defaults: { jevMode: 'prefer' },
      sources: { email: { jevMode: 'only', jevMinMargin: 0.7 } },
    } });
    render(<UntrustedContentPolicyPanel />);
    fireEvent.change(await screen.findByLabelText('Source'), { target: { value: 'email' } });
    fireEvent.change(screen.getByLabelText('Minimum decision margin'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Local scorer'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save content policies' }));
    // Re-inheriting means the KEY is gone: a persisted null would be layered on
    // top of the default it is supposed to defer to.
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ untrustedContent: {
      defaults: { jevMode: 'prefer' },
      sources: { email: {} },
    } }));
  });
});
