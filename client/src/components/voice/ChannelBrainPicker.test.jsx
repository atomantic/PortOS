import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => ({
  updateVoiceConfig: vi.fn(),
  fetchAvatarLibrary: vi.fn(),
  patchAvatarChannel: vi.fn(),
}));

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: true } }));
vi.mock('../../services/apiProviders', () => ({
  getProviders: vi.fn(async () => ({
    providers: [
      { id: 'lmstudio', type: 'api', name: 'LM Studio', models: ['model-a'] },
      { id: 'ollama', type: 'api', name: 'Ollama', models: ['model-b'] },
    ],
  })),
  refreshProviderModels: vi.fn(),
}));
vi.mock('../../services/apiVoice', () => ({ updateVoiceConfig: mocks.updateVoiceConfig }));
vi.mock('../../services/apiVoiceAvatar', () => ({
  fetchAvatarLibrary: mocks.fetchAvatarLibrary,
  patchAvatarChannel: mocks.patchAvatarChannel,
}));
vi.mock('../settings/voice/ConversationalGemmaNotice', () => ({ default: () => null }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../ProviderModelSelector', () => ({
  default: ({ label, providers, selectedProviderId, onProviderChange }) => (
    <select aria-label={label} value={selectedProviderId} onChange={(e) => onProviderChange(e.target.value)}>
      {providers.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
    </select>
  ),
}));

import ChannelBrainPicker from './ChannelBrainPicker';

let stored;
const library = (agent) => ({
  avatars: [],
  active: 1,
  channels: Array.from({ length: 6 }, (_, i) => ({ label: '', avatar: null, agent: i === 1 ? agent : {} })),
});

beforeEach(() => {
  vi.clearAllMocks();
  stored = library({});
  mocks.fetchAvatarLibrary.mockImplementation(async () => stored);
  mocks.patchAvatarChannel.mockImplementation(async (index, { agent }) => {
    stored = { ...stored, channels: stored.channels.map((ch, i) => (i === index ? { ...ch, agent } : ch)) };
    return stored;
  });
  mocks.updateVoiceConfig.mockResolvedValue({});
});

const renderPicker = () => render(
  <MemoryRouter><ChannelBrainPicker globalProvider="lmstudio" globalModel="model-a" onGlobalSaved={vi.fn()} /></MemoryRouter>,
);

it('edits the global LLM until the on-air channel takes its own, then edits only that channel', async () => {
  renderPicker();
  const scope = await screen.findByRole('group', { name: 'Voice brain applies to' });
  expect(within(scope).getByRole('button', { name: 'All channels' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(within(scope).getByRole('button', { name: 'CH2 only' }));
  await waitFor(() => expect(mocks.patchAvatarChannel).toHaveBeenLastCalledWith(
    1, { agent: { provider: 'lmstudio', model: 'model-a' } }, { silent: true },
  ));
  await waitFor(() => expect(within(scope).getByRole('button', { name: 'CH2 only' })).toHaveAttribute('aria-pressed', 'true'));

  const providerSelect = screen.getByRole('combobox', { name: 'Voice LLM provider' });
  await within(providerSelect).findByRole('option', { name: 'Ollama' });
  fireEvent.change(providerSelect, { target: { value: 'ollama' } });
  await waitFor(() => expect(mocks.patchAvatarChannel).toHaveBeenLastCalledWith(
    1, { agent: { provider: 'ollama', model: 'auto' } }, { silent: true },
  ));
  expect(mocks.updateVoiceConfig).not.toHaveBeenCalled();

  fireEvent.click(within(scope).getByRole('button', { name: 'All channels' }));
  await waitFor(() => expect(mocks.patchAvatarChannel).toHaveBeenLastCalledWith(1, { agent: {} }, { silent: true }));
});
