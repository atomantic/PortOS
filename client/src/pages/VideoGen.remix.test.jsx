import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  loadVideoGenPage,
  renderVideoGenPage,
  resetVideoGenMockState,
  state,
  videoGenModel,
  videoGenModelContext,
  videoGenStatus,
} from '../test/videoGenPageMocks.jsx';

/**
 * Cross-page Remix restores exactly what in-page Remix restores (#6290).
 *
 * Media History used to hand /media/video a field-by-field URL bundle built by
 * `useMediaPreviewActions`, a second restore implementation that fell behind the
 * page's own `applyRemix`: the conditioner, speed profile, draft decode and the
 * LoRA arrays were all missing from it, so the same saved clip came back with
 * stock/Quality/Full/no-LoRA settings from History and with its real settings
 * from the gallery — a different render at a different compute cost. The handoff
 * is now the RECORD ID, resolved here against the page's own history load and
 * replayed through the one restore implementation.
 */
const MODEL = videoGenModel('example-ltx', {
  name: 'Example LTX',
  runtime: 'ltx2',
  supportedModes: ['text', 'image'],
  defaultFrames: 121,
  frameOptions: [121, 241],
  fpsOptions: [24],
  samplerLocked: false,
  supportsNegativePrompt: true,
  supportsTiling: true,
  supportsDisableAudio: true,
  textEncoderOptions: [
    { id: 'stock', label: 'Stock conditioner', builtIn: true },
    { id: 'example-substitute', label: 'Example substitute' },
  ],
  speedProfiles: [{ id: 'turbo', label: 'Turbo', steps: 4, guidance: 1 }],
  draftDecodeOptions: [{ id: 'example-draft', label: 'Example draft decoder' }],
});

const LORA = { filename: 'lora-example.safetensors', name: 'Example LoRA', loraCompatKey: 'ltx-video' };

/**
 * A saved render carrying every field the old URL bundle dropped. `hidden` is
 * deliberate: History can open a hidden record, so the lookup has to run against
 * the unfiltered load rather than the gallery's visible slice.
 */
const RECORD = {
  id: 'vid-example-1',
  filename: 'example.mp4',
  prompt: 'a paper boat on a canal',
  negativePrompt: 'blurry',
  modelId: MODEL.id,
  width: 768,
  height: 512,
  numFrames: 121,
  fps: 24,
  seed: 42,
  steps: 12,
  guidanceScale: 3,
  tiling: 'none',
  disableAudio: true,
  textEncoderId: 'example-substitute',
  speedProfileId: 'turbo',
  draftDecode: 'example-draft',
  loraFilenames: [LORA.filename],
  loraScales: [0.7],
  chainedFrom: ['vid-example-a', 'vid-example-b'],
  chunkPrompts: ['the boat launches', 'the boat sinks'],
  hidden: true,
};

/** A record from before the optional render fields existed. */
const LEGACY_RECORD = {
  id: 'vid-legacy-1',
  filename: 'legacy.mp4',
  prompt: 'a kite over a field',
  modelId: MODEL.id,
  width: 768,
  height: 512,
  numFrames: 121,
  fps: 24,
};

await loadVideoGenPage();

/**
 * Everything the restore is responsible for, read off the live form: the
 * controls the page renders itself, plus the sampler/LoRA props it hands the
 * panels. One reading, so the two entry paths are compared on identical terms.
 */
const readRestoredForm = () => ({
  prompt: screen.getByLabelText('Prompt').value,
  negativePrompt: screen.getByLabelText('Negative Prompt').value,
  modelId: screen.getByLabelText('Model').value,
  textEncoderId: screen.getByLabelText('Text encoder').value,
  loras: (state.loraPicker?.selected || []).map((l) => `${l.filename}@${l.scale}`),
  numFrames: state.advancedParams?.numFrames,
  fps: state.advancedParams?.fps,
  seed: state.advancedParams?.seed,
  steps: state.advancedParams?.steps,
  guidanceScale: state.advancedParams?.guidanceScale,
  speedProfileId: state.advancedParams?.speedProfileId,
  draftDecode: state.advancedParams?.draftDecode,
  tiling: state.advancedParams?.tiling,
  disableAudio: state.advancedParams?.disableAudio,
  chunks: state.advancedParams?.chunks,
  chunkPrompts: state.advancedParams?.chunkPrompts,
});

