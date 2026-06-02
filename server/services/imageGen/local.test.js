import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// FLUX.2 venv resolution mock — flip between "installed" and "missing" with
// the .returnValue setter on each test.
const mockResolveFlux2Python = vi.fn();
vi.mock('../../lib/pythonSetup.js', () => ({
  resolveFlux2Python: () => mockResolveFlux2Python(),
  FLUX2_VENV_DEFAULT: '/fake/home/.portos/venv-flux2/bin/python3',
}));

// Point the registry at a temp dir. local.js itself no longer calls
// getImageModels() at module load — but any test that exercises a code path
// invoking the registry (e.g. generateImage → loadMediaModels → seedIfMissing)
// would still write to the repo's data/media-models.json without this. Save +
// restore the prior env value and call vi.resetModules() so a previously
// cached mediaModels.js inside the same vitest worker doesn't stick to the
// wrong file. Pattern matches server/lib/mediaModels.test.js.
let tmpRegistryDir;
let priorRegistryEnv;
let buildArgs;
let buildSidecarMeta;

beforeAll(async () => {
  tmpRegistryDir = mkdtempSync(join(tmpdir(), 'portos-imagegen-local-test-'));
  priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRegistryDir, 'media-models.json');
  vi.resetModules();
  ({ buildArgs, buildSidecarMeta } = await import('./local.js'));
});

afterAll(() => {
  if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
  else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
  rmSync(tmpRegistryDir, { recursive: true, force: true });
});

