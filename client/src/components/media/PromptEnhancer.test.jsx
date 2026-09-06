import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PromptEnhancer from './PromptEnhancer';
import * as api from '../../services/api';
import toast from '../ui/Toast';

vi.mock('../../hooks/useProviderModels', () => ({
  default: vi.fn(() => ({
    providers: [
      { id: 'openai', name: 'OpenAI', enabled: true, defaultModel: 'gpt-4o' },
      { id: 'antigravity', name: 'Antigravity', enabled: true, defaultModel: 'gemini-2.5-flash' },
    ],
    selectedProviderId: 'openai',
    selectedModel: 'gpt-4o',
    availableModels: ['gpt-4o', 'gpt-4o-mini'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  })),
}));

vi.mock('../../services/api', () => ({
  refineMediaPrompt: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() }),
}));

describe('PromptEnhancer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders enhance button and handles click to enhance prompt', async () => {
    const setPrompt = vi.fn();
    const setNegativePrompt = vi.fn();
    vi.mocked(api.refineMediaPrompt).mockResolvedValue({
      prompt: 'an enhanced detailed prompt',
      negativePrompt: 'low resolution',
      rationale: 'Enhanced details.',
    });

    render(
      <PromptEnhancer
        kind="image"
        prompt="a simple cat"
        setPrompt={setPrompt}
        negativePrompt=""
        setNegativePrompt={setNegativePrompt}
      />
    );

    const enhanceBtn = screen.getByRole('button', { name: /^enhance$/i });
    expect(enhanceBtn).toBeInTheDocument();

    fireEvent.click(enhanceBtn);

    await waitFor(() => {
      expect(api.refineMediaPrompt).toHaveBeenCalledWith({
        kind: 'image',
        prompt: 'a simple cat',
        negativePrompt: '',
        providerId: 'openai',
        model: 'gpt-4o',
        effort: undefined,
        renderConfig: {},
      });
    });

    expect(setPrompt).toHaveBeenCalledWith('an enhanced detailed prompt');
    expect(setNegativePrompt).toHaveBeenCalledWith('low resolution');
  });

  // reactor.inc rejects a prompt over its cap outright, so the enhancer has to
  // be told the budget rather than handing back a richer, unrenderable prompt.
  it('forwards the render backend prompt cap and reports a trimmed result', async () => {
    const setPrompt = vi.fn();
    vi.mocked(api.refineMediaPrompt).mockResolvedValue({
      prompt: 'an enhanced detailed prompt',
      negativePrompt: '',
      truncated: true,
    });

    render(
      <PromptEnhancer
        kind="video"
        prompt="a simple cat"
        setPrompt={setPrompt}
        maxPromptLength={785}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^enhance$/i }));

    await waitFor(() => {
      expect(api.refineMediaPrompt).toHaveBeenCalledWith(expect.objectContaining({ maxPromptLength: 785 }));
    });
    expect(setPrompt).toHaveBeenCalledWith('an enhanced detailed prompt');
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('785'));
    expect(toast.success).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /toggle ai prompt enhancement options/i }));
    expect(screen.getByText(/kept within 785 characters/i)).toBeInTheDocument();
  });

  it('toggles settings panel to reveal provider, model and effort controls', () => {
    render(
      <PromptEnhancer
        kind="video"
        prompt="a cinematic scene"
        setPrompt={vi.fn()}
      />
    );

    const toggleBtn = screen.getByRole('button', { name: /toggle ai prompt enhancement options/i });
    expect(toggleBtn).toBeInTheDocument();

    fireEvent.click(toggleBtn);

    expect(screen.getByText('AI Prompt Enhancer Settings')).toBeInTheDocument();
    expect(screen.getByText('Provider')).toBeInTheDocument();
  });
});
