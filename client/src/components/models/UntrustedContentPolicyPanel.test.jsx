import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const render = (ui) => renderView(ui, { wrapper: MemoryRouter });

vi.mock('../../services/apiSystem.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../../services/apiProviders.js', () => ({ getProviders: vi.fn() }));
vi.mock('../ui/Toast');

import { getProviders } from '../../services/apiProviders.js';
import { getSettings, updateSettings } from '../../services/apiSystem.js';
import UntrustedContentPolicyPanel from './UntrustedContentPolicyPanel';

beforeEach(() => {
  vi.clearAllMocks();
  getProviders.mockResolvedValue({ providers: [
    { id: 'local-api', name: 'Local example', type: 'api', endpoint: 'http://127.0.0.1:11434/v1', models: ['example-model'] },
    { id: 'cloud-api', name: 'Cloud example', type: 'api', endpoint: 'https://example.com/v1', models: ['example-model'], defaultModel: 'example-model' },
  ] });
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

  it('shows what Automatic resolves to, skipping an eligible provider without a default model', async () => {
    render(<UntrustedContentPolicyPanel />);
    fireEvent.change(await screen.findByLabelText('Source'), { target: { value: 'github-pr' } });
    expect(await screen.findByText(/Resolves to Cloud example with model example-model/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'email' } });
    expect(screen.getByRole('status')).toHaveTextContent('No eligible API provider has a default model');
    fireEvent.change(screen.getByLabelText('Analysis API provider'), { target: { value: 'local-api' } });
    expect(screen.getByRole('status')).toHaveTextContent('The pinned provider has no default model');
  });

  it('uses the model-specific window for Automatic and keeps private sources on loopback', async () => {
    getProviders.mockResolvedValueOnce({ providers: [
      {
        id: 'local-api', name: 'Local example', type: 'api', endpoint: 'http://127.0.0.1:11434/v1',
        defaultModel: 'small', models: ['small', 'wide'],
        untrustedContentWindows: { defaultWindow: 4_096, byModel: { wide: 32_768 } },
      },
      {
        id: 'cloud-api', name: 'Cloud example', type: 'api', endpoint: 'https://example.com/v1',
        defaultModel: 'large', untrustedContentWindows: { defaultWindow: 32_768, byModel: {} },
      },
    ] });
    getSettings.mockResolvedValueOnce({ untrustedContent: { sources: { 'github-issue': { model: 'wide' } } } });
    render(<UntrustedContentPolicyPanel />);
    const source = await screen.findByLabelText('Source');
    fireEvent.change(source, { target: { value: 'github-pr' } });
    expect(await screen.findByText('Resolves to Cloud example with model large.')).toBeInTheDocument();
    fireEvent.change(source, { target: { value: 'github-issue' } });
    expect(screen.getByText('Resolves to Local example with model wide.')).toBeInTheDocument();
    fireEvent.change(source, { target: { value: 'email' } });
    expect(screen.getByText('Resolves to Local example with model small.')).toBeInTheDocument();
  });

  it('offers a provider-list retry after a failed read', async () => {
    getProviders.mockRejectedValueOnce(new Error('unavailable'));
    render(<UntrustedContentPolicyPanel />);
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Could not load analysis providers');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Resolves to Cloud example with model example-model.')).toBeInTheDocument();
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

  it('lists Moltbook as a public source and still offers a cloud API provider', async () => {
    render(<UntrustedContentPolicyPanel />);
    const source = await screen.findByLabelText('Source');
    expect(within(source).getByRole('option', { name: 'Moltbook' })).toBeInTheDocument();
    fireEvent.change(source, { target: { value: 'moltbook' } });
    expect(within(screen.getByLabelText('Analysis API provider')).getByRole('option', { name: 'Cloud example' })).toBeEnabled();
    expect(screen.getByText(/Cloud APIs may receive public sources/)).toBeInTheDocument();
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