describe('imageGen local.buildArgs flux2 dispatch', () => {
  beforeEach(() => {
    mockResolveFlux2Python.mockReset();
  });

  const baseInput = {
    pythonPath: '/usr/bin/python3', // unused for flux2 but kept in shape
    prompt: 'a red cube',
    negativePrompt: '',
    width: 512,
    height: 512,
    steps: 8,
    guidance: 3.5,
    seed: 42,
    quantize: '8',
    outputPath: '/tmp/out.png',
    loraPaths: [],
    loraScales: [],
    stepwiseDir: '/tmp/stepwise',
    initImagePath: null,
    initImageStrength: null,
  };

  it('routes SDNQ flux2 models to the flux2 venv + flux2_macos.py', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { bin, args } = buildArgs({
      ...baseInput,
      model: {
        id: 'flux2-klein-4b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      },
    });
    expect(bin).toBe('/fake/venv-flux2/bin/python3');
    // First arg is the script path
    expect(args[0]).toMatch(/scripts[/\\]flux2_macos\.py$/);
    // Required CLI fields land in the args list (order isn't important here,
    // but we want presence + the exact repo/tokenizer values).
    expect(args).toContain('--quantization');
    expect(args[args.indexOf('--quantization') + 1]).toBe('sdnq');
    expect(args).toContain('--repo');
    expect(args[args.indexOf('--repo') + 1]).toBe('Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic');
    expect(args).toContain('--tokenizer-repo');
    expect(args[args.indexOf('--tokenizer-repo') + 1]).toBe('black-forest-labs/FLUX.2-klein-4B');
    expect(args).toContain('--prompt');
    expect(args).toContain('a red cube');
    expect(args).toContain('--seed');
    expect(args[args.indexOf('--seed') + 1]).toBe('42');
    // No --metadata flag: local.js writes the canonical sidecar itself.
    expect(args).not.toContain('--metadata');
    // Stepwise dir threads through so live preview frames land where local.js's watcher reads.
    expect(args).toContain('--stepwise-image-output-dir');
    expect(args[args.indexOf('--stepwise-image-output-dir') + 1]).toBe('/tmp/stepwise');
  });

  it('routes Int8 flux2 models with the base pipeline repo flag', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      model: {
        id: 'flux2-klein-4b-int8',
        runner: 'flux2',
        quantization: 'int8',
        repo: 'aydin99/FLUX.2-klein-4B-int8',
        basePipelineRepo: 'black-forest-labs/FLUX.2-klein-4B',
      },
    });
    expect(args[args.indexOf('--quantization') + 1]).toBe('int8');
    expect(args[args.indexOf('--repo') + 1]).toBe('aydin99/FLUX.2-klein-4B-int8');
    expect(args).toContain('--base-pipeline-repo');
    expect(args[args.indexOf('--base-pipeline-repo') + 1]).toBe('black-forest-labs/FLUX.2-klein-4B');
    // SDNQ-only flag must NOT appear when the model didn't supply tokenizerRepo.
    expect(args).not.toContain('--tokenizer-repo');
  });

  it('throws a setup hint when the flux2 venv is missing', () => {
    mockResolveFlux2Python.mockReturnValue(null);
    expect(() => buildArgs({
      ...baseInput,
      model: {
        id: 'flux2-klein-4b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      },
    })).toThrow(/INSTALL_FLUX2=1/);
  });

  it('throws when an SDNQ flux2 model is missing tokenizerRepo', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    expect(() => buildArgs({
      ...baseInput,
      model: {
        id: 'flux2-klein-4b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
        // tokenizerRepo missing — registry was edited badly
      },
    })).toThrow(/tokenizerRepo/);
  });

  it('throws when an Int8 flux2 model is missing basePipelineRepo', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    expect(() => buildArgs({
      ...baseInput,
      model: {
        id: 'flux2-klein-4b-int8',
        runner: 'flux2',
        quantization: 'int8',
        repo: 'aydin99/FLUX.2-klein-4B-int8',
      },
    })).toThrow(/basePipelineRepo/);
  });

  it('throws when a flux2 model is missing repo entirely', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    expect(() => buildArgs({
      ...baseInput,
      model: { id: 'flux2-broken', runner: 'flux2', quantization: 'sdnq' },
    })).toThrow(/missing the 'repo' field/);
  });

  it('passes init-image args for flux2 i2i', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      initImagePath: '/safe/path/init.png',
      initImageStrength: 0.7,
      model: {
        id: 'flux2-klein-4b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      },
    });
    expect(args).toContain('--image-path');
    expect(args[args.indexOf('--image-path') + 1]).toBe('/safe/path/init.png');
    expect(args).toContain('--image-strength');
    expect(args[args.indexOf('--image-strength') + 1]).toBe('0.7');
  });

  it('emits --reference-images + --reference-strengths for flux2 multi-ref edits', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      referenceImagePaths: ['/safe/path/ref-a.png', '/safe/path/ref-b.jpg'],
      referenceImageStrengths: [0.85, 0.5],
      model: {
        id: 'flux2-klein-9b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-9B',
      },
    });
    const refIdx = args.indexOf('--reference-images');
    expect(refIdx).toBeGreaterThan(-1);
    // Both paths land immediately after the flag, in submit order.
    expect(args[refIdx + 1]).toBe('/safe/path/ref-a.png');
    expect(args[refIdx + 2]).toBe('/safe/path/ref-b.jpg');
    const strIdx = args.indexOf('--reference-strengths');
    expect(strIdx).toBeGreaterThan(-1);
    expect(args[strIdx + 1]).toBe('0.85');
    expect(args[strIdx + 2]).toBe('0.5');
  });

  it('omits --reference-images entirely when no reference paths are supplied', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      model: {
        id: 'flux2-klein-4b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      },
    });
    expect(args).not.toContain('--reference-images');
    expect(args).not.toContain('--reference-strengths');
  });

  it('skips --reference-strengths when paths are supplied without strengths', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      referenceImagePaths: ['/safe/path/ref-only.png'],
      referenceImageStrengths: [],
      model: {
        id: 'flux2-klein-4b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-4B-SDNQ-4bit-dynamic',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-4B',
      },
    });
    expect(args).toContain('--reference-images');
    expect(args).not.toContain('--reference-strengths');
  });

  // Templates land at /data/templates/, not /data/images/ — the runner-side
  // resolver (generateImage) accepts them via resolveImageInputPath (covered
  // in fileUtils.test.js). Pin that buildArgs emits the validated absolute
  // path verbatim so a future refactor can't silently drop the template anchor.
  it('emits --image-path verbatim for a pre-validated template path', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      initImagePath: '/data/templates/character-reference-sheet.png',
      initImageStrength: 0.25,
      model: {
        id: 'flux2-klein-9b',
        runner: 'flux2',
        quantization: 'sdnq',
        repo: 'Disty0/FLUX.2-klein-9B-SDNQ-4bit-dynamic-svd-r32',
        tokenizerRepo: 'black-forest-labs/FLUX.2-klein-9B',
      },
    });
    expect(args).toContain('--image-path');
    expect(args[args.indexOf('--image-path') + 1]).toBe('/data/templates/character-reference-sheet.png');
    expect(args).toContain('--image-strength');
    expect(args[args.indexOf('--image-strength') + 1]).toBe('0.25');
  });

  it('falls back to mflux dispatch for non-flux2 models on macOS', () => {
    // No flux2 mock needed — the branch shouldn't be taken at all.
    mockResolveFlux2Python.mockReturnValue(null);
    const { bin, args } = buildArgs({
      ...baseInput,
      model: { id: 'dev', steps: 20, guidance: 3.5 },
    });
    // mflux-generate sits next to the python binary in the venv.
    expect(bin).toMatch(/mflux-generate$/);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('dev');
    expect(args).toContain('--quantize');
  });
});

