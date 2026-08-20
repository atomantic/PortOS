import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TRELLIS2_CUDA_REPO,
  TRELLIS2_CUDA_CONDA_ENV,
  TRELLIS2_CUDA_SETUP_FLAGS,
  TRELLIS2_CUDA_TEXTURE_SIZES,
  TRELLIS2_CUDA_DEFAULT_TEXTURE_SIZE,
  TRELLIS2_CUDA_HIGH_QUALITY_TEXTURE_SIZE,
  TRELLIS2_CUDA_DEFAULT_DECIMATION,
  TRELLIS2_CUDA_HIGH_QUALITY_DECIMATION,
  TRELLIS2_CUDA_HIGH_QUALITY_MIN_VRAM_GB,
  trellis2CudaRoot,
  trellis2CudaPython,
  trellis2CudaPythonCandidates,
  trellis2CudaGenerateRunnerScript,
  isTrellis2CudaInstalled,
  buildCudaInstallSteps,
  buildCudaGenerateArgs,
  selectTrellis2CudaExportBudget,
  installTrellis2Cuda,
  runTrellis2CudaGenerate,
} from './trellis2Cuda.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Paths are composed with join() rather than written as posix literals so these
// assertions hold on every host the repo is developed on.
const BASE = join('/tmp', 'portos-test-home');
const ROOT = join(BASE, 'trellis2-cuda');
const CONDA = join('/opt', 'conda');
const CONDA_PY = join(CONDA, 'envs', 'trellis2', 'bin', 'python');

/** An `exists` stub that answers true for exactly the listed paths. */
const existsFor = (...paths) => (p) => paths.includes(p);

/** A fully installed host: conda env python + the upstream package on disk. */
const INSTALLED = existsFor(CONDA_PY, join(ROOT, 'trellis2'));
const CONDA_ENV = { CONDA_ROOT: CONDA };

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('trellis2Cuda path resolution', () => {
  it('roots the install under the injected base, beside (not inside) the MPS lane', () => {
    expect(trellis2CudaRoot(BASE)).toBe(ROOT);
    // Distinct dirs — the two lanes must never share a clone or a venv.
    expect(trellis2CudaRoot(BASE)).not.toBe(join(BASE, 'trellis2'));
  });

  it('probes conda roots for the env setup.sh --new-env creates', () => {
    const candidates = trellis2CudaPythonCandidates({ env: CONDA_ENV });
    expect(candidates).toContain(CONDA_PY);
    expect(candidates.every((p) => p.includes(join('envs', TRELLIS2_CUDA_CONDA_ENV)))).toBe(true);
  });

  it('walks up from an active envs/<name> CONDA_PREFIX to find the base install', () => {
    // PortOS itself running under some other conda env must still locate `trellis2`.
    const candidates = trellis2CudaPythonCandidates({
      env: { CONDA_PREFIX: join(CONDA, 'envs', 'portos') },
    });
    expect(candidates.some((p) => p.includes(join('conda', 'envs', 'trellis2')))).toBe(true);
  });

  it('returns the first existing candidate, or null when none is present', () => {
    expect(trellis2CudaPython({ exists: existsFor(CONDA_PY), env: CONDA_ENV })).toBe(CONDA_PY);
    expect(trellis2CudaPython({ exists: () => false, env: CONDA_ENV })).toBeNull();
  });

  it('resolves PortOS’s own runner script (upstream ships no CLI entrypoint)', () => {
    expect(trellis2CudaGenerateRunnerScript()).toMatch(/trellis2CudaGenerateRunner\.py$/);
  });
});

describe('isTrellis2CudaInstalled', () => {
  it('is true only when BOTH the conda python and the upstream package exist', () => {
    expect(isTrellis2CudaInstalled({ base: BASE, exists: INSTALLED, env: CONDA_ENV })).toBe(true);
  });

  it('is false when setup.sh built the env but the package is missing', () => {
    // The realistic half-install: env created, then a CUDA extension build failed.
    expect(isTrellis2CudaInstalled({ base: BASE, exists: existsFor(CONDA_PY), env: CONDA_ENV }))
      .toBe(false);
  });

  it('is false when the clone exists but no conda env was ever built', () => {
    expect(isTrellis2CudaInstalled({
      base: BASE, exists: existsFor(join(ROOT, 'trellis2')), env: CONDA_ENV,
    })).toBe(false);
  });
});

