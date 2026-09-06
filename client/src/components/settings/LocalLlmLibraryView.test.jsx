import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../services/api', () => ({
  getLocalLlmStatus: vi.fn(),
  getSystemCapabilities: vi.fn(),
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
  getSlotstreamServerStatus: vi.fn().mockResolvedValue({ installed: false, running: false, supported: true, cachedModels: [], memoryPlan: { targetGb: 22, expectedPeakGb: 22, expectedWarmDecodeToks: 8, auto: true } }),
  startSlotstreamServer: vi.fn(),
  stopSlotstreamServer: vi.fn(),
  installSlotstream: vi.fn(),
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
  previewLocalLlmDownload: vi.fn(async () => ({
    kind: 'spec-decode',
    destPath: 'models/example.gguf',
    expectedBytes: 6,
    freeBytes: 1e12,
    requiredBytes: 6,
    headroomBytes: 0,
    verdict: 'ok',
  })),
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
  getSystemCapabilities,
  getLocalLlmCatalog,
  installLocalLlmBackend,
  patchSettingsSlice,
  installLocalLlmModel,
  upgradeLocalLlmBackend,
} from '../../services/api';
import socket from '../../services/socket';
import { clickStartDownload } from '../../test/downloadPreflightConfirm.js';
import LocalLlmLibraryView from './LocalLlmLibraryView.jsx';

// A realistically long HF model id — the shape that got ellipsised to
// "hf.co/sja…" on a phone before the row was allowed to wrap.
const LONG_ID = 'hf.co/example-org/Example-Long-Model-Name-34B-Instruct-GGUF:Q6_K';

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

const renderLibrary = async () => {
  render(
    <MemoryRouter>
      <LocalLlmLibraryView />
      <LocationProbe />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'llm-management-panel-library'));
  await waitFor(() => expect(screen.getByText(/Installed on (Ollama|LM Studio)/)).toBeTruthy());
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
  getSystemCapabilities.mockResolvedValue({
    platform: 'darwin',
    appleSilicon: true,
    totalMemoryGb: 64,
    cuda: { status: 'absent', gpus: [], maxVramGb: null },
  });
  installLocalLlmBackend.mockResolvedValue({ success: true });
  patchSettingsSlice.mockResolvedValue({});
  deleteLocalLlmModel.mockResolvedValue({ success: true });
});

