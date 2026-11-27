import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiLocalLlm.js', () => ({
  getLocalPersistentMindSetup: vi.fn(),
  applyLocalPersistentMindSetup: vi.fn(),
  installLocalLlmBackend: vi.fn(),
  installLocalLlmModel: vi.fn(),
  controlOllamaService: vi.fn(),
}));
vi.mock('../ui/Toast');

import { getLocalPersistentMindSetup, applyLocalPersistentMindSetup, installLocalLlmModel } from '../../services/apiLocalLlm.js';
import toast from '../ui/Toast';
import LocalPersistentMindSetupCard from './LocalPersistentMindSetupCard.jsx';

const applicableSetup = {
  applicable: true,
  ready: false,
  recommendation: {
    machine: 'CPU-only host (~16 GB RAM)',
    modelLabel: 'Qwen2.5 7B Instruct (Q4)',
    runtime: 'Ollama',
    mindRole: 'Persistent Mind (free, local, tool-capable)',
    codingHarnesses: 'Cursor Agent / OpenCode Zen (cloud CLIs) for coding tasks',
    topology: 'Local Ollama Persistent Mind + cloud coding CLIs',
    note: 'Default for Grok Bot boxes and other CPU-only / no-GPU installs.',
    alternatives: 'Do not enable vLLM or Qwen3.8-27B presets on this host.',
    warnings: ['This host has no usable NVIDIA GPU — inference runs on CPU and will be slower than a GPU box.'],
  },
  steps: [
    { id: 'recommendation', status: 'ready', detail: 'recommended' },
    { id: 'ollama-installed', status: 'ready', detail: 'Ollama CLI is on PATH.' },
    { id: 'ollama-running', status: 'ready', detail: 'Ollama daemon is answering.' },
    {
      id: 'model-present',
      status: 'todo',
      detail: 'Pull qwen2.5:7b-instruct',
      action: { kind: 'pull-model', backend: 'ollama', modelId: 'qwen2.5:7b-instruct', label: 'Pull' },
    },
    { id: 'provider-enabled', status: 'todo', detail: 'Enable provider' },
    { id: 'mind-profile', status: 'todo', detail: 'Optionally pin mind' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getLocalPersistentMindSetup.mockResolvedValue(applicableSetup);
  applyLocalPersistentMindSetup.mockResolvedValue({
    success: true,
    profile: { enabled: true, providerId: 'ollama', model: 'qwen2.5:7b-instruct' },
  });
});

describe('LocalPersistentMindSetupCard', () => {
  it('renders the Grok-box topology and guardrails when applicable', async () => {
    render(
      <MemoryRouter>
        <LocalPersistentMindSetupCard />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: /free local persistent mind/i })).toBeTruthy();
    expect(screen.getAllByText(/Grok Bot boxes/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Cursor Agent \/ OpenCode Zen/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/no usable NVIDIA GPU/i)).toBeTruthy();
    expect(screen.getByText(/Do not enable vLLM or Qwen3.8-27B/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /pull qwen2\.5 7b instruct/i })).toBeTruthy();
  });

  it('renders nothing when the host is outside the free local-mind path', async () => {
    getLocalPersistentMindSetup.mockResolvedValue({ applicable: false, recommendation: null, steps: [] });
    const { container } = render(
      <MemoryRouter>
        <LocalPersistentMindSetupCard />
      </MemoryRouter>,
    );
    await waitFor(() => expect(getLocalPersistentMindSetup).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="local-persistent-mind-setup"]')).toBeNull();
  });

  it('leaves the pull available when the download is canceled', async () => {
    const onApplied = vi.fn();
    installLocalLlmModel.mockResolvedValueOnce({ status: 'canceled', canceled: true, modelId: 'qwen2.5:7b-instruct' });
    render(
      <MemoryRouter>
        <LocalPersistentMindSetupCard onApplied={onApplied} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /pull qwen2\.5 7b instruct/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /pull qwen2\.5 7b instruct/i })).toBeEnabled());
    expect(toast.info).toHaveBeenCalledWith('Model download canceled');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('applies the mind profile pin when requested', async () => {
    const onApplied = vi.fn();
    render(
      <MemoryRouter>
        <LocalPersistentMindSetupCard onApplied={onApplied} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: /free local persistent mind/i });
    fireEvent.click(screen.getByRole('button', { name: /enable provider \+ set mind profile/i }));
    await waitFor(() => expect(applyLocalPersistentMindSetup).toHaveBeenCalledWith(
      { setMindProfile: true },
      { silent: true },
    ));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });
});