describe('buildCudaInstallSteps', () => {
  it('clones recursively — upstream vendors its CUDA extensions as submodules', () => {
    const steps = buildCudaInstallSteps(BASE, { exists: () => false });
    expect(steps.map((s) => s.stage)).toEqual(['clone', 'setup']);
    expect(steps[0]).toMatchObject({
      command: 'git',
      args: ['clone', '-b', 'main', '--recursive', TRELLIS2_CUDA_REPO, ROOT],
    });
  });

  it('SOURCES setup.sh in a login shell so `conda activate` has its hooks', () => {
    // `bash setup.sh` would run conda activate in a shell with no profile loaded and
    // install into the wrong interpreter — upstream documents `. ./setup.sh`.
    const [, setup] = buildCudaInstallSteps(BASE, { exists: () => false });
    expect(setup).toMatchObject({ stage: 'setup', command: 'bash', cwd: ROOT });
    expect(setup.args[0]).toBe('-lc');
    expect(setup.args[1]).toMatch(/^\. \.\/setup\.sh /);
  });

  it('passes upstream’s documented extension flags verbatim', () => {
    const [, setup] = buildCudaInstallSteps(BASE, { exists: () => false });
    for (const flag of TRELLIS2_CUDA_SETUP_FLAGS) expect(setup.args[1]).toContain(flag);
    // --o-voxel provides the to_glb exporter the runner calls; dropping it yields an
    // install that imports and then fails mid-render.
    expect(setup.args[1]).toContain('--o-voxel');
  });

  it('skips the clone and resumes at setup when the repo is already on disk', () => {
    // Load-bearing for resume: an unconditional clone would abort on "destination
    // path already exists" and never reach the idempotent setup.
    const steps = buildCudaInstallSteps(BASE, { exists: existsFor(join(ROOT, '.git')) });
    expect(steps.map((s) => s.stage)).toEqual(['setup']);
  });
});

describe('selectTrellis2CudaExportBudget', () => {
  it('keeps the supported 24 GB floor on the conservative lane', () => {
    expect(selectTrellis2CudaExportBudget(24)).toEqual({
      textureSize: TRELLIS2_CUDA_DEFAULT_TEXTURE_SIZE,
      decimationTarget: TRELLIS2_CUDA_DEFAULT_DECIMATION,
    });
  });

  it('opts into upstream’s full-fat settings only with real headroom', () => {
    expect(selectTrellis2CudaExportBudget(TRELLIS2_CUDA_HIGH_QUALITY_MIN_VRAM_GB)).toEqual({
      textureSize: TRELLIS2_CUDA_HIGH_QUALITY_TEXTURE_SIZE,
      decimationTarget: TRELLIS2_CUDA_HIGH_QUALITY_DECIMATION,
    });
  });

  it('falls back to the conservative lane when VRAM is unknown', () => {
    // An unsized card must degrade quality, never overcommit VRAM.
    for (const unknown of [null, undefined, NaN]) {
      expect(selectTrellis2CudaExportBudget(unknown)).toEqual({
        textureSize: TRELLIS2_CUDA_DEFAULT_TEXTURE_SIZE,
        decimationTarget: TRELLIS2_CUDA_DEFAULT_DECIMATION,
      });
    }
  });

  it('moves atlas size and decimation target together, never one without the other', () => {
    // A 4K atlas over a 200k mesh (or the reverse) is a combination nothing intends.
    const floor = selectTrellis2CudaExportBudget(24);
    const high = selectTrellis2CudaExportBudget(80);
    expect(floor.textureSize).not.toBe(high.textureSize);
    expect(floor.decimationTarget).not.toBe(high.decimationTarget);
  });
});

