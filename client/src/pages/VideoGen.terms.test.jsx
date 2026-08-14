import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const TERMS_ONE = 'minimax-h3-license-v1';
const TERMS_TWO = 'minimax-h3-license-v2';
const model = (id, termsId) => ({
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
  termsGate: {
    id: termsId,
    title: `Terms for ${id}`,
    summary: 'This model is available only in its applicable territory.',
    acknowledgement: `I am eligible and accept ${termsId}.`,
    licenseUrl: 'https://example.com/license',
  },
});
const H3_ONE = model('h3-one', TERMS_ONE);
const H3_TWO = model('h3-two', TERMS_TWO);

const state = vi.hoisted(() => ({
  modelStatuses: {},
  generateVideo: vi.fn(),
  startDownload: vi.fn(),
  repairModel: vi.fn(),
  enqueue: vi.fn(),
  attach: vi.fn(),
  eventSourceRef: { current: null },
  // Stands in for the persisted install-wide acceptance list
  // (settings.videoGen.acceptedModelTerms) the terms endpoints read and write.
  acceptedTerms: [],
  setVideoModelTerms: vi.fn(),
}));

// Acceptance lives on the server, not in this browser, so a single
// acknowledgement authorizes every render surface. The page reads and writes it
// through these two endpoints.
vi.mock('../services/apiImageVideo.js', () => ({
  getVideoModelTerms: vi.fn(async () => ({ accepted: [...state.acceptedTerms] })),
  setVideoModelTerms: (...args) => state.setVideoModelTerms(...args),
}));

