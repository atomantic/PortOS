import { describe, expect, it } from 'vitest';
import { buildVideoGenSubmission } from './videoGenSubmission.js';

// #6499 — block streaming is a request-only field sent to the LOCAL backend,
// and only when it is both a real choice (the current model actually runs on
// an LTX-2/2.5 MLX runtime) and a non-default one ('auto' — the bridge's own
// default). Every other field the local payload needs is filled with the
// minimal values that keep the shared prompt/mode helpers from throwing.
const baseArgs = (overrides = {}) => ({
  hostedLane: null, remoteSubmissionFields: null,
  prompt: 'a fox running through a forest',
  negativePrompt: '',
  width: 768, height: 512, mode: 'text',
  numFrames: 121, fps: 24, steps: '', guidanceScale: '', seed: '', batchSize: 1,
  models: [],
  tiling: 'auto', textEncoderId: '', speedProfileId: '', draftDecode: '',
  disableAudio: false, noMusic: false, imageStrength: '', i2vReferenceMode: 'anchor',
  keyframesActive: false, keyframes: [], loraFamily: null, selectedLoras: [],
  icModeActive: false, icImageKind: false, icReferenceImageFiles: [], icStrength: 1, icSkipStage2: false,
  chainingActive: false, chunks: 1, chunkPrompts: [], contextFrames: 0,
  ...overrides,
});

it('submits the H3 profile without stale sampler overrides and preserves incompatible selections for visible refusal', () => {
  const model = { id: 'h3', runtime: 'minimax_h3_cuda', speedProfiles: [
    { id: 'h3-speed', type: 'minimax-h3-lightx2v', modes: ['text', 'image'] },
  ] };
  for (const mode of ['text', 'fflf']) {
    const result = buildVideoGenSubmission(baseArgs({ modelId: model.id, currentModel: model,
      mode, speedProfileId: 'h3-speed', steps: '8', guidanceScale: '3' }));
    expect(result).toMatchObject({ speedProfileId: 'h3-speed', steps: '', guidanceScale: '' });
  }
});

describe('buildVideoGenSubmission — block streaming request (#6499)', () => {
  it('sends a non-default mode when the current model runs an LTX-2/2.5 MLX runtime', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'ltx25' },
      streamingMode: 'stream',
    }));
    expect(payload.backend).toBe('local');
    expect(payload.streamingMode).toBe('stream');
  });

  it('omits the field for the default (auto) mode, even on an LTX-2/2.5 model', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'ltx2' },
      streamingMode: 'auto',
    }));
    expect(payload.streamingMode).toBeUndefined();
  });

  it('omits the field entirely when the current model does not run an LTX-2/2.5 MLX runtime', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'mlx_video' },
      streamingMode: 'stream',
    }));
    expect(payload.streamingMode).toBeUndefined();
  });

  it('omits the field when no model is selected yet', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: null,
      streamingMode: 'stream',
    }));
    expect(payload.streamingMode).toBeUndefined();
  });
});

describe('buildVideoGenSubmission — fal options (#9232)', () => {
  it('carries selected resolution and provider audio only to the fal backend', () => {
    const options = { falResolution: '4k', falGenerateAudio: true };
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: 'fal', ...options })))
      .toMatchObject({ backend: 'fal', falResolution: '4k', falGenerateAudio: true });
    const local = buildVideoGenSubmission(baseArgs(options));
    expect(local).not.toHaveProperty('falResolution');
    expect(local).not.toHaveProperty('falGenerateAudio');
  });

  it('omits unset options so the server keeps its resolution and silent defaults', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      hostedLane: 'fal', falResolution: '', falGenerateAudio: false,
    }));
    expect(payload).not.toHaveProperty('falResolution');
    expect(payload).not.toHaveProperty('falGenerateAudio');
  });
});

describe('buildVideoGenSubmission — lane dispatch', () => {
  it('routes each hosted lane to its own payload and null to the local one', () => {
    for (const lane of ['grok', 'fal', 'reactor', 'runway']) {
      expect(buildVideoGenSubmission(baseArgs({ hostedLane: lane }))).toMatchObject({ backend: lane });
    }
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: null }))).toMatchObject({ backend: 'local' });
  });
});

