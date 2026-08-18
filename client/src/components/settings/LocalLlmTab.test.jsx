import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/api', () => ({
  getLocalLlmStatus: vi.fn(),
  getLocalLlmCatalog: vi.fn(),
  getLocalLlmHuggingFaceSearch: vi.fn(),
  installLocalLlmModel: vi.fn(),
  deleteLocalLlmModel: vi.fn(),
  switchLocalLlmBackend: vi.fn(),
  migrateLocalLlmBackend: vi.fn(),
  installLocalLlmBackend: vi.fn(),
  upgradeLocalLlmBackend: vi.fn(),
  controlOllamaService: vi.fn(),
  installAudioModel: vi.fn(),
  patchSettingsSlice: vi.fn(),
}));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
// The memory panel owns its own 5s poll + voice/TTS endpoints — irrelevant here.
vi.mock('./MemoryManagement.jsx', () => ({ default: () => <div data-testid="memory-management" /> }));
// Same for the assessments panel — it fetches its own report on mount and is
// covered by LocalModelAssessments.test.jsx.
vi.mock('./LocalModelAssessments.jsx', () => ({ default: () => <div data-testid="local-model-assessments" /> }));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import { getLocalLlmStatus, getLocalLlmCatalog, patchSettingsSlice } from '../../services/api';
import { LocalLlmTab } from './LocalLlmTab';

// A realistically long HF model id — the shape that got ellipsised to
// "hf.co/sja…" on a phone before the row was allowed to wrap.
const LONG_ID = 'hf.co/example-org/Example-Long-Model-Name-34B-Instruct-GGUF:Q6_K';

const renderTab = async () => {
  render(
    <MemoryRouter>
      <LocalLlmTab />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText(/Installed on Ollama/)).toBeTruthy());
};

beforeEach(() => {
  vi.clearAllMocks();
  getLocalLlmStatus.mockResolvedValue({
    backend: 'ollama',
    ollama: {
      installed: true,
      available: true,
      modelCount: 1,
      models: [{
        id: LONG_ID,
        name: LONG_ID,
        params: '34.7B',
        quantization: 'Q6_K',
        family: 'qwen2',
        size: 30_500_000_000,
        capabilities: ['tools', 'reasoning'],
      }],
    },
    lmstudio: { installed: false, available: false, modelCount: 0, models: [] },
  });
  getLocalLlmCatalog.mockResolvedValue({ models: [] });
  patchSettingsSlice.mockResolvedValue({});
});

