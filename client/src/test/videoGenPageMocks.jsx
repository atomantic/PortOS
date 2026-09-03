/**
 * Shared mock scaffold for the VideoGen page suites.
 *
 * Five suites (`pages/VideoGen.terms`, `.federatedTarget`, `.composeWhileBusy`,
 * `.textEncoderAutoDownload`, `.modelLoading`) each used to carry a near-verbatim
 * ~140-line copy of the same 25 `vi.mock` registrations, the same `state` object,
 * the same model fixture and the same `renderPage()` helper. Every endpoint or
 * hook the page started calling had to be added in five places, or four suites
 * broke at once.
 *
 * **Importing this module registers the mocks** — that is the whole point, and it
 * is what the vitest hoisting rules allow. `vi.mock` is hoisted to the top of the
 * file it is written in, so these registrations run when this module is evaluated,
 * which is while the importing test file's static imports are being resolved and
 * therefore before its `await loadVideoGenPage()`. The relative specifiers resolve
 * identically from here and from `pages/` (`src/test/../services/api` and
 * `src/pages/../services/api` are the same module), so the mocked paths are the
 * ones the page itself imports.
 *
 * Every mock reads through the exported `state`, so a suite varies behavior by
 * assigning to it in `beforeEach` rather than by re-registering a mock. Call
 * `resetVideoGenMockState()` first to get the documented defaults back.
 */

import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';

/** Universe style the stub picker hands to the page when its button is clicked. */
const DEFAULT_UNIVERSE_STYLE = {
  id: 'u-1',
  name: 'Example Universe',
  influences: { embrace: ['inky linework'], avoid: ['glossy'] },
};

/**
 * Every knob the five suites vary. Mutated in `beforeEach`; read lazily by the
 * mock factories below, so a reassignment takes effect on the next render.
 */
export const state = {
  /** `GET /api/instances` peers — a media-provider peer makes the target picker appear. */
  peers: [],
  /** `getVideoGenStatus`; a spy so a suite can defer it, count calls or vary the payload. */
  getVideoGenStatus: vi.fn(),
  generateVideo: vi.fn(),
  attach: vi.fn(),
  eventSourceRef: { current: null },
  activeJob: null,
  /** Cache-status entries keyed by download id, read by the default `getModelStatus`. */
  modelStatuses: {},
  /** Override to answer ids the map cannot (e.g. the `__text_encoder_option__:` prefix). */
  getModelStatus: (id) => state.modelStatuses[id] ?? null,
  start: vi.fn(),
  startWhenIdle: vi.fn(),
  queuedModelId: null,
  repair: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
  /** `RuntimeInstallModal`'s `onComplete`, captured so a suite can fire it. */
  runtimeInstallComplete: null,
  universeStyle: DEFAULT_UNIVERSE_STYLE,
};

const SPIES = ['getVideoGenStatus', 'generateVideo', 'attach', 'start', 'startWhenIdle', 'repair', 'cancel', 'refresh'];

/** Restore every documented default, including fresh spies. Call it first in `beforeEach`. */
export function resetVideoGenMockState() {
  state.peers = [];
  state.activeJob = null;
  state.modelStatuses = {};
  state.getModelStatus = (id) => state.modelStatuses[id] ?? null;
  state.queuedModelId = null;
  state.runtimeInstallComplete = null;
  state.universeStyle = DEFAULT_UNIVERSE_STYLE;
  state.eventSourceRef.current = null;
  for (const key of SPIES) state[key].mockReset();
}

/** A video model as `GET /api/video-gen/status` reports it. */
export const videoGenModel = (id, overrides = {}) => ({
  id,
  name: `MiniMax ${id}`,
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
  ...overrides,
});

/** The eligibility gate a territory-restricted model carries. */
export const videoGenTermsGate = (termsId) => ({
  id: termsId,
  title: `Terms for ${termsId}`,
  summary: 'This model is available only in its applicable territory.',
  acknowledgement: `I am eligible and accept ${termsId}.`,
  licenseUrl: 'https://example.com/license',
});