describe('VideoGen cross-page Remix handoff', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetVideoGenMockState();
    state.getVideoGenStatus.mockResolvedValue(videoGenStatus([MODEL]));
    state.getVideoGenModelContext.mockResolvedValue(videoGenModelContext([MODEL]));
    state.attach.mockResolvedValue({ filename: 'example.mp4' });
    state.availableLoras = [LORA];
    state.listVideoHistory.mockResolvedValue([RECORD, LEGACY_RECORD]);
  });

  it('restores the same settings from a History handoff as from the in-page gallery', async () => {
    await renderVideoGenPage(`/media/video?remix=${RECORD.id}`);
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    const fromHistory = readRestoredForm();

    // The exact fields the old URL bundle dropped. Asserted by name as well as
    // by the equality below, so a regression that broke BOTH paths together
    // still fails this test rather than comparing two blank forms.
    expect(fromHistory.textEncoderId).toBe('example-substitute');
    expect(fromHistory.speedProfileId).toBe('turbo');
    expect(fromHistory.draftDecode).toBe('example-draft');
    expect(fromHistory.loras).toEqual(['lora-example.safetensors@0.7']);
    expect(fromHistory.chunks).toBe(2);
    expect(fromHistory.chunkPrompts).toEqual(RECORD.chunkPrompts);

    cleanup();
    await renderVideoGenPage();
    await act(async () => { state.galleryProps.onRemix(RECORD); });
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));

    expect(readRestoredForm()).toEqual(fromHistory);
  });

  it('resets the optional controls to their sentinels for a legacy record', async () => {
    await renderVideoGenPage(`/media/video?remix=${LEGACY_RECORD.id}`);
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(LEGACY_RECORD.prompt));

    const restored = readRestoredForm();
    expect(restored.textEncoderId).toBe('stock');
    expect(restored.speedProfileId).toBe('quality');
    expect(restored.draftDecode).toBe('full');
    expect(restored.loras).toEqual([]);
    expect(restored.steps).toBe('');
    expect(restored.guidanceScale).toBe('');
    expect(restored.chunks).toBe(1);
  });

  it('says nothing about a missing record while the history fetch is still in flight', async () => {
    let settleHistory;
    state.listVideoHistory.mockReturnValue(new Promise((resolve) => { settleHistory = resolve; }));
    await renderVideoGenPage(`/media/video?remix=${RECORD.id}`);

    // The pending fetch is not evidence of anything — claiming the record is
    // gone here would fire on every load that beats the round trip.
    expect(screen.queryByText(/no longer in your history/)).toBeNull();
    expect(screen.queryByText(/Couldn't load your render history/)).toBeNull();

    await act(async () => { settleHistory([RECORD]); });
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    expect(screen.queryByText(/no longer in your history/)).toBeNull();
  });

  it('offers a retry when the history fetch fails, and restores once it succeeds', async () => {
    state.listVideoHistory.mockRejectedValueOnce(new Error('offline'));
    await renderVideoGenPage(`/media/video?remix=${RECORD.id}`);

    // A failed fetch is not a missing record — the settings may be perfectly
    // intact on disk, so the notice has to be the retryable one.
    await screen.findByText(/Couldn't load your render history/);
    expect(screen.queryByText(/no longer in your history/)).toBeNull();

    state.listVideoHistory.mockResolvedValue([RECORD]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });

    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));
    expect(screen.queryByText(/Couldn't load your render history/)).toBeNull();
  });

  it('reports an actionable missing-record state when the load holds no such record', async () => {
    state.listVideoHistory.mockResolvedValue([LEGACY_RECORD]);
    await renderVideoGenPage('/media/video?remix=vid-deleted');

    await screen.findByText(/no longer in your history/);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(screen.queryByText(/no longer in your history/)).toBeNull();
  });

  it('does not replay the consumed handoff over the edits that follow it', async () => {
    await renderVideoGenPage(`/media/video?remix=${RECORD.id}`);
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue(RECORD.prompt));

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a paper boat at dusk' } });
    // The completion refresh re-fetches history — the handoff must not ride
    // along with it and overwrite what the user has typed since.
    await act(async () => { await state.completionRefresh.onVideoCompleted(); });

    expect(screen.getByLabelText('Prompt')).toHaveValue('a paper boat at dusk');
  });
});
