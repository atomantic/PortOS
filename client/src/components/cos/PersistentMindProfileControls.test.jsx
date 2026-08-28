import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  updateCosConfig: vi.fn(),
}));
const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
}));
const providerHook = vi.hoisted(() => ({
  setSelectedProviderId: vi.fn(),
  setSelectedModel: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../../services/apiLocalLlm', () => localLlm);
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{
      id: 'ollama',
      name: 'Ollama',
      type: 'api',
      endpoint: 'http://localhost:11434/v1',
      defaultModel: 'qwen3.6:35b',
      models: ['qwen3.6:35b', 'gemma3:4b'],
    }],
    availableModels: ['qwen3.6:35b', 'gemma3:4b'],
    setSelectedProviderId: providerHook.setSelectedProviderId,
    setSelectedModel: providerHook.setSelectedModel,
  }),
}));
vi.mock('../ui/Toast', () => ({ default: toast }));

import PersistentMindProfileControls from './PersistentMindProfileControls.jsx';

describe('PersistentMindProfileControls capability guidance', () => {
  it('shows runtime capabilities and the local recommendation for the selected model', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    localLlm.getToolUseModels.mockResolvedValue({
      models: [{ providerId: 'ollama', id: 'qwen3.6:35b' }],
    });
    localLlm.getLocalLlmStatus.mockResolvedValue({
      ollama: {
        models: [{ id: 'qwen3.6:35b', capabilities: ['chat', 'tools', 'vision', 'reasoning'] }],
        recommendations: { editorial: { id: 'qwen3.6:35b', reason: 'Best fit for local text work.' } },
      },
      lmstudio: { models: [] },
    });

    render(
      <PersistentMindProfileControls
        profile={{ enabled: true, providerId: 'ollama', model: 'qwen3.6:35b', effort: 'medium', thinkingInterface: 'text' }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('model-capability-summary')).toBeInTheDocument());
    expect(screen.getByLabelText('Chat')).toBeInTheDocument();
    expect(screen.getByLabelText('Tool use')).toBeInTheDocument();
    expect(screen.getByLabelText('Vision')).toBeInTheDocument();
    expect(screen.getByLabelText('Reasoning')).toBeInTheDocument();
    expect(screen.getByText('★ Recommended local model')).toBeInTheDocument();
    expect(screen.getByText('Best fit for local text work.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: /qwen3\.6:35b.*tool use/i })).toBeInTheDocument());
  });

  it('keeps an unpinned model visibly unselected even when the provider has a default', async () => {
    localLlm.getToolUseModels.mockResolvedValue({ models: [] });
    localLlm.getLocalLlmStatus.mockResolvedValue({
      ollama: {
        models: [{ id: 'qwen3.6:35b', capabilities: ['chat', 'tools'] }],
        recommendations: { editorial: { id: 'qwen3.6:35b', reason: 'Best fit for local text work.' } },
      },
      lmstudio: { models: [] },
    });

    render(
      <PersistentMindProfileControls
        profile={{ enabled: true, providerId: 'ollama', model: '', effort: '', thinkingInterface: 'text' }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Choose a provider and model to see capability badges and the available recommendation.')).toBeInTheDocument());
    expect(screen.queryByText('★ Recommended local model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Tool use')).not.toBeInTheDocument();
  });
});
