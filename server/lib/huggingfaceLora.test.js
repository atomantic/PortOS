import { describe, it, expect } from 'vitest';
import {
  parseHuggingfaceLoraRef,
  buildHfResolveUrl,
  buildHfAuthHeaders,
  pickHfLoraFile,
  detectVideoLoraFamily,
  detectImageLoraFamily,
  detectHfLoraFamily,
  flux2VariantFromBlob,
  buildHfLoraSidecar,
  fetchHuggingfaceModel,
} from './huggingfaceLora.js';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES } from './runners.js';

describe('parseHuggingfaceLoraRef', () => {
  it('parses a full HF URL', () => {
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/ltx2.3-audio-reactive-lora'))
      .toEqual({ repo: 'fal/ltx2.3-audio-reactive-lora', revision: null, file: null });
  });
  it('recovers a revision from /tree/<rev> and /blob/<rev> URLs', () => {
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/tree/v1.0'))
      .toEqual({ repo: 'fal/x', revision: 'v1.0', file: null });
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/blob/main/lora.safetensors'))
      .toEqual({ repo: 'fal/x', revision: 'main', file: 'lora.safetensors' });
  });

  it('takes only the first segment after tree/blob as the revision (subpaths are not part of the ref)', () => {
    // The common copy-paste case: a single-segment revision followed by a
    // (possibly nested) subpath. Only `main` is the ref; the rest is the path.
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/blob/main/weights/lora.safetensors'))
      .toEqual({ repo: 'fal/x', revision: 'main', file: 'weights/lora.safetensors' });
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/tree/main/subdir'))
      .toEqual({ repo: 'fal/x', revision: 'main', file: null });
  });

  it('recovers a .safetensors path from a /resolve/<rev>/… URL', () => {
    expect(parseHuggingfaceLoraRef(
      'https://huggingface.co/Alissonerdx/CharacterSheet/resolve/main/TripleView_klein9b_v1.safetensors',
    )).toEqual({
      repo: 'Alissonerdx/CharacterSheet',
      revision: 'main',
      file: 'TripleView_klein9b_v1.safetensors',
    });
  });

  it('recovers a slash-containing ref from the org/name@rev form (URL form is ambiguous)', () => {
    expect(parseHuggingfaceLoraRef('fal/x@refs/pr/123'))
      .toEqual({ repo: 'fal/x', revision: 'refs/pr/123', file: null });
  });
  it('parses a bare org/name id (optionally @rev or :rev)', () => {
    expect(parseHuggingfaceLoraRef('fal/ltx-lora')).toEqual({ repo: 'fal/ltx-lora', revision: null, file: null });
    expect(parseHuggingfaceLoraRef('fal/ltx-lora@v2')).toEqual({ repo: 'fal/ltx-lora', revision: 'v2', file: null });
    expect(parseHuggingfaceLoraRef('fal/ltx-lora:abc123')).toEqual({ repo: 'fal/ltx-lora', revision: 'abc123', file: null });
  });
  it('rejects garbage and non-HF hosts', () => {
    expect(() => parseHuggingfaceLoraRef('')).toThrow(/Empty/);
    expect(() => parseHuggingfaceLoraRef('https://example.com/fal/x')).toThrow(/Not a HuggingFace/);
    expect(() => parseHuggingfaceLoraRef('justaword')).toThrow(/org\/name/);
  });
});

describe('buildHfResolveUrl', () => {
  it('builds a resolve URL defaulting revision to main and encoding path segments', () => {
    expect(buildHfResolveUrl('fal/x', null, 'lora.safetensors'))
      .toBe('https://huggingface.co/fal/x/resolve/main/lora.safetensors');
    expect(buildHfResolveUrl('fal/x', 'v1', 'sub dir/lora.safetensors'))
      .toBe('https://huggingface.co/fal/x/resolve/v1/sub%20dir/lora.safetensors');
  });
});

