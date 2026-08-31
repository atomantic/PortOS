import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const extractLastFrame = vi.fn();
vi.mock('../services/api', () => ({ extractLastFrame: (...a) => extractLastFrame(...a) }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));

const { useVideoGenForm } = await import('./useVideoGenForm.js');

// Two runtimes matter to the payload shape: `ltx2` unlocks keyframes / LoRAs /
// a2v / IC remix and routes extend through the video id, `mlx_video` is the
// legacy path that extends from an extracted last frame.
// `lastFrameAnchored` is server-decorated onto every model by listVideoModels()
// (from LAST_FRAME_ANCHORED_RUNTIMES) — fixtures carry it as the payload does.
// `supportedModes` likewise: the registry resolves it for EVERY entry at load
// (server/lib/videoModeProfiles.js, #3737), so a model that reaches the client
// without one is not a shape the picker has to handle.
const RUNTIME_MODES = ['text', 'image', 'fflf', 'extend'];
const LTX2 = { id: 'ltx2-model', name: 'LTX-2.3', runtime: 'ltx2', lastFrameAnchored: true, supportedModes: [...RUNTIME_MODES, 'a2v'] };
const LTX25 = {
  id: 'ltx25-model',
  name: 'LTX-2.5',
  runtime: 'ltx25',
  lastFrameAnchored: true,
  supportedModes: [...RUNTIME_MODES, 'a2v'],
  audioDurationDriven: true,
  frameStride: 8,
  maxNumFrames: 1017,
};
const MLX = { id: 'mlx-model', name: 'LTX distilled', runtime: 'mlx_video', lastFrameAnchored: false, supportedModes: RUNTIME_MODES };
const WAN_T2V = { id: 'wan-t2v', name: 'Wan T2V', runtime: 'wan22', supportedModes: ['text'], frameStride: 4 };
const WAN_TI2V = { id: 'wan-ti2v', name: 'Wan TI2V', runtime: 'wan22', supportedModes: ['text', 'image'], frameStride: 4 };
const H3 = {
  id: 'minimax-h3', name: 'MiniMax H3', runtime: 'minimax_h3', supportedModes: ['text', 'image', 'fflf'],
  lastFrameAnchored: true,
  frameOptions: [107, 124, 141, 158], fpsOptions: [24], defaultFrames: 124,
  defaultWidth: 1344, defaultHeight: 768, resolutionStep: 32,
  resolutionOptions: [
    { label: '1536x672', w: 1536, h: 672 },
    { label: '1344x768', w: 1344, h: 768 },
    { label: '768x1344', w: 768, h: 1344 },
  ],
  supportsNegativePrompt: false, supportsTiling: false, supportsDisableAudio: false,
  samplerLocked: true,
  // Server-decorated per model (videoGen/local.js#decorateVideoModel) — the
  // client never derives this from a runtime name, so the fixture carries it
  // exactly as the /models payload does.
  textEncoderOptions: [
    { id: 'stock', label: 'Stock', description: 'Ships with the model.', builtIn: true },
    { id: 'heretic-bf16', label: 'Ultra-Heretic', description: 'Uncensored.', builtIn: false, sizeBytes: 51506295440 },
  ],
};
const H3_REF2VA = {
  id: 'minimax-h3-ref2va',
  name: 'MiniMax H3 Ref2VA',
  runtime: 'minimax_h3_ref2va',
  supportedModes: ['a2v'],
  requiresSourceImageForA2v: true,
  audioDurationDriven: true,
  arbitraryLengthAudio: true,
  maxReferenceAudioSeconds: 15,
  frameOptions: [107, 124, 141],
  fpsOptions: [24],
  defaultFrames: 124,
};
const MODELS = [MLX, LTX2];
const STATUS = { connected: true, defaultModel: MLX.id };

