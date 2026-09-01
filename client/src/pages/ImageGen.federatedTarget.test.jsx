import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const MODEL = { id: 'dev', name: 'FLUX.1 Dev', runner: 'mflux', steps: 20, guidance: 3.5 };

// A peer opted in as an image provider, advertising one allowlisted model with a
// verifiable freshness window — the shape `GET /api/instances` returns.
const PEER = {
  id: 'peer-example',
  name: 'Example GPU',
  status: 'online',
  enabled: true,
  mediaProvider: { enabled: true, imageModels: [{ engine: 'local', modelId: 'peer-flux' }] },
  mediaProviderStatus: {
    state: 'ready',
    checkedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 },
      capabilities: [{
        kind: 'image', engine: 'local', engineName: 'Local image', modelId: 'peer-flux',
        modelName: 'FLUX.2 Klein', ready: true, unavailableReason: null,
        runtimeReady: true, platformSupported: true, cudaRequired: false, cudaState: 'available',
      }],
    },
  },
};

const state = vi.hoisted(() => ({ generateImage: vi.fn(), attachJobEvents: vi.fn() }));

vi.mock('../services/api', () => ({
  getInstances: vi.fn(async () => ({ peers: [PEER] })),
  getImageGenStatus: vi.fn(async () => ({ connected: true, mode: 'local', model: 'FLUX.1 Dev' })),
  generateImage: (...args) => state.generateImage(...args),
  generateImageMultipart: vi.fn(async () => ({})),
  listImageModels: vi.fn(async () => [MODEL]),
  listLorasFull: vi.fn(async () => []),
  listImageGallery: vi.fn(async () => []),
  cancelImageGen: vi.fn(async () => ({})),
  deleteImage: vi.fn(async () => ({})),
  setImageHidden: vi.fn(async () => ({})),
  cleanGalleryImage: vi.fn(async () => ({})),
  getActiveImageJob: vi.fn(async () => ({ activeJob: null })),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' }, grok: { enabled: true } } })),
  buildFormData: vi.fn(() => new FormData()),
  listMediaJobs: vi.fn(async () => ({ jobs: [] })),
  regenerateGalleryImage: vi.fn(async () => ({})),
  getRegenAvailability: vi.fn(async () => ({ available: false })),
  removeImageWatermark: vi.fn(async () => ({})),
  getFlux2Status: vi.fn(async () => ({ installed: true, ready: true })),
}));

vi.mock('../hooks/useImageGenProgress', () => ({
  useImageGenProgress: () => ({ progress: null, begin: vi.fn(), end: vi.fn(), resume: vi.fn() }),
}));
vi.mock('../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: (...a) => state.attachJobEvents(...a), eventSourceRef: { current: null } }),
}));
vi.mock('../hooks/useModelDownloadStatus', () => ({
  useModelDownloadStatus: () => ({
    getStatus: () => ({ cached: true }), start: vi.fn(), cancel: vi.fn(), repair: vi.fn(), refresh: vi.fn(),
    downloading: false, repairing: false, progress: null, lastError: null, activeModelId: null, extra: {}, loading: false, statusError: null,
  }),
}));
vi.mock('../hooks/useHfTokenStatus', () => ({ useHfTokenStatus: () => ({ present: true, refresh: vi.fn() }) }));
vi.mock('../hooks/useAgyModels', () => ({ useAgyModels: () => ({ models: [], error: null }) }));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: vi.fn() }));
vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn(), getCardProps: vi.fn(() => ({})) }),
}));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: vi.fn() }));
vi.mock('../hooks/usePreviewRoute', () => ({ default: () => [null, vi.fn()] }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));
vi.mock('../components/media/PromptEnhancer', () => ({ default: () => null }));
vi.mock('../components/media/PromptFromMedia', () => ({ default: () => null }));
vi.mock('../components/media/UniverseStylePicker', () => ({
  default: ({ onChange }) => (
    <button
      type="button"
      onClick={() => onChange({
        id: 'u-1', name: 'Example Universe',
        influences: { embrace: ['inky linework'], avoid: ['glossy'] },
      })}
    >
      Use universe style
    </button>
  ),
}));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));
vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/imageGen/Flux2InstallModal', () => ({ default: () => null }));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/InitImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/ReferenceImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));

const { default: ImageGen } = await import('./ImageGen.jsx');

const mount = async (promptText = 'a lighthouse at dusk') => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/media/image']}>
        <ImageGen />
      </MemoryRouter>,
    );
  });
  fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: promptText } });
};

describe('ImageGen federated render target', () => {
  beforeEach(() => {
    state.generateImage.mockReset().mockResolvedValue({ jobId: 'job-1' });
    state.attachJobEvents.mockReset().mockReturnValue(new Promise(() => {}));
  });

  // The whole point of the picker: a peer's model reaches the generate route as
  // an explicit (peer, engine, model) selection, and nothing that only describes
  // a LOCAL dispatch rides along with it.
  it('submits the peer, its engine and its model — and no local-only fields', async () => {
    await mount();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })); });

    await waitFor(() => expect(state.generateImage).toHaveBeenCalled());
    expect(state.generateImage.mock.calls[0][0]).toMatchObject({
      prompt: 'a lighthouse at dusk',
      mediaProviderPeerId: 'peer-example',
      mediaProviderEngine: 'local',
      modelId: 'peer-flux',
    });
    // `mode` picks a local dispatcher lane, `quantize` and the cleaners describe
    // work on this machine's bytes — none of them mean anything on a peer.
    for (const field of ['mode', 'quantize', 'cleanC2PA', 'denoise', 'loraFilenames', 'cloudModel']) {
      expect(state.generateImage.mock.calls[0][0]).not.toHaveProperty(field);
    }
  });

  it('adds the selected universe positive and negative style tokens to the image payload', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Use universe style' }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })); });

    await waitFor(() => expect(state.generateImage).toHaveBeenCalled());
    expect(state.generateImage.mock.calls[0][0]).toMatchObject({
      prompt: 'inky linework. a lighthouse at dusk',
      negativePrompt: expect.stringContaining('glossy'),
    });
  });

  it('hides the generation target field when Grok is selected', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /Grok/i }));

    await waitFor(() => expect(screen.queryByRole('combobox', { name: /generation target/i })).not.toBeInTheDocument());
  });

  // A stale snapshot still records `state: 'ready'`; gating on it would leave
  // Generate live against a peer the server is about to refuse.
  it('disables Generate and explains why when the peer’s capacity window lapsed', async () => {
    const { getInstances } = await import('../services/api');
    getInstances.mockResolvedValueOnce({
      peers: [{
        ...PEER,
        mediaProviderStatus: { ...PEER.mediaProviderStatus, freshUntil: new Date(Date.now() - 60_000).toISOString() },
      }],
    });
    await mount();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    expect(screen.getByText(/capacity snapshot expired/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
    expect(state.generateImage).not.toHaveBeenCalled();
  });
});
