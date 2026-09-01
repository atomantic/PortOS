import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

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
  controlLmStudioService: vi.fn(),
  getMtplxServerStatus: vi.fn().mockResolvedValue({ installed: false, running: false, supported: true, cachedModels: [] }),
  startMtplxServer: vi.fn(),
  stopMtplxServer: vi.fn(),
  installMtplx: vi.fn(),
  // The MTPLX card's checkpoint panel loads upstream's default listing on mount.
  searchMtplxModels: vi.fn().mockResolvedValue({ models: [], error: null }),
  pullMtplxModel: vi.fn(),
  removeMtplxModel: vi.fn(),
  saveRuntimeStartupList: vi.fn(),
  installAudioModel: vi.fn(),
  patchSettingsSlice: vi.fn(),
  getLlamaServerStatus: vi.fn().mockResolvedValue({ installed: false, running: false }),
  getLlamaServerUpdateStatus: vi.fn().mockResolvedValue(null),
  startLlamaServer: vi.fn(),
  stopLlamaServer: vi.fn(),
  installLlamaServer: vi.fn().mockResolvedValue({ success: true }),
  upgradeLlamaServer: vi.fn().mockResolvedValue({ success: true, note: 'updated' }),
  downloadSpecDecodeModel: vi.fn(),
  cancelSpecDecodeModelDownload: vi.fn(),
}));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import {
  deleteLocalLlmModel,
  getLocalLlmStatus,
  getLocalLlmCatalog,
  installLocalLlmBackend,
  patchSettingsSlice,
  installLocalLlmModel,
} from '../../services/api';
import socket from '../../services/socket';
import { LocalLlmTab } from './LocalLlmTab';

// A realistically long HF model id — the shape that got ellipsised to
// "hf.co/sja…" on a phone before the row was allowed to wrap.
const LONG_ID = 'hf.co/example-org/Example-Long-Model-Name-34B-Instruct-GGUF:Q6_K';

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

const renderTab = async (view = 'runtimes') => {
  render(
    <MemoryRouter>
      <LocalLlmTab view={view} />
      <LocationProbe />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('id', `llm-management-panel-${view}`));
  if (view === 'library') {
    await waitFor(() => expect(screen.getByText(/Installed on (Ollama|LM Studio)/)).toBeTruthy());
  } else {
    await waitFor(() => expect(screen.getByTitle(/PortOS routes local-LLM runs here by default/)).toBeInTheDocument());
  }
  // The MTPLX checkpoint panel only mounts once the MTPLX status resolves, and
  // it then fetches its default listing — two chained awaits, so flush twice so
  // both state updates land inside act().
  await act(async () => {});
  await act(async () => {});
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
  installLocalLlmBackend.mockResolvedValue({ success: true });
  patchSettingsSlice.mockResolvedValue({});
  deleteLocalLlmModel.mockResolvedValue({ success: true });
});