const render = ({ models = MODELS, status = STATUS, availableLoras = [], grokEnabled = false, url = '/media/video' } = {}) => {
  const wrapper = ({ children }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  return renderHook(
    (props) => useVideoGenForm(props),
    { wrapper, initialProps: { models, status, availableLoras, grokEnabled } },
  );
};

describe('useVideoGenForm', () => {
  beforeEach(() => {
    extractLastFrame.mockReset();
  });

  it('loads a music-library render from an Audio-to-Video handoff URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['audio bytes'], { type: 'audio/mpeg' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = render({ url: '/media/video?mode=a2v&audioFilename=example%20take.mp3' });

    await waitFor(() => expect(result.current.audioFile).toBeInstanceOf(File));
    expect(result.current.mode).toBe('a2v');
    expect(result.current.audioFile.name).toBe('example take.mp3');
    expect(fetchMock).toHaveBeenCalledWith('/data/music/example%20take.mp3');
    vi.unstubAllGlobals();
  });

  it('seeds the model from status.defaultModel without clobbering a URL pick', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));

    const remix = render({ url: '/media/video?modelId=ltx2-model&numFrames=49' });
    await waitFor(() => expect(remix.result.current.modelId).toBe(LTX2.id));
    expect(remix.result.current.numFrames).toBe(49);
  });

  it('builds a text-to-video payload with the empty-string sentinels the route expects', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.setPrompt('a cat'));

    const payload = result.current.buildGeneratePayload();
    expect(payload).toMatchObject({
      backend: 'local',
      prompt: 'a cat',
      modelId: MLX.id,
      mode: 'text',
      width: 768,
      height: 512,
      disableAudio: 'false',
      // Every mode-specific channel is blanked in text mode so nothing stale
      // rides along.
      sourceImageFile: '', sourceImage: '', lastImageFile: '', lastImage: '',
      extendFromVideoId: '', audioFile: '', keyframes: '', chunks: '',
      icReference: '', icReferenceVideoIds: '', icStrength: '', icSkipStage2: '',
    });
    expect(payload.loraFilenames).toBeUndefined();
  });

  it('appends the no-music constraint only while audio generation is on', async () => {
    const { result } = render();
    act(() => { result.current.setPrompt('a cat'); result.current.setNoMusic(true); });
    expect(result.current.buildGeneratePayload().prompt).toBe('a cat\n\nno music, no soundtrack');

    act(() => result.current.setDisableAudio(true));
    expect(result.current.buildGeneratePayload().prompt).toBe('a cat');

    // Idempotent — the user already said it themselves.
    act(() => { result.current.setDisableAudio(false); result.current.setPrompt('No Music please'); });
    expect(result.current.buildGeneratePayload().prompt).toBe('No Music please');
  });

  it('sends the grok payload shape when the grok backend is selected', async () => {
    const { result } = render({ grokEnabled: true });
    act(() => result.current.setPrompt('a cat'));
    act(() => result.current.handleBackendChange('grok'));
    expect(result.current.isGrok).toBe(true);

    const payload = result.current.buildGeneratePayload();
    expect(payload.backend).toBe('grok');
    expect(payload.mode).toBe('text');
    expect(payload.grokDuration).toBeTypeOf('number');
    // Local-only knobs must not ride along — the grok lane ignores them.
    expect(payload.modelId).toBeUndefined();
    expect(payload.numFrames).toBeUndefined();
  });

  it('snaps an unsupported mode back when switching to grok, clearing that mode inputs', async () => {
    const { result } = render({ grokEnabled: true });
    act(() => result.current.handleModeChange('a2v'));
    act(() => result.current.setAudioFile(new File(['x'], 'a.wav')));
    expect(result.current.audioFile).toBeTruthy();

    act(() => result.current.handleBackendChange('grok'));
    expect(result.current.mode).toBe('text');
    expect(result.current.audioFile).toBeNull();
  });

  it('routes extend through the video id on ltx2 and through the extracted frame on mlx_video', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));

    extractLastFrame.mockResolvedValue({ filename: 'last.png' });
    act(() => result.current.handleModeChange('extend'));
    await act(async () => { await result.current.handleExtendPick('vid-1'); });
    expect(extractLastFrame).toHaveBeenCalledWith('vid-1', { silent: true });
    expect(result.current.sourceImageFile).toBe('last.png');
    expect(result.current.extendingFrame).toBe(false);
    expect(result.current.extendModeBlocked).toBe(false);

    let payload = result.current.buildGeneratePayload();
    expect(payload.sourceImageFile).toBe('last.png');
    expect(payload.extendFromVideoId).toBe('');

    // ltx2 skips the ffmpeg roundtrip entirely and sends the id.
    extractLastFrame.mockClear();
    act(() => result.current.handleModelChange(LTX2.id));
    await act(async () => { await result.current.handleExtendPick('vid-2'); });
    expect(extractLastFrame).not.toHaveBeenCalled();
    payload = result.current.buildGeneratePayload();
    expect(payload.extendFromVideoId).toBe('vid-2');
    expect(payload.sourceImageFile).toBe('');
  });

  it('prefills the prompt from the render being continued, dropping the style preset', async () => {
    const first = { id: 'vid-1', prompt: 'a neon alley, rain', negativePrompt: 'blurry' };
    const second = { id: 'vid-2', prompt: 'a desert highway' };
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    // The stored prompt is already style-composed; leaving a preset selected
    // would prefix a second one onto it at submit.
    act(() => result.current.setStylePreset({ id: 'noir', prompt: 'film noir' }));

    extractLastFrame.mockResolvedValue({ filename: 'last.png' });
    act(() => result.current.handleModeChange('extend'));
    await act(async () => { await result.current.handleExtendPick('vid-1', first); });
    expect(result.current.prompt).toBe('a neon alley, rain');
    expect(result.current.negativePrompt).toBe('blurry');
    expect(result.current.stylePreset).toBeNull();
    expect(result.current.buildGeneratePayload().prompt).toBe('a neon alley, rain');

    // Re-picking replaces the earlier auto-fill rather than stranding it, and
    // a source with no negative leaves the earlier fill standing (not wiped).
    await act(async () => { await result.current.handleExtendPick('vid-2', second); });
    expect(result.current.prompt).toBe('a desert highway');
    expect(result.current.negativePrompt).toBe('blurry');
  });

  it('never clobbers a typed prompt, and leaves it alone for a source with none', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    extractLastFrame.mockResolvedValue({ filename: 'last.png' });
    act(() => result.current.handleModeChange('extend'));

    act(() => result.current.setPrompt('my own direction'));
    await act(async () => {
      await result.current.handleExtendPick('vid-1', { id: 'vid-1', prompt: 'a neon alley, rain' });
    });
    expect(result.current.prompt).toBe('my own direction');

    // A clip we didn't generate carries no prompt — prefill is a no-op, not a wipe.
    await act(async () => {
      await result.current.handleExtendPick('imported', { id: 'imported', filename: 'clip.mp4' });
    });
    expect(result.current.prompt).toBe('my own direction');
  });

  it('ignores a stale extract when a newer pick has already landed', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.handleModeChange('extend'));

    let releaseFirst;
    extractLastFrame
      .mockImplementationOnce(() => new Promise((res) => { releaseFirst = () => res({ filename: 'stale.png' }); }))
      .mockResolvedValueOnce({ filename: 'fresh.png' });

    let firstPick;
    act(() => { firstPick = result.current.handleExtendPick('vid-A'); });
    await act(async () => { await result.current.handleExtendPick('vid-B'); });
    await act(async () => { releaseFirst(); await firstPick; });

    expect(result.current.sourceImageFile).toBe('fresh.png');
  });

  it('blocks a2v until an audio file and an ltx2 model are both present', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.handleModeChange('a2v'));
    // The compatibility effect swaps to the only a2v-capable model.
    await waitFor(() => expect(result.current.modelId).toBe(LTX2.id));
    expect(result.current.a2vModeBlocked).toBe(true);

    const wav = new File(['x'], 'drums.wav');
    act(() => result.current.setAudioFile(wav));
    expect(result.current.a2vModeBlocked).toBe(false);
    expect(result.current.buildGeneratePayload().audioFile).toBe(wav);
  });

  it('requires and submits both image and audio for MiniMax H3 Ref2VA', async () => {
    const { result } = render({ models: [MLX, H3_REF2VA] });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.handleModeChange('a2v'));
    await waitFor(() => expect(result.current.modelId).toBe(H3_REF2VA.id));

    const wav = new File(['audio'], 'awakening.wav', { type: 'audio/wav' });
    act(() => result.current.setAudioFile(wav));
    expect(result.current.a2vModeBlocked).toBe(true);

    act(() => result.current.pickSourceImage('awakening-reference.png'));
    expect(result.current.a2vModeBlocked).toBe(false);
    expect(result.current.buildGeneratePayload()).toMatchObject({
      mode: 'a2v',
      modelId: H3_REF2VA.id,
      audioFile: wav,
      sourceImageFile: 'awakening-reference.png',
    });
  });

  it('derives an LTX-2.5 frame canvas from the full uploaded audio duration', async () => {
    const { result } = render({ models: [MLX, LTX25] });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.handleModeChange('a2v'));
    await waitFor(() => expect(result.current.modelId).toBe(LTX25.id));

    const wav = new File(['audio'], 'forty-one-seconds.wav', { type: 'audio/wav' });
    act(() => {
      result.current.setAudioFile(wav);
      result.current.setAudioDurationSec(41.041281);
    });
    await waitFor(() => expect(result.current.numFrames).toBe(985));
    expect(result.current.a2vModeBlocked).toBe(false);
    expect(result.current.buildGeneratePayload()).toMatchObject({
      mode: 'a2v',
      modelId: LTX25.id,
      audioFile: wav,
      sourceImageFile: '',
      numFrames: 985,
    });
  });

  it('blocks an LTX-2.5 A2V file that exceeds its single-pass frame boundary', async () => {
    const { result } = render({ models: [MLX, LTX25] });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.handleModeChange('a2v'));
    await waitFor(() => expect(result.current.modelId).toBe(LTX25.id));
    act(() => {
      result.current.setAudioFile(new File(['audio'], 'one-minute.wav', { type: 'audio/wav' }));
      result.current.setAudioDurationSec(60);
    });
    expect(result.current.a2vModeBlocked).toBe(true);
    expect(result.current.a2vDurationError).toMatch(/supports up to 42\.4s/i);
  });

  it('clears sampler overrides on an automatic mode-compatible model fallback', async () => {
    const { result } = render({
      models: [WAN_T2V, WAN_TI2V],
      status: { connected: true, defaultModel: WAN_T2V.id },
    });
    await waitFor(() => expect(result.current.modelId).toBe(WAN_T2V.id));
    act(() => {
      result.current.setSteps('17');
      result.current.setGuidanceScale('6');
      result.current.handleModeChange('image');
    });
    await waitFor(() => expect(result.current.modelId).toBe(WAN_TI2V.id));
    expect(result.current.steps).toBe('');
    expect(result.current.guidanceScale).toBe('');
  });

  it('does not submit chunks for a T2V-only Wan profile', async () => {
    const { result } = render({
      models: [WAN_T2V],
      status: { connected: true, defaultModel: WAN_T2V.id },
    });
    await waitFor(() => expect(result.current.modelId).toBe(WAN_T2V.id));
    act(() => {
      result.current.setPrompt('a test');
      result.current.setChunks(3);
    });
    expect(result.current.buildGeneratePayload().chunks).toBe('');
  });

  it('normalizes MiniMax H3 to its fixed temporal and sampler contract', async () => {
    const { result } = render({
      models: [MLX, H3],
      status: { connected: true, defaultModel: MLX.id },
    });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => {
      result.current.setPrompt('a fox watches the rain');
      result.current.setNegativePrompt('blurry');
      result.current.setNumFrames(129);
      result.current.setFps(30);
      result.current.setTiling('full');
      result.current.setDisableAudio(true);
      result.current.setNoMusic(true);
      result.current.handleModelChange(H3.id);
    });
    await waitFor(() => expect(result.current.modelId).toBe(H3.id));
    await waitFor(() => expect(result.current.numFrames).toBe(124));

    expect(result.current.mode).toBe('text');
    const payload = result.current.buildGeneratePayload();
    expect(payload).toMatchObject({
      modelId: H3.id,
      mode: 'text',
      negativePrompt: '',
      numFrames: 124,
      fps: 24,
      tiling: 'auto',
      disableAudio: 'false',
      width: 1344,
      height: 768,
    });
    expect(payload.prompt).toBe('a fox watches the rain\n\nno music, no soundtrack');
  });

  // Substitutable prompt conditioner (#4081).
  describe('text encoder selection', () => {
    const renderWithH3 = async () => {
      const rendered = render({ models: [MLX, H3], status: { connected: true, defaultModel: MLX.id } });
      await waitFor(() => expect(rendered.result.current.modelId).toBe(MLX.id));
      act(() => rendered.result.current.handleModelChange(H3.id));
      await waitFor(() => expect(rendered.result.current.modelId).toBe(H3.id));
      return rendered;
    };

    // An empty list is what hides the picker; a model with substitutions
    // exposes them straight off the server-decorated entry.
    it('exposes only the selected model’s options', async () => {
      const { result } = render({ models: [MLX, H3], status: { connected: true, defaultModel: MLX.id } });
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      expect(result.current.textEncoderOptions).toEqual([]);
      act(() => result.current.handleModelChange(H3.id));
      await waitFor(() => expect(result.current.textEncoderOptions).toHaveLength(2));
    });

    // The stock choice must submit the same body a request that never knew
    // about this knob would — the server treats absence and 'stock' identically,
    // so sending the sentinel would only add noise to persisted job params.
    it('drops the stock choice from the payload', async () => {
      const { result } = await renderWithH3();
      expect(result.current.textEncoderId).toBe('stock');
      act(() => result.current.setPrompt('a fox'));
      expect(result.current.buildGeneratePayload().textEncoderId).toBeUndefined();
    });

    it('submits an explicitly chosen substitute', async () => {
      const { result } = await renderWithH3();
      act(() => {
        result.current.setPrompt('a fox');
        result.current.setTextEncoderId('heretic-bf16');
      });
      await waitFor(() => expect(result.current.textEncoderId).toBe('heretic-bf16'));
      expect(result.current.buildGeneratePayload().textEncoderId).toBe('heretic-bf16');
    });

    // Switching to a model that can't load the selection has to snap it back,
    // or the <select> sits on a value with no matching <option> and the submit
    // 400s with VIDEO_TEXT_ENCODER_UNSUPPORTED.
    it('resets to stock when the model changes to one without that option', async () => {
      const { result } = await renderWithH3();
      act(() => result.current.setTextEncoderId('heretic-bf16'));
      await waitFor(() => expect(result.current.textEncoderId).toBe('heretic-bf16'));

      act(() => result.current.handleModelChange(MLX.id));
      await waitFor(() => expect(result.current.textEncoderId).toBe('stock'));
      act(() => result.current.setPrompt('a fox'));
      expect(result.current.buildGeneratePayload().textEncoderId).toBeUndefined();
    });

    // History records the conditioner only for a non-stock render, so a remix
    // of a stock render must CLEAR a leftover selection rather than carry it
    // into a render the user asked to reproduce faithfully.
    it.each([
      ['restores a recorded substitute', { textEncoderId: 'heretic-bf16' }, 'heretic-bf16', H3.id],
      ['clears the selection when the record has none', {}, 'stock', MLX.id],
    ])('%s on remix', async (_label, extra, expected, expectedModelId) => {
      const { result } = await renderWithH3();
      act(() => result.current.setTextEncoderId('heretic-bf16'));
      await waitFor(() => expect(result.current.textEncoderId).toBe('heretic-bf16'));

      act(() => result.current.applyRemix({ modelId: H3.id, prompt: 'a fox', ...extra }));
      await waitFor(() => expect(result.current.textEncoderId).toBe(expected));
      expect(result.current.modelId).toBe(expectedModelId);
    });

    it('restores a resumed in-flight render’s conditioner', async () => {
      const { result } = await renderWithH3();
      act(() => result.current.applyResumedParams({ modelId: H3.id, prompt: 'a fox', textEncoderId: 'heretic-bf16' }));
      await waitFor(() => expect(result.current.textEncoderId).toBe('heretic-bf16'));
    });
  });

  it('preserves H3 native 32px-grid geometry in the submitted payload', async () => {
    const { result } = render({
      models: [MLX, H3],
      status: { connected: true, defaultModel: MLX.id },
    });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.handleModelChange(H3.id));
    await waitFor(() => expect(result.current.modelId).toBe(H3.id));
    act(() => result.current.handleResolutionChange(1536, 672));
    expect(result.current.width).toBe(1536);
    expect(result.current.height).toBe(672);
    expect(result.current.buildGeneratePayload()).toMatchObject({ width: 1536, height: 672 });
  });

  // H3's fl2va path anchors keyframes at the first/last latent frame, so image
  // mode (and therefore chunk chaining, which re-seeds from the prior chunk's
  // last frame) is available — and its last frame is a real anchor, not a hint.
  it('offers MiniMax H3 image mode, chaining and a non-advisory last frame', async () => {
    const { result } = render({
      models: [MLX, H3],
      status: { connected: true, defaultModel: MLX.id },
    });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => {
      result.current.setPrompt('a fox watches the rain');
      result.current.setChunks(3);
      result.current.handleModelChange(H3.id);
    });
    await waitFor(() => expect(result.current.modelId).toBe(H3.id));

    expect(result.current.chainingActive).toBe(true);
    expect(result.current.buildGeneratePayload().chunks).toBe(3);
    expect(result.current.lastFrameIsAdvisory).toBe(false);
    act(() => result.current.handleModeChange('image'));
    await waitFor(() => expect(result.current.mode).toBe('image'));
    expect(result.current.modelId).toBe(H3.id);
  });

  it('keeps the advisory last-frame note on a single-frame mlx_video runtime', async () => {
    const { result } = render({ models: [MLX, H3] });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    expect(result.current.lastFrameIsAdvisory).toBe(true);
  });

  describe('per-chunk prompt beats (#3695)', () => {
    const chained = async (count = 3) => {
      const { result } = render();
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      act(() => { result.current.setPrompt('a long shot'); result.current.setChunks(count); });
      return result;
    };

    it('serializes the beats as JSON, keeping a blank beat in position', async () => {
      const result = await chained(3);
      act(() => result.current.setChunkPromptAt(0, 'she opens the door'));
      act(() => result.current.setChunkPromptAt(2, 'the storm breaks'));

      expect(result.current.chainingActive).toBe(true);
      // A blank middle beat keeps its POSITION — that's what tells the server
      // chunk 2 falls back to the main prompt rather than shifting beat 3 up.
      expect(JSON.parse(result.current.buildGeneratePayload().chunkPrompts))
        .toEqual(['she opens the door', '', 'the storm breaks']);
    });

    it('keeps text for chunks beyond the current count so lowering then raising restores it', async () => {
      const result = await chained(3);
      act(() => { result.current.setChunkPromptAt(0, 'first'); result.current.setChunkPromptAt(2, 'third'); });

      act(() => result.current.setChunks(2));
      expect(JSON.parse(result.current.buildGeneratePayload().chunkPrompts)).toEqual(['first', '']);

      act(() => result.current.setChunks(3));
      expect(JSON.parse(result.current.buildGeneratePayload().chunkPrompts))
        .toEqual(['first', '', 'third']);
    });

    it('omits the beats when every one is blank', async () => {
      const result = await chained(2);
      act(() => result.current.setChunkPromptAt(0, '   '));
      expect(result.current.buildGeneratePayload().chunkPrompts).toBe('');
    });

    it('omits the beats when the request does not chain', async () => {
      const result = await chained(1);
      act(() => result.current.setChunkPromptAt(0, 'a stale beat'));
      expect(result.current.chainingActive).toBe(false);
      expect(result.current.buildGeneratePayload().chunkPrompts).toBe('');
    });

    it('omits the beats for a mode the server pins to one chunk', async () => {
      const result = await chained(3);
      act(() => result.current.handleModelChange(LTX2.id));
      act(() => result.current.handleModeChange('fflf'));
      act(() => result.current.toggleKeyframesMode());
      act(() => result.current.setChunkPromptAt(0, 'a beat'));

      expect(result.current.keyframesActive).toBe(true);
      expect(result.current.chainingActive).toBe(false);
      expect(result.current.buildGeneratePayload().chunkPrompts).toBe('');
    });

    it('wraps each beat in the same style/no-music envelope as the main prompt', async () => {
      // A raw beat would render its chunk without the style preset (and with the
      // soundtrack the user disabled) while the fallback chunks keep both — a
      // visible change at exactly the seams chaining exists to smooth over.
      const result = await chained(2);
      act(() => {
        result.current.setStylePreset({ prompt: 'film noir', negativePrompt: 'blurry' });
        result.current.setNoMusic(true);
        result.current.setChunkPromptAt(1, 'the storm breaks');
      });

      const payload = result.current.buildGeneratePayload();
      expect(payload.prompt).toBe('film noir. a long shot\n\nno music, no soundtrack');
      expect(JSON.parse(payload.chunkPrompts)).toEqual([
        '',
        'film noir. the storm breaks\n\nno music, no soundtrack',
      ]);
    });

    it('restores the beats and the chunk count when remixing a chained clip', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      act(() => result.current.applyRemix({
        prompt: 'a long shot',
        chainedFrom: ['a', 'b', 'c'],
        chunkPrompts: ['she opens the door', null, 'the storm breaks'],
      }));
      expect(result.current.chunks).toBe(3);
      expect(result.current.chunkPrompts).toEqual(['she opens the door', '', 'the storm breaks']);
    });

    it('clears stale beats when remixing a clip that never chained', async () => {
      // Otherwise a "faithful reproduction" remix is steered by beats the user
      // typed for a render they never submitted.
      const result = await chained(3);
      act(() => result.current.setChunkPromptAt(0, 'a stale beat'));
      act(() => result.current.applyRemix({ prompt: 'an unrelated clip' }));
      expect(result.current.chunks).toBe(1);
      expect(result.current.chunkPrompts).toEqual([]);
      expect(result.current.buildGeneratePayload().chunkPrompts).toBe('');
    });

    it('submits the continuation window only while chaining', async () => {
      const result = await chained(3);
      expect(result.current.buildGeneratePayload().contextFrames).toBe('22');
      act(() => result.current.setChunks(1));
      // A single-chunk render has nothing to continue from, so the knob must
      // not ride along and be persisted into that job's params.
      expect(result.current.buildGeneratePayload().contextFrames).toBe('');
    });

    it('submits a chosen 0 rather than dropping it as falsy', async () => {
      // buildFormData skips '' — sending the number 0 raw would be skipped too,
      // and the server would default the user straight back to a window.
      const result = await chained(2);
      act(() => result.current.setContextFrames(0));
      expect(result.current.buildGeneratePayload().contextFrames).toBe('0');
    });

    it('restores a resumed 0 instead of treating it as unset', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      act(() => result.current.applyResumedParams({
        prompt: 'a long shot',
        chunks: 2,
        contextFrames: 0,
      }));
      expect(result.current.contextFrames).toBe(0);
    });

    it('restores a numeric-string context window without losing an explicit 0', async () => {
      // The route persists a number, but a share link or hand-rolled client
      // sends '0'. Rejecting the string would silently put the render back on
      // a 22-frame window after the user chose last-frame chaining.
      const { result } = render();
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      act(() => result.current.applyResumedParams({ prompt: 'p', chunks: 2, contextFrames: '0' }));
      expect(result.current.contextFrames).toBe(0);

      act(() => result.current.applyResumedParams({ prompt: 'p', chunks: 2, contextFrames: '45' }));
      expect(result.current.contextFrames).toBe(45);
    });

    it('leaves the context window alone when the resumed job carries none', async () => {
      // Number(null) and Number('') are both a finite 0 — folding the absence
      // test into the numeric check would clear the default to 0 here.
      const { result } = render();
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      act(() => result.current.applyResumedParams({ prompt: 'p', chunks: 2 }));
      expect(result.current.contextFrames).toBe(22);
      act(() => result.current.applyResumedParams({ prompt: 'p', chunks: 2, contextFrames: '' }));
      expect(result.current.contextFrames).toBe(22);
    });

    it('restores beats from a resumed job, mapping the server null back to blank', async () => {
      const { result } = render();
      await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
      act(() => result.current.applyResumedParams({
        prompt: 'a long shot',
        chunks: 3,
        chunkPrompts: ['she opens the door', null, 'the storm breaks'],
      }));
      expect(result.current.chunkPrompts).toEqual(['she opens the door', '', 'the storm breaks']);
      expect(JSON.parse(result.current.buildGeneratePayload().chunkPrompts))
        .toEqual(['she opens the door', '', 'the storm breaks']);
    });
  });

  it('serializes keyframes as JSON and suppresses chunking while they are active', async () => {
    const { result } = render();
    act(() => result.current.handleModelChange(LTX2.id));
    act(() => result.current.handleModeChange('fflf'));
    act(() => result.current.setChunks(3));
    act(() => result.current.toggleKeyframesMode());
    expect(result.current.keyframesActive).toBe(true);
    // Seeded empty rows block until the user picks gallery files.
    expect(result.current.keyframesBlocked).toBe(true);

    act(() => { result.current.updateKeyframe(0, { file: 'a.png' }); result.current.updateKeyframe(1, { file: 'b.png' }); });
    expect(result.current.keyframesError).toBeNull();

    const payload = result.current.buildGeneratePayload();
    expect(JSON.parse(payload.keyframes)).toHaveLength(2);
    expect(payload.chunks).toBe('');
    // The legacy first/last pair is mutually exclusive with keyframes.
    expect(payload.lastImageFile).toBe('');
  });

  it('rejects non-ascending keyframe indices', async () => {
    const { result } = render();
    act(() => result.current.handleModelChange(LTX2.id));
    act(() => result.current.handleModeChange('fflf'));
    act(() => result.current.toggleKeyframesMode());
    act(() => {
      result.current.updateKeyframe(0, { file: 'a.png', index: 5 });
      result.current.updateKeyframe(1, { file: 'b.png', index: 2 });
    });
    expect(result.current.keyframesError).toMatch(/strictly ascending/);
    expect(result.current.keyframesBlocked).toBe(true);
  });

  it('keeps the IC clip and image reference channels apart', async () => {
    const { result } = render();
    act(() => result.current.handleModelChange(LTX2.id));

    act(() => result.current.handleModeChange('ic-control'));
    expect(result.current.icModeActive).toBe(true);
    expect(result.current.icLoraModeBlocked).toBe(true);
    act(() => result.current.pickIcReferenceVideoId('ref-1'));
    let payload = result.current.buildGeneratePayload();
    expect(payload.icReferenceVideoIds).toBe('ref-1');
    expect(payload.icReferenceImageFiles).toBeUndefined();

    // An upload wins over the history pick — the route rejects both at once.
    const clip = new File(['x'], 'ref.mp4');
    act(() => result.current.pickIcReferenceFile(clip));
    expect(result.current.icReferenceVideoId).toBe('');
    payload = result.current.buildGeneratePayload();
    expect(payload.icReference).toBe(clip);
    expect(payload.icReferenceVideoIds).toBe('');

    // Image-kind weights use the gallery row list and blank the clip fields.
    act(() => result.current.handleModeChange('ic-ingredients'));
    await waitFor(() => expect(result.current.icReferenceImageFiles).toHaveLength(2));
    act(() => { result.current.updateIcReferenceImage(0, 'a.png'); result.current.updateIcReferenceImage(1, 'b.png'); });
    payload = result.current.buildGeneratePayload();
    expect(payload.icReferenceImageFiles).toEqual(['a.png', 'b.png']);
    expect(payload.icReference).toBe('');
    expect(payload.icReferenceVideoIds).toBe('');
  });

  it('only sends LoRAs on a runtime that can fuse them', async () => {
    const loras = [{ filename: 'v.safetensors', name: 'V', loraCompatKey: 'ltx-video' }];
    const { result } = render({ availableLoras: loras });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => result.current.setSelectedLoras([{ filename: 'v.safetensors', name: 'V', scale: 0.8 }]));

    // mlx_video can't fuse — the picker is hidden and the payload omits them.
    expect(result.current.loraFamily).toBeFalsy();
    expect(result.current.buildGeneratePayload().loraFilenames).toBeUndefined();

    act(() => result.current.handleModelChange(LTX2.id));
    const payload = result.current.buildGeneratePayload();
    expect(payload.loraFilenames).toEqual(['v.safetensors']);
    expect(payload.loraScales).toEqual([0.8]);
  });

  it('applyRemix restores a stitched chain\'s render params and clears stale conditioning inputs', async () => {
    const { result } = render();
    act(() => result.current.handleModeChange('image'));
    act(() => result.current.pickSourceImage('old.png'));
    expect(result.current.sourceImageFile).toBe('old.png');

    act(() => result.current.applyRemix({
      prompt: 'remixed', negativePrompt: 'blurry', modelId: LTX2.id,
      width: 1024, height: 576, numFrames: 49, fps: 30, seed: 7,
      steps: 20, guidanceScale: 0, tiling: 'spatial', disableAudio: true,
      imageStrength: 0.35, chainedFrom: ['chunk-a', 'chunk-b'],
      chunkPrompts: ['opening beat', 'closing beat'],
      loraFilenames: ['v.safetensors'], loraScales: [0.5],
    }));

    expect(result.current.prompt).toBe('remixed');
    expect(result.current.negativePrompt).toBe('blurry');
    expect(result.current.modelId).toBe(LTX2.id);
    expect(result.current.width).toBe(1024);
    expect(result.current.height).toBe(576);
    expect(result.current.numFrames).toBe(49);
    expect(result.current.fps).toBe(30);
    expect(result.current.seed).toBe('7');
    expect(result.current.steps).toBe('20');
    // guidanceScale 0 (CFG off) must survive the round-trip as "0", not "".
    expect(result.current.guidanceScale).toBe('0');
    expect(result.current.tiling).toBe('spatial');
    expect(result.current.disableAudio).toBe(true);
    expect(result.current.imageStrength).toBe('0.35');
    expect(result.current.chunks).toBe(2);
    expect(result.current.chunkPrompts).toEqual(['opening beat', 'closing beat']);
    expect(result.current.mode).toBe('text');
    expect(result.current.sourceImageFile).toBeNull();
    expect(result.current.selectedLoras).toEqual([
      { filename: 'v.safetensors', name: 'v.safetensors', scale: 0.5 },
    ]);
  });

  it('moves a fixed-profile remix to an editable model while preserving its restored controls', async () => {
    const { result } = render({
      models: [MLX, H3],
      status: { connected: true, defaultModel: MLX.id },
    });
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));

    act(() => result.current.applyRemix({
      modelId: H3.id,
      prompt: 'a fox in rain',
      negativePrompt: 'blurry',
      steps: 9,
      guidanceScale: 0,
    }));

    await waitFor(() => expect(result.current.remixModelFallback).toEqual({
      sourceName: H3.name,
      targetName: MLX.name,
      samplerLocked: true,
      negativePromptUnsupported: true,
    }));
    expect(result.current.modelId).toBe(MLX.id);
    expect(result.current.negativePrompt).toBe('blurry');
    expect(result.current.steps).toBe('9');
    expect(result.current.guidanceScale).toBe('0');
  });

  it('uses the same editable-model fallback for a cross-page Remix handoff', async () => {
    const { result } = render({
      models: [MLX, H3],
      status: { connected: true, defaultModel: MLX.id },
      url: `/media/video?modelId=${H3.id}&numFrames=124&steps=9&guidanceScale=0`,
    });

    await waitFor(() => expect(result.current.remixModelFallback).toEqual({
      sourceName: H3.name,
      targetName: MLX.name,
      samplerLocked: true,
      negativePromptUnsupported: true,
    }));
    expect(result.current.modelId).toBe(MLX.id);
    expect(result.current.steps).toBe('9');
    expect(result.current.guidanceScale).toBe('0');
  });

  it('applyRemix clears fields the record does not carry rather than leaving stale ones', async () => {
    const { result } = render();
    act(() => { result.current.setSteps('40'); result.current.setGuidanceScale('7'); result.current.setNegativePrompt('old neg'); });
    act(() => result.current.applyRemix({ prompt: '(no prompt)' }));
    expect(result.current.prompt).toBe('');
    expect(result.current.negativePrompt).toBe('');
    expect(result.current.steps).toBe('');
    expect(result.current.guidanceScale).toBe('');
  });

  it('applyFinish keeps the draft seed but drops its sampler for the delivery model (#3696)', async () => {
    const { result } = render();
    act(() => result.current.applyFinish({
      prompt: 'a quiet street at dusk', negativePrompt: 'blurry', modelId: MLX.id,
      width: 768, height: 512, numFrames: 49, fps: 24, seed: 424242,
      steps: 4, guidanceScale: 1, mode: 'text',
    }, LTX2.id));

    // The whole point: same prompt + same seed, rendered on the delivery model
    // at ITS defaults ('' = "use the model's own steps/guidance") rather than
    // the draft's 4-step / guidance-1.0 sampler.
    expect(result.current.modelId).toBe(LTX2.id);
    expect(result.current.seed).toBe('424242');
    expect(result.current.prompt).toBe('a quiet street at dusk');
    expect(result.current.negativePrompt).toBe('blurry');
    expect(result.current.numFrames).toBe(49);
    expect(result.current.steps).toBe('');
    expect(result.current.guidanceScale).toBe('');
    expect(result.current.mode).toBe('text');
  });

  // #5449 — applyFinish resets the decode, but a user can also reach a delivery
  // model by hand from the Model dropdown. Without the same clamp there the
  // form would submit a draft decode the server declines, and persist a knob
  // that changed nothing on the render.
  it('clamps a draft decode to full when a delivery model is picked by hand', async () => {
    const DECODE_OPTIONS = [
      { id: 'full', label: 'Full decode' },
      { id: 'draft', label: 'Example draft decoder' },
    ];
    const draft = { ...MLX, finishModelId: LTX2.id, draftDecodeOptions: DECODE_OPTIONS };
    const delivery = { ...LTX2, draftDecodeOptions: DECODE_OPTIONS };
    const { result } = render({ models: [draft, delivery] });
    await waitFor(() => expect(result.current.modelId).toBe(draft.id));

    act(() => result.current.setDraftDecode('draft'));
    await waitFor(() => expect(result.current.draftDecode).toBe('draft'));

    act(() => result.current.handleModelChange(delivery.id));
    await waitFor(() => expect(result.current.draftDecode).toBe('full'));
  });
  it('applyFinish switches off the grok backend so the delivery model is what actually renders', async () => {
    const { result } = render({ grokEnabled: true });
    act(() => result.current.handleBackendChange('grok'));
    expect(result.current.isGrok).toBe(true);

    act(() => result.current.applyFinish({
      prompt: 'a quiet street at dusk', modelId: MLX.id, seed: 424242, mode: 'text',
    }, LTX2.id));

    // Leaving the form on grok would submit a grok payload that ignores the
    // local delivery model entirely.
    expect(result.current.isGrok).toBe(false);
    expect(result.current.modelId).toBe(LTX2.id);
  });

  it('applyFinish is inert without a record or a delivery model — it never starts a render', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.modelId).toBe(MLX.id));
    act(() => { result.current.setPrompt('untouched'); });
    act(() => result.current.applyFinish(null, LTX2.id));
    act(() => result.current.applyFinish({ prompt: 'x', modelId: MLX.id }, null));
    expect(result.current.prompt).toBe('untouched');
    expect(result.current.modelId).toBe(MLX.id);
  });

  it('applyResumedParams restores an in-flight grok job to the grok backend', async () => {
    const { result } = render({ grokEnabled: true });
    act(() => result.current.applyResumedParams({
      mode: 'grok', videoMode: 'image', duration: 10, prompt: 'running',
    }));
    expect(result.current.isGrok).toBe(true);
    expect(result.current.mode).toBe('image');
    expect(result.current.grokDuration).toBe(10);
    expect(result.current.prompt).toBe('running');
  });

  it('clamps the submitted resolution to the runner edge bounds', async () => {
    const { result } = render();
    act(() => result.current.handleResolutionChange(0, 4096));
    const payload = result.current.buildGeneratePayload();
    expect(payload.width).toBe(64);
    expect(payload.height).toBe(2048);
  });
});

