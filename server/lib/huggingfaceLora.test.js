import { describe, it, expect } from 'vitest';
import {
  parseHuggingfaceLoraRef,
  buildHfResolveUrl,
  buildHfAuthHeaders,
  pickHfLoraFile,
  detectVideoLoraFamily,
  buildHfLoraSidecar,
  fetchHuggingfaceModel,
} from './huggingfaceLora.js';
import { VIDEO_LORA_FAMILIES } from './runners.js';

describe('parseHuggingfaceLoraRef', () => {
  it('parses a full HF URL', () => {
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/ltx2.3-audio-reactive-lora'))
      .toEqual({ repo: 'fal/ltx2.3-audio-reactive-lora', revision: null });
  });
  it('recovers a revision from /tree/<rev> and /blob/<rev> URLs', () => {
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/tree/v1.0'))
      .toEqual({ repo: 'fal/x', revision: 'v1.0' });
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/blob/main/lora.safetensors'))
      .toEqual({ repo: 'fal/x', revision: 'main' });
  });

  it('takes only the first segment after tree/blob as the revision (subpaths are not part of the ref)', () => {
    // The common copy-paste case: a single-segment revision followed by a
    // (possibly nested) subpath. Only `main` is the ref; the rest is the path.
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/blob/main/weights/lora.safetensors'))
      .toEqual({ repo: 'fal/x', revision: 'main' });
    expect(parseHuggingfaceLoraRef('https://huggingface.co/fal/x/tree/main/subdir'))
      .toEqual({ repo: 'fal/x', revision: 'main' });
  });

  it('recovers a slash-containing ref from the org/name@rev form (URL form is ambiguous)', () => {
    expect(parseHuggingfaceLoraRef('fal/x@refs/pr/123'))
      .toEqual({ repo: 'fal/x', revision: 'refs/pr/123' });
  });
  it('parses a bare org/name id (optionally @rev or :rev)', () => {
    expect(parseHuggingfaceLoraRef('fal/ltx-lora')).toEqual({ repo: 'fal/ltx-lora', revision: null });
    expect(parseHuggingfaceLoraRef('fal/ltx-lora@v2')).toEqual({ repo: 'fal/ltx-lora', revision: 'v2' });
    expect(parseHuggingfaceLoraRef('fal/ltx-lora:abc123')).toEqual({ repo: 'fal/ltx-lora', revision: 'abc123' });
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
  it('throws when there is no .safetensors', () => {
    expect(() => pickHfLoraFile(m('config.json', 'README.md'))).toThrow(/no .safetensors/);
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
  it('returns null for unrelated repos (e.g. an image SDXL LoRA)', () => {
    expect(detectVideoLoraFamily({ repo: 'someone/sdxl-anime-lora', model: { tags: ['sdxl'] } })).toBe(null);
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
