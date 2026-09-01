import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const TERMS_ID = 'minimax-h3-license-v1';
const MODEL = {
  id: 'h3-one',
  name: 'MiniMax h3-one',
  repo: 'example-org/h3-one',
  revision: '1111111111111111111111111111111111111111',
  runtime: 'minimax_h3',
  supportedModes: ['text'],
  defaultFrames: 124,
  frameOptions: [124, 141],
  fpsOptions: [24],
  steps: 8,
  guidance: 0,
  samplerLocked: true,
  supportsNegativePrompt: false,
  supportsTiling: false,
  supportsDisableAudio: false,
  termsGate: {
    id: TERMS_ID,
    title: 'Terms for h3-one',
    summary: 'This model is available only in its applicable territory.',
    acknowledgement: `I am eligible and accept ${TERMS_ID}.`,
    licenseUrl: 'https://example.com/license',
  },
};

// A peer opted in as a video provider, advertising one allowlisted model with a
// verifiable freshness window — the shape `GET /api/instances` returns.
const PEER = {
  id: 'peer-example',
  name: 'Example GPU',
  status: 'online',
  enabled: true,
  mediaProvider: { enabled: true, videoModels: [{ engine: 'local', modelId: 'peer-wan' }] },
  mediaProviderStatus: {
    state: 'ready',
    checkedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      queue: { accepting: true, running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4 },
      capabilities: [{
        kind: 'video', engine: 'local', engineName: 'Local video', modelId: 'peer-wan',
        modelName: 'Wan 2.2 T2V', ready: true, unavailableReason: null,
        runtimeReady: true, platformSupported: true, cudaRequired: false, cudaState: 'available',
      }],
    },
  },
};

const state = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  attach: vi.fn(),
  eventSourceRef: { current: null },
}));

vi.mock('../services/apiImageVideo.js', () => ({
  getVideoModelTerms: vi.fn(async () => ({ accepted: [TERMS_ID] })),
  setVideoModelTerms: vi.fn(async () => ({ accepted: [TERMS_ID] })),
}));

vi.mock('../services/api', () => ({
  getInstances: vi.fn(async () => ({ peers: [PEER] })),
  getVideoGenStatus: vi.fn(async () => ({
    connected: true,
    pythonPath: '/opt/example/python3',
    defaultModel: 'h3-one',
    models: [MODEL],
    byovRuntimes: [],
    systemMemoryGb: 128,
    backendDisclosures: [],
  })),
  generateVideo: (...args) => state.generateVideo(...args),
  cancelVideoGen: vi.fn(async () => ({})),
  listVideoHistory: vi.fn(async () => []),
  deleteVideoHistoryItem: vi.fn(async () => ({})),
  setVideoHidden: vi.fn(async () => ({})),
  extractLastFrame: vi.fn(async () => ({})),
  upscaleVideo: vi.fn(async () => ({})),
  listImageGallery: vi.fn(async () => []),
  patchSettingsSlice: vi.fn(async () => ({})),
  getActiveVideoJob: vi.fn(async () => ({ activeJob: null })),
  getSettings: vi.fn(async () => ({ imageGen: { grok: { enabled: false } } })),
  getVideoGenRuntimeStatus: vi.fn(async () => ({ installed: true, ready: true, current: true })),
  listLorasFull: vi.fn(async () => []),
  getProviders: vi.fn(async () => ({ providers: [] })),
  getVisionModels: vi.fn(async () => ({ models: [] })),
}));

vi.mock('../hooks/useModelDownloadStatus', () => ({
  TEXT_ENCODER_DOWNLOAD_ID: '__text_encoder__',
  useModelDownloadStatus: () => ({
    extra: {},
    loading: false,
    statusError: null,
    activeModelId: null,
    progress: null,
    lastError: null,
    downloading: false,
    repairing: false,
    getStatus: () => ({ id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 }),
    start: vi.fn(),
    cancel: vi.fn(),
    repair: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: state.attach, eventSourceRef: state.eventSourceRef }),
}));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: vi.fn() }));
vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn(), getCardProps: vi.fn(() => ({})) }),
}));
vi.mock('../hooks/usePreviewRoute', () => ({ default: () => [null, vi.fn()] }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));