// What the source image PROMISES (#4874). The form is where the promise is made,
// so it must never display or submit one the render cannot keep — and must never
// silently drop one the render IS keeping.
describe('useVideoGenForm — i2v reference mode (#4874)', () => {
  const LTX25 = {
    id: 'ltx25-model', name: 'LTX-2.5', runtime: 'ltx25',
    lastFrameAnchored: true, supportedModes: RUNTIME_MODES,
  };
  const LTX25_MODELS = [LTX25, LTX2];
  const LTX25_STATUS = { connected: true, defaultModel: LTX25.id };

  const inImageMode = async (opts = {}) => {
    const { result } = render({ models: LTX25_MODELS, status: LTX25_STATUS, ...opts });
    await act(async () => { result.current.handleModeChange('image'); });
    return result;
  };

  it('defaults to Anchor and omits the field from the payload', async () => {
    const result = await inImageMode();
    expect(result.current.i2vReferenceMode).toBe('anchor');
    expect(result.current.buildGeneratePayload().i2vReferenceMode).toBe('');
  });

  it('submits an Inspire pick on a runtime that can keep it', async () => {
    const result = await inImageMode();
    await act(async () => { result.current.setI2vReferenceMode('inspire'); });
    expect(result.current.i2vReferenceMode).toBe('inspire');
    expect(result.current.buildGeneratePayload().i2vReferenceMode).toBe('inspire');
  });

  it('snaps back to Anchor when the model is switched to one that pins frame one', async () => {
    const result = await inImageMode();
    await act(async () => { result.current.setI2vReferenceMode('inspire'); });
    await act(async () => { result.current.handleModelChange(LTX2.id); });
    await waitFor(() => expect(result.current.i2vReferenceMode).toBe('anchor'));
  });

  it('snaps back to Anchor when the mode leaves image-to-video', async () => {
    const result = await inImageMode();
    await act(async () => { result.current.setI2vReferenceMode('inspire'); });
    await act(async () => { result.current.handleModeChange('text'); });
    await waitFor(() => expect(result.current.i2vReferenceMode).toBe('anchor'));
  });

  it('keeps a resumed Inspire pick while the model catalog is still empty', async () => {
    // The regression this guards: reading an unresolved `currentModel` as
    // "unsupported" cleared a restored pick before the model it belongs to had
    // even loaded, so the resumed form denied a promise the running render was
    // actually keeping.
    const { result, rerender } = renderHook(
      (props) => useVideoGenForm(props),
      {
        wrapper: ({ children }) => <MemoryRouter initialEntries={['/media/video']}>{children}</MemoryRouter>,
        initialProps: { models: [], status: LTX25_STATUS, availableLoras: [], grokEnabled: false },
      },
    );
    await act(async () => {
      result.current.applyResumedParams({ modelId: LTX25.id, mode: 'image', i2vReferenceMode: 'inspire' });
    });
    expect(result.current.i2vReferenceMode).toBe('inspire');

    rerender({ models: LTX25_MODELS, status: LTX25_STATUS, availableLoras: [], grokEnabled: false });
    await waitFor(() => expect(result.current.currentModel?.id).toBe(LTX25.id));
    expect(result.current.i2vReferenceMode).toBe('inspire');
  });

  it('clears the promise when the backend switches to grok, which always anchors', async () => {
    // The grok lane reads only prompt/dims/source-image/duration, so its payload
    // has nowhere to carry the mode — leaving `inspire` in state would keep the
    // source-image panel promising a generated frame one that grok never delivers.
    const result = await inImageMode({ grokEnabled: true });
    await act(async () => { result.current.setI2vReferenceMode('inspire'); });
    await act(async () => { result.current.handleBackendChange('grok'); });
    await waitFor(() => expect(result.current.i2vReferenceMode).toBe('anchor'));
    expect(result.current.buildGeneratePayload().i2vReferenceMode).toBeUndefined();
  });

  it('restores the strength a resume echoes, and clears it when the resume echoes none', async () => {
    const result = await inImageMode();
    await act(async () => { result.current.applyResumedParams({ imageStrength: 0.35 }); });
    expect(result.current.imageStrength).toBe('0.35');
    await act(async () => { result.current.applyResumedParams({}); });
    expect(result.current.imageStrength).toBe('');
  });

  it('does NOT carry a remixed record\'s promise onto whatever image the user picks next', async () => {
    const result = await inImageMode();
    await act(async () => { result.current.setI2vReferenceMode('inspire'); });
    await act(async () => {
      result.current.applyRemix({ prompt: 'a fox', modelId: LTX25.id, i2vReferenceMode: 'inspire' });
    });
    // Remix drops to text mode and clears every conditioning input, so there is
    // no reference left for a promise to be about.
    expect(result.current.mode).toBe('text');
    await waitFor(() => expect(result.current.i2vReferenceMode).toBe('anchor'));
  });
});
