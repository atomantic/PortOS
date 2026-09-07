import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'url';

// The generative-upscale runtimes are BYO-venv checkouts that do not exist on
// CI (and are the capability gate that keeps #6511 off until #6512/#6513 land),
// so the install assertion is stubbed for the argv tests and exercised on its
// own below. Paths are fixtures, never a real install's layout.
vi.mock('./runtimes.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertByovRuntimeInstalled: vi.fn(),
  LTX25_VENV_PYTHON: '/fixture/ltx-2.5-mlx/.venv/bin/python3',
  LTX25_UPSCALE_HELPER_SCRIPT: '/fixture/scripts/upscale_ltx25.py',
  LTX25_CUDA_VENV_PYTHON: '/fixture/ltx-2.5-cuda/.venv/bin/python3',
  LTX25_CUDA_UPSCALE_HELPER_SCRIPT: '/fixture/scripts/upscale_ltx25_cuda.py',
}));

const { buildArgs, buildLtxUpscaleArgs } = await import('./renderArgs.js');
const runtimes = await import('./runtimes.js');

// An existing file the builder can stat as the IC reference: this test itself,
// so nothing about the developer's install leaks into the fixture.
// fileURLToPath, NOT `new URL(...).pathname` — the latter yields `/D:/a/...` on
// Windows, which existsSync rejects.
const REFERENCE = fileURLToPath(import.meta.url);

const upscale = (extra = {}) => ({
  runtime: 'ltx25',
  sourceVideoPath: REFERENCE,
  icLoraWeightPath: '/fixture/cache/pixel-spatial-upscaler.safetensors',
  icMinReferences: 1,
  icMaxReferences: 1,
  width: 1728,
  height: 1024,
  numFrames: 121,
  fps: 24,
  seed: 4242,
  ...extra,
});

describe('buildLtxUpscaleArgs (#6511)', () => {
  it('builds the exact MLX argv, with the reference bounds passed explicitly', () => {
    expect(buildLtxUpscaleArgs({ ...upscale(), outputPath: '/fixture/out.mp4' })).toEqual({
      bin: '/fixture/ltx-2.5-mlx/.venv/bin/python3',
      args: [
        '/fixture/scripts/upscale_ltx25.py',
        '--ic-lora-path', '/fixture/cache/pixel-spatial-upscaler.safetensors',
        '--ic-reference', REFERENCE,
        '--ic-min-references', '1',
        '--ic-max-references', '1',
        '--width', '1728',
        '--height', '1024',
        '--num-frames', '121',
        '--fps', '24',
        '--seed', '4242',
        '--output', '/fixture/out.mp4',
      ],
    });
  });

  it('routes the CUDA runtime to its own interpreter and helper', () => {
    const { bin, args } = buildLtxUpscaleArgs({ ...upscale({ runtime: 'ltx25_cuda' }), outputPath: '/fixture/out.mp4' });
    expect(bin).toBe('/fixture/ltx-2.5-cuda/.venv/bin/python3');
    expect(args[0]).toBe('/fixture/scripts/upscale_ltx25_cuda.py');
  });

  // The bounds are `run_ic_lora`'s contract and the weight registry is their
  // single source of truth across both languages. A job that lost them (an old
  // persisted job, a hand-edited media-jobs.json) must fail rather than let the
  // Python helper supply a second, drifting table.
  it.each([
    ['icMinReferences', { icMinReferences: undefined }],
    ['icMaxReferences', { icMaxReferences: null }],
    ['a non-integer bound', { icMinReferences: 1.5 }],
  ])('refuses to render when %s is missing', (_label, extra) => {
    expect(() => buildLtxUpscaleArgs({ ...upscale(extra), outputPath: '/fixture/out.mp4' }))
      .toThrow(expect.objectContaining({ code: 'IC_LORA_REFERENCE_BOUNDS_MISSING' }));
  });

  it('refuses an un-downloaded adapter rather than handing the pipeline a repo id', () => {
    expect(() => buildLtxUpscaleArgs({ ...upscale({ icLoraWeightPath: null }), outputPath: '/fixture/out.mp4' }))
      .toThrow(expect.objectContaining({ code: 'IC_LORA_WEIGHT_UNRESOLVED' }));
  });

  it('refuses a source clip that is not on disk', () => {
    expect(() => buildLtxUpscaleArgs({ ...upscale({ sourceVideoPath: '/fixture/gone.mp4' }), outputPath: '/fixture/out.mp4' }))
      .toThrow(expect.objectContaining({ code: 'IC_LORA_REFERENCE_MISSING' }));
  });

  it('refuses a runtime with no upscale runner', () => {
    expect(() => buildLtxUpscaleArgs({ ...upscale({ runtime: 'ltx2' }), outputPath: '/fixture/out.mp4' }))
      .toThrow(expect.objectContaining({ code: 'UPSCALE_RUNTIME_UNSUPPORTED' }));
  });

  // The capability gate #6511 ships behind: with no venv installed there is no
  // generative upscale on this machine, whatever else the request carries.
  it('asserts the BYOV runtime is installed before building anything', () => {
    runtimes.assertByovRuntimeInstalled.mockImplementationOnce(() => {
      throw Object.assign(new Error('LTX-2.5 MLX runtime is not installed.'), { code: 'LTX25_VENV_MISSING' });
    });
    expect(() => buildLtxUpscaleArgs({ ...upscale(), outputPath: '/fixture/out.mp4' }))
      .toThrow(expect.objectContaining({ code: 'LTX25_VENV_MISSING' }));
  });
});

describe('buildArgs upscale dispatch', () => {
  // The upscale carries no video model, no prompt and no reference mode, so it
  // has to decline before any of buildArgs' render guards dereference one.
  it('routes an upscale request without a model or prompt', () => {
    expect(buildArgs({ upscale: upscale(), outputPath: '/fixture/out.mp4' }))
      .toEqual(buildLtxUpscaleArgs({ ...upscale(), outputPath: '/fixture/out.mp4' }));
  });
});
