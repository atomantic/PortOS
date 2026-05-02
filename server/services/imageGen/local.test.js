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

// Point the registry at a temp dir so importing local.js (which calls
// getImageModels() at module load and triggers seedIfMissing in
// mediaModels.js) doesn't write to the repo's data/media-models.json.
// Save + restore the prior env value and call vi.resetModules() so a
// previously-cached mediaModels.js inside the same vitest worker doesn't
// stick to the wrong file. Pattern matches server/lib/mediaModels.test.js.
let tmpRegistryDir;
let priorRegistryEnv;
let buildArgs;

beforeAll(async () => {
  tmpRegistryDir = mkdtempSync(join(tmpdir(), 'portos-imagegen-local-test-'));
  priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
  process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRegistryDir, 'media-models.json');
  vi.resetModules();
  ({ buildArgs } = await import('./local.js'));
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