describe('buildHfAuthHeaders', () => {
  it('returns a bearer header only when a token is present', () => {
    expect(buildHfAuthHeaders('hf_abc')).toEqual({ Authorization: 'Bearer hf_abc' });
    expect(buildHfAuthHeaders('')).toEqual({});
    expect(buildHfAuthHeaders(undefined)).toEqual({});
  });
});

describe('pickHfLoraFile', () => {
  const m = (...names) => ({ siblings: names.map((rfilename) => ({ rfilename })) });
  it('returns the lone .safetensors', () => {
    expect(pickHfLoraFile(m('lora.safetensors', 'README.md'))).toBe('lora.safetensors');
  });
  it('prefers the canonical diffusers filename', () => {
    expect(pickHfLoraFile(m('extra.safetensors', 'pytorch_lora_weights.safetensors')))
      .toBe('pytorch_lora_weights.safetensors');
  });
  it('prefers a name containing "lora" when no canonical match', () => {
    expect(pickHfLoraFile(m('model.safetensors', 'my_style_lora.safetensors')))
      .toBe('my_style_lora.safetensors');
  });
  it('selects an exact versioned file when requested', () => {
    const model = {
      id: 'fal/audio-reactive',
      ...m('audio_reactive.safetensors', 'audio_reactive_v2.safetensors'),
    };
    expect(pickHfLoraFile(model, 'audio_reactive_v2.safetensors'))
      .toBe('audio_reactive_v2.safetensors');
    expect(() => pickHfLoraFile(model, 'audio_reactive_v3.safetensors'))
      .toThrow(/does not contain audio_reactive_v3/);
  });
  it('throws when there is no .safetensors', () => {
    expect(() => pickHfLoraFile(m('config.json', 'README.md'))).toThrow(/no .safetensors/);
  });
  it('prefers a Flux.2 Klein 9B sibling over a Krea sibling when hinted', () => {
    const model = m(
      'DynamicCharacterSheet_krea2_v1.safetensors',
      'QuadView_klein9b_v1.safetensors',
      'QuadView_krea2_v1.safetensors',
      'TripleView_klein9b_v1.safetensors',
    );
    expect(pickHfLoraFile(model, null, { family: RUNNER_FAMILIES.FLUX2, fluxVariant: '9b' }))
      .toBe('QuadView_klein9b_v1.safetensors');
  });
});

describe('detectVideoLoraFamily', () => {
  it('classifies LTX repos as ltx-video from the repo id', () => {
    expect(detectVideoLoraFamily({ repo: 'fal/ltx2.3-audio-reactive-lora' })).toBe(VIDEO_LORA_FAMILIES.LTX_VIDEO);
    expect(detectVideoLoraFamily({ repo: 'Lightricks/LTX-Video-LoRA' })).toBe(VIDEO_LORA_FAMILIES.LTX_VIDEO);
  });
  it('classifies via tags / base_model when the id is opaque', () => {
    expect(detectVideoLoraFamily({ repo: 'someone/cool-lora', model: { tags: ['ltxv', 'lora'] } }))
      .toBe(VIDEO_LORA_FAMILIES.LTX_VIDEO);
    expect(detectVideoLoraFamily({ repo: 'someone/cool-lora', model: { cardData: { base_model: 'Lightricks/LTX-Video' } } }))
      .toBe(VIDEO_LORA_FAMILIES.LTX_VIDEO);
  });
  it('classifies MiniMax H3 repos as minimax-h3', () => {
    expect(detectVideoLoraFamily({ repo: 'someone/minimax-h3-character-lora' })).toBe(VIDEO_LORA_FAMILIES.MINIMAX_H3);
    expect(detectVideoLoraFamily({ repo: 'someone/opaque', model: { cardData: { base_model: 'MiniMaxAI/MiniMax-H3' } } }))
      .toBe(VIDEO_LORA_FAMILIES.MINIMAX_H3);
    expect(detectVideoLoraFamily({ repo: 'someone/opaque', model: { tags: ['minimax h3', 'lora'] } }))
      .toBe(VIDEO_LORA_FAMILIES.MINIMAX_H3);
  });
  it('needs the minimax maker token — a bare "h3" version suffix must not mis-tag', () => {
    expect(detectVideoLoraFamily({ repo: 'someone/style-h3' })).toBe(null);
    expect(detectVideoLoraFamily({ repo: 'someone/h3-anime-lora', model: { tags: ['sdxl'] } })).toBe(null);
  });
  it('prefers H3 over LTX when an H3 card also name-drops LTX', () => {
    expect(detectVideoLoraFamily({
      repo: 'someone/minimax-h3-lora',
      model: { cardData: { base_model: 'MiniMaxAI/MiniMax-H3' }, tags: ['ltx-video'] },
    })).toBe(VIDEO_LORA_FAMILIES.MINIMAX_H3);
  });
  it('returns null for unrelated repos (e.g. an image SDXL LoRA)', () => {
    expect(detectVideoLoraFamily({ repo: 'someone/sdxl-anime-lora', model: { tags: ['sdxl'] } })).toBe(null);
  });
});

