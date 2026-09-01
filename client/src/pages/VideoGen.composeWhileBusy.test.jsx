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

vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/settings/LocalSetupPanel', () => ({ default: () => null }));
vi.mock('../components/install/RuntimeInstallModal', () => ({
  default: ({ streamMethod }) => <div data-testid="runtime-install-modal" data-stream-method={streamMethod} />,
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
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));

const { default: VideoGen } = await import('./VideoGen.jsx');

describe('VideoGen compose-while-busy', () => {
  beforeEach(() => {
    state.generateVideo.mockReset().mockReturnValue(new Promise(() => {}));
    state.attach.mockReset().mockReturnValue(new Promise(() => {}));
    state.eventSourceRef.current = null;
    vi.stubGlobal('open', vi.fn());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  it('starts runtime installation through the non-idempotent POST stream', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/media/video']}>
          <VideoGen />
        </MemoryRouter>,
      );
    });

    expect(screen.getByTestId('runtime-install-modal')).toHaveAttribute('data-stream-method', 'POST');
  });

  it('leaves Enhance with AI and Prompt from media usable so the next clip can be queued', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/media/video']}>
          <VideoGen />
        </MemoryRouter>,
      );
    });

    const prompt = await screen.findByLabelText('Prompt');
    fireEvent.change(prompt, { target: { value: 'a fox watches the rain' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument());

    expect(screen.getByTestId('prompt-enhancer')).toHaveAttribute('data-disabled', '0');
    expect(screen.getByTestId('prompt-from-media')).toHaveAttribute('data-disabled', '0');
    expect(screen.getByRole('button', { name: /Add to queue/ })).toBeEnabled();
  });

  it('includes the selected universe style in the submitted video prompt', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/media/video']}>
          <VideoGen />
        </MemoryRouter>,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use universe style' }));
    fireEvent.change(await screen.findByLabelText('Prompt'), { target: { value: 'a fox watches the rain' } });
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(state.generateVideo).toHaveBeenCalled());
    expect(state.generateVideo.mock.calls[0][0].prompt).toBe('inky linework. a fox watches the rain');
  });

  it('submits an additional render to the server queue while another render is active', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/media/video']}>
          <VideoGen />
        </MemoryRouter>,
      );
    });

    const prompt = await screen.findByLabelText('Prompt');
    fireEvent.change(prompt, { target: { value: 'a fox watches the rain' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add to queue/ }));
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledTimes(2));
    expect(state.generateVideo.mock.calls[1][0]).toMatchObject({
      mode: 'text',
      prompt: 'a fox watches the rain',
    });
  });

});
