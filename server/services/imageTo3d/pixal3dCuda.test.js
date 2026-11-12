import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PIXAL3D_CONDA_ENV,
  PIXAL3D_RESOLUTIONS,
  PIXAL3D_STANDARD_MODE_MIN_VRAM_GB,
  PIXAL3D_HIGH_RES_MIN_VRAM_GB,
  PIXAL3D_NAF_FALLBACK_HELP,
  pixal3dRoot,
  pixal3dPython,
  isPixal3dCudaInstalled,
  buildPixal3dGenerateArgs,
  selectPixal3dRenderBudget,
  parsePixal3dProgress,
  probePixal3dModules,
  isPixal3dNafError,
  isPixal3dWslNafError,
  runPixal3dCudaGenerate,
} from './pixal3dCuda.js';
import { trellis2CudaRoot } from './trellis2Cuda.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Paths are composed with join() rather than posix literals so these assertions hold
// on every host the repo is developed on.
const BASE = join('/tmp', 'portos-test-home');
const ROOT = join(BASE, 'pixal3d');
const REPO = join(ROOT, 'Pixal3D');
const INFERENCE = join(REPO, 'inference.py');
const CONDA = join('/opt', 'conda');
const CONDA_PY = join(CONDA, 'envs', 'pixal3d', 'bin', 'python');
const CONDA_ENV = { CONDA_ROOT: CONDA };

/** An `exists` stub that answers true for exactly the listed paths. */
const existsFor = (...paths) => (p) => paths.includes(p);
/** A fully installed host: conda env python + upstream's entrypoint on disk. */
const INSTALLED = existsFor(CONDA_PY, INFERENCE);

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('pixal3dCuda path resolution', () => {
  it('roots its install apart from BOTH TRELLIS.2 lanes', () => {
    expect(pixal3dRoot(BASE)).toBe(ROOT);
    // The whole point of a separate env: nothing may share a clone with trellis2Cuda,
    // whose dependency set Pixal3D's pinned requirements would otherwise mutate.
    expect(pixal3dRoot(BASE)).not.toBe(trellis2CudaRoot(BASE));
    expect(pixal3dRoot(BASE)).not.toBe(join(BASE, 'trellis2'));
  });

  // The candidate-list shape and the CONDA_PREFIX walk-up are covered once, with the
  // shared resolver (`server/lib/pythonSetup.test.js`). What matters here is that this
  // lane asks for its OWN env — resolving to `trellis2` would hand Pixal3D an
  // interpreter whose dependency set it must not touch.
  it('resolves its own conda env, never the TRELLIS.2 one', () => {
    expect(pixal3dPython({ exists: existsFor(CONDA_PY), env: CONDA_ENV })).toBe(CONDA_PY);
    expect(CONDA_PY).toContain(join('envs', PIXAL3D_CONDA_ENV));
    expect(PIXAL3D_CONDA_ENV).not.toBe('trellis2');
    // A host with ONLY the trellis2 env present must read as not-installed here.
    expect(pixal3dPython({
      exists: existsFor(join(CONDA, 'envs', 'trellis2', 'bin', 'python')), env: CONDA_ENV,
    })).toBeNull();
    expect(pixal3dPython({ exists: () => false, env: CONDA_ENV })).toBeNull();
  });
});

describe('isPixal3dCudaInstalled', () => {
  it('requires BOTH the env python and upstream entrypoint', () => {
    expect(isPixal3dCudaInstalled({ base: BASE, exists: INSTALLED, env: CONDA_ENV })).toBe(true);
    // Env created but the clone/build never landed — must not read as installed.
    expect(isPixal3dCudaInstalled({ base: BASE, exists: existsFor(CONDA_PY), env: CONDA_ENV })).toBe(false);
    // Clone present but no env.
    expect(isPixal3dCudaInstalled({ base: BASE, exists: existsFor(INFERENCE), env: CONDA_ENV })).toBe(false);
  });
});