describe('LocalLlmTab information architecture', () => {
  it('defaults the legacy LLM URL to runtime controls without loading the model catalog', async () => {
    await renderTab();

    expect(screen.getByRole('heading', { name: 'Local Runtime Servers' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Models' })).not.toBeInTheDocument();
    expect(getLocalLlmCatalog).not.toHaveBeenCalled();
  });

  it('gives model installation its own panel without mounting runtime management', async () => {
    const { getLlamaServerStatus, getMtplxServerStatus } = await import('../../services/api');

    await renderTab('library');

    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Local Runtime Servers' })).not.toBeInTheDocument();
    expect(getLlamaServerStatus).not.toHaveBeenCalled();
    expect(getMtplxServerStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(getLocalLlmCatalog).toHaveBeenCalled());
  });

  it('navigates between the focused panels with a shareable URL', async () => {
    await renderTab();

    fireEvent.click(screen.getByRole('tab', { name: 'Model Library' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/models/llms/library');
  });
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
    fireEvent.click(screen.getByTitle('Mark LM Studio as intentionally disabled'));
    await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith('localLlm.lmstudio', { disabled: true }));
    await waitFor(() => expect(screen.getByText('Disabled')).toBeInTheDocument());
  });
});

describe('LocalLlmTab runtime servers', () => {
  it('installs a missing catalog backend at the blocker without sending the user to a terminal', async () => {
    getLocalLlmStatus.mockResolvedValue({
      backend: 'ollama',
      ollama: {
        installed: false,
        available: false,
        canAutoInstall: true,
        modelCount: 0,
        models: [],
      },
      lmstudio: { installed: true, available: true, modelCount: 0, models: [] },
    });

    await renderTab('library');

    const blocker = screen.getByText("Ollama isn't installed yet.").closest('div');
    expect(within(blocker).queryByText(/npm run setup:llm/)).toBeNull();

    fireEvent.click(within(blocker).getByRole('button', { name: 'Install Ollama' }));

    await waitFor(() => expect(installLocalLlmBackend).toHaveBeenCalledWith('ollama'));
  });

  it('offers the vendor download when PortOS cannot auto-install the backend', async () => {
    getLocalLlmStatus.mockResolvedValue({
      backend: 'lmstudio',
      ollama: { installed: true, available: true, modelCount: 0, models: [] },
      lmstudio: {
        installed: false,
        available: false,
        canAutoInstall: false,
        downloadUrl: 'https://lmstudio.ai/download',
        modelCount: 0,
        models: [],
      },
    });

    await renderTab('library');

    const blocker = screen.getByText("LM Studio isn't installed yet.").closest('div');
    expect(within(blocker).queryByRole('button', { name: 'Install LM Studio' })).toBeNull();
    expect(within(blocker).getByRole('link', { name: 'Download LM Studio' }))
      .toHaveAttribute('href', 'https://lmstudio.ai/download');
  });

  it('mounts one control surface covering every local runtime, not just the catalog backends', async () => {
    await renderTab();
    const card = screen.getByRole('heading', { name: 'Local Runtime Servers' }).closest('div.bg-port-card');
    for (const label of ['Ollama', 'LM Studio', 'llama.cpp', 'MTPLX']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
  });

  // MTPLX starts on demand — the first request routed to it brings it up — and
  // also offers an explicit start when its checkpoint is already cached.
  it('offers MTPLX Start on the unified runtime surface', async () => {
    const { getMtplxServerStatus, startMtplxServer } = await import('../../services/api');
    getMtplxServerStatus.mockResolvedValue({
      installed: true, running: false, supported: true, cachedModels: ['Example/Qwen-MTP'], endpoint: 'http://127.0.0.1:8000/v1',
    });
    startMtplxServer.mockResolvedValue({ online: true });

    await renderTab();
    const card = screen.getByRole('heading', { name: 'Local Runtime Servers' }).closest('div.bg-port-card');
    const mtplxRow = within(card).getByText('MTPLX').closest('div.flex.flex-col');

    fireEvent.click(within(mtplxRow).getByRole('button', { name: /^Start/ }));
    await waitFor(() => expect(startMtplxServer).toHaveBeenCalledWith({}));
  });

  it('saves an idle window through the settings slice for that runtime', async () => {
    const { getLlamaServerStatus, patchSettingsSlice } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue({ installed: true, running: true, idleMinutes: 0, config: {} });

    await renderTab();
    const card = screen.getByRole('heading', { name: 'Local Runtime Servers' }).closest('div.bg-port-card');
    const llamaRow = within(card).getByText('llama.cpp').closest('div.flex.flex-col');
    const field = within(llamaRow).getByLabelText('Idle release');
    fireEvent.change(field, { target: { value: '30' } });
    fireEvent.blur(field);

    await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith('localLlm.llama', { idleMinutes: 30 }));
  });

  it('reports a failed checkpoint download as one error, not an empty success', async () => {
    // `pullMtplxModel` RESOLVES `{success: false}` for a failed download (its
    // progress already streamed), so a formatter-only success message would fire
    // an empty success toast alongside the real reason.
    const { getMtplxServerStatus, pullMtplxModel } = await import('../../services/api');
    const toast = (await import('../ui/Toast')).default;
    getMtplxServerStatus.mockResolvedValue({
      installed: true, running: false, supported: true, cachedModels: [], cacheError: null,
    });
    pullMtplxModel.mockResolvedValue({ success: false, model: null, error: 'no space left on device' });

    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Download default checkpoint/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/no space left on device/)));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('downloads MTPLX\'s own default checkpoint when the cache is empty', async () => {
    const { getMtplxServerStatus, pullMtplxModel } = await import('../../services/api');
    getMtplxServerStatus.mockResolvedValue({
      installed: true, running: false, supported: true, cachedModels: [], cacheError: null,
    });
    pullMtplxModel.mockResolvedValue({ success: true, model: null, cachedModels: ['Example/Qwen-MTP'] });

    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Download default checkpoint/ }));

    // `null` (not a repo id the card invented) = MTPLX's own verified default.
    await waitFor(() => expect(pullMtplxModel).toHaveBeenCalledWith(null));
  });

  it('saves the PM2 process list so the managed daemons survive a reboot', async () => {
    const { saveRuntimeStartupList } = await import('../../services/api');
    saveRuntimeStartupList.mockResolvedValue({ success: true });

    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Save PM2 list for reboot/ }));

    await waitFor(() => expect(saveRuntimeStartupList).toHaveBeenCalled());
  });
});