describe('imageGen local.buildArgs z-image dispatch', () => {
  beforeEach(() => {
    mockResolveFlux2Python.mockReset();
  });

  const baseInput = {
    pythonPath: '/usr/bin/python3', // unused for z-image but kept in shape
    prompt: 'a green dragon',
    negativePrompt: '',
    width: 1024,
    height: 1024,
    steps: 8,
    guidance: 1.0,
    seed: 99,
    quantize: '8',
    outputPath: '/tmp/out.png',
    loraPaths: [],
    loraScales: [],
    stepwiseDir: '/tmp/stepwise',
    initImagePath: null,
    initImageStrength: null,
  };

  it('routes z-image models to the FLUX.2 venv + z_image_turbo.py', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { bin, args } = buildArgs({
      ...baseInput,
      model: {
        id: 'z-image-turbo-bf16',
        runner: 'z-image',
        repo: 'Tongyi-MAI/Z-Image-Turbo',
      },
    });
    expect(bin).toBe('/fake/venv-flux2/bin/python3');
    expect(args[0]).toMatch(/scripts[/\\]z_image_turbo\.py$/);
    expect(args).toContain('--repo');
    expect(args[args.indexOf('--repo') + 1]).toBe('Tongyi-MAI/Z-Image-Turbo');
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toBe('a green dragon');
    expect(args).toContain('--guidance');
    expect(args[args.indexOf('--guidance') + 1]).toBe('1');
    // No --metadata flag: local.js writes the canonical sidecar itself.
    expect(args).not.toContain('--metadata');
    // Stepwise dir threads through.
    expect(args).toContain('--stepwise-image-output-dir');
    expect(args[args.indexOf('--stepwise-image-output-dir') + 1]).toBe('/tmp/stepwise');
    // Z-Image doesn't take FLUX.2's quantization/tokenizer/base flags.
    expect(args).not.toContain('--quantization');
    expect(args).not.toContain('--tokenizer-repo');
    expect(args).not.toContain('--base-pipeline-repo');
  });

  it('throws a setup hint when the FLUX.2 venv is missing for z-image', () => {
    mockResolveFlux2Python.mockReturnValue(null);
    expect(() => buildArgs({
      ...baseInput,
      model: { id: 'z-image-turbo-bf16', runner: 'z-image', repo: 'Tongyi-MAI/Z-Image-Turbo' },
    })).toThrow(/INSTALL_FLUX2=1/);
  });

  it('throws when a z-image model is missing repo', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    expect(() => buildArgs({
      ...baseInput,
      model: { id: 'z-image-broken', runner: 'z-image' },
    })).toThrow(/missing the 'repo' field/);
  });

  it('throws when a z-image model has empty repo string', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    expect(() => buildArgs({
      ...baseInput,
      model: { id: 'z-image-quant', runner: 'z-image', repo: '' },
    })).toThrow(/missing the 'repo' field/);
  });

  it('passes init-image args for z-image i2i', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      initImagePath: '/safe/path/init.png',
      initImageStrength: 0.6,
      model: {
        id: 'z-image-turbo-bf16',
        runner: 'z-image',
        repo: 'Tongyi-MAI/Z-Image-Turbo',
      },
    });
    expect(args).toContain('--image-path');
    expect(args[args.indexOf('--image-path') + 1]).toBe('/safe/path/init.png');
    expect(args).toContain('--image-strength');
    expect(args[args.indexOf('--image-strength') + 1]).toBe('0.6');
  });

  it('passes negative prompt only when non-empty', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args: withoutNeg } = buildArgs({
      ...baseInput,
      model: { id: 'z-image-turbo-bf16', runner: 'z-image', repo: 'Tongyi-MAI/Z-Image-Turbo' },
    });
    expect(withoutNeg).not.toContain('--negative-prompt');
    const { args: withNeg } = buildArgs({
      ...baseInput,
      negativePrompt: 'blurry',
      model: { id: 'z-image-turbo-bf16', runner: 'z-image', repo: 'Tongyi-MAI/Z-Image-Turbo' },
    });
    expect(withNeg).toContain('--negative-prompt');
    expect(withNeg[withNeg.indexOf('--negative-prompt') + 1]).toBe('blurry');
  });

  it('routes ERNIE models through the same script with --pipeline-class + --use-pe', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { bin, args } = buildArgs({
      ...baseInput,
      model: {
        id: 'ernie-image',
        runner: 'ernie',
        repo: 'baidu/ERNIE-Image',
        pipelineClass: 'ErnieImagePipeline',
        usePromptEnhancer: true,
      },
    });
    expect(bin).toBe('/fake/venv-flux2/bin/python3');
    expect(args[0]).toMatch(/scripts[/\\]z_image_turbo\.py$/);
    expect(args).toContain('--pipeline-class');
    expect(args[args.indexOf('--pipeline-class') + 1]).toBe('ErnieImagePipeline');
    expect(args).toContain('--use-pe');
    expect(args[args.indexOf('--repo') + 1]).toBe('baidu/ERNIE-Image');
  });

  it('omits --pipeline-class and --use-pe when the registry entry doesn\'t set them', () => {
    mockResolveFlux2Python.mockReturnValue('/fake/venv-flux2/bin/python3');
    const { args } = buildArgs({
      ...baseInput,
      model: { id: 'z-image-turbo-bf16', runner: 'z-image', repo: 'Tongyi-MAI/Z-Image-Turbo' },
    });
    expect(args).not.toContain('--pipeline-class');
    expect(args).not.toContain('--use-pe');
  });
});