describe('private Pixal3D CUDA profile', () => {
  const prefix = join(ROOT, '.conda');
  const python = join(prefix, 'bin', 'python');
  const record = join(prefix, 'portos-profile.json');
  const repo = join(prefix, 'portos-source', 'Pixal3D');
  const entrypoint = join(repo, 'inference.py');

  it('uses the completed private source and interpreter for rendering', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const exists = existsFor(prefix, python, record, entrypoint, CONDA_PY, INFERENCE);
    expect(isPixal3dCudaInstalled({ base: BASE, exists, env: CONDA_ENV })).toBe(true);
    const run = runPixal3dCudaGenerate({ base: BASE, exists, env: CONDA_ENV,
      imagePath: '/tmp/image.png', outputPath: '/tmp/output.glb', spawnImpl,
      postprocessGlb: vi.fn() });
    expect(spawnImpl.mock.calls[0][0]).toBe(python);
    expect(spawnImpl.mock.calls[0][1][0]).toBe(entrypoint);
    expect(spawnImpl.mock.calls[0][2].cwd).toBe(repo);
    child.emit('close', 0);
    await run.promise;
  });

  it('does not fall back to a legacy environment after interrupted Repair', () => {
    for (const paths of [[prefix, python], [join(ROOT, 'portos-installing')]]) {
      expect(isPixal3dCudaInstalled({ base: BASE, env: CONDA_ENV,
        exists: existsFor(...paths, CONDA_PY, INFERENCE, entrypoint) })).toBe(false);
    }
  });
});

describe('selectPixal3dRenderBudget', () => {
  it('gives a big card standard mode at full resolution', () => {
    expect(selectPixal3dRenderBudget(PIXAL3D_STANDARD_MODE_MIN_VRAM_GB)).toEqual({ lowVram: false, resolution: 1536 });
    expect(selectPixal3dRenderBudget(80)).toEqual({ lowVram: false, resolution: 1536 });
  });

  it('gives a mid card full resolution WITH offload', () => {
    expect(selectPixal3dRenderBudget(PIXAL3D_HIGH_RES_MIN_VRAM_GB)).toEqual({ lowVram: true, resolution: 1536 });
    expect(selectPixal3dRenderBudget(35)).toEqual({ lowVram: true, resolution: 1536 });
  });

  it('drops a small card to the 1024 floor', () => {
    expect(selectPixal3dRenderBudget(12)).toEqual({ lowVram: true, resolution: 1024 });
    expect(selectPixal3dRenderBudget(23)).toEqual({ lowVram: true, resolution: 1024 });
  });

  it('degrades an unknown card to the floor rather than overcommitting it', () => {
    // A card we failed to size must never be handed the 36 GB lane (sentinel rule).
    for (const unknown of [null, undefined, NaN, 'lots']) {
      expect(selectPixal3dRenderBudget(unknown)).toEqual({ lowVram: true, resolution: 1024 });
    }
  });
});

describe('buildPixal3dGenerateArgs', () => {
  const args = (over = {}) => buildPixal3dGenerateArgs({
    imagePath: '/img/src.png', base: BASE, python: CONDA_PY, ...over,
  }).args;

  it('targets upstream inference.py with the image as a FLAG', () => {
    const built = buildPixal3dGenerateArgs({ imagePath: '/img/src.png', base: BASE, python: CONDA_PY });
    expect(built.command).toBe(CONDA_PY);
    expect(built.args[0]).toBe(INFERENCE);
    expect(built.args).toContain('--image');
    expect(built.args[built.args.indexOf('--image') + 1]).toBe('/img/src.png');
  });

  it('passes outputPath THROUGH as a full .glb path, never reduced to a stem', () => {
    const out = join('/data', 'image-to-3d', 'abc', 'model.glb');
    const built = args({ outputPath: out });
    // inference.py writes exactly the path it is given; handing it a stem would
    // silently produce an extension-less file.
    expect(built[built.indexOf('--output') + 1]).toBe(out);
  });

  it('emits --low_vram only when the tier asks for it', () => {
    expect(args({ lowVram: true })).toContain('--low_vram');
    expect(args({ lowVram: false })).not.toContain('--low_vram');
  });

  it('emits the resolution and rejects one upstream does not accept', () => {
    expect(args({ resolution: 1536 })).toEqual(expect.arrayContaining(['--resolution', '1536']));
    expect(() => args({ resolution: 2048 })).toThrow(/resolution must be one of/);
  });

  it('requires an image', () => {
    expect(() => buildPixal3dGenerateArgs({ base: BASE })).toThrow(/imagePath is required/);
  });

  it('emits --seed but drops --steps, while still validating both', () => {
    expect(args({ seed: 7 })).toEqual(expect.arrayContaining(['--seed', '7']));
    // inference.py has no per-phase step override; an unrecognized flag would make
    // argparse abort a job we already queued.
    expect(args({ steps: 12 })).not.toContain('--steps');
    // Validation still happens at the same boundary as the other lanes.
    expect(() => args({ steps: 9999 })).toThrow(/steps must be an integer/);
    expect(() => args({ seed: -1 })).toThrow(/seed must be an integer/);
  });

});