describe('flux2VariantFromBlob', () => {
  it('reads klein9b / klein-9b / flux.2-klein-9b', () => {
    expect(flux2VariantFromBlob('flux.2-klein-9b')).toBe('9b');
    expect(flux2VariantFromBlob('TripleView_klein9b_v1.safetensors')).toBe('9b');
    expect(flux2VariantFromBlob('flux2-klein-4b-int8')).toBe('4b');
  });
  it('does not treat 4bit as a size variant', () => {
    expect(flux2VariantFromBlob('model-4bit')).toBe(null);
  });
});

describe('detectImageLoraFamily', () => {
  const characterSheet = {
    tags: ['lora', 'flux.2', 'flux.2-klein-9b', 'krea-2'],
    siblings: [
      { rfilename: 'DynamicCharacterSheet_krea2_v1.safetensors' },
      { rfilename: 'QuadView_klein9b_v1.safetensors' },
      { rfilename: 'QuadView_krea2_v1.safetensors' },
      { rfilename: 'TripleView_klein9b_v1.safetensors' },
    ],
  };

  it('classifies Alissonerdx/CharacterSheet as flux2-9b from tags + filenames', () => {
    expect(detectImageLoraFamily({ repo: 'Alissonerdx/CharacterSheet', model: characterSheet }))
      .toEqual({ family: RUNNER_FAMILIES.FLUX2, fluxVariant: '9b' });
  });

  it('does not inherit repo flux.2 tags onto a picked Krea sibling', () => {
    expect(detectImageLoraFamily({
      repo: 'Alissonerdx/CharacterSheet',
      model: characterSheet,
      file: 'QuadView_krea2_v1.safetensors',
    })).toBe(null);
  });

  it('classifies a klein9b filename even without flux tags', () => {
    expect(detectImageLoraFamily({
      repo: 'someone/opaque-sheet',
      model: { tags: ['lora'], siblings: [{ rfilename: 'TripleView_klein9b_v1.safetensors' }] },
    })).toEqual({ family: RUNNER_FAMILIES.FLUX2, fluxVariant: '9b' });
  });
});

describe('detectHfLoraFamily', () => {
  it('prefers Flux.2 over LTX when a card name-drops LTX as a use case', () => {
    expect(detectHfLoraFamily({
      repo: 'Alissonerdx/CharacterSheet',
      model: {
        tags: ['lora', 'flux.2-klein-9b'],
        siblings: [{ rfilename: 'TripleView_klein9b_v1.safetensors' }],
      },
    })).toEqual({ family: RUNNER_FAMILIES.FLUX2, fluxVariant: '9b' });
  });

  it('still classifies a pure LTX video repo as ltx-video', () => {
    expect(detectHfLoraFamily({ repo: 'fal/ltx2.3-audio-reactive-lora' }))
      .toEqual({ family: VIDEO_LORA_FAMILIES.LTX_VIDEO, fluxVariant: null });
  });

  it('returns null for an unsupported image family (SDXL)', () => {
    expect(detectHfLoraFamily({ repo: 'someone/sdxl-anime-lora', model: { tags: ['sdxl'] } })).toBe(null);
  });
});