describe('buildVideoGenSubmission — hosted image-mode source', () => {
  const source = { sourceImageFile: 'frame.png', sourceImageUpload: 'data:image/png;base64,AAA' };
  const lanes = { grok: { hostedLane: 'grok' }, fal: { hostedLane: 'fal' }, reactor: { hostedLane: 'reactor' } };

  for (const [backend, flag] of Object.entries(lanes)) {
    it(`${backend}: image mode copies the source, text mode sends empty strings`, () => {
      expect(buildVideoGenSubmission(baseArgs({ ...flag, ...source, mode: 'image' })))
        .toMatchObject({ backend, mode: 'image', sourceImageFile: 'frame.png', sourceImage: 'data:image/png;base64,AAA' });
      expect(buildVideoGenSubmission(baseArgs({ ...flag, ...source, mode: 'text' })))
        .toMatchObject({ backend, mode: 'text', sourceImageFile: '', sourceImage: '' });
      // Any non-image mode collapses to text on hosted lanes.
      expect(buildVideoGenSubmission(baseArgs({ ...flag, ...source, mode: 'a2v' })))
        .toMatchObject({ mode: 'text', sourceImageFile: '', sourceImage: '' });
    });

    it(`${backend}: image mode with no source sends empty strings`, () => {
      expect(buildVideoGenSubmission(baseArgs({ ...flag, mode: 'image' })))
        .toMatchObject({ mode: 'image', sourceImageFile: '', sourceImage: '' });
    });
  }

  it('fal and reactor never send a negative prompt; grok does', () => {
    const args = { negativePrompt: 'blurry' };
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: 'fal', ...args }))).not.toHaveProperty('negativePrompt');
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: 'reactor', ...args }))).not.toHaveProperty('negativePrompt');
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: 'grok', ...args }))).toHaveProperty('negativePrompt');
  });

  it('fal omits an unset model id', () => {
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: 'fal', falModelId: '' })).falModelId).toBeUndefined();
    expect(buildVideoGenSubmission(baseArgs({ hostedLane: 'fal', falModelId: 'm1' })).falModelId).toBe('m1');
  });
});

describe('buildVideoGenSubmission — reactor fields', () => {
  const reactor = (o) => buildVideoGenSubmission(baseArgs({ hostedLane: 'reactor', ...o }));

  it('sends a seed of 0 and omits an unset seed', () => {
    expect(reactor({ reactorSeed: 0 }).reactorSeed).toBe(0);
    expect(reactor({ reactorSeed: 42 }).reactorSeed).toBe(42);
    expect(reactor({ reactorSeed: '' }).reactorSeed).toBeUndefined();
    expect(reactor({ reactorSeed: null }).reactorSeed).toBeUndefined();
    expect(reactor({ reactorSeed: undefined }).reactorSeed).toBeUndefined();
  });

  it('drops the continuation clip id in image mode and omits empty seconds/aspect', () => {
    expect(reactor({ reactorClipId: 'c1', mode: 'text' }).reactorClipId).toBe('c1');
    expect(reactor({ reactorClipId: 'c1', mode: 'image' }).reactorClipId).toBeUndefined();
    expect(reactor({ reactorClipId: '' }).reactorClipId).toBeUndefined();
    const p = reactor({ reactorSeconds: 0, reactorAspect: '' });
    expect(p.reactorSeconds).toBeUndefined();
    expect(p.reactorAspect).toBeUndefined();
    expect(p).not.toHaveProperty('width');
    expect(reactor({ reactorSeconds: 5, reactorAspect: '9:16' })).toMatchObject({ reactorSeconds: 5, reactorAspect: '9:16' });
  });
});

describe('buildVideoGenSubmission — remote lane', () => {
  it('spreads remote fields over a text-mode local payload', () => {
    const p = buildVideoGenSubmission(baseArgs({
      remoteSubmissionFields: { modelId: 'remote-1', remoteInstanceId: 'peer' },
      steps: 0, guidanceScale: 0, seed: 0,
    }));
    expect(p).toMatchObject({
      backend: 'local', mode: 'text', modelId: 'remote-1', remoteInstanceId: 'peer',
      steps: '', guidanceScale: '', seed: 0, numFrames: 121, fps: 24,
    });
    expect(p).not.toHaveProperty('tiling');
  });
});