vi.mock('../components/media/PromptEnhancer', () => ({
  default: ({ disabled }) => (
    <div data-testid="prompt-enhancer" data-disabled={disabled ? '1' : '0'}>Enhance with AI</div>
  ),
}));
vi.mock('../components/media/PromptFromMedia', () => ({
  default: ({ disabled }) => (
    <div data-testid="prompt-from-media" data-disabled={disabled ? '1' : '0'}>Prompt from media</div>
  ),
}));

vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/settings/LocalSetupPanel', () => ({ default: () => null }));
vi.mock('../components/install/RuntimeInstallModal', () => ({ default: () => null }));
vi.mock('../components/videoGen/FramePanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/KeyframePanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/AudioPanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/ExtendPanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/IcLoraPanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/AdvancedParamsPanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/RuntimeFingerprint', () => ({ default: () => null }));
vi.mock('../components/videoGen/VideoGenGallery', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: () => null }));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/UniverseStylePicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));


const { default: VideoGen } = await import('./VideoGen.jsx');

const startRender = async (promptText = 'a fox watches the rain') => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/media/video']}>
        <VideoGen />
      </MemoryRouter>,
    );
  });
  fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: promptText } });
};

describe('VideoGen federated render target', () => {
  beforeEach(() => {
    state.generateVideo.mockReset().mockReturnValue(new Promise(() => {}));
    state.attach.mockReset().mockReturnValue(new Promise(() => {}));
    state.eventSourceRef.current = null;
  });

  // The whole point of the picker: a peer's model reaches the generate route as
  // an explicit (peer, engine, model) selection, and nothing that only describes
  // a LOCAL dispatch rides along with it.
  it('submits the peer, its engine and its model — and no local-only fields', async () => {
    await startRender();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Generate$/ })); });

    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    const payload = state.generateVideo.mock.calls[0][0];
    expect(payload).toMatchObject({
      backend: 'local',
      mode: 'text',
      prompt: 'a fox watches the rain',
      mediaProviderPeerId: 'peer-example',
      mediaProviderEngine: 'local',
      modelId: 'peer-wan',
    });
    // Every one of these means "run this on my hardware" and the provider route
    // refuses a body carrying them.
    for (const field of ['sourceImageFile', 'lastImageFile', 'keyframes', 'extendFromVideoId', 'audioFile', 'loraFilenames', 'textEncoderId', 'tiling', 'chunks']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  // The local model dropdown lists models the peer does not have. Leaving it
  // visible would let a stale selection read as the model that rendered the clip.
  it('replaces the local model dropdown with the peer’s advertised models', async () => {
    await startRender();
    expect(screen.getByRole('option', { name: /MiniMax h3-one/ })).toBeInTheDocument();

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });

    expect(screen.queryByRole('option', { name: /MiniMax h3-one/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Wan 2\.2 T2V/ })).toBeInTheDocument();
  });
  // Image-to-video is no longer refused outright (ADR
  // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1): the
  // FRAME is what has to cross, and whether it can is a per-model question
  // answered at the moment one is picked. Selecting the mode with no frame yet
  // conditions nothing, so blocking there would refuse a render that is still
  // a plain text-to-video job.
  it('lets image mode be selected on a peer, since a mode alone conditions nothing', async () => {
    await startRender();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^Image$/ }));

    expect(screen.queryByText(/cannot take/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled();
  });

  // Extend and audio-to-video are multi-step CHAIN STATE and an input the wire
  // has no field for (rule 4) — still refused, and refused at the MODE rather
  // than only at the input, since the mode can be set before its input is
  // filled. Blocking must beat dropping: an a2v render that reached the peer as
  // plain text-to-video is a valid-looking clip of a different thing.
  it.each([['Extend'], ['Audio']])('blocks %s mode, which cannot cross at all', async (label) => {
    await startRender();
    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}$`) }));

    expect(screen.getByText(/cannot take/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
  });
});
