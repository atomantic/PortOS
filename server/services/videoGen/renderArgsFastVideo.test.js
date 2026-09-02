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
}));

const { buildFastVideoArgs, fastvideoFamily } = await import('./renderArgs.js');

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