vi.mock('../services/api', () => ({
  getVideoGenStatus: vi.fn(async () => ({
    connected: true,
    pythonPath: '/opt/example/python3',
    defaultModel: 'h3-one',
    models: [H3_ONE, H3_TWO],
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
  // The prompt-enhancement controls mount useProviderModels, which fetches the
  // provider list from a mount effect. Unmocked it throws out of a passive
  // effect — the tests still pass, but the unhandled rejection fails the run.
  getProviders: vi.fn(async () => ({ providers: [] })),
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
vi.mock('../hooks/useVideoGenQueue.js', () => ({
  useVideoGenQueue: () => ({
    queue: [],
    enqueue: state.enqueue,
    removeFromQueue: vi.fn(),
    clearFinishedQueue: vi.fn(),
    cancelRunning: vi.fn(),
  }),
}));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));

// Keep the policy-bearing controls real; replace unrelated, heavyweight page
// surfaces so this is a focused orchestration test rather than a gallery/SSE
// integration suite.
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
vi.mock('../components/videoGen/VideoPreviewPanel', () => ({ default: () => null }));
vi.mock('../components/videoGen/VideoGenGallery', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: () => null }));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/BatchQueuePanel', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));

const { default: VideoGen } = await import('./VideoGen.jsx');

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

const prompt = () => screen.getByLabelText('Prompt');
const generate = () => screen.getByRole('button', { name: /^Generate$/ });
const enqueue = () => screen.getByRole('button', { name: /Add to queue/ });
const termsCheckbox = () => screen.getByRole('checkbox', { name: /I am eligible/ });

describe('VideoGen restricted-model orchestration', () => {
  beforeEach(() => {
    localStorage.clear();
    state.modelStatuses = {
      [H3_ONE.id]: { id: H3_ONE.id, repo: H3_ONE.repo, cached: true, sizeBytes: 100 },
      [H3_TWO.id]: { id: H3_TWO.id, repo: H3_TWO.repo, cached: true, sizeBytes: 100 },
    };
    state.generateVideo.mockReset().mockResolvedValue({ jobId: 'job-1' });
    state.startDownload.mockReset();
    state.repairModel.mockReset().mockResolvedValue({ ok: true });
    state.enqueue.mockReset();
    state.acceptedTerms = [];
    state.setVideoModelTerms.mockReset().mockImplementation(async (termsId, accepted) => {
      state.acceptedTerms = accepted
        ? [...new Set([...state.acceptedTerms, termsId])]
        : state.acceptedTerms.filter((id) => id !== termsId);
      return { accepted: [...state.acceptedTerms] };
    });
    state.eventSourceRef.current = null;
    state.attach.mockReset().mockImplementation(async (_jobId, handlers) => {
      handlers.onComplete({ result: { filename: 'example.mp4' } });
      return { filename: 'example.mp4' };
    });
  });

  it('restores only the exact license, gates model switches, submit, queue, and revocation', async () => {
    // A pre-existing browser-local acknowledgement of this exact license id is
    // carried forward into the install-wide list once, then cleared — the user
    // already performed this acknowledgement and must not be asked again.
    localStorage.setItem(`video-gen:terms:${TERMS_ONE}`, '1');
    await renderPage();

    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_ONE.id));
    await waitFor(() => expect(termsCheckbox()).toBeChecked());
    expect(state.setVideoModelTerms).toHaveBeenCalledWith(TERMS_ONE, true, { silent: true });
    await waitFor(() => expect(localStorage.getItem(`video-gen:terms:${TERMS_ONE}`)).toBe('0'));
    fireEvent.change(prompt(), { target: { value: 'a fox watches the rain' } });

    await waitFor(() => expect(enqueue()).toBeEnabled());
    fireEvent.click(enqueue());
    // The payload carries no acceptance of its own — the server resolves it
    // from the install record, so nothing renders without a recorded (and
    // therefore withdrawable) acknowledgement.
    expect(state.enqueue).toHaveBeenCalledWith(expect.objectContaining({ modelId: H3_ONE.id }));
    expect(state.enqueue.mock.calls[0][0]).not.toHaveProperty('termsAcceptance');

    // A form submit models keyboard/Enter submission and must pass the same
    // gate as clicking Generate.
    await act(async () => {
      fireEvent.submit(prompt().closest('form'));
    });
    await waitFor(() => expect(state.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      modelId: H3_ONE.id,
    })));
    expect(state.generateVideo.mock.calls[0][0]).not.toHaveProperty('termsAcceptance');

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: H3_TWO.id } });
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue(H3_TWO.id));
    expect(termsCheckbox()).not.toBeChecked();
    expect(generate()).toBeDisabled();
    expect(enqueue()).toBeDisabled();
    expect(generate()).toHaveAttribute('aria-describedby', 'video-model-terms-requirement');
    expect(state.generateVideo).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: H3_ONE.id } });
    await waitFor(() => expect(termsCheckbox()).toBeChecked());
    fireEvent.click(termsCheckbox());
    expect(state.setVideoModelTerms).toHaveBeenLastCalledWith(TERMS_ONE, false, { silent: true });
    await waitFor(() => expect(generate()).toBeDisabled());
    expect(enqueue()).toBeDisabled();
  });

  it('blocks download until the acknowledgement is recorded', async () => {
    state.modelStatuses[H3_ONE.id] = { id: H3_ONE.id, repo: H3_ONE.repo, cached: false, sizeBytes: 0 };
    await renderPage();

    const download = await screen.findByRole('button', { name: /Download/ });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute('aria-describedby', 'video-model-terms-requirement');
    fireEvent.click(termsCheckbox());
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    expect(state.startDownload).toHaveBeenCalledWith(H3_ONE.id);
  });

  it('blocks integrity repair until the acknowledgement is recorded', async () => {
    state.modelStatuses[H3_ONE.id] = {
      id: H3_ONE.id,
      repo: H3_ONE.repo,
      cached: true,
      sizeBytes: 100,
      integrity: { status: 'bad', badFiles: [{ name: 'model.safetensors' }] },
    };
    await renderPage();

    const repair = await screen.findByRole('button', { name: /Repair model/ });
    expect(repair).toBeDisabled();
    expect(repair).toHaveAttribute('aria-describedby', 'video-model-terms-requirement');
    fireEvent.click(termsCheckbox());
    await waitFor(() => expect(repair).toBeEnabled());
    fireEvent.click(repair);
    expect(state.repairModel).toHaveBeenCalledWith(H3_ONE.id);
  });
});
