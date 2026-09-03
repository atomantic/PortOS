import { beforeEach, describe, expect, it, vi } from 'vitest';

// The `fastvideo` runtime is a BYO-venv checkout that does not exist on CI, so
// the install assertion is stubbed. Everything else under test is pure argv
// construction. Paths are fixtures, never a real install's layout.
vi.mock('./runtimes.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertByovRuntimeInstalled: vi.fn(),
  FASTVIDEO_VENV_PYTHON: '/fixture/fastvideo/.venv/bin/python3',
  FASTVIDEO_HELPER_SCRIPT: '/fixture/scripts/generate_fastvideo.py',
  FASTVIDEO_REPO_DIR: '/fixture/fastvideo',
  FASTVIDEO_MLX_CHECKPOINT_DIR: '/fixture/fastvideo/mlx-checkpoints',
  FASTVIDEO_PROMPT_CACHE_DIR: '/fixture/fastvideo/prompt-cache',
}));

const { buildFastVideoArgs, fastvideoFamily, fastvideoMlxFormat } = await import('./renderArgs.js');

const fastmetal = {
  id: 'fastmetal_5b_qad',
  name: 'Example FastMetal Profile',
  runtime: 'fastvideo',
  repo: 'example-org/example-fastmetal',
  supportedModes: ['text', 'image'],
};
const fasth3 = {
  id: 'fasth3_dense_datafree_mlx_int4',
  name: 'Example FastH3 Profile',
  runtime: 'fastvideo',
  fastvideoFamily: 'fasth3',
  repo: 'example-org/example-fasth3',
  supportedModes: ['text'],
};

// The upstream FastVideo snapshot: same family, but its DiT is bf16 under
// transformer/, so the row names the MLX format the helper must convert to.
const fasth3Source = {
  id: 'fasth3_dense_datafree_int6',
  name: 'Example FastH3 Source Profile',
  runtime: 'fastvideo',
  fastvideoFamily: 'fasth3',
  fastvideoMlxFormat: 'int6',
  repo: 'example-org/example-fasth3-source',
  supportedModes: ['text'],
};

const base = {
  prompt: 'a paper boat on a puddle',
  width: 832,
  height: 480,
  numFrames: 124,
  fps: 24,
  steps: 4,
  guidance: 1,
  seed: 2026,
  mode: 'text',
  outputPath: '/fixture/out/render.mp4',
};

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

describe('fastvideoFamily', () => {
  it('defaults to fastmetal for every pre-#5860 row', () => {
    expect(fastvideoFamily(fastmetal)).toBe('fastmetal');
    expect(fastvideoFamily({})).toBe('fastmetal');
    expect(fastvideoFamily(null)).toBe('fastmetal');
  });

  it('reads the declared family off the entry', () => {
    expect(fastvideoFamily(fasth3)).toBe('fasth3');
  });

  it('falls back to fastmetal for an unknown family rather than forwarding it', () => {
    // The helper's argparse would reject an unknown --family, turning a
    // hand-edited or peer-synced row into a crash instead of a render.
    expect(fastvideoFamily({ fastvideoFamily: 'vsa' })).toBe('fastmetal');
  });
});