describe('buildHfLoraSidecar', () => {
  it('shapes a video-LoRA sidecar with a huggingface block and stamped family', () => {
    const sidecar = buildHfLoraSidecar({
      repo: 'fal/ltx2.3-audio-reactive-lora',
      revision: null,
      file: 'lora.safetensors',
      family: VIDEO_LORA_FAMILIES.LTX_VIDEO,
      filename: 'lora-fal-ltx2-3-audio-reactive-lora-hf.safetensors',
      model: { tags: ['ltxv'], cardData: { base_model: 'Lightricks/LTX-2.3', instance_prompt: 'audio reactive' } },
    });
    expect(sidecar.runnerFamily).toBe('ltx-video');
    expect(sidecar.source).toBe('huggingface');
    expect(sidecar.huggingface.repo).toBe('fal/ltx2.3-audio-reactive-lora');
    expect(sidecar.huggingface.revision).toBe('main');
    expect(sidecar.huggingface.baseModel).toBe('Lightricks/LTX-2.3');
    expect(sidecar.triggerWords).toEqual(['audio reactive']);
    expect(sidecar.recommendedScale).toBe(1.0);
    expect(sidecar.civitai).toBeUndefined();
    expect(sidecar.file.downloadUrl).toContain('/resolve/main/lora.safetensors');
  });

  it('labels a V2 LoRA distinctly and uses its recommended scale', () => {
    const sidecar = buildHfLoraSidecar({
      repo: 'fal/ltx2.3-audio-reactive-lora',
      revision: null,
      file: 'ltx2.3_audio_reactive_lora_v2.safetensors',
      family: VIDEO_LORA_FAMILIES.LTX_VIDEO,
      filename: 'lora-fal-ltx2.3-audio-reactive-lora-v2-hf.safetensors',
      model: {},
    });
    expect(sidecar.name).toBe('ltx2.3-audio-reactive-lora · ltx2.3_audio_reactive_lora_v2');
    expect(sidecar.recommendedScale).toBe(1.2);
  });

  it('stamps fluxVariant and a file-stem name for a Flux.2 Klein collection', () => {
    const sidecar = buildHfLoraSidecar({
      repo: 'Alissonerdx/CharacterSheet',
      revision: null,
      file: 'QuadView_klein9b_v1.safetensors',
      family: RUNNER_FAMILIES.FLUX2,
      fluxVariant: '9b',
      filename: 'lora-alissonerdx-charactersheet-quadview-klein9b-v1-hf.safetensors',
      model: { tags: ['flux.2-klein-9b'] },
    });
    expect(sidecar.runnerFamily).toBe('flux2');
    expect(sidecar.fluxVariant).toBe('9b');
    expect(sidecar.name).toBe('CharacterSheet · QuadView_klein9b_v1');
  });
});

describe('fetchHuggingfaceModel', () => {
  it('rejects malformed repo ids before any fetch', async () => {
    await expect(fetchHuggingfaceModel('notarepo')).rejects.toThrow(/Invalid HuggingFace repo id/);
  });
  it('surfaces a gated/auth error on 401/403', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await expect(fetchHuggingfaceModel('fal/x', { fetchImpl })).rejects.toMatchObject({ code: 'HF_AUTH' });
  });
  it('returns the parsed body on success', async () => {
    const body = { id: 'fal/x', siblings: [{ rfilename: 'lora.safetensors' }], tags: ['ltxv'] };
    // readResponseJson reads res.text() then parses tolerantly.
    const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify(body) });
    await expect(fetchHuggingfaceModel('fal/x', { fetchImpl })).resolves.toEqual(body);
  });
});
