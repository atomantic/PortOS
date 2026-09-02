/**
 * Picking a substitute prompt conditioner starts its download right there.
 *
 * The conditioner is unusable until it is resident and Generate is gated on it
 * either way, so the separate Download click sat between the choice and the only
 * thing that could follow it. What this file pins down is the boundary: an
 * EXPLICIT selection pulls, and a state restore (a resumed render, a Remix, the
 * snap-to-stock on a model change) never does — those all reach the same
 * setTextEncoderId, and a ~57 GB pull must follow a click, not a restore.
 */
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
  textEncoderOptions: [
    { id: 'stock', label: 'Stock', description: 'Ships with the model.', builtIn: true },
    { id: 'huihui-abliterated', label: 'Huihui abliterated', description: 'Abliterated.', builtIn: false, repo: 'example-org/abliterated', sizeBytes: 56962931632 },
  ],
  termsGate: {
    id: TERMS_ID,
    title: 'Terms for h3-one',
    summary: 'This model is available only in its applicable territory.',
    acknowledgement: `I am eligible and accept ${TERMS_ID}.`,
    licenseUrl: 'https://example.com/license',
  },
};

const state = vi.hoisted(() => ({
  start: vi.fn(),
  startWhenIdle: vi.fn(),
  downloadStatus: { downloading: false, loading: false, cached: false },
  queued: null,
  history: [],
  activeJob: null,
  generateVideo: vi.fn(),
  attach: vi.fn(),
  eventSourceRef: { current: null },
}));

vi.mock('../services/api', () => ({
  // The page offers a federated render target (#4348); with no peer opted in
  // as a media provider the picker renders nothing and every local path below
  // is unchanged.
  getInstances: vi.fn(async () => ({ peers: [] })),
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
  listVideoHistory: vi.fn(async () => state.history),
  deleteVideoHistoryItem: vi.fn(async () => ({})),
  setVideoHidden: vi.fn(async () => ({})),
  extractLastFrame: vi.fn(async () => ({})),
  upscaleVideo: vi.fn(async () => ({})),
  listImageGallery: vi.fn(async () => []),
  patchSettingsSlice: vi.fn(async () => ({})),
  getActiveVideoJob: vi.fn(async () => ({ activeJob: state.activeJob })),
  getSettings: vi.fn(async () => ({ imageGen: { grok: { enabled: false } } })),
  getVideoGenRuntimeStatus: vi.fn(async () => ({ installed: true, ready: true, current: true })),
  listLorasFull: vi.fn(async () => []),
  getProviders: vi.fn(async () => ({ providers: [] })),
  getVisionModels: vi.fn(async () => ({ models: [] })),
}));

vi.mock('../hooks/useModelDownloadStatus', () => ({
  TEXT_ENCODER_DOWNLOAD_ID: '__text_encoder__',
  textEncoderDownloadId: (id) => `__text_encoder_option__:${id}`,
  useModelDownloadStatus: () => ({
    extra: {},
    loading: state.downloadStatus.loading,
    statusError: null,
    activeModelId: null,
    progress: null,
    lastError: null,
    downloading: state.downloadStatus.downloading,
    repairing: false,
    getStatus: (id) => (String(id).startsWith('__text_encoder_option__:')
      ? { id: 'huihui-abliterated', repo: 'example-org/abliterated', cached: state.downloadStatus.cached, sizeBytes: 0 }
      : { id: MODEL.id, repo: MODEL.repo, cached: true, sizeBytes: 100 }),
    start: state.start,
    startWhenIdle: state.startWhenIdle,
    queuedModelId: state.queued,
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

const SUBSTITUTE_ID = 'huihui-abliterated';
const DOWNLOAD_ID = `__text_encoder_option__:${SUBSTITUTE_ID}`;

const mountPage = async () => {
  await act(async () => {
    render(<MemoryRouter initialEntries={['/media/video']}><VideoGen /></MemoryRouter>);
  });
  return screen.findByLabelText('Text encoder');
};

describe('VideoGen substitute text-encoder auto-download', () => {
  beforeEach(() => {
    state.start.mockReset();
    state.startWhenIdle.mockReset();
    state.queued = null;
    state.downloadStatus = { downloading: false, loading: false, cached: false };
    state.history = [];
    state.activeJob = null;
  });

  it('requests the pull when a substitute is selected', async () => {
    const select = await mountPage();
    // Arriving on the page with stock selected requests nothing.
    expect(state.startWhenIdle).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(select, { target: { value: SUBSTITUTE_ID } });
    });
    await waitFor(() => expect(state.startWhenIdle).toHaveBeenCalledWith(DOWNLOAD_ID));
    // The commanding `start` is NOT used here — it would hijack the lane and
    // skip the cache check that makes selecting a resident encoder free.
    expect(state.start).not.toHaveBeenCalled();
  });

  // The built-in conditioner ships inside the model's weights, so there is
  // nothing to fetch — and switching to it must retract a pull queued a moment
  // earlier for the substitute the user just moved off.
  it('clears the request when the selection goes back to stock', async () => {
    const select = await mountPage();
    await act(async () => {
      fireEvent.change(select, { target: { value: SUBSTITUTE_ID } });
    });
    await act(async () => {
      fireEvent.change(select, { target: { value: 'stock' } });
    });
    expect(state.startWhenIdle).toHaveBeenLastCalledWith(null);
  });

  it('surfaces the queued state on the selected substitute', async () => {
    state.queued = DOWNLOAD_ID;
    const select = await mountPage();
    await act(async () => {
      fireEvent.change(select, { target: { value: SUBSTITUTE_ID } });
    });
    await waitFor(() => expect(screen.getByText(/starts when the current download finishes/i)).toBeInTheDocument());
  });

  // Reloading onto an in-flight render replays its conditioner into the form.
  // That is a state restore, not a choice — and the weights are demonstrably
  // already resident, since the render is running on them. Remix (applyRemix)
  // and the model-change snap reach setTextEncoderId the same way, which is why
  // only the picker's own onChange requests a pull.
  it('requests nothing when a resumed render restores its conditioner', async () => {
    state.activeJob = {
      jobId: 'job-1',
      status: 'running',
      params: { modelId: MODEL.id, prompt: 'a fox watches the rain', mode: 'text', textEncoderId: SUBSTITUTE_ID },
    };
    await mountPage();
    await waitFor(() => expect(screen.getByLabelText('Text encoder')).toHaveValue(SUBSTITUTE_ID));
    expect(state.startWhenIdle).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
  });
});
