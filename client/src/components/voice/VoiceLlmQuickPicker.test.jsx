import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  refreshProviderModels: vi.fn(),
  updateVoiceConfig: vi.fn(),
  getLlamaServerStatus: vi.fn(),
  startLlamaServer: vi.fn(),
  setLlamaServerAutoStart: vi.fn(),
}));

vi.mock('../../services/apiProviders', () => ({
  getProviders: mocks.getProviders,
  refreshProviderModels: mocks.refreshProviderModels,
}));
vi.mock('../../services/apiVoice', () => ({ updateVoiceConfig: mocks.updateVoiceConfig }));
vi.mock('../../services/apiLocalLlm', () => ({
  getLlamaServerStatus: mocks.getLlamaServerStatus,
  startLlamaServer: mocks.startLlamaServer,
  setLlamaServerAutoStart: mocks.setLlamaServerAutoStart,
}));
vi.mock('../settings/voice/ConversationalGemmaNotice', () => ({ default: () => null }));
vi.mock('../ProviderModelSelector', () => ({
  default: ({ label, providers, selectedProviderId, onProviderChange }) => (
    <select aria-label={label} value={selectedProviderId} onChange={(e) => onProviderChange(e.target.value)}>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
    </select>
  ),
}));

import VoiceLlmQuickPicker from './VoiceLlmQuickPicker';

const SAVED_LAUNCH = { model: '/models/voice.gguf', alias: 'example-org/voice-model', ctxSize: 4096 };
const PROVIDERS = [
  { id: 'lmstudio', type: 'api', name: 'LM Studio', endpoint: 'http://localhost:1234/v1', models: ['model-a'] },
  { id: 'llama-server', type: 'api', name: 'llama.cpp (local)', endpoint: 'http://127.0.0.1:5568/v1', models: ['example-org/voice-model'] },
];

const renderPicker = (props) => render(
  <MemoryRouter><VoiceLlmQuickPicker {...props} /></MemoryRouter>,
);

describe('VoiceLlmQuickPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviders.mockResolvedValue({ providers: PROVIDERS });
    mocks.updateVoiceConfig.mockResolvedValue({});
    mocks.getLlamaServerStatus.mockResolvedValue({ installed: true, running: false, autoStart: false, savedLaunch: SAVED_LAUNCH });
  });

  it('saves a provider switch with the model reset to auto', async () => {
    const onSaved = vi.fn();
    renderPicker({ provider: 'lmstudio', model: 'model-a', onSaved });
    const providerSelect = await screen.findByRole('combobox', { name: 'Voice LLM provider' });
    await within(providerSelect).findByRole('option', { name: 'llama.cpp (local)' });

    fireEvent.change(providerSelect, { target: { value: 'llama-server' } });

    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith(
      { llm: { provider: 'llama-server', model: 'auto' } },
      { silent: true },
    ));
    expect(onSaved).toHaveBeenCalledWith({ provider: 'llama-server', model: 'auto' });
  });

  it('shows no llama.cpp controls for another provider', async () => {
    renderPicker({ provider: 'lmstudio', model: 'auto' });
    await screen.findByRole('option', { name: 'llama.cpp (local)' });
    expect(screen.queryByText('Start with PortOS')).toBeNull();
    expect(mocks.getLlamaServerStatus).not.toHaveBeenCalled();
  });

  it('starts a stopped llama.cpp server from its saved launch line', async () => {
    renderPicker({ provider: 'llama-server', model: 'auto' });
    expect(await screen.findByRole('status')).toHaveTextContent('llama.cpp stopped · example-org/voice-model');
    mocks.startLlamaServer.mockResolvedValue({ online: true });
    mocks.getLlamaServerStatus.mockResolvedValue({ installed: true, running: true, autoStart: false, savedLaunch: SAVED_LAUNCH });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('llama.cpp running'));
    expect(mocks.startLlamaServer).toHaveBeenCalledWith(SAVED_LAUNCH, { silent: true });
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('turns on Start with PortOS and shows the server the toggle started', async () => {
    mocks.setLlamaServerAutoStart.mockResolvedValue({
      autoStart: true,
      started: true,
      status: { installed: true, running: true, autoStart: true, savedLaunch: SAVED_LAUNCH },
    });
    renderPicker({ provider: 'llama-server', model: 'auto' });
    const toggle = await screen.findByRole('checkbox', { name: 'Start with PortOS' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Start with PortOS' })).toBeChecked());
    expect(mocks.setLlamaServerAutoStart).toHaveBeenCalledWith(true, { silent: true });
    expect(screen.getByRole('status')).toHaveTextContent('llama.cpp running');
  });

  it('refreshes status when Start with PortOS persists the toggle but immediate start fails', async () => {
    mocks.setLlamaServerAutoStart.mockRejectedValue(new Error('Model file missing'));
    renderPicker({ provider: 'llama-server', model: 'auto' });
    const toggle = await screen.findByRole('checkbox', { name: 'Start with PortOS' });
    expect(toggle).not.toBeChecked();

    mocks.getLlamaServerStatus.mockResolvedValue({ installed: true, running: false, autoStart: true, savedLaunch: SAVED_LAUNCH });
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Start with PortOS' })).toBeChecked());
    expect(screen.getByRole('status')).toHaveTextContent('llama.cpp stopped');
  });
});
