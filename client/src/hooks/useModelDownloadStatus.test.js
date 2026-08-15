import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// The hook's own SSE lifecycle is covered by useSseProgress's suite; here it
// only has to be inert and observable, so the tests can assert which download
// owns the lane without opening a real EventSource.
const sseState = vi.hoisted(() => ({ url: null }));
vi.mock('./useSseProgress.js', () => ({
  useSseProgress: (url) => {
    sseState.url = url;
    return { latest: null, closed: false, close: vi.fn() };
  },
}));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));
vi.mock('../services/apiImageVideo.js', () => ({
  getImageModelStatuses: vi.fn(async () => []),
  getVideoModelStatuses: vi.fn(async () => ({ models: [], textEncoder: null, textEncoderOptions: [], icLoras: [] })),
  verifyImageModels: vi.fn(),
  verifyVideoModels: vi.fn(),
  repairImageModel: vi.fn(),
  repairVideoModel: vi.fn(),
  repairTextEncoder: vi.fn(),
  repairTextEncoderOption: vi.fn(),
  repairIcLora: vi.fn(),
}));

const { getVideoModelStatuses } = await import('../services/apiImageVideo.js');
const {
  buildDownloadUrl, TEXT_ENCODER_DOWNLOAD_ID, textEncoderDownloadId, useModelDownloadStatus,
} = await import('./useModelDownloadStatus.js');

describe('buildDownloadUrl', () => {
  it('builds a plain model download URL', () => {
    // A restricted model's license acknowledgement is NOT a query parameter —
    // the server resolves it from the install record, so a download can't be
    // self-authorized by whoever builds this URL.
    expect(buildDownloadUrl('video', 'minimax_h3_8bit')).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download',
    );
  });

  it('adds the repair force flag without changing special routes', () => {
    expect(buildDownloadUrl('video', 'minimax_h3_8bit', true)).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download?force=1',
    );
    expect(buildDownloadUrl('video', TEXT_ENCODER_DOWNLOAD_ID, true)).toBe(
      '/api/video-gen/text-encoder/download?force=1',
    );
  });

  // Substitutable prompt conditioners (#4081) route to their own lane, and the
  // SHARED install-wide encoder keeps its separate scalar route — the two must
  // not collapse into one another.
  it('routes a substitutable text encoder to the per-id lane', () => {
    expect(buildDownloadUrl('video', textEncoderDownloadId('heretic-bf16'))).toBe(
      '/api/video-gen/text-encoders/heretic-bf16/download',
    );
    expect(buildDownloadUrl('video', textEncoderDownloadId('heretic-bf16'), true)).toBe(
      '/api/video-gen/text-encoders/heretic-bf16/download?force=1',
    );
  });

  // Routing keys on the namespace prefix, not the bare id, so a registry model
  // that ever shared an encoder's name can't be misrouted into the encoder lane.
  it('does not treat a bare encoder-shaped model id as an encoder', () => {
    expect(buildDownloadUrl('video', 'heretic-bf16')).toBe(
      '/api/video-gen/models/heretic-bf16/download',
    );
  });

  it('leaves image-gen ids on the model lane whatever they are named', () => {
    expect(buildDownloadUrl('image', textEncoderDownloadId('heretic-bf16'))).toBe(
      `/api/image-gen/models/${encodeURIComponent(textEncoderDownloadId('heretic-bf16'))}/download`,
    );
  });
});

// `startWhenIdle` — the "choosing an option IS the request for its weights"
// entry point. Everything it has to wait on belongs to this hook (the cache
// verdict and the single EventSource lane), which is why the policy lives here
// rather than in each picker that wants auto-download-on-select.
describe('startWhenIdle', () => {
  const ENCODER_ID = textEncoderDownloadId('heretic-bf16');

  const mountHook = async (encoderStatus, { onStatuses } = {}) => {
    getVideoModelStatuses.mockImplementation(async () => {
      onStatuses?.();
      return { models: [], textEncoder: null, textEncoderOptions: [encoderStatus], icLoras: [] };
    });
    const view = renderHook(() => useModelDownloadStatus({ kind: 'video' }));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    return view;
  };

  beforeEach(() => {
    getVideoModelStatuses.mockReset();
    sseState.url = null;
  });

  it('starts the pull for an id that is not cached', async () => {
    const { result } = await mountHook({ id: 'heretic-bf16', cached: false });
    act(() => { result.current.startWhenIdle(ENCODER_ID); });
    await waitFor(() => expect(result.current.activeModelId).toBe(ENCODER_ID));
    expect(result.current.queuedModelId).toBeNull();
  });

  // The whole point of the "if missing" half: re-pulling a resident multi-GB
  // repo because a picker was clicked is the failure this replaces.
  it('starts nothing for an id that is already cached', async () => {
    const { result } = await mountHook({ id: 'heretic-bf16', cached: true });
    act(() => { result.current.startWhenIdle(ENCODER_ID); });
    await waitFor(() => expect(result.current.queuedModelId).toBeNull());
    expect(result.current.activeModelId).toBeNull();
  });

  // One EventSource lane: starting here would abort the pull already on it.
  it('queues behind a download already in flight and starts when it frees up', async () => {
    const { result } = await mountHook({ id: 'heretic-bf16', cached: false });
    act(() => { result.current.start('some-model'); });
    act(() => { result.current.startWhenIdle(ENCODER_ID); });

    expect(result.current.activeModelId).toBe('some-model');
    expect(result.current.queuedModelId).toBe(ENCODER_ID);

    act(() => { result.current.cancel(); });
    await waitFor(() => expect(result.current.activeModelId).toBe(ENCODER_ID));
  });

  // The verdict usually hasn't landed at click time — the intent has to survive
  // until it does rather than resolve against an empty status list.
  it('holds the intent until the cache verdict lands', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    getVideoModelStatuses.mockImplementation(async () => {
      await gate;
      return { models: [], textEncoder: null, textEncoderOptions: [{ id: 'heretic-bf16', cached: false }], icLoras: [] };
    });
    const { result } = renderHook(() => useModelDownloadStatus({ kind: 'video' }));
    act(() => { result.current.startWhenIdle(ENCODER_ID); });
    expect(result.current.activeModelId).toBeNull();

    await act(async () => { release(); });
    await waitFor(() => expect(result.current.activeModelId).toBe(ENCODER_ID));
  });

  it('clears a queued intent when the caller passes nothing', async () => {
    const { result } = await mountHook({ id: 'heretic-bf16', cached: false });
    act(() => { result.current.start('some-model'); });
    act(() => { result.current.startWhenIdle(ENCODER_ID); });
    expect(result.current.queuedModelId).toBe(ENCODER_ID);

    act(() => { result.current.startWhenIdle(null); });
    expect(result.current.queuedModelId).toBeNull();
    act(() => { result.current.cancel(); });
    await waitFor(() => expect(result.current.activeModelId).toBeNull());
  });
});