describe('LocalLlmTab backend disable state', () => {
  it('suppresses the offline warning and persists the intentional disabled state', async () => {
    getLocalLlmStatus.mockResolvedValue({
      backend: 'lmstudio',
      ollama: { installed: true, available: true, modelCount: 0, models: [] },
      lmstudio: { installed: true, available: false, disabled: false, modelCount: 0, models: [] },
    });
    getLocalLlmStatus.mockResolvedValueOnce({
      backend: 'lmstudio',
      ollama: { installed: true, available: true, modelCount: 0, models: [] },
      lmstudio: { installed: true, available: false, disabled: false, modelCount: 0, models: [] },
    }).mockResolvedValue({
      backend: 'lmstudio',
      ollama: { installed: true, available: true, modelCount: 0, models: [] },
      lmstudio: { installed: true, available: false, disabled: true, modelCount: 0, models: [] },
    });
    await renderTab();
    expect(screen.getByText(/LM Studio isn't running/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Mark LM Studio as intentionally disabled'));
    await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith('localLlm.lmstudio', { disabled: true }));
    await waitFor(() => expect(screen.queryByText(/LM Studio isn't running/)).toBeNull());
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });
});

describe('LocalLlmTab installed models', () => {
  it('links to the shared Ollama generation controls', async () => {
    await renderTab();
    expect(screen.getByRole('link', { name: /temperature and thinking defaults/i }).getAttribute('href')).toBe('/ai');
  });

  it('lets a long model id wrap instead of truncating it', async () => {
    await renderTab();
    const name = screen.getByText(LONG_ID);
    expect(name.className).toMatch(/\bbreak-all\b/);
    expect(name.className).not.toMatch(/\btruncate\b/);
  });

  it('stacks the row on mobile and keeps it inline from sm up', async () => {
    await renderTab();
    // The row is the flex container holding the name; on mobile it stacks so the
    // id gets the full width, and the action row drops beneath it.
    const row = screen.getByText(LONG_ID).closest('.rounded-lg');
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
  });

  it('folds the model size into the wrapping metadata line', async () => {
    await renderTab();
    // Size used to be its own fixed-width column competing with the name; it now
    // rides along with params/quant/family so nothing is squeezed out.
    expect(screen.getByText(/^34\.7B · Q6_K · qwen2 · [\d.]+ GB$/)).toBeTruthy();
  });
});

describe('LocalLlmTab recommendations', () => {
  it('links a gated curated model to Hugging Face so its terms can be accepted', async () => {
    getLocalLlmCatalog.mockResolvedValue({
      models: [{
        id: 'orcarouter/qwen3.8-27b-uncensored-mlx:4bit',
        key: 'qwen3.8-27b-uncensored-mlx',
        name: 'Qwen3.8 27B Uncensored MLX',
        category: 'general',
        recommendedFor: ['general'],
        params: '27B',
        size: '15 GB',
        description: 'A gated local evaluation model.',
        repository: 'orcarouter/Qwen3.8-27B-Uncensored-MLX',
        gated: true,
        capabilities: ['chat'],
      }],
    });

    await renderTab();

    const termsLink = await screen.findByRole('link', { name: 'Accept terms' });
    expect(termsLink).toHaveAttribute('href', 'https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX');
    expect(termsLink).toHaveAttribute('target', '_blank');
  });

  it('highlights the flagship general model and surfaces it in its coding use-case filter', async () => {
    getLocalLlmCatalog.mockResolvedValue({
      models: [{
        id: 'hf.co/unsloth/Qwen3.8-27B-GGUF:Q4_K_M',
        key: 'qwen3.8-27b',
        name: 'Qwen3.8 27B',
        category: 'general',
        recommendedFor: ['general', 'coding', 'reasoning', 'vision', 'multilingual'],
        featured: {
          label: 'Best overall',
          description: 'Flagship local pick for general work, coding and agents, reasoning, and image analysis.',
        },
        params: '27B',
        size: '17 GB',
        description: 'A broad local model.',
        capabilities: ['chat', 'code', 'reasoning', 'tools', 'vision'],
      }],
    });

    await renderTab();

    expect(await screen.findByText('Best overall')).toBeTruthy();
    expect(screen.getAllByText('General purpose').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Coding & agents (1)' }));
    await waitFor(() => expect(screen.getByText('Qwen3.8 27B')).toBeTruthy());
  });
});

describe('LocalLlmTab runtime context window', () => {
  // Ollama picks the runtime window from VRAM; a harness that overruns it dies
  // mid-task, so the card has to make the loaded window visible.
  const withContext = (contextLength) => {
    getLocalLlmStatus.mockResolvedValue({
      backend: 'ollama',
      ollama: { installed: true, available: true, modelCount: 0, models: [], contextLength },
      lmstudio: { installed: false, available: false, modelCount: 0, models: [] },
    });
  };

  it('flags a runtime window below the agent floor', async () => {
    withContext({ runtime: 32768, applied: null, agentMinimum: 65536 });
    await renderTab();
    const badge = screen.getByTitle(/below what an agent harness/);
    expect(badge.textContent).toContain('32K ctx');
    expect(badge.className).toMatch(/text-port-warning/);
  });

  it('shows a generous window without the warning styling', async () => {
    withContext({ runtime: 131072, applied: 131072, agentMinimum: 65536 });
    await renderTab();
    const badge = screen.getByTitle('Loaded models are running at 128K ctx');
    expect(badge.className || '').not.toMatch(/text-port-warning/);
  });

  it('shows nothing while no model is resident — Ollama has not picked a window yet', async () => {
    withContext({ runtime: null, applied: null, agentMinimum: 65536 });
    await renderTab();
    expect(screen.queryByTitle(/Loaded models are running at/)).toBeNull();
  });
});
