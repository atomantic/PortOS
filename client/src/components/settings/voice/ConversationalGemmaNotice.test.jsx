import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mocks = vi.hoisted(() => ({
  checkConversationalGemmaAccess: vi.fn(),
}));

vi.mock('../../../services/apiLocalLlm.js', () => ({
  checkConversationalGemmaAccess: mocks.checkConversationalGemmaAccess,
}));
vi.mock('../../imageGen/HfTokenBanner.jsx', () => ({
  default: () => <div data-testid="hf-token-banner">HF Token Banner</div>,
}));

import ConversationalGemmaNotice from './ConversationalGemmaNotice';

describe('ConversationalGemmaNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows actionable local and external install steps plus HF access check when no provider serves it', async () => {
    mocks.checkConversationalGemmaAccess.mockResolvedValue({ status: 'ready' });
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[{ id: 'lmstudio', name: 'LM Studio', models: ['gemma4:31b'] }]}
          selectedProviderId="lmstudio"
          selectedModelId="auto"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/How to install & enable Conversational Gemma 4 31B/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'llama.cpp runtime' })).toHaveAttribute('href', '/models/llms-runtimes');
    expect(screen.getByRole('link', { name: 'Local LLMs' })).toHaveAttribute('href', '/models/llms');

    fireEvent.click(screen.getByRole('button', { name: 'Check Hugging Face access' }));
    expect(await screen.findByText(/Hugging Face confirmed download access/)).toBeInTheDocument();
  });

  it('offers a one-click provider switch when another connected API provider serves it', () => {
    const onSwitch = vi.fn();
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[
            { id: 'lmstudio', name: 'LM Studio', models: ['gemma4:31b'] },
            { id: 'local-llama', name: 'Local llama.cpp', models: ['Trelis/gemma-4-31B-it-conversational'] },
          ]}
          selectedProviderId="lmstudio"
          selectedModelId="auto"
          onSwitchProviderAndModel={onSwitch}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Local llama.cpp' }));
    expect(onSwitch).toHaveBeenCalledWith('local-llama', 'Trelis/gemma-4-31B-it-conversational');
  });

  it('offers one-click selection when the selected provider serves it', () => {
    const onSelect = vi.fn();
    render(
      <MemoryRouter>
        <ConversationalGemmaNotice
          apiProviders={[
            { id: 'local-llama', name: 'Local llama.cpp', models: ['trelis/gemma-4-31b-it-conversational'] },
          ]}
          selectedProviderId="local-llama"
          selectedModelId="auto"
          onSelectModel={onSelect}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use Conversational Gemma 4 31B' }));
    expect(onSelect).toHaveBeenCalledWith('trelis/gemma-4-31b-it-conversational');
  });
});