/** A `/status` payload over `models`; the first model is the default unless overridden. */
export const videoGenStatus = (models, overrides = {}) => ({
  connected: true,
  pythonPath: '/opt/example/python3',
  defaultModel: models[0]?.id ?? null,
  models,
  byovRuntimes: [],
  systemMemoryGb: 128,
  backendDisclosures: [],
  ...overrides,
});

vi.mock('../services/api', () => ({
  // The page offers a federated render target (#4348); with no peer opted in as
  // a media provider the picker renders nothing and every local path is unchanged.
  getInstances: vi.fn(async () => ({ peers: state.peers })),
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
  getActiveVideoJob: vi.fn(async () => ({ activeJob: state.activeJob })),
  getSettings: vi.fn(async () => ({ imageGen: { grok: { enabled: false } } })),
  getVideoGenRuntimeStatus: vi.fn(async () => ({ installed: true, ready: true, current: true })),
  listLorasFull: vi.fn(async () => []),
  // The prompt-enhancement controls mount useProviderModels, which fetches the
  // provider list from a mount effect. Unmocked it throws out of a passive
  // effect — the tests still pass, but the unhandled rejection fails the run.
  getProviders: vi.fn(async () => ({ providers: [] })),
  getVisionModels: vi.fn(async () => ({ models: [] })),
}));

vi.mock('../hooks/useModelDownloadStatus', () => ({
  TEXT_ENCODER_DOWNLOAD_ID: '__text_encoder__',
  textEncoderDownloadId: (id) => `__text_encoder_option__:${id}`,
  useModelDownloadStatus: () => ({
    extra: {},
    loading: false,
    statusError: null,
    activeModelId: null,
    progress: null,
    lastError: null,
    downloading: false,
    repairing: false,
    getStatus: (id) => state.getModelStatus(id),
    start: state.start,
    startWhenIdle: state.startWhenIdle,
    queuedModelId: state.queuedModelId,
    cancel: state.cancel,
    repair: state.repair,
    refresh: state.refresh,
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

// The prompt helpers stay observable rather than blanked: whether they remain
// usable while a render is already in flight is itself one of the assertions.
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
// Interactive so a suite can drive the style into the page; inert everywhere else.
vi.mock('../components/media/UniverseStylePicker', () => ({
  default: ({ onChange }) => (
    <button type="button" onClick={() => onChange(state.universeStyle)}>Use universe style</button>
  ),
}));
// Captures `onComplete` (the runtime-setup refresh) and exposes `streamMethod`.
vi.mock('../components/install/RuntimeInstallModal', () => ({
  default: ({ onComplete, streamMethod }) => {
    state.runtimeInstallComplete = onComplete;
    return <div data-testid="runtime-install-modal" data-stream-method={streamMethod} />;
  },
}));

// Keep the policy-bearing controls real; replace unrelated, heavyweight page
// surfaces so these stay focused orchestration tests rather than a gallery/SSE
// integration suite.
vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/settings/LocalSetupPanel', () => ({ default: () => null }));
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
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));

let VideoGen = null;

/**
 * Import the page under the mocks above. Every suite loads it dynamically at
 * module scope so the registrations are in place first; the component is kept
 * here so `renderVideoGenPage()` needs no argument.
 */
export async function loadVideoGenPage() {
  ({ default: VideoGen } = await import('../pages/VideoGen.jsx'));
  return VideoGen;
}

/** Mount the page on its own route, flushing the mount effects. */
export async function renderVideoGenPage() {
  if (!VideoGen) throw new Error('await loadVideoGenPage() at module scope before rendering');
  let view;
  await act(async () => {
    view = render(
      <MemoryRouter initialEntries={['/media/video']}>
        <VideoGen />
      </MemoryRouter>,
    );
  });
  return view;
}