describe('buildVideoGenSubmission — local frame sources', () => {
  const ltx = { runtime: 'ltx2' };
  const other = { runtime: 'mlx_video' };
  const src = { sourceImageFile: 'a.png', sourceImageUpload: 'up', lastImageFile: 'z.png', lastImageUpload: 'zup', extendFromVideoId: 'v1', audioFile: 'a.wav' };
  const local = (o) => buildVideoGenSubmission(baseArgs({ currentModel: other, ...src, ...o }));

  it('attaches the start frame for image mode', () => {
    expect(local({ mode: 'image' })).toMatchObject({ sourceImageFile: 'a.png', sourceImage: 'up', lastImageFile: '', lastImage: '', extendFromVideoId: '', audioFile: '' });
  });

  it('attaches the start frame and audio for a2v', () => {
    expect(local({ mode: 'a2v' })).toMatchObject({ sourceImageFile: 'a.png', sourceImage: 'up', audioFile: 'a.wav', extendFromVideoId: '' });
  });

  it('attaches both frames for legacy first-last-frame, not when keyframes are active', () => {
    expect(local({ mode: 'fflf', keyframesActive: false }))
      .toMatchObject({ sourceImageFile: 'a.png', sourceImage: 'up', lastImageFile: 'z.png', lastImage: 'zup' });
    expect(local({ mode: 'fflf', keyframesActive: true, keyframes: [{ a: 1 }] }))
      .toMatchObject({ sourceImageFile: '', sourceImage: '', lastImageFile: '', lastImage: '', keyframes: '[{"a":1}]' });
  });

  it('extend on a non-LTX-2 runtime attaches the file only (no upload, no video id)', () => {
    expect(local({ mode: 'extend' })).toMatchObject({ sourceImageFile: 'a.png', sourceImage: '', extendFromVideoId: '' });
  });

  it('extend on LTX-2 uses extendFromVideoId and no start frame', () => {
    expect(local({ mode: 'extend', currentModel: ltx })).toMatchObject({ sourceImageFile: '', sourceImage: '', extendFromVideoId: 'v1' });
  });

  it('text mode sends empty strings for every frame/audio/extend field', () => {
    expect(local({ mode: 'text' })).toMatchObject({
      sourceImageFile: '', sourceImage: '', lastImageFile: '', lastImage: '', extendFromVideoId: '', audioFile: '', keyframes: '',
    });
  });

  it('missing sources fall back to empty strings', () => {
    expect(buildVideoGenSubmission(baseArgs({ currentModel: other, mode: 'fflf' })))
      .toMatchObject({ sourceImageFile: '', sourceImage: '', lastImageFile: '', lastImage: '' });
  });
});

describe('buildVideoGenSubmission — local IC-LoRA, chunks and misc', () => {
  const local = (o) => buildVideoGenSubmission(baseArgs({ currentModel: { runtime: 'ltx2' }, ...o }));

  it('inactive IC mode sends empty reference fields', () => {
    expect(local({ icReferenceFile: 'r.mp4', icReferenceVideoId: 'v' })).toMatchObject({
      icReference: '', icReferenceVideoIds: '', icStrength: '', icSkipStage2: '',
    });
    expect(local({})).toHaveProperty('icReferenceImageFiles', undefined);
  });

  it('video reference: file wins over video id; video id used when no file', () => {
    expect(local({ icModeActive: true, icReferenceFile: 'r.mp4', icReferenceVideoId: 'v', icStrength: 0.5, icSkipStage2: true }))
      .toMatchObject({ icReference: 'r.mp4', icReferenceVideoIds: '', icStrength: 0.5, icSkipStage2: 'true' });
    expect(local({ icModeActive: true, icReferenceVideoId: 'v' }))
      .toMatchObject({ icReference: '', icReferenceVideoIds: 'v', icSkipStage2: '' });
    expect(local({ icModeActive: true }).icReferenceImageFiles).toBeUndefined();
  });

  it('image reference kind sends filtered image files and no video fields', () => {
    expect(local({
      icModeActive: true, icImageKind: true, icReferenceFile: 'r.mp4', icReferenceVideoId: 'v',
      icReferenceImageFiles: ['a.png', '', 'b.png'],
    })).toMatchObject({ icReference: '', icReferenceVideoIds: '', icReferenceImageFiles: ['a.png', 'b.png'] });
  });

  it('inactive chunking sends empty strings; active chunking slices live beats', () => {
    expect(local({ chunkPrompts: ['x'], chunks: 2, contextFrames: 9 }))
      .toMatchObject({ chunks: '', chunkPrompts: '', contextFrames: '' });
    const p = local({ chainingActive: true, chunks: 2, chunkPrompts: ['one', 'two', 'stale'], contextFrames: 9 });
    expect(p).toMatchObject({ chunks: 2, contextFrames: '9' });
    expect(JSON.parse(p.chunkPrompts)).toEqual(['one', 'two']);
    expect(local({ chainingActive: true, chunks: 2, chunkPrompts: ['', '  '] }).chunkPrompts).toBe('');
  });

  it('batch size, loras, display sleep and negative prompt follow model support', () => {
    expect(local({ currentModel: { runtime: 'ltx2', supportsWarmBatch: true }, batchSize: 3 }).batchSize).toBe(3);
    expect(local({ currentModel: { runtime: 'ltx2', supportsWarmBatch: true }, batchSize: 3, chainingActive: true })).not.toHaveProperty('batchSize');
    expect(local({ batchSize: 3 })).not.toHaveProperty('batchSize');
    const loras = local({ loraFamily: 'ltx', selectedLoras: [{ filename: 'f.safetensors', scale: 0.8 }] });
    expect(loras.loraFilenames).toEqual(['f.safetensors']);
    expect(loras.loraScales).toEqual([0.8]);
    expect(local({ loraFamily: 'ltx', selectedLoras: [] }).loraFilenames).toBeUndefined();
    expect(local({ currentModel: { runtime: 'ltx2', sleepsDisplayDuringRender: true }, displaySleepEnabled: true }).displaySleep).toBe('true');
    expect(local({ currentModel: { runtime: 'ltx2', sleepsDisplayDuringRender: true }, displaySleepEnabled: false }).displaySleep).toBe('false');
    expect(local({})).not.toHaveProperty('displaySleep');
    expect(local({ currentModel: { runtime: 'ltx2', supportsNegativePrompt: false }, negativePrompt: 'x' }).negativePrompt).toBe('');
    expect(local({ currentModel: { runtime: 'ltx2', supportsTiling: false }, tiling: 'on' }).tiling).toBe('auto');
    expect(local({ tiling: 'on' }).tiling).toBe('on');
  });

  it('steps, guidance and seed keep 0 seed but blank 0 steps/guidance', () => {
    expect(local({ steps: 0, guidanceScale: 0, seed: 0 })).toMatchObject({ steps: '', guidanceScale: '', seed: 0 });
    expect(local({ steps: 8, guidanceScale: 3, seed: null })).toMatchObject({ steps: 8, guidanceScale: 3, seed: '' });
  });
});

