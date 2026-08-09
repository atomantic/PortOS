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
const LTX2 = { id: 'ltx2-model', name: 'LTX-2.3', runtime: 'ltx2' };
const MLX = { id: 'mlx-model', name: 'LTX distilled', runtime: 'mlx_video' };
const WAN_T2V = { id: 'wan-t2v', name: 'Wan T2V', runtime: 'wan22', supportedModes: ['text'], frameStride: 4 };
const WAN_TI2V = { id: 'wan-ti2v', name: 'Wan TI2V', runtime: 'wan22', supportedModes: ['text', 'image'], frameStride: 4 };
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

  it('applyRemix restores the render params and clears stale conditioning inputs', async () => {
    const { result } = render();
    act(() => result.current.handleModeChange('image'));
    act(() => result.current.pickSourceImage('old.png'));
    expect(result.current.sourceImageFile).toBe('old.png');

    act(() => result.current.applyRemix({
      prompt: 'remixed', negativePrompt: 'blurry', modelId: LTX2.id,
      width: 1024, height: 576, numFrames: 49, fps: 30, seed: 7,
      steps: 20, guidanceScale: 0, tiling: 'both', disableAudio: true,
      loraFilenames: ['v.safetensors'], loraScales: [0.5],
    }));

    expect(result.current.prompt).toBe('remixed');
    expect(result.current.negativePrompt).toBe('blurry');
    expect(result.current.seed).toBe('7');
    expect(result.current.steps).toBe('20');
    // guidanceScale 0 (CFG off) must survive the round-trip as "0", not "".
    expect(result.current.guidanceScale).toBe('0');
    expect(result.current.disableAudio).toBe(true);
    expect(result.current.mode).toBe('text');
    expect(result.current.sourceImageFile).toBeNull();
    expect(result.current.selectedLoras).toEqual([
      { filename: 'v.safetensors', name: 'v.safetensors', scale: 0.5 },
    ]);
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