describe('buildCudaGenerateArgs', () => {
  const args = (extra = {}) => buildCudaGenerateArgs({
    imagePath: '/img/in.png', base: BASE, python: CONDA_PY, ...extra,
  });

  it('invokes PortOS’s runner with the conda python and the repo root', () => {
    const { command, args: argv } = args();
    expect(command).toBe(CONDA_PY);
    expect(argv[0]).toMatch(/trellis2CudaGenerateRunner\.py$/);
    expect(argv[1]).toBe('/img/in.png');
    expect(argv).toContain('--repo-root');
    expect(argv[argv.indexOf('--repo-root') + 1]).toBe(ROOT);
  });

  it('strips a trailing .glb so the runner’s stem+extension does not double it', () => {
    const { args: argv } = args({ outputPath: '/out/model.glb' });
    expect(argv[argv.indexOf('--output') + 1]).toBe('/out/model');
  });

  it('passes the resolved texture size and decimation target', () => {
    const { args: argv } = args({ textureSize: 4096, decimationTarget: 1_000_000 });
    expect(argv[argv.indexOf('--texture-size') + 1]).toBe('4096');
    expect(argv[argv.indexOf('--decimation-target') + 1]).toBe('1000000');
  });

  it('throws without a source image — a render with no input is a bug, not an empty run', () => {
    expect(() => buildCudaGenerateArgs({ base: BASE })).toThrow(/imagePath is required/);
  });

  it('rejects an unsupported texture size here rather than in the child’s argparse', () => {
    expect(() => args({ textureSize: 8192 })).toThrow(/must be one of/);
    expect(TRELLIS2_CUDA_TEXTURE_SIZES).not.toContain(8192);
  });

  it('passes --seed and --steps when provided and omits both by default (MPS-lane parity)', () => {
    const { args: argv } = args({ seed: 1234, steps: 24 });
    expect(argv[argv.indexOf('--seed') + 1]).toBe('1234');
    expect(argv[argv.indexOf('--steps') + 1]).toBe('24');

    const { args: defaults } = args();
    expect(defaults).not.toContain('--seed');
    expect(defaults).not.toContain('--steps');
  });

  it('rejects out-of-range steps and seed here rather than in the child’s argparse', () => {
    expect(() => args({ steps: 0 })).toThrow(/steps must be an integer/);
    expect(() => args({ seed: -1 })).toThrow(/seed must be an integer/);
  });
});