describe('LocalLlmLibraryView information architecture', () => {
  it('gives model installation its own panel without mounting runtime management', async () => {
    const { getLlamaServerStatus, getMtplxServerStatus, getSlotstreamServerStatus } = await import('../../services/api');

    await renderLibrary();

    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Local Runtime Servers' })).not.toBeInTheDocument();
    expect(getLlamaServerStatus).not.toHaveBeenCalled();
    expect(getMtplxServerStatus).not.toHaveBeenCalled();
    expect(getSlotstreamServerStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(getLocalLlmCatalog).toHaveBeenCalled());
  });

  it('keeps the model-abuse guard off the catalog panel', async () => {
    await renderLibrary();

    expect(screen.queryByRole('heading', { name: 'Model-abuse guard' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument();
  });

  // The two views never mount together, so whichever one is on screen must be the
  // ONLY subscriber to the shared `localLlm:progress` channel — a second one would
  // double every status refetch and catalog re-query the channel triggers.
  it('leaves exactly one subscriber on the shared progress channel', async () => {
    await renderLibrary();

    expect(socket.on.mock.calls.filter(([event]) => event === 'localLlm:progress')).toHaveLength(1);
  });
});

// The Ollama auto-upgrade banner lives beside the install that triggers it. Its
// only entry point is a model install, which is a Model Library action — before
// the view split the banner rendered inside the Runtimes panel, where the flow
// that sets it can never be running, so nobody ever saw it.
describe('LocalLlmLibraryView Ollama auto-upgrade', () => {
  it('surfaces the upgrade banner beside the install that triggered it', async () => {
    installLocalLlmModel.mockRejectedValue(Object.assign(new Error('needs a newer Ollama'), { code: 'OLLAMA_OUTDATED' }));
    // Never resolves — the banner has to be readable while the upgrade runs.
    upgradeLocalLlmBackend.mockReturnValue(new Promise(() => {}));

    await renderLibrary();
    fireEvent.change(screen.getByLabelText('Install a Ollama model by id'), { target: { value: 'llama3.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await clickStartDownload();

    expect(await screen.findByText('Upgrading Ollama')).toBeInTheDocument();
    expect(screen.getByText(/llama3.2 needs a newer Ollama/)).toBeInTheDocument();
  });
});

describe('LocalLlmLibraryView backend blockers', () => {
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

    await renderLibrary();

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

    await renderLibrary();

    const blocker = screen.getByText("LM Studio isn't installed yet.").closest('div');
    expect(within(blocker).queryByRole('button', { name: 'Install LM Studio' })).toBeNull();
    expect(within(blocker).getByRole('link', { name: 'Download LM Studio' }))
      .toHaveAttribute('href', 'https://lmstudio.ai/download');
  });
});

describe('LocalLlmLibraryView installed models', () => {
  it('lets a long model id wrap instead of truncating it', async () => {
    await renderLibrary();
    const name = screen.getByText(LONG_ID);
    expect(name.className).toMatch(/\bbreak-all\b/);
    expect(name.className).not.toMatch(/\btruncate\b/);
  });

  it('stacks the row on mobile and keeps it inline from sm up', async () => {
    await renderLibrary();
    // The row is the flex container holding the name; on mobile it stacks so the
    // id gets the full width, and the action row drops beneath it.
    const row = screen.getByText(LONG_ID).closest('.rounded-lg');
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toMatch(/\bsm:flex-row\b/);
  });

  it('folds the model size into the wrapping metadata line', async () => {
    await renderLibrary();
    // Size used to be its own fixed-width column competing with the name; it now
    // rides along with params/quant/family so nothing is squeezed out.
    expect(screen.getByText(/^34\.7B · Q6_K · qwen2 · [\d.]+ GB$/)).toBeTruthy();
  });

  it('redownloads an installed model instead of requiring delete-then-install', async () => {
    installLocalLlmModel.mockResolvedValue({ success: true });
    await renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: `Redownload ${LONG_ID}` }));
    await clickStartDownload();
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

    await renderLibrary();
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
    await renderLibrary();
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
        <LocalLlmLibraryView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Installed on LM Studio/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Redownload Qwen3.8 27B' }));
    await clickStartDownload();
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
        <LocalLlmLibraryView />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Installed on LM Studio/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Redownload/ })).toBeNull();
  });
});

describe('LocalLlmLibraryView recommendations', () => {
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

    await renderLibrary();

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

    await renderLibrary();

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
    await renderLibrary();
    expect(await screen.findByText('Qwen3.8 27B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Redownload$/ }));
    await clickStartDownload();
    await waitFor(() => expect(installLocalLlmModel).toHaveBeenCalledWith(
      'ollama',
      'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M',
      expect.objectContaining({ force: true }),
    ));
  });
});

describe('LocalLlmLibraryView measured fit badge', () => {
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
    await renderLibrary();

    const badge = await screen.findByText(/exceeds RAM \(measured\)/);
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('title')).toMatch(/Measured on this machine/);
    // The disagreement is the point — the reader must see what the estimate claimed.
    expect(badge.getAttribute('title')).toMatch(/fits comfortably/);
  });

  it('labels an unmeasured verdict as the estimate it is', async () => {
    getLocalLlmCatalog.mockResolvedValue({ models: [catalogEntry({ fit: 'comfortable', fitSource: 'estimated', estimatedFit: 'comfortable', measuredFit: null })] });
    await renderLibrary();

    const badge = await screen.findByText('fits comfortably');
    expect(badge.getAttribute('title')).toMatch(/Estimated fit/);
    expect(badge.textContent).not.toMatch(/measured/);
  });

  it('renders the measurement-only verdict the size estimate can never produce', async () => {
    // No amount of free RAM fixes a backend refusing a model, so `incompatible`
    // only ever comes from a real run.
    getLocalLlmCatalog.mockResolvedValue({ models: [catalogEntry({ fit: 'incompatible', fitSource: 'measured', estimatedFit: 'comfortable', measuredFit: 'incompatible', disagrees: true })] });
    await renderLibrary();

    expect(await screen.findByText(/backend refused it \(measured\)/)).toBeInTheDocument();
  });
});