describe('buildFastVideoArgs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes a FastMetal row through the fastmetal family with no MLX checkpoint', () => {
    const { bin, args } = buildFastVideoArgs({
      ...base, model: fastmetal, fastvideoModelPath: '/fixture/cache/fastmetal',
    });

    expect(bin).toBe('/fixture/fastvideo/.venv/bin/python3');
    expect(flagValue(args, '--family')).toBe('fastmetal');
    expect(flagValue(args, '--model-root')).toBe('/fixture/cache/fastmetal');
    expect(args).not.toContain('--mlx-checkpoint');
  });

  it('routes a FastH3 row through the fasth3 family, pointing both paths at the snapshot', () => {
    // The shipped pack is self-contained: the quantized DiT sits beside the
    // VAEs / text encoder the pipeline loads, so model-root IS the checkpoint.
    const { args } = buildFastVideoArgs({
      ...base, model: fasth3, fastvideoModelPath: '/fixture/cache/fasth3',
    });

    expect(flagValue(args, '--family')).toBe('fasth3');
    expect(flagValue(args, '--model-root')).toBe('/fixture/cache/fasth3');
    expect(flagValue(args, '--mlx-checkpoint')).toBe('/fixture/cache/fasth3');
    // It already holds a quantized DiT, so it must never trigger a conversion.
    expect(args).not.toContain('--mlx-format');
    expect(args).not.toContain('--mlx-checkpoint-cache-dir');
  });

  it('passes the pinned render controls through for FastH3', () => {
    const { args } = buildFastVideoArgs({ ...base, model: fasth3, fastvideoModelPath: '/fixture/cache/fasth3' });

    expect(flagValue(args, '--width')).toBe('832');
    expect(flagValue(args, '--height')).toBe('480');
    expect(flagValue(args, '--num-frames')).toBe('124');
    expect(flagValue(args, '--steps')).toBe('4');
    expect(flagValue(args, '--seed')).toBe('2026');
    expect(flagValue(args, '--output')).toBe('/fixture/out/render.mp4');
  });

  it('falls back to the repo id when the snapshot path is unresolved', () => {
    const { args } = buildFastVideoArgs({ ...base, model: fasth3, fastvideoModelPath: null });

    expect(flagValue(args, '--model-root')).toBe('example-org/example-fasth3');
    expect(flagValue(args, '--mlx-checkpoint')).toBe('example-org/example-fasth3');
  });

  it('refuses an image-mode render against a text-only FastH3 row', () => {
    // mlx_fasth3.py is text-to-video-with-audio only; an i2v request must fail
    // here rather than reach a child process that has no --image-path flag.
    expect(() => buildFastVideoArgs({
      ...base, model: fasth3, mode: 'image', sourceImagePath: '/fixture/first.png',
    })).toThrowError(/mode/i);
  });
});

describe('fastvideoMlxFormat', () => {
  it('is null for a row that already ships a quantized DiT', () => {
    expect(fastvideoMlxFormat(fasth3)).toBeNull();
    expect(fastvideoMlxFormat({})).toBeNull();
    expect(fastvideoMlxFormat(null)).toBeNull();
  });

  it('reads the declared format off the entry', () => {
    expect(fastvideoMlxFormat(fasth3Source)).toBe('int6');
  });

  it('rejects a format the converter does not publish', () => {
    // A hand-edited or peer-synced row naming e.g. "fp8" must not reach the
    // helper's argparse, which would reject it and turn a render into a crash.
    expect(fastvideoMlxFormat({ ...fasth3Source, fastvideoMlxFormat: 'fp8' })).toBeNull();
  });
});

describe('buildFastVideoArgs — upstream FastH3 snapshot', () => {
  it('asks the helper to convert, and does not pin a checkpoint path', () => {
    const { args } = buildFastVideoArgs({
      ...base, model: fasth3Source, fastvideoModelPath: '/fixture/models/fasth3-source',
    });
    expect(flagValue(args, '--mlx-format')).toBe('int6');
    // The converted DiT lands under a SERVER-declared cache root, not beside the
    // snapshot, so pinning --mlx-checkpoint here would point the pipeline at the
    // bf16 diffusers layout it cannot load.
    expect(args).not.toContain('--mlx-checkpoint');
    expect(flagValue(args, '--mlx-checkpoint-cache-dir')).toBe('/fixture/fastvideo/mlx-checkpoints');
    expect(flagValue(args, '--model-root')).toBe('/fixture/models/fasth3-source');
  });

  it('reuses one server-declared prompt cache for every FastH3 row', () => {
    // Conditioning is half a render's wall clock and recomputes identical
    // embeddings, so both layouts must get the flag — and FastMetal must not,
    // since mlx_wan_prompt_to_video.py would reject it.
    for (const model of [fasth3, fasth3Source]) {
      const { args } = buildFastVideoArgs({ ...base, model, fastvideoModelPath: '/fixture/cache/fasth3' });
      expect(flagValue(args, '--prompt-cache-dir')).toBe('/fixture/fastvideo/prompt-cache');
    }
    const { args } = buildFastVideoArgs({ ...base, model: fastmetal, fastvideoModelPath: '/fixture/cache/fastmetal' });
    expect(args).not.toContain('--prompt-cache-dir');
  });

  it('never asks FastMetal to convert, even if a row mislabels a format', () => {
    const { args } = buildFastVideoArgs({
      ...base, model: { ...fastmetal, fastvideoMlxFormat: 'int4' },
      fastvideoModelPath: '/fixture/models/fastmetal',
    });
    expect(args).not.toContain('--mlx-format');
    expect(args).not.toContain('--mlx-checkpoint');
  });
});