describe('LocalLlmTab installed models', () => {
  it('links to the shared local generation controls', async () => {
    await renderTab();
    expect(screen.getByRole('link', { name: /temperature, top-p and thinking defaults/i }).getAttribute('href')).toBe('/ai');
  });

  it('lets a long model id wrap instead of truncating it', async () => {
    await renderTab('library');
    const name = screen.getByText(LONG_ID);
    expect(name.className).toMatch(/\bbreak-all\b/);
    expect(name.className).not.toMatch(/\btruncate\b/);
  });

  it('stacks the row on mobile and keeps it inline from sm up', async () => {
    await renderTab('library');
    // The row is the flex container holding the name; on mobile it stacks so the
    // id gets the full width, and the action row drops beneath it.
    const row = screen.getByText(LONG_ID).closest('.rounded-lg');
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
  });

  it('folds the model size into the wrapping metadata line', async () => {
    await renderTab('library');
    // Size used to be its own fixed-width column competing with the name; it now
    // rides along with params/quant/family so nothing is squeezed out.
    expect(screen.getByText(/^34\.7B · Q6_K · qwen2 · [\d.]+ GB$/)).toBeTruthy();
  });

  it('redownloads an installed model instead of requiring delete-then-install', async () => {
    installLocalLlmModel.mockResolvedValue({ success: true });
    await renderTab('library');
    fireEvent.click(screen.getByRole('button', { name: `Redownload ${LONG_ID}` }));
    await waitFor(() => expect(installLocalLlmModel).toHaveBeenCalledWith(
      'ollama',
      LONG_ID,
      expect.objectContaining({ force: true, silent: true }),
    ));
  });

  it('limits comparisons to six models and navigates with those targets', async () => {
    const models = Array.from({ length: 7 }, (_, index) => ({
      id: `example-model-${index + 1}`,
      name: `Example model ${index + 1}`,
    }));
    getLocalLlmStatus.mockResolvedValue({
      backend: 'ollama',
      ollama: { installed: true, available: true, modelCount: models.length, models },
      lmstudio: { installed: false, available: false, modelCount: 0, models: [] },
    });
    const toast = (await import('../ui/Toast')).default;

    await renderTab('library');
    for (const model of models.slice(0, 6)) {
      fireEvent.click(screen.getByRole('checkbox', { name: `Select ${model.name} for comparison` }));
    }
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${models[6].name} for comparison` }));
    expect(toast.error).toHaveBeenCalledWith('Compare up to 6 models at once');

    fireEvent.click(screen.getByRole('button', { name: /Compare selected/ }));
    const location = screen.getByTestId('location').textContent;
    expect(location).toMatch(/^\/local-llm\/playground\?/);
    const targets = JSON.parse(new URLSearchParams(location.split('?')[1]).get('targets'));
    expect(targets).toEqual(models.slice(0, 6).map((model) => ({ backend: 'ollama', modelId: model.id })));
  }, 10_000);

  it('requires inline confirmation before deleting an installed model', async () => {
    await renderTab('library');
    fireEvent.click(screen.getByRole('button', { name: `Delete ${LONG_ID}` }));
    expect(screen.getByText('Delete?')).toBeInTheDocument();
    expect(deleteLocalLlmModel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteLocalLlmModel).toHaveBeenCalledWith('ollama', LONG_ID));
  });

  it('tags an LM Studio installed model with its quantization so redownload can evict that GGUF', async () => {
    installLocalLlmModel.mockResolvedValue({ success: true });
    getLocalLlmStatus.mockResolvedValue({
      backend: 'lmstudio',
      ollama: { installed: false, available: false, modelCount: 0, models: [] },
      lmstudio: {
        installed: true,
        available: true,
        modelCount: 1,
        models: [{
          id: 'unsloth/Qwen3.8-27B-GGUF',
          name: 'Qwen3.8 27B',
          quantization: 'UD-Q4_K_M',
        }],
      },
    });
    render(
      <MemoryRouter>
        <LocalLlmTab view="library" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Installed on LM Studio/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Redownload Qwen3.8 27B' }));
    await waitFor(() => expect(installLocalLlmModel).toHaveBeenCalledWith(
      'lmstudio',
      'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M',
      expect.objectContaining({ force: true }),
    ));
  });

  it('hides redownload when LM Studio did not report a quantization', async () => {
    getLocalLlmStatus.mockResolvedValue({
      backend: 'lmstudio',
      ollama: { installed: false, available: false, modelCount: 0, models: [] },
      lmstudio: {
        installed: true,
        available: true,
        modelCount: 1,
        models: [{ id: 'unsloth/Qwen3.8-27B-GGUF', name: 'Qwen3.8 27B' }],
      },
    });
    render(
      <MemoryRouter>
        <LocalLlmTab view="library" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Installed on LM Studio/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Redownload/ })).toBeNull();
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

    await renderTab('library');

    const termsLink = await screen.findByRole('link', { name: 'Accept terms' });
    expect(termsLink).toHaveAttribute('href', 'https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX');
    expect(termsLink).toHaveAttribute('target', '_blank');
  });

  it('highlights the flagship general model and surfaces it in its coding use-case filter', async () => {
    getLocalLlmCatalog.mockResolvedValue({
      models: [{
        id: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
        key: 'qwen3.8-27b',
        name: 'Qwen3.8 27B',
        category: 'general',
        recommendedFor: ['general', 'coding', 'reasoning', 'vision', 'multilingual'],
        featured: {
          label: 'Best Qwen3.8 path',
          description: 'For Qwen3.8 CoS tasks, use MTPLX + OpenCode MTPLX TUI; use native MLX when isolated decoder throughput or vision is the priority.',
        },
        params: '27B',
        size: '16.5 GB',
        description: 'A broad local model.',
        note: 'Dynamic 3.0 is baked into the GGUF files — re-download if you already have an older Unsloth Qwen3.8 build.',
        repository: 'unsloth/Qwen3.8-27B-GGUF',
        capabilities: ['chat', 'code', 'reasoning', 'tools', 'vision'],
      }],
    });

    await renderTab('library');

    expect(await screen.findByText('Best Qwen3.8 path')).toBeTruthy();
    expect(screen.getAllByText('General purpose').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Coding & agents (1)' }));
    await waitFor(() => expect(screen.getByText('Qwen3.8 27B')).toBeTruthy());
  });

  it('offers redownload on an already-installed catalog card', async () => {
    installLocalLlmModel.mockResolvedValue({ success: true });
    getLocalLlmCatalog.mockResolvedValue({
      models: [{
        id: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
        key: 'qwen3.8-27b',
        name: 'Qwen3.8 27B',
        installed: true,
        category: 'general',
        recommendedFor: ['general'],
        params: '27B',
        size: '16.5 GB',
        description: 'A broad local model.',
        capabilities: ['chat'],
      }],
    });
    await renderTab('library');
    expect(await screen.findByText('Qwen3.8 27B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Redownload$/ }));
    await waitFor(() => expect(installLocalLlmModel).toHaveBeenCalledWith(
      'ollama',
      'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
      expect.objectContaining({ force: true }),
    ));
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

describe('LocalLlmTab measured fit badge', () => {
  const catalogEntry = (overrides = {}) => ({
    key: 'example-14b',
    id: 'example-model:14b',
    name: 'Example 14B',
    params: '14B',
    description: 'An example instruct model.',
    category: 'general',
    size: '9 GB',
    sizeBytes: 9_000_000_000,
    source: 'catalog',
    ...overrides,
  });

  it('marks a measured verdict as measured and keeps the estimate it overruled in the tooltip', async () => {
    getLocalLlmCatalog.mockResolvedValue({
      models: [catalogEntry({
        fit: 'too-large',
        fitSource: 'measured',
        estimatedFit: 'comfortable',
        measuredFit: 'too-large',
        disagrees: true,
        assessedAt: '2026-01-02T00:00:00.000Z',
      })],
    });
    await renderTab('library');

    const badge = await screen.findByText(/exceeds RAM \(measured\)/);
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title')).toMatch(/Measured on this machine/);
    // The disagreement is the point — the reader must see what the estimate claimed.
    expect(badge.getAttribute('title')).toMatch(/fits comfortably/);
  });

  it('labels an unmeasured verdict as the estimate it is', async () => {
    getLocalLlmCatalog.mockResolvedValue({ models: [catalogEntry({ fit: 'comfortable', fitSource: 'estimated', estimatedFit: 'comfortable', measuredFit: null })] });
    await renderTab('library');

    const badge = await screen.findByText('fits comfortably');
    expect(badge.getAttribute('title')).toMatch(/Estimated fit/);
    expect(badge.textContent).not.toMatch(/measured/);
  });

  it('renders the measurement-only verdict the size estimate can never produce', async () => {
    // No amount of free RAM fixes a backend refusing a model, so `incompatible`
    // only ever comes from a real run.
    getLocalLlmCatalog.mockResolvedValue({ models: [catalogEntry({ fit: 'incompatible', fitSource: 'measured', estimatedFit: 'comfortable', measuredFit: 'incompatible', disagrees: true })] });
    await renderTab('library');

    expect(await screen.findByText(/backend refused it \(measured\)/)).toBeInTheDocument();
  });
});

// The launcher presets (and their weights' on-disk state) come from the server
// on the llama-server status response — the component holds no copy.
const specPresets = ({ baseExists = true, draftExists = true } = {}) => ([
  {
    id: 'qwen3.8-27b-dspark',
    label: 'Qwen 3.8 27B + DSpark Drafter (Recommended — stock llama.cpp)',
    specType: 'draft-dspark',
    model: {
      role: 'model',
      path: 'models/Qwen3.8-27B-Instruct-Q4_K_M.gguf',
      exists: baseExists,
      sizeBytes: baseExists ? 17_000_000_000 : null,
      repo: 'unsloth/Qwen3.8-27B-GGUF',
      repoUrl: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF',
      downloadable: true,
      downloading: false,
    },
    draftModel: {
      role: 'draftModel',
      path: 'models/Qwen3.8-27B-DSpark-bf16.gguf',
      exists: draftExists,
      sizeBytes: draftExists ? 1_200_000_000 : null,
      repo: 'magnitudedev/Qwen3.8-27B-DSpark-GGUF',
      repoUrl: 'https://huggingface.co/magnitudedev/Qwen3.8-27B-DSpark-GGUF',
      downloadable: true,
      downloading: false,
    },
  },
  {
    id: 'qwen3-8b-dspark',
    label: 'Qwen 3 8B + DSpark Drafter (small target)',
    specType: 'draft-dspark',
    model: {
      role: 'model',
      path: 'models/Qwen3-8B-Instruct-Q4_K_M.gguf',
      exists: true,
      sizeBytes: 5_000_000_000,
      repo: 'Qwen/Qwen3-8B-Instruct-GGUF',
      repoUrl: 'https://huggingface.co/Qwen/Qwen3-8B-Instruct-GGUF',
      downloadable: true,
      downloading: false,
    },
    // The 8B DSpark block ships as a tokenizer-less checkpoint that has to be
    // converted against its target — no single-file GGUF to fetch, so this row
    // has to link out instead of offering a button.
    draftModel: {
      role: 'draftModel',
      path: 'models/dspark_qwen3_8b_block7-bf16.gguf',
      exists: false,
      sizeBytes: null,
      repo: null,
      repoUrl: 'https://huggingface.co/models?search=dspark_qwen3_8b_block7-bf16',
      downloadable: false,
      downloading: false,
    },
  },
  { id: 'custom', label: 'Custom GGUF / Manual Paths', specType: 'draft-dspark', model: null, draftModel: null },
]);

const llamaReady = (overrides = {}) => ({
  installed: true,
  running: false,
  managed: false,
  presets: specPresets(),
  ...overrides,
});

describe('LocalLlmTab llama-server management', () => {
  // `vi.clearAllMocks()` clears calls but NOT queued `mockResolvedValueOnce`
  // values or implementations, so a test that queues one more than the
  // component consumes leaks it into the next test's first status read. Reset
  // the mock outright here and give it a sane standing default.
  beforeEach(async () => {
    const { getLlamaServerStatus, getLlamaServerUpdateStatus } = await import('../../services/api');
    getLlamaServerStatus.mockReset();
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    getLlamaServerUpdateStatus.mockReset();
    getLlamaServerUpdateStatus.mockResolvedValue(null);
  });

  it('renders start form and launches server when llama-server is installed', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 12345 });

    await renderTab();

    expect(await screen.findByText(/Launch Speculative Decoding Server/)).toBeInTheDocument();
    const modelInput = screen.getByPlaceholderText(/models\/Qwen3\.8-27B-Instruct/);
    fireEvent.change(modelInput, { target: { value: 'models/my-model.gguf' } });

    const startBtn = screen.getByRole('button', { name: /Start Speculative Server/ });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(startLlamaServer).toHaveBeenCalledWith(expect.objectContaining({
        model: 'models/my-model.gguf',
      }));
    });
  });

  it('sends --parallel 1 by default and honours an edited slot count', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 99 });

    await renderTab();
    await screen.findByText(/Launch Speculative Decoding Server/);
    await waitFor(() => expect(screen.queryByText(/Enter a Target Base Model path to enable Start/)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Advanced options/ }));
    fireEvent.change(screen.getByLabelText('Parallel slots'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Speculative Server/ }));

    await waitFor(() => expect(startLlamaServer).toHaveBeenCalled());
    expect(startLlamaServer.mock.calls[0][0].parallel).toBe(2);
  });

  // An untouched tuning field means "llama.cpp's default", which is not a value
  // PortOS can name. Sending `''` (which the server coerces to 0) or a made-up
  // number would pin a setting the user never chose and make two "default"
  // launches incomparable.
  it('omits an untouched tuning flag from the launch payload entirely', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 99 });

    await renderTab();
    await screen.findByText(/Launch Speculative Decoding Server/);
    await waitFor(() => expect(screen.queryByText(/Enter a Target Base Model path to enable Start/)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Advanced options/ }));
    fireEvent.change(screen.getByLabelText('Micro-batch (-ub)'), { target: { value: '512' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Speculative Server/ }));

    await waitFor(() => expect(startLlamaServer).toHaveBeenCalled());
    const payload = startLlamaServer.mock.calls[0][0];
    expect(payload.ubatchSize).toBe(512);
    for (const untouched of ['batchSize', 'threads', 'cacheTypeK', 'cacheTypeV']) {
      expect(payload, untouched).not.toHaveProperty(untouched);
    }
    // A boolean has no "unset" spelling, so it does travel — as `false`, which
    // is what leaves `--flash-attn` off the line.
    expect(payload.flashAttn).toBe(false);
  });

  // The preset select mounts pre-selected, so the form must mount pre-filled too —
  // otherwise Start is disabled while the UI reads as fully configured.
  it('seeds the form from the mounted preset so Start is immediately usable', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 4242 });

    await renderTab();

    await screen.findByText(/Launch Speculative Decoding Server/);
    // Same effect-ordering caveat as above, from the other side: wait for the
    // seeded form rather than asserting the warning is already gone.
    await waitFor(() => expect(screen.queryByText(/Enter a Target Base Model path to enable Start/)).toBeNull());

    const startBtn = screen.getByRole('button', { name: /Start Speculative Server/ });
    expect(startBtn).not.toBeDisabled();
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(startLlamaServer).toHaveBeenCalledWith(expect.objectContaining({
        model: 'models/Qwen3.8-27B-Instruct-Q4_K_M.gguf',
        draftModel: 'models/Qwen3.8-27B-DSpark-bf16.gguf',
        specType: 'draft-dspark',
        parallel: 1,
      }));
    });
  });

  it('explains why Start is disabled once the model path is cleared', async () => {
    const { getLlamaServerStatus } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());

    await renderTab();

    const modelInput = await screen.findByLabelText(/Target Base Model \(GGUF Path\)/);
    fireEvent.change(modelInput, { target: { value: '  ' } });

    const startBtn = screen.getByRole('button', { name: /Start Speculative Server/ });
    expect(startBtn).toBeDisabled();
    expect(startBtn).toHaveAttribute('title', expect.stringContaining('required'));
    expect(screen.getByText(/Enter a Target Base Model path to enable Start/)).toBeInTheDocument();
  });

  it('swaps the preset and repoints both model paths', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 7 });

    await renderTab();

    const presetSelect = await screen.findByLabelText('Preset');
    fireEvent.change(presetSelect, { target: { value: 'qwen3-8b-dspark' } });

    expect(screen.getByLabelText(/Target Base Model \(GGUF Path\)/))
      .toHaveValue('models/Qwen3-8B-Instruct-Q4_K_M.gguf');
    expect(screen.getByLabelText(/Draft Model \(Optional\)/))
      .toHaveValue('models/dspark_qwen3_8b_block7-bf16.gguf');

    // This preset's drafter isn't on disk, so Start stays blocked until the
    // user downloads it (or clears the field) — that is the launcher contract,
    // not an incidental fixture detail.
    expect(screen.getByRole('button', { name: /Start Speculative Server/ })).toBeDisabled();
    expect(startLlamaServer).not.toHaveBeenCalled();
  });

  // Coercing a number input on every keystroke snaps it back to its default the
  // moment you clear it to retype, so the default is applied at launch instead.
  it('lets an advanced number field sit empty while retyping and defaults it at launch', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 21 });

    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Advanced options/ }));
    const gpuLayers = screen.getByLabelText(/GPU Layers/);
    fireEvent.change(gpuLayers, { target: { value: '' } });
    expect(gpuLayers).toHaveValue(null);

    fireEvent.click(screen.getByRole('button', { name: /Start Speculative Server/ }));

    await waitFor(() => {
      expect(startLlamaServer).toHaveBeenCalledWith(expect.objectContaining({ nGpuLayers: 99 }));
    });
  });

  it('keeps an explicit -ngl 0 rather than treating it as unset', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 22 });

    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Advanced options/ }));
    fireEvent.change(screen.getByLabelText(/GPU Layers/), { target: { value: '0' } });

    fireEvent.click(screen.getByRole('button', { name: /Start Speculative Server/ }));

    await waitFor(() => {
      expect(startLlamaServer).toHaveBeenCalledWith(expect.objectContaining({ nGpuLayers: 0 }));
    });
  });

  it('lets the user set the model id llama.cpp will answer as', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    startLlamaServer.mockResolvedValueOnce({ success: true, pid: 23 });

    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Advanced options/ }));
    fireEvent.change(screen.getByLabelText(/Model id \(alias\)/), { target: { value: 'dspark' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Speculative Server/ }));

    await waitFor(() => {
      expect(startLlamaServer).toHaveBeenCalledWith(expect.objectContaining({ alias: 'dspark' }));
    });
  });

  it('drops the preset label to Custom once a preset-supplied path is hand-edited', async () => {
    const { getLlamaServerStatus } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());

    await renderTab();

    const presetSelect = await screen.findByLabelText('Preset');
    expect(presetSelect).toHaveValue('qwen3.8-27b-dspark');

    fireEvent.change(screen.getByLabelText(/Target Base Model \(GGUF Path\)/), {
      target: { value: 'models/hand-picked.gguf' },
    });

    expect(presetSelect).toHaveValue('custom');
  });

  // The whole point of the weights rows: a missing GGUF used to surface only as
  // a 400 from Start ("The base model was not found at `models/…`") with no
  // stated way to fix it.
  it('offers a download button for a preset GGUF that is not on disk', async () => {
    const { getLlamaServerStatus, downloadSpecDecodeModel } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady({ presets: specPresets({ baseExists: false }) }));
    downloadSpecDecodeModel.mockResolvedValueOnce({ success: true, path: 'models/Qwen3.8-27B-Instruct-Q4_K_M.gguf' });

    await renderTab();

    await screen.findByText(/Launch Speculative Decoding Server/);
    // The drafter IS on disk, so exactly one row offers a download.
    expect(screen.getByText(/Downloaded \(1\.1 GB\)/)).toBeInTheDocument();
    const downloadBtn = screen.getByRole('button', { name: /^Download$/ });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(downloadSpecDecodeModel).toHaveBeenCalledWith('qwen3.8-27b-dspark', 'model', { silent: true });
    });
  });

  // A dropped request (reload, proxy idle timeout) does not stop the transfer —
  // reporting it as a failure sends the user hunting a problem that isn't there.
  it('reports a lost request as still-running when the server is still downloading', async () => {
    const { getLlamaServerStatus, downloadSpecDecodeModel } = await import('../../services/api');
    const toast = (await import('../ui/Toast')).default;
    const downloading = specPresets({ baseExists: false });
    downloading[0].model.downloading = true;
    // No queued `…Once` values anywhere in this block: a refresh from a
    // finished test can land during the next one and eat a queued entry, which
    // is how this suite went order-dependent. Flip on call count instead.
    let statusCalls = 0;
    getLlamaServerStatus.mockImplementation(async () => {
      statusCalls += 1;
      return llamaReady({ presets: statusCalls === 1 ? specPresets({ baseExists: false }) : downloading });
    });
    downloadSpecDecodeModel.mockRejectedValueOnce(new Error('Failed to fetch'));

    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /^Download$/ }));

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/still running in the background/));
    });
    expect(toast.error).not.toHaveBeenCalled();
    // Mount + the catch's check + the finally's refresh.
    await waitFor(() => expect(getLlamaServerStatus).toHaveBeenCalledTimes(3));
  });

  it('offers Cancel for a running preset download and calls the cancel endpoint', async () => {
    const { getLlamaServerStatus, cancelSpecDecodeModelDownload } = await import('../../services/api');
    const downloading = specPresets({ baseExists: false });
    downloading[0].model.downloading = true;
    getLlamaServerStatus.mockResolvedValue(llamaReady({ presets: downloading }));
    cancelSpecDecodeModelDownload.mockResolvedValue({ success: true, cancelled: true });

    await renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }));

    await waitFor(() => {
      expect(cancelSpecDecodeModelDownload).toHaveBeenCalledWith('qwen3.8-27b-dspark', 'model', { silent: true });
    });
  });

  it('blocks Start while a preset GGUF is missing and names the fix', async () => {
    const { getLlamaServerStatus, startLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady({ presets: specPresets({ baseExists: false }) }));

    await renderTab();

    // `findBy…` on the warning itself: the form is seeded from the presets in
    // an effect, so the Start button can render a tick before the gate that
    // disables it — asserting the button first makes this order-dependent.
    expect(await screen.findByText('Download the base model to enable Start')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start Speculative Server/ })).toBeDisabled();
    expect(startLlamaServer).not.toHaveBeenCalled();
  });

  // A drafter with no published single-file GGUF has no Download button — the
  // row must send the user somewhere rather than offering an action that 400s.
  it('links out when a drafter has no automatic Hugging Face source', async () => {
    const { getLlamaServerStatus } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());

    await renderTab();

    const presetSelect = await screen.findByLabelText('Preset');
    fireEvent.change(presetSelect, { target: { value: 'qwen3-8b-dspark' } });

    const link = screen.getByRole('link', { name: /Find on Hugging Face/ });
    expect(link).toHaveAttribute('href', 'https://huggingface.co/models?search=dspark_qwen3_8b_block7-bf16');
  });

  it('renders install button and triggers install when llama-server is not installed', async () => {
    const { getLlamaServerStatus, installLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue({ installed: false, running: false, managed: false, presets: specPresets() });

    await renderTab();

    const installBtn = await screen.findByRole('button', { name: /Install llama\.cpp/ });
    expect(installBtn).toBeInTheDocument();
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(installLlamaServer).toHaveBeenCalled();
    });
  });

  it('updates llama.cpp from the unified runtime row', async () => {
    const { getLlamaServerStatus, getLlamaServerUpdateStatus, upgradeLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue(llamaReady());
    getLlamaServerUpdateStatus.mockResolvedValueOnce({
      version: '0.1.1-dev',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: true,
      downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases',
    });
    upgradeLlamaServer.mockResolvedValueOnce({ success: true, note: 'updated and restarted' });

    await renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Update to v0.3.0' }));

    await waitFor(() => {
      expect(upgradeLlamaServer).toHaveBeenCalledWith();
    });
  });

  it('renders running badge and stops server when llama-server is managed', async () => {
    const { getLlamaServerStatus, stopLlamaServer } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue({
      installed: true,
      running: true,
      managed: true,
      presets: specPresets(),
      pid: 9999,
      endpoint: 'http://127.0.0.1:5568/v1',
      config: { model: 'models/base.gguf', draftModel: 'models/draft.gguf', specType: 'draft-dflash', alias: 'dflash' },
    });
    stopLlamaServer.mockResolvedValueOnce({ success: true });

    await renderTab();

    expect(await screen.findByText(/Running \(PID 9999\)/)).toBeInTheDocument();
    expect(screen.getByText(/Providers must send/)).toBeInTheDocument();
    expect(screen.getByText('dflash')).toBeInTheDocument();
    const stopBtn = screen.getByRole('button', { name: /Stop Server/ });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      expect(stopLlamaServer).toHaveBeenCalled();
    });
  });

  // `managed` has three states: `true` ours, `false` somebody else's, `null`
  // PM2 could not be read. A truthiness test told a user whose own daemon
  // PortOS had merely failed to read that they had started it in a terminal.
  it('does not call a server external when PM2 could not be read', async () => {
    const { getLlamaServerStatus } = await import('../../services/api');
    getLlamaServerStatus.mockResolvedValue({
      installed: true,
      running: true,
      managed: null,
      presets: specPresets(),
      pid: null,
      endpoint: 'http://127.0.0.1:5568/v1',
      config: { model: 'models/base.gguf', specType: 'draft-dflash', alias: 'dflash' },
    });

    await renderTab();

    expect(await screen.findByText(/PM2 status could not be read/)).toBeInTheDocument();
    expect(screen.queryByText(/Running as external process/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop Server/ })).not.toBeInTheDocument();
  });

  // `localLlm:progress` is shared with the measurement paths, and an overnight
  // sweep emits a `complete` frame PER MODEL. Answering those here would reload
  // the status and re-query the Hugging Face catalog once per measured model,
  // all night, and paint sweep text into the install banner.
  describe('shared progress channel', () => {
    const fireFrame = async (frame) => {
      const handler = socket.on.mock.calls.find(([event]) => event === 'localLlm:progress')?.[1];
      await act(async () => handler(frame));
    };

    it('ignores assessment and sweep frames on the shared progress event', async () => {
      await renderTab();
      const catalogCalls = getLocalLlmCatalog.mock.calls.length;

      await fireFrame({ scope: 'assessment', event: 'complete', message: 'example-model: fits' });
      await fireFrame({ scope: 'assessment-sweep', event: 'complete', message: 'Sweep complete: 30/30 measured' });

      expect(getLocalLlmCatalog.mock.calls.length).toBe(catalogCalls);
      expect(screen.queryByText(/Sweep complete/)).not.toBeInTheDocument();
    });

    it('still answers the install frames this tab owns', async () => {
      await renderTab();
      await fireFrame({ event: 'progress', message: 'pulling manifest' });
      expect(await screen.findByText(/pulling manifest/)).toBeInTheDocument();
    });
  });
});