describe('imageGen local.buildSidecarMeta', () => {
  // Pull the real PATHS.loras prefix so LoRA candidates the meta-builder joins
  // against it pass its resolve+prefix check. Existence is faked via the
  // injected `loraExists` so the test never touches the filesystem.
  let LORAS_ROOT;
  let join_;
  beforeAll(async () => {
    ({ PATHS: { loras: LORAS_ROOT } } = await import('../../lib/fileUtils.js'));
    ({ join: join_ } = await import('path'));
  });

  // Default injectable deps: resolveInputPath echoes any path it's given (i.e.
  // every supplied path is "valid"), loraExists always true, fixed timestamp.
  const ECHO = (p) => p;
  const ALWAYS = () => true;
  const FIXED_NOW = () => '2024-01-01T00:00:00.000Z';

  const baseMetaInput = {
    jobId: 'job-1234-5678',
    model: { id: 'flux2-klein-9b', steps: 8, guidance: 0 },
    prompt: 'a red cube',
    negativePrompt: '',
    modelId: 'flux2-klein-9b',
    width: 1024,
    height: 768,
    steps: 8,
    guidance: 0,
    seed: 42,
    quantize: 'sdnq',
    resolveInputPath: ECHO,
    loraExists: ALWAYS,
    now: FIXED_NOW,
  };

  it('builds the canonical sidecar meta shape with reference fields populated', () => {
    const refA = '/data/images/ref-a.png';
    const refB = '/data/image-refs/ref-b.jpg';
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      referenceImagePaths: [refA, refB],
      referenceImageStrengths: [0.85, 0.5],
    });
    expect(meta).toMatchObject({
      id: 'job-1234-5678',
      prompt: 'a red cube',
      negativePrompt: '',
      modelId: 'flux2-klein-9b',
      seed: 42,
      width: 1024,
      height: 768,
      steps: 8,
      guidance: 0,
      quantize: 'sdnq',
      filename: 'job-1234-5678.png',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    // referenceImageFilenames stores basenames, parallel to the strengths array.
    expect(meta.referenceImageFilenames).toEqual(['ref-a.png', 'ref-b.jpg']);
    expect(meta.referenceImageStrengths).toEqual([0.85, 0.5]);
  });

  it('defaults each missing reference strength to 1.0 (full influence)', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      referenceImagePaths: ['/data/images/r1.png', '/data/images/r2.png'],
      referenceImageStrengths: [0.3], // only the first supplied
    });
    expect(meta.referenceImageFilenames).toEqual(['r1.png', 'r2.png']);
    expect(meta.referenceImageStrengths).toEqual([0.3, 1.0]);
  });

  it('clamps reference strengths to 0..1 and falls back to 1.0 on non-finite', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      referenceImagePaths: ['/data/images/lo.png', '/data/images/hi.png', '/data/images/bad.png'],
      referenceImageStrengths: [-2, 5, Number('nope')],
    });
    expect(meta.referenceImageStrengths).toEqual([0, 1, 1.0]);
  });

  it('drops a rejected reference path WITHOUT shifting the surviving strength', () => {
    // resolveInputPath rejects the second path; the third must keep ITS own
    // strength (0.9), not inherit the dropped slot's (0.2). This pins the
    // "pair before filter" invariant the meta-builder relies on.
    const resolveInputPath = (p) => (p.includes('reject') ? null : p);
    const { meta, validReferenceImagePaths } = buildSidecarMeta({
      ...baseMetaInput,
      resolveInputPath,
      referenceImagePaths: ['/data/images/keep.png', '/data/images/reject.png', '/data/images/also-keep.png'],
      referenceImageStrengths: [0.4, 0.2, 0.9],
    });
    expect(validReferenceImagePaths).toEqual(['/data/images/keep.png', '/data/images/also-keep.png']);
    expect(meta.referenceImageFilenames).toEqual(['keep.png', 'also-keep.png']);
    expect(meta.referenceImageStrengths).toEqual([0.4, 0.9]);
  });

  it('emits empty reference arrays when no references are supplied', () => {
    const { meta } = buildSidecarMeta({ ...baseMetaInput });
    expect(meta.referenceImageFilenames).toEqual([]);
    expect(meta.referenceImageStrengths).toEqual([]);
  });

  it('tolerates a non-array referenceImagePaths (sidecar replay corruption)', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      referenceImagePaths: null,
      referenceImageStrengths: null,
    });
    expect(meta.referenceImageFilenames).toEqual([]);
    expect(meta.referenceImageStrengths).toEqual([]);
  });

  it('records initImageFilename + clamped strength for i2i', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      initImagePath: '/data/images/init.png',
      initImageStrength: 0.7,
    });
    expect(meta.initImageFilename).toBe('init.png');
    expect(meta.initImageStrength).toBe(0.7);
  });

  it('leaves init strength null when no init image survives resolution', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      resolveInputPath: () => null, // init path rejected
      initImagePath: '/somewhere/outside.png',
      initImageStrength: 0.7,
    });
    expect(meta.initImageFilename).toBeNull();
    expect(meta.initImageStrength).toBeNull();
  });

  it('keeps only LoRA basenames that exist, storing both filenames + paths', () => {
    const loraFilenames = ['lora-good.safetensors', 'lora-missing.safetensors'];
    const loraExists = (abs) => abs.endsWith('lora-good.safetensors');
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      loraFilenames,
      loraScales: [1.0],
      loraExists,
    });
    expect(meta.loraFilenames).toEqual(['lora-good.safetensors']);
    expect(meta.loraPaths).toEqual([join_(LORAS_ROOT, 'lora-good.safetensors')]);
    // loraScales passes through verbatim (the runner pairs them positionally).
    expect(meta.loraScales).toEqual([1.0]);
  });

  it('rejects a LoRA path outside the loras root (sidecar replay traversal)', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      loraPaths: ['/etc/evil.safetensors'],
      loraExists: ALWAYS, // would exist, but prefix-check must reject it first
    });
    expect(meta.loraFilenames).toEqual([]);
    expect(meta.loraPaths).toEqual([]);
  });

  it('falls back to model defaults for steps and guidance when unset', () => {
    const { meta } = buildSidecarMeta({
      ...baseMetaInput,
      model: { id: 'm', steps: 28, guidance: 3.5 },
      steps: undefined,
      guidance: undefined,
    });
    expect(meta.steps).toBe(28);
    expect(meta.guidance).toBe(3.5);
  });

  it('clamps guidance to <=1.0 for cfgDisabled models, leaving sub-1.0 untouched', () => {
    const high = buildSidecarMeta({
      ...baseMetaInput,
      model: { id: 'm', steps: 8, cfgDisabled: true },
      guidance: 7.5,
    }).meta;
    expect(high.guidance).toBe(1.0);
    const low = buildSidecarMeta({
      ...baseMetaInput,
      model: { id: 'm', steps: 8, cfgDisabled: true },
      guidance: 0,
    }).meta;
    expect(low.guidance).toBe(0);
  });

  it('generates a random seed in range when none is supplied', () => {
    const { meta } = buildSidecarMeta({ ...baseMetaInput, seed: undefined });
    expect(Number.isInteger(meta.seed)).toBe(true);
    expect(meta.seed).toBeGreaterThanOrEqual(0);
    expect(meta.seed).toBeLessThan(2147483647);
  });
});