describe('parsePixal3dProgress', () => {
  it('maps upstream banners to monotonically increasing percents', () => {
    const seq = [
      '[Pipeline] Loading from TencentARC/Pixal3D...',
      '[ImageCond] Building DinoV3ProjFeatureExtractor models...',
      '[NAF] Pre-loading NAF upsampler model...',
      '[Pipeline] Low-VRAM mode enabled.',
      '[Inference] Processing image: /img/src.png',
      '[MoGe-2] Loading model for camera estimation...',
      '[Inference] Estimating camera parameters...',
      '[Inference] Running 3D generation pipeline...',
      '[Inference] Using pipeline_type=1536_cascade',
      '[Inference] Extracting GLB...',
    ].map((l) => parsePixal3dProgress(l));
    expect(seq.every(Boolean)).toBe(true);
    const percents = seq.map((f) => f.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('treats the saved .glb line as the terminal export frame', () => {
    const out = join('/data', 'image-to-3d', 'abc', 'model.glb');
    const frame = parsePixal3dProgress(`[Done] GLB saved to: ${out}`);
    expect(frame.stage).toBe('export');
    expect(frame.assetPath).toBe(out);
  });

  it('does NOT mistake "Extracting GLB" for a written .glb path', () => {
    // Regression guard: the export matcher looks for `<something>.glb`, and this line
    // must land on the texturing banner instead of resolving the render early.
    const frame = parsePixal3dProgress('[Inference] Extracting GLB...');
    expect(frame.stage).toBe('texturing');
    expect(frame.assetPath).toBeUndefined();
  });

  it('scales a bare tqdm percentage into the shared sampling band', () => {
    const frame = parsePixal3dProgress('  50%|#####     | 6/12');
    expect(frame.stage).toBe('generating');
    // Band is [10,50]; a per-phase bar at 50% must not fill the whole render.
    expect(frame.percent).toBeGreaterThanOrEqual(10);
    expect(frame.percent).toBeLessThanOrEqual(50);
  });

  it('returns null for noise', () => {
    expect(parsePixal3dProgress('')).toBeNull();
    expect(parsePixal3dProgress('   ')).toBeNull();
    expect(parsePixal3dProgress('some unrelated chatter')).toBeNull();
  });
});

describe('probePixal3dModules', () => {
  const okProbe = (payload) => (_py, _args, _opts, cb) => cb(null, JSON.stringify(payload));

  it('reports NAF available when natten resolves', async () => {
    const res = await probePixal3dModules({
      base: BASE,
      exists: INSTALLED,
      env: CONDA_ENV,
      execFileImpl: okProbe({ o_voxel: true, flex_gemm: true, natten: true }),
    });
    expect(res.naf).toBe('available');
    expect(res.missing).toEqual([]);
    expect(res.help).toBeUndefined();
    // The raw find_spec map is deliberately NOT returned — nothing consumed it, and it
    // reached the client as `target.modules.modules`.
    expect(res.modules).toBeUndefined();
  });

  it('reports NAF unavailable with actionable help when natten is absent', async () => {
    const res = await probePixal3dModules({
      base: BASE,
      exists: INSTALLED,
      env: CONDA_ENV,
      execFileImpl: okProbe({ o_voxel: true, flex_gemm: true, natten: false }),
    });
    expect(res.naf).toBe('unavailable');
    expect(res.help).toBe(PIXAL3D_NAF_FALLBACK_HELP);
  });

  it('separates a broken install from a degraded one', async () => {
    const res = await probePixal3dModules({
      base: BASE,
      exists: INSTALLED,
      env: CONDA_ENV,
      execFileImpl: okProbe({ o_voxel: false, flex_gemm: true, natten: true }),
    });
    expect(res.missing).toEqual(['o_voxel']);
  });

  it('says unknown — never "unavailable" — when the probe itself fails', async () => {
    // "Failed to determine" must not render as "determined to be bad".
    const failed = await probePixal3dModules({
      base: BASE,
      exists: INSTALLED,
      env: CONDA_ENV,
      execFileImpl: (_py, _args, _opts, cb) => cb(new Error('boom')),
    });
    expect(failed.naf).toBe('unknown');

    const garbage = await probePixal3dModules({
      base: BASE,
      exists: INSTALLED,
      env: CONDA_ENV,
      execFileImpl: (_py, _args, _opts, cb) => cb(null, 'not json'),
    });
    expect(garbage.naf).toBe('unknown');

    const noEnv = await probePixal3dModules({ base: BASE, exists: () => false, env: CONDA_ENV });
    expect(noEnv.naf).toBe('unknown');
  });
});

describe('pixal3d error classifiers', () => {
  it('recognizes a NATTEN/NAF build problem', () => {
    expect(isPixal3dNafError("ModuleNotFoundError: No module named 'natten'")).toBe(true);
    expect(isPixal3dNafError('AttributeError: natten.HAS_LIBNATTEN')).toBe(true);
    expect(isPixal3dNafError('some other crash')).toBe(false);
  });

  it('recognizes the WSL2 NAF driver fault distinctly from a build problem', () => {
    const wsl = 'RuntimeError: CUDA driver error: device not ready';
    expect(isPixal3dWslNafError(wsl)).toBe(true);
    // Must NOT also match the NATTEN classifier, or the user gets told to rebuild
    // NATTEN for a fault a rebuild cannot fix (upstream #31).
    expect(isPixal3dNafError(wsl)).toBe(false);
  });
});

describe('runPixal3dCudaGenerate', () => {
  it('refuses to run when the environment is absent (no cold-bootstrap)', async () => {
    const { promise } = runPixal3dCudaGenerate({
      imagePath: '/img/src.png', base: BASE, exists: () => false, env: CONDA_ENV,
    });
    await expect(promise).rejects.toMatchObject({ code: 'PIXAL3D_CUDA_NOT_INSTALLED' });
  });

  it('refuses when the env exists but upstream entrypoint does not', async () => {
    const { promise } = runPixal3dCudaGenerate({
      imagePath: '/img/src.png', base: BASE, exists: existsFor(CONDA_PY), env: CONDA_ENV,
    });
    await expect(promise).rejects.toMatchObject({ code: 'PIXAL3D_CUDA_NOT_INSTALLED' });
  });

  it('spawns inference.py from the Pixal3D checkout with the VRAM-selected tier', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const { promise } = runPixal3dCudaGenerate({
      imagePath: '/img/src.png',
      outputPath: join('/data', 'model.glb'),
      base: BASE,
      vramGb: 48,
      exists: INSTALLED,
      env: CONDA_ENV,
      spawnImpl,
      postprocessGlb: () => {},
    });
    await flush();
    const [command, args, opts] = spawnImpl.mock.calls[0];
    expect(command).toBe(CONDA_PY);
    expect(args[0]).toBe(INFERENCE);
    // A 48 GB card gets standard mode at 1536.
    expect(args).toEqual(expect.arrayContaining(['--resolution', '1536']));
    expect(args).not.toContain('--low_vram');
    // cwd is load-bearing: inference.py imports its own package relative to the
    // checkout and writes its flex_gemm autotune cache beside the script.
    expect(opts.cwd).toBe(REPO);

    child.stdout.emit('data', Buffer.from(`[Done] GLB saved to: ${join('/data', 'model.glb')}\n`));
    child.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ assetPath: join('/data', 'model.glb') });
  });

  it('drops an unsized card to the low-VRAM floor', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    runPixal3dCudaGenerate({
      imagePath: '/img/src.png', base: BASE, vramGb: null,
      exists: INSTALLED, env: CONDA_ENV, spawnImpl, postprocessGlb: () => {},
    });
    await flush();
    const args = spawnImpl.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['--resolution', '1024']));
    expect(args).toContain('--low_vram');
  });

  it('is killable mid-render', async () => {
    const child = makeChild();
    const { kill } = runPixal3dCudaGenerate({
      imagePath: '/img/src.png', base: BASE, exists: INSTALLED, env: CONDA_ENV,
      spawnImpl: () => child, postprocessGlb: () => {},
    });
    await flush();
    kill();
    expect(child.kill).toHaveBeenCalled();
  });
});