describe('buildVideoGenSubmission — prompt additions (#11317)', () => {
  const preset = { label: 'Film noir', prompt: 'cinematic noir', negativePrompt: '' };

  it('drops carried style metadata when switching to Runway character performance', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      hostedLane: 'runway', mode: 'character-performance', runwayModelId: 'act_two',
      stylePreset: preset, negativePrompt: 'blur', noMusic: true,
    }));
    expect(payload).toMatchObject({ prompt: '', negativePrompt: '' });
    expect(payload).not.toHaveProperty('promptAdditions');
  });

  it('lists the style preset, then the No music line the local lane appends', () => {
    const payload = buildVideoGenSubmission(baseArgs({ currentModel: {}, stylePreset: preset, noMusic: true }));
    expect(payload.prompt).toBe('cinematic noir. a fox running through a forest\n\nno music, no soundtrack');
    expect(payload.promptAdditions).toEqual([
      { id: 'style-1', label: 'Style preset: Film noir', text: 'cinematic noir' },
      { id: 'no-music', label: 'No music', text: 'no music, no soundtrack' },
    ]);
  });

  it('sends no No music chip on a hosted lane, which never appends it', () => {
    const payload = buildVideoGenSubmission(baseArgs({ hostedLane: 'fal', currentModel: {}, stylePreset: preset, noMusic: true }));
    expect(payload.promptAdditions).toEqual([{ id: 'style-1', label: 'Style preset: Film noir', text: 'cinematic noir' }]);
  });
});

describe('buildVideoGenSubmission — extra reference images', () => {
  it('sends the filled gallery picks, clipped to the model ceiling minus the input image', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'fastvideo', maxReferenceImages: 3 },
      referenceImageFiles: ['a.png', '', 'b.png', 'c.png'],
    }));
    expect(payload.referenceImageFiles).toEqual(['a.png', 'b.png']);
  });

  it('sends clips as ids and voices as indexed upload slots, clipped to the model ceilings', () => {
    const voices = [new File(['a'], 'a.wav'), new File(['b'], 'b.wav'), new File(['c'], 'c.wav')];
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'fastvideo', maxReferenceImages: 2, maxReferenceVideos: 1, maxReferenceAudios: 2 },
      referenceVideoIds: ['', 'clip-1', 'clip-2'],
      referenceAudioFiles: voices,
    }));
    expect(payload.referenceVideoIds).toEqual(['clip-1']);
    expect(payload.referenceAudio0).toBe(voices[0]);
    expect(payload.referenceAudio1).toBe(voices[1]);
    expect(payload.referenceAudio2).toBeUndefined();
  });

  it('never carries a stale list to a model that takes none', () => {
    const payload = buildVideoGenSubmission(baseArgs({
      currentModel: { runtime: 'fastvideo' },
      referenceImageFiles: ['a.png'],
    }));
    expect(payload.referenceImageFiles).toBeUndefined();
  });
});


it('preserves explicit stage strengths through backend/model changes for visible server refusal and leaves defaults absent', () => {
  for (const lane of [null, 'grok', 'fal', 'reactor', 'runway']) {
    const payload = buildVideoGenSubmission(baseArgs({ hostedLane: lane, a2vLoraStageStrengths: [0, 1] }));
    expect(payload.a2vLoraStageStrengths).toBe('[0,1]');
  }
  expect(buildVideoGenSubmission(baseArgs({ a2vLoraStageStrengths: [1, 1] })))
    .not.toHaveProperty('a2vLoraStageStrengths');
});
