import { describe, it, expect } from 'vitest';
import {
  classifyHfMediaModel,
  inspectModelFiles,
  customModelIdFromRepo,
  buildCustomModelEntry,
  searchHuggingfaceModels,
} from './huggingfaceModel.js';

// Build a minimal HF `/api/models/{repo}` response.
const hf = ({ files = [], tags = [], base = null, pipeline = null } = {}) => ({
  siblings: files.map((rfilename) => ({ rfilename })),
  tags,
  cardData: base ? { base_model: base } : {},
  pipeline_tag: pipeline,
});

describe('inspectModelFiles', () => {
  it('detects safetensors and gguf presence', () => {
    expect(inspectModelFiles(hf({ files: ['model.safetensors', 'config.json'] })))
      .toMatchObject({ hasSafetensors: true, hasGguf: false });
    expect(inspectModelFiles(hf({ files: ['model-Q4_K_M.gguf'] })))
      .toMatchObject({ hasSafetensors: false, hasGguf: true });
  });
});

describe('classifyHfMediaModel — strict refusal', () => {
  it('refuses a GGUF-only repo (no runtime can load it)', () => {
    expect(() => classifyHfMediaModel({
      repo: 'unsloth/LTX-2.3-GGUF',
      model: hf({ files: ['ltx-2.3-22b-distilled-Q4_K_M.gguf'], tags: ['ltx'] }),
    })).toThrow(/GGUF/);
  });

  it('refuses a repo with no safetensors', () => {
    expect(() => classifyHfMediaModel({
      repo: 'foo/bar',
      model: hf({ files: ['README.md'] }),
    })).toThrow(/no .safetensors/i);
  });

  it('refuses Wan repos (BYO-venv, not self-service)', () => {
    expect(() => classifyHfMediaModel({
      repo: 'Wan-AI/Wan2.2-T2V-A14B',
      model: hf({ files: ['model.safetensors'], tags: ['wan'] }),
    })).toThrow(/Wan/);
  });

  it('refuses HunyuanVideo repos', () => {
    expect(() => classifyHfMediaModel({
      repo: 'tencent/HunyuanVideo',
      model: hf({ files: ['model.safetensors'], tags: ['hunyuan'] }),
    })).toThrow(/Hunyuan/);
  });

  it('refuses a wan/hunyuan repo even when an addable runtime is forced (no override-laundering)', () => {
    // The "a bad add can't wedge the picker" guarantee must hold even under an
    // explicit runtime override — forcing mlx_video on a Hunyuan repo would
    // register an entry no runtime can load.
    expect(() => classifyHfMediaModel({
      repo: 'tencent/HunyuanVideo',
      model: hf({ files: ['model.safetensors'], tags: ['hunyuan'] }),
      kind: 'video',
      runtime: 'mlx_video',
    })).toThrow(/needs a dedicated venv/);
  });

  it('refuses a wan/hunyuan repo even when kind:image is forced (override cannot skip the video guard)', () => {
    // kind:'image' would route into the image branch and bypass the video-only
    // refusal — the guard must run unconditionally, before kind resolution.
    expect(() => classifyHfMediaModel({
      repo: 'Wan-AI/Wan2.2-T2V-A14B',
      model: hf({ files: ['model.safetensors'], tags: ['wan'] }),
      kind: 'image',
      runner: 'qwen',
    })).toThrow(/needs a dedicated venv/);
  });

  it('refuses a LoRA adapter repo (belongs in the LoRA manager, not base models)', () => {
    // base_model in the card is the adapter signal.
    expect(() => classifyHfMediaModel({
      repo: 'fal/ltx2.3-audio-reactive-lora',
      model: hf({ files: ['pytorch_lora_weights.safetensors'], tags: ['lora', 'ltx-video'], base: 'Lightricks/LTX-Video' }),
    })).toThrow(/LoRA adapter/);
  });

  it('refuses a quantized FLUX.2 repo (needs sibling tokenizer/base repos)', () => {
    expect(() => classifyHfMediaModel({
      repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic',
      model: hf({ files: ['model.safetensors'], tags: ['sdnq'], pipeline: 'text-to-image' }),
    })).toThrow(/quantized FLUX\.2/);
  });

  it('refuses an unclassifiable safetensors repo with no kind hint', () => {
    expect(() => classifyHfMediaModel({
      repo: 'someone/mystery-weights',
      model: hf({ files: ['model.safetensors'] }),
    })).toThrow(/image or video/);
  });
});