describe('installTrellis2Cuda', () => {
  it('runs the steps in order and completes once the install verifies', async () => {
    const children = [];
    const spawnImpl = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const events = [];
    // Not installed at plan time (so the clone step is included), installed at verify.
    let installed = false;
    const exists = (p) => (installed ? INSTALLED(p) : false);

    const { promise } = installTrellis2Cuda({
      base: BASE, spawnImpl, exists, env: CONDA_ENV, onEvent: (e) => events.push(e),
    });
    await flush();
    children[0].emit('close', 0); // clone
    await flush();
    installed = true;
    children[1].emit('close', 0); // setup
    await expect(promise).resolves.toEqual({ ok: true });

    expect(spawnImpl.mock.calls.map((c) => c[0])).toEqual(['git', 'bash']);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });

  it('fails loudly when setup.sh exits 0 without producing a usable environment', async () => {
    // setup.sh can leave a conda env behind while an extension build failed; a bare
    // exit-0 success would report an install that cannot render (the #2952 lesson).
    const children = [];
    const spawnImpl = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const { promise } = installTrellis2Cuda({
      base: BASE, spawnImpl, exists: existsFor(join(ROOT, '.git')), env: CONDA_ENV,
    });
    await flush();
    children[0].emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_INSTALL_INCOMPLETE' });
  });

  it('retries a transient network failure in place, then succeeds', async () => {
    const children = [];
    const spawnImpl = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    let installed = false;
    const { promise } = installTrellis2Cuda({
      base: BASE,
      spawnImpl,
      exists: (p) => (installed ? INSTALLED(p) : existsFor(join(ROOT, '.git'))(p)),
      env: CONDA_ENV,
      sleep: () => Promise.resolve(),
    });
    await flush();
    children[0].stderr.emit('data', 'fatal: early EOF\nfetch-pack: invalid index-pack output');
    children[0].emit('close', 128);
    await flush();
    expect(spawnImpl).toHaveBeenCalledTimes(2); // retried the same idempotent step
    installed = true;
    children[1].emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('does NOT retry a real (non-transient) failure', async () => {
    const children = [];
    const spawnImpl = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const { promise } = installTrellis2Cuda({
      base: BASE, spawnImpl, exists: existsFor(join(ROOT, '.git')), env: CONDA_ENV,
      sleep: () => Promise.resolve(),
    });
    await flush();
    children[0].stderr.emit('data', 'error: no CUDA toolkit found; aborting');
    children[0].emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_INSTALL_FAILED', stage: 'setup' });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('cancels in flight and stops before the next step', async () => {
    const children = [];
    const spawnImpl = vi.fn(() => { const c = makeChild(); children.push(c); return c; });
    const { promise, kill } = installTrellis2Cuda({
      base: BASE, spawnImpl, exists: () => false, env: CONDA_ENV,
    });
    await flush();
    kill();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_INSTALL_CANCELED' });
    expect(spawnImpl).toHaveBeenCalledTimes(1); // never started `setup`
  });
});

describe('runTrellis2CudaGenerate', () => {
  const run = (opts = {}) => runTrellis2CudaGenerate({
    imagePath: '/img/in.png',
    outputPath: '/out/model.glb',
    base: BASE,
    exists: INSTALLED,
    env: CONDA_ENV,
    postprocessGlb: vi.fn(),
    ...opts,
  });

  it('refuses to run — and never spawns — when the environment is absent', async () => {
    // The no-cold-bootstrap guard: this must be impossible to reach on a fresh host.
    const spawnImpl = vi.fn();
    const { promise } = run({ exists: () => false, spawnImpl });
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_NOT_INSTALLED' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('resolves with the produced asset and normalizes its materials to opaque', async () => {
    const child = makeChild();
    const postprocessGlb = vi.fn();
    const { promise } = run({ spawnImpl: () => child, postprocessGlb });
    await flush();
    child.stdout.emit('data', 'Saved: /out/model.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/model.glb' });
    expect(postprocessGlb).toHaveBeenCalledWith('/out/model.glb');
  });

  it('streams progress through the MPS lane’s parser — one vocabulary, two lanes', async () => {
    const child = makeChild();
    const frames = [];
    const { promise } = run({ spawnImpl: () => child, onProgress: (f) => frames.push(f) });
    await flush();
    // The banners the Python runner prints, in order.
    child.stdout.emit('data', 'Loading pipeline...\n');
    child.stdout.emit('data', 'Device: cuda (NVIDIA GeForce RTX 3090)\n');
    child.stdout.emit('data', 'Generating 3D model...\n');
    child.stdout.emit('data', ' 50%|#####     | 6/12\r 75%|#######   | 9/12\r');
    child.stdout.emit('data', 'Mesh: 120000 vertices, 240000 faces\n');
    child.stdout.emit('data', 'Baking textures at 2048px...\n');
    child.stdout.emit('data', 'Saved: /out/model.glb\n');
    child.emit('close', 0);
    await promise;

    expect(frames.map((f) => f.stage)).toEqual([
      'loading', 'loading', 'generating', 'generating', 'generating', 'meshing', 'texturing', 'export',
    ]);
    // Percent advances monotonically across the whole render.
    const percents = frames.map((f) => f.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('classifies a gated-repo failure as actionable HF auth, not a crash', async () => {
    const child = makeChild();
    const { promise } = run({ spawnImpl: () => child });
    await flush();
    child.stderr.emit('data', 'GatedRepoError: access to model facebook/dinov3 is restricted');
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_HF_AUTH_REQUIRED' });
    // The message names the gated repo from the registry, so the two never drift.
    await promise.catch((err) => expect(err.message).toContain('facebook/dinov3-vitl16-pretrain-lvd1689m'));
  });

  it('classifies a CUDA OOM distinctly from a generic failure', async () => {
    const child = makeChild();
    const { promise } = run({ spawnImpl: () => child });
    await flush();
    child.stderr.emit('data', 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB');
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_OUT_OF_MEMORY' });
  });

  it('fails when the child exits 0 without ever emitting a .glb', async () => {
    const child = makeChild();
    const { promise } = run({ spawnImpl: () => child, outputPath: undefined });
    await flush();
    child.emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_GENERATE_FAILED' });
  });

  it('surfaces a postprocess failure rather than reporting a bad mesh as ready', async () => {
    const child = makeChild();
    const { promise } = run({
      spawnImpl: () => child,
      postprocessGlb: vi.fn(() => { throw new Error('not a GLB'); }),
    });
    await flush();
    child.stdout.emit('data', 'Saved: /out/model.glb\n');
    child.emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_GLB_POSTPROCESS_FAILED' });
  });

  it('kills the child on request so a deleted record stops burning GPU', async () => {
    const child = makeChild();
    const { promise, kill } = run({ spawnImpl: () => child });
    await flush();
    kill();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 143);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_CUDA_GENERATE_FAILED' });
  });
});
