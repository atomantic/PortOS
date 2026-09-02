import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

/**
 * The Model picker paints before /status lands.
 *
 * /status shells out to python and rebuilds the hardware-aware model list on
 * every call, so the field used to be absent for a second or two and then pop
 * into the middle of the form. It now holds its place with a loading
 * placeholder, and a session-cached payload paints the real list immediately —
 * while every connectivity claim keeps waiting for the live probe.
 */
const model = (id) => ({
  id,
  name: `Example ${id}`,
  repo: `example-org/${id}`,
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
});
const MODEL_ONE = model('example-one');
const MODEL_TWO = model('example-two');
const statusPayload = (overrides = {}) => ({
  connected: true,
  pythonPath: '/opt/example/python3',
  defaultModel: MODEL_ONE.id,
  models: [MODEL_ONE, MODEL_TWO],
  byovRuntimes: [],
  systemMemoryGb: 128,
  backendDisclosures: [],
  ...overrides,
});
const state = vi.hoisted(() => ({
  modelStatuses: {},
  generateVideo: vi.fn(),
  startDownload: vi.fn(),
  repairModel: vi.fn(),
  attach: vi.fn(),
  eventSourceRef: { current: null },
  getVideoGenStatus: vi.fn(),
  runtimeInstallComplete: null,
}));

vi.mock('../services/api', () => ({
  // The page offers a federated render target (#4348); with no peer opted in
  // as a media provider the picker renders nothing and every local path below
  // is unchanged.
  getInstances: vi.fn(async () => ({ peers: [] })),
  getVideoGenStatus: (...args) => state.getVideoGenStatus(...args),
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
  // The prompt-enhancement controls mount useProviderModels, which fetches the
  // provider list from a mount effect. Unmocked it throws out of a passive
  // effect — the tests still pass, but the unhandled rejection fails the run.
  getProviders: vi.fn(async () => ({ providers: [] })),
  getVisionModels: vi.fn(async () => ({ models: [] })),
}));

vi.mock('../components/media/PromptFromMedia', () => ({ default: () => null }));

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
    getStatus: (id) => state.modelStatuses[id] || null,
    start: state.startDownload,
    cancel: vi.fn(),
    repair: state.repairModel,
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

// Keep the policy-bearing controls real; replace unrelated, heavyweight page
// surfaces so this is a focused orchestration test rather than a gallery/SSE
// integration suite.
vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/settings/LocalSetupPanel', () => ({ default: () => null }));
vi.mock('../components/install/RuntimeInstallModal', () => ({
  default: ({ onComplete }) => {
    state.runtimeInstallComplete = onComplete;
    return null;
  },
}));
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
const { VIDEO_GEN_STATUS_CACHE_KEY } = await import('../lib/videoGenStatusCache.js');

const renderPage = async () => {
  let view;
  await act(async () => {
    view = render(
      <MemoryRouter initialEntries={['/media/video']}>
        <VideoGen />
      </MemoryRouter>,
    );
  });
  return view;
};

// A /status call the test settles by hand, so the page can be asserted mid-probe.
const deferredStatus = () => {
  let settle;
  state.getVideoGenStatus.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
  return async (payload) => { await act(async () => { settle(payload); }); };
};

describe('VideoGen model picker while /status is in flight', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    state.modelStatuses = {};
    state.getVideoGenStatus.mockReset().mockResolvedValue(statusPayload());
    state.eventSourceRef.current = null;
    state.attach.mockReset().mockResolvedValue({ filename: 'example.mp4' });
  });

  it('keeps the Model field with a loading placeholder until the model list lands', async () => {
    const resolveStatus = deferredStatus();
    await renderPage();

    const field = screen.getByLabelText('Model');
    expect(field).toBeDisabled();
    expect(field).toHaveTextContent('Loading models…');

    await resolveStatus(statusPayload());

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id));
    expect(screen.getByLabelText('Model')).toBeEnabled();
  });

  it('paints the cached model list on the next load instead of waiting for the probe', async () => {
    const first = await renderPage();
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id));
    // Only the model-shaping slice is persisted — python health never is.
    expect(Object.keys(JSON.parse(sessionStorage.getItem(VIDEO_GEN_STATUS_CACHE_KEY))).sort())
      .toEqual(['defaultModel', 'models', 'systemMemoryGb']);
    first.unmount();

    const resolveStatus = deferredStatus();
    await renderPage();

    const field = screen.getByLabelText('Model');
    expect(field).toBeEnabled();
    expect(field).toHaveValue(MODEL_ONE.id);
    await resolveStatus(statusPayload());
  });

  it('never reports python health from a cached entry', async () => {
    // A hand-written entry carrying a FAILED probe — the belt to the
    // projection's braces. The model list may come from storage; the diagnosis
    // may not, because the interpreter can have been fixed since.
    sessionStorage.setItem(VIDEO_GEN_STATUS_CACHE_KEY, JSON.stringify(statusPayload({
      connected: false,
      reason: 'Python probe failed',
      missingPackages: ['torch'],
    })));
    const resolveStatus = deferredStatus();
    await renderPage();

    expect(screen.getByLabelText('Model')).toHaveValue(MODEL_ONE.id);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.queryByText(/Install missing Python packages/)).toBeNull();
    expect(screen.queryByText(/Python probe failed/)).toBeNull();

    await resolveStatus(statusPayload({ connected: true, pythonVersion: '3.12.1' }));
    await waitFor(() => expect(screen.getByText('Python 3.12.1')).toBeInTheDocument());
  });
});