describe('classifyHfMediaModel — happy paths', () => {
  it('classifies an LTX safetensors repo as video/mlx_video', () => {
    expect(classifyHfMediaModel({
      repo: 'notapalindrome/ltx23-mlx-av-q4',
      model: hf({ files: ['model.safetensors'], tags: ['ltx-video'] }),
    })).toEqual({ kind: 'video', runtime: 'mlx_video', format: 'safetensors' });
  });

  it('auto-detects a dgrauet LTX repo as the ltx2 runtime (not mlx_video)', () => {
    expect(classifyHfMediaModel({
      repo: 'dgrauet/ltx-2.3-mlx-q8',
      model: hf({ files: ['model.safetensors'], tags: ['ltx'] }),
    })).toEqual({ kind: 'video', runtime: 'ltx2', format: 'safetensors' });
  });

  it('detects a Qwen-Image-Edit repo and stamps the edit pipeline + editOnly', () => {
    const c = classifyHfMediaModel({
      repo: 'Qwen/Qwen-Image-Edit',
      model: hf({ files: ['model.safetensors'], pipeline: 'text-to-image' }),
    });
    expect(c).toMatchObject({ kind: 'image', runner: 'qwen', editVariant: true });
    const entry = buildCustomModelEntry({ repo: 'Qwen/Qwen-Image-Edit', model: hf({}), classification: c });
    expect(entry).toMatchObject({ runner: 'qwen', pipelineClass: 'QwenImageEditPipeline', editOnly: true });
  });

  it('honors an explicit ltx2 runtime override', () => {
    expect(classifyHfMediaModel({
      repo: 'dgrauet/ltx-2.3-mlx-q8',
      model: hf({ files: ['model.safetensors'], tags: ['ltx'] }),
      runtime: 'ltx2',
    })).toEqual({ kind: 'video', runtime: 'ltx2', format: 'safetensors' });
  });

  it('detects a FLUX.2 image repo as flux2', () => {
    expect(classifyHfMediaModel({
      repo: 'black-forest-labs/FLUX.2-klein-9B',
      model: hf({ files: ['model.safetensors'], pipeline: 'text-to-image' }),
    })).toEqual({ kind: 'image', runner: 'flux2', format: 'safetensors' });
  });

  it('detects a Qwen image repo', () => {
    expect(classifyHfMediaModel({
      repo: 'Qwen/Qwen-Image',
      model: hf({ files: ['model.safetensors'], pipeline: 'text-to-image' }),
    })).toEqual({ kind: 'image', runner: 'qwen', format: 'safetensors' });
  });

  it('rejects an invalid explicit runtime', () => {
    expect(() => classifyHfMediaModel({
      repo: 'x/y',
      model: hf({ files: ['model.safetensors'], tags: ['ltx'] }),
      runtime: 'gguf-runtime',
    })).toThrow(/can't be added self-service/);
  });

  it('falls back to a caller-supplied kind+runner for an ambiguous image repo', () => {
    expect(classifyHfMediaModel({
      repo: 'someone/custom-diffusers',
      model: hf({ files: ['model.safetensors'] }),
      kind: 'image',
      runner: 'qwen',
    })).toEqual({ kind: 'image', runner: 'qwen', format: 'safetensors' });
  });

  it('refuses a detected mflux (Flux.1) repo — mflux ignores a custom repo', () => {
    // mflux-generate only loads its built-in dev/schnell aliases, so a custom
    // repo would register but fail at render — refuse it up front.
    expect(() => classifyHfMediaModel({
      repo: 'black-forest-labs/FLUX.1-dev',
      model: hf({ files: ['model.safetensors'], pipeline: 'text-to-image' }),
    })).toThrow(/mflux|Flux\.1/);
  });

  it('rejects an explicit mflux runner override (off the addable allowlist)', () => {
    expect(() => classifyHfMediaModel({
      repo: 'someone/x',
      model: hf({ files: ['model.safetensors'] }),
      kind: 'image',
      runner: 'mflux',
    })).toThrow(/Unknown image runner|mflux/);
  });

  it('refuses a text-to-video repo with no detected runtime (would 400 at render on mlx_video)', () => {
    // pipeline_tag says video but no LTX/Wan/Hunyuan marker — mlx_video only
    // loads LTX, so defaulting to it would register an un-renderable entry.
    expect(() => classifyHfMediaModel({
      repo: 'someone/mystery-video',
      model: hf({ files: ['model.safetensors'], pipeline: 'text-to-video' }),
    })).toThrow(/Couldn't determine which video runtime/);
  });

  it('accepts an undetected video repo when an explicit runtime is supplied', () => {
    expect(classifyHfMediaModel({
      repo: 'someone/mystery-video',
      model: hf({ files: ['model.safetensors'], pipeline: 'text-to-video' }),
      runtime: 'mlx_video',
    })).toEqual({ kind: 'video', runtime: 'mlx_video', format: 'safetensors' });
  });
});

describe('customModelIdFromRepo', () => {
  it('slugifies with an hf- prefix', () => {
    expect(customModelIdFromRepo('notapalindrome/ltx23-mlx-av-q4')).toBe('hf-notapalindrome-ltx23-mlx-av-q4');
    expect(customModelIdFromRepo('black-forest-labs/FLUX.2-klein-9B')).toBe('hf-black-forest-labs-flux-2-klein-9b');
  });
});

describe('buildCustomModelEntry', () => {
  it('builds a video entry with runtime + user source + defaults', () => {
    const entry = buildCustomModelEntry({
      repo: 'notapalindrome/ltx23-mlx-av-q4',
      model: hf({ tags: ['ltx'] }),
      classification: { kind: 'video', runtime: 'mlx_video', format: 'safetensors' },
    });
    expect(entry).toMatchObject({
      id: 'hf-notapalindrome-ltx23-mlx-av-q4',
      repo: 'notapalindrome/ltx23-mlx-av-q4',
      runtime: 'mlx_video',
      source: 'user',
      steps: 25,
      guidance: 3.0,
    });
    expect(entry.runner).toBeUndefined();
    expect(entry.installedAt).toBeTruthy();
  });

  it('builds an image entry with runner + honors overrides', () => {
    const entry = buildCustomModelEntry({
      repo: 'Qwen/Qwen-Image',
      model: hf({}),
      classification: { kind: 'image', runner: 'qwen', format: 'safetensors' },
      name: 'My Qwen',
      steps: 40,
      guidance: 5,
    });
    expect(entry).toMatchObject({ runner: 'qwen', name: 'My Qwen', steps: 40, guidance: 5, source: 'user' });
    expect(entry.runtime).toBeUndefined();
    expect(entry.quantization).toBeUndefined(); // only flux2 needs it
  });

  it('stamps quantization:none on a flux2 entry so the runner uses repo directly (no tokenizerRepo 400)', () => {
    const entry = buildCustomModelEntry({
      repo: 'black-forest-labs/FLUX.2-klein-9B',
      model: hf({}),
      classification: { kind: 'image', runner: 'flux2', format: 'safetensors' },
    });
    expect(entry).toMatchObject({ runner: 'flux2', quantization: 'none', source: 'user' });
  });

  it('stamps ERNIE pipeline metadata the runner requires', () => {
    const entry = buildCustomModelEntry({
      repo: 'baidu/ERNIE-Image',
      model: hf({}),
      classification: { kind: 'image', runner: 'ernie', format: 'safetensors' },
    });
    expect(entry).toMatchObject({ runner: 'ernie', pipelineClass: 'ErnieImagePipeline', usePromptEnhancer: true });
  });

  it('stamps HiDream pipeline + gated text-encoder metadata', () => {
    const entry = buildCustomModelEntry({
      repo: 'HiDream-ai/HiDream-I1-Full',
      model: hf({}),
      classification: { kind: 'image', runner: 'hidream', format: 'safetensors' },
    });
    expect(entry).toMatchObject({
      runner: 'hidream',
      pipelineClass: 'HiDreamImagePipeline',
      textEncoderRepo: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      textEncoderClass: 'LlamaForCausalLM',
    });
  });

  it('stamps the Qwen pipeline class', () => {
    const entry = buildCustomModelEntry({
      repo: 'Qwen/Qwen-Image',
      model: hf({}),
      classification: { kind: 'image', runner: 'qwen', format: 'safetensors' },
    });
    expect(entry).toMatchObject({ runner: 'qwen', pipelineClass: 'QwenImagePipeline' });
  });
});

describe('searchHuggingfaceModels', () => {
  it('builds the search URL and maps rows', async () => {
    let calledUrl = null;
    const fetchImpl = async (url) => {
      calledUrl = url;
      return {
        ok: true,
        text: async () => JSON.stringify([
          { id: 'org/a', likes: 5, downloads: 100, pipeline_tag: 'text-to-image' },
          { modelId: 'org/b', pipeline_tag: 'text-to-video' },
          { likes: 1 }, // no id → dropped
        ]),
      };
    };
    const rows = await searchHuggingfaceModels('ltx', { pipeline: 'text-to-video', limit: 5, fetchImpl });
    expect(calledUrl).toContain('search=ltx');
    expect(calledUrl).toContain('pipeline_tag=text-to-video');
    expect(calledUrl).toContain('limit=5');
    expect(rows).toEqual([
      { id: 'org/a', likes: 5, downloads: 100, pipeline_tag: 'text-to-image' },
      { id: 'org/b', likes: 0, downloads: 0, pipeline_tag: 'text-to-video' },
    ]);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
    await expect(searchHuggingfaceModels('x', { fetchImpl })).rejects.toThrow(/search failed/i);
  });
});
