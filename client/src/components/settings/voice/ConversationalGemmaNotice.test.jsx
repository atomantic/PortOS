import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => ({
  getConversationalGemmaSetupStatus: vi.fn(),
  startConversationalGemmaSetup: vi.fn(),
  cancelConversationalGemmaSetup: vi.fn(),
}));

vi.mock('../../../services/apiLocalLlm.js', () => ({
  getConversationalGemmaSetupStatus: mocks.getConversationalGemmaSetupStatus,
  startConversationalGemmaSetup: mocks.startConversationalGemmaSetup,
  cancelConversationalGemmaSetup: mocks.cancelConversationalGemmaSetup,
}));
vi.mock('../../../hooks/useSocketResource.js', () => ({
  useSocketResource: vi.fn((_fetcher, opts) => {
    const data = opts?.enabled ? mocks.getConversationalGemmaSetupStatus() : null;
    return { data, updateData: vi.fn() };
  }),
}));
vi.mock('../../imageGen/HfTokenBanner.jsx', () => ({
  default: () => <div data-testid="hf-token-banner">HF Token Banner</div>,
}));

import ConversationalGemmaNotice from './ConversationalGemmaNotice';

describe('ConversationalGemmaNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConversationalGemmaSetupStatus.mockReturnValue({
      supported: true,
      llamaInstalled: false,
      ggufExists: false,
      running: false,
      phase: 'idle',
      detail: '',
      error: '',
      accessStatus: null,
    });
  });

  it('offers one-click automated llama.cpp + Conversational Gemma setup when no provider serves it', async () => {
    mocks.startConversationalGemmaSetup.mockResolvedValue({
      supported: true,
      running: true,
      phase: 'installing-llama',
      detail: 'Installing llama.cpp…',
      percent: 10,
    });
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[{ id: 'lmstudio', name: 'LM Studio', models: ['gemma4:31b'] }]}
          selectedProviderId="lmstudio"
          selectedModelId="auto"
        />
      </MemoryRouter>,
    );

    const btn = screen.getByRole('button', { name: 'Use llama.cpp + Conversational Gemma 4 31B' });
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.startConversationalGemmaSetup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('shows Start shortcut when local Q8_0 GGUF already exists on disk', () => {
    mocks.getConversationalGemmaSetupStatus.mockReturnValue({
      supported: true,
      llamaInstalled: true,
      ggufExists: true,
      running: false,
      phase: 'idle',
    });
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[{ id: 'ollama', name: 'Ollama', models: [] }]}
          selectedProviderId="ollama"
          selectedModelId="auto"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Start llama.cpp + Conversational Gemma' })).toBeInTheDocument();
  });

  it('renders inline HF token banner when setup needs gated checkpoint access', () => {
    mocks.getConversationalGemmaSetupStatus.mockReturnValue({
      supported: true,
      llamaInstalled: true,
      ggufExists: false,
      running: false,
      phase: 'failed',
      error: 'Save a Hugging Face read token.',
      accessStatus: 'token-required',
    });
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[{ id: 'ollama', name: 'Ollama', models: [] }]}
          selectedProviderId="ollama"
          selectedModelId="auto"
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('hf-token-banner')).toBeInTheDocument();
  });

  it('offers a one-click provider switch when another connected API provider serves it', () => {
    const onSwitch = vi.fn();
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[
            { id: 'lmstudio', name: 'LM Studio', models: ['gemma4:31b'] },
            { id: 'llama-server', name: 'llama.cpp (local)', models: ['Trelis/gemma-4-31B-it-conversational'] },
          ]}
          selectedProviderId="lmstudio"
          selectedModelId="auto"
          onSwitchProviderAndModel={onSwitch}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Switch to llama.cpp (local)' }));
    expect(onSwitch).toHaveBeenCalledWith('llama-server', 'Trelis/gemma-4-31B-it-conversational');
  });

  it('offers one-click selection when the selected provider serves it', () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[
            { id: 'llama-server', name: 'llama.cpp (local)', models: ['trelis/gemma-4-31b-it-conversational'] },
          ]}
          selectedProviderId="llama-server"
          selectedModelId="auto"
          onSelectModel={onSelect}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use Conversational Gemma 4 31B' }));
    expect(onSelect).toHaveBeenCalledWith('trelis/gemma-4-31b-it-conversational');
  });
});
