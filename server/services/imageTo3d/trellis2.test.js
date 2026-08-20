import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  TRELLIS2_REPO,
  TRELLIS2_APPLE_REPO,
  trellis2Root,
  trellis2AppleDepDir,
  trellis2VenvPython,
  trellis2GenerateScript,
  trellis2GenerateRunnerScript,
  isTrellis2Installed,
  buildInstallSteps,
  trellis2OutputStem,
  buildGenerateArgs,
  parseGenerateProgress,
  runTrellis2Generate,
  installTrellis2,
  isTransientInstallError,
  isHfAuthError,
  probeTrellis2TextureBake,
  probeMetalToolchain,
  TRELLIS2_METAL_BAKE_MODULES,
  TRELLIS2_BAKE_QUALITY_MODULES,
  TRELLIS2_FALLBACK_BAKE_HELP,
  TRELLIS2_METAL_TOOLCHAIN_HINT,
  TRELLIS2_REQUIRES_XCODE_HINT,
  TRELLIS2_DEFAULT_TEXTURE_SIZE,
  TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE,
  TRELLIS2_TEXTURE_SIZES,
  TRELLIS2_PIPELINE_TYPES,
  TRELLIS2_BASELINE_PIPELINE_TYPE,
  TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE,
  TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB,
  selectTrellis2PipelineType,
  selectTrellis2TextureSize,
} from './trellis2.js';
import { getTarget } from './targets.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const BASE = '/tmp/portos-test-home';

describe('trellis2 path resolution', () => {
  it('roots the install under the injected base', () => {
    expect(trellis2Root(BASE)).toBe(join(BASE, 'trellis2'));
    expect(trellis2VenvPython(BASE)).toBe(process.platform === 'win32'
      ? join(BASE, 'trellis2', '.venv', 'Scripts', 'python.exe')
      : join(BASE, 'trellis2', '.venv', 'bin', 'python3'));
    expect(trellis2GenerateScript(BASE)).toBe(join(BASE, 'trellis2', 'generate.py'));
    expect(trellis2GenerateRunnerScript()).toMatch(/trellis2GenerateRunner\.py$/);
  });
});

describe('isTrellis2Installed', () => {
  const venv = trellis2VenvPython(BASE);
  const script = trellis2GenerateScript(BASE);

  it('is installed only when BOTH the venv python and generate.py exist', () => {
    expect(isTrellis2Installed({ base: BASE, exists: () => true })).toBe(true);
  });

  it('is not installed when the venv python is missing', () => {
    expect(isTrellis2Installed({ base: BASE, exists: (p) => p !== venv })).toBe(false);
  });

  it('is not installed when generate.py is missing', () => {
    expect(isTrellis2Installed({ base: BASE, exists: (p) => p !== script })).toBe(false);
  });

  it('is not installed on a clean host', () => {
    expect(isTrellis2Installed({ base: BASE, exists: () => false })).toBe(false);
  });
});

describe('buildInstallSteps', () => {
  it('clones the MPS port then runs its setup.sh when nothing is on disk', () => {
    const steps = buildInstallSteps(BASE, { exists: () => false });
    // apple-deps sits between the two for reasons both load-bearing: after the clone
    // because `git clone <root>` refuses a non-empty root, before setup.sh because that
    // is what makes upstream's `if [ ! -d deps/trellis2-apple ]` guard skip its clone.
    expect(steps.map((s) => s.stage)).toEqual(['clone', 'apple-deps', 'setup']);
    expect(steps[0]).toMatchObject({ command: 'git' });
    expect(steps[0].args).toContain(TRELLIS2_REPO);
    expect(steps[0].args).toContain(trellis2Root(BASE));
    expect(steps[2]).toMatchObject({ command: 'bash', args: ['setup.sh'], cwd: trellis2Root(BASE) });
  });

  // #3041: setup.sh compiles the Metal packages from .metal sources, so the
  // toolchain must land BEFORE it runs or those builds fail silently.
  it('leads with the Metal Toolchain step when the toolchain is missing but fetchable', () => {
    const steps = buildInstallSteps(BASE, { exists: () => false, installMetalToolchain: true });
    expect(steps.map((s) => s.stage)).toEqual(['metal-toolchain', 'clone', 'apple-deps', 'setup']);
    expect(steps[0]).toMatchObject({ command: 'xcodebuild', args: ['-downloadComponent', 'MetalToolchain'] });
  });

  it('marks the bake-only steps optional — a missing bake degrades output, it does not break it', () => {
    // Only the two bake-dependency steps degrade. The clone and setup.sh stay
    // required, or a real failure would be swallowed.
    const optionalStages = buildInstallSteps(BASE, { exists: () => false, installMetalToolchain: true })
      .filter((s) => s.optional).map((s) => s.stage);
    expect(optionalStages).toEqual(['metal-toolchain', 'apple-deps']);
  });

  it('omits the toolchain step by default (already present / not macOS / not fetchable)', () => {
    expect(buildInstallSteps(BASE, { exists: () => false }).map((s) => s.stage))
      .toEqual(['clone', 'apple-deps', 'setup']);
  });

  it('does not let a caller mutate the shared toolchain step template', () => {
    const [step] = buildInstallSteps(BASE, { exists: () => false, installMetalToolchain: true });
    step.args.push('--tampered');
    const [fresh] = buildInstallSteps(BASE, { exists: () => false, installMetalToolchain: true });
    expect(fresh.args).toEqual(['-downloadComponent', 'MetalToolchain']);
  });

  it('skips the clone step and resumes at setup.sh when the repo is already present', () => {
    // A prior install cloned the top-level repo but failed inside setup.sh (the
    // #2952 case). Re-cloning into the non-empty root would abort, so resume must
    // begin at the idempotent setup.sh.
    const gitDir = join(trellis2Root(BASE), '.git');
    const steps = buildInstallSteps(BASE, { exists: (p) => p === gitDir });
    expect(steps.map((s) => s.stage)).toEqual(['apple-deps', 'setup']);
    expect(steps[1]).toMatchObject({ command: 'bash', args: ['setup.sh'], cwd: trellis2Root(BASE) });
  });

  // The bug behind #2952's long tail: o_voxel compiles against Eigen, which
  // trellis2-apple carries as a submodule. Upstream's clone_dep never fetches it, the
  // build dies on 'Eigen/Dense' not found, setup.sh swallows it, and the install lands
  // permanently on the confetti fallback baker — unfixable by installing Xcode.
  describe('apple-deps (the Eigen submodule upstream never fetches)', () => {
    const appleGitDir = join(trellis2AppleDepDir(BASE), '.git');
    const appleOVoxelDir = join(trellis2AppleDepDir(BASE), 'o-voxel');
    // A healthy existing checkout has both the git dir and the subdirectory upstream
    // pip-installs from.
    const healthyCheckout = (p) => p === appleGitDir || p === appleOVoxelDir;
    const appleStep = (exists) => buildInstallSteps(BASE, { exists })
      .find((s) => s.stage === 'apple-deps');

    it('clones trellis2-apple WITH submodules when the dep is not on disk', () => {
      const step = appleStep(() => false);
      expect(step).toMatchObject({ command: 'git', optional: true });
      expect(step.args).toContain('--recurse-submodules');
      // Eigen's full history is ~117 MB against ~10 MB shallow, for zero benefit.
      expect(step.args).toContain('--shallow-submodules');
      expect(step.args).toContain(TRELLIS2_APPLE_REPO);
      expect(step.args).toContain(trellis2AppleDepDir(BASE));
      // Cloned into place, so there is nothing to cd into yet.
      expect(step.cwd).toBeUndefined();
    });

    // Re-cloning over an existing checkout would abort the way the root clone does, so
    // the repair path updates in place instead. `optional` matters most on THIS branch:
    // it is the one a user reaches by clicking Repair, and Eigen is the install's only
    // gitlab.com fetch — the likeliest to be blocked.
    it('initializes submodules in place when an older setup.sh already cloned it', () => {
      expect(appleStep(healthyCheckout)).toMatchObject({
        command: 'git',
        args: ['submodule', 'update', '--init', '--recursive', '--depth', '1'],
        cwd: trellis2AppleDepDir(BASE),
        optional: true,
      });
    });

    // A clone killed partway can leave `.git` with no worktree. `git submodule update`
    // cannot restore a missing superproject, so treating that as "already cloned" would
    // succeed as a no-op while leaving o_voxel unbuildable forever — upstream's `! -d`
    // guard skips its clone, and its `pip install …/o-voxel` then targets a path that
    // does not exist. Route it to the clone branch, which fails loudly instead.
    it('does NOT treat a partial checkout (.git but no o-voxel/) as already cloned', () => {
      const step = appleStep((p) => p === appleGitDir);
      expect(step.args).toContain('clone');
      expect(step.args).toContain('--recurse-submodules');
      expect(step.args).not.toContain('submodule');
      expect(step.cwd).toBeUndefined();
    });
  });
});

describe('trellis2OutputStem', () => {
  it('strips a single trailing .glb (the port appends the extension itself)', () => {
    expect(trellis2OutputStem('/data/image-to-3d/abc/model.glb')).toBe('/data/image-to-3d/abc/model');
  });

  it('is case-insensitive on the extension', () => {
    expect(trellis2OutputStem('/out/Model.GLB')).toBe('/out/Model');
  });

  it('leaves a stem with no .glb extension untouched (and does not eat a mid-path .glb)', () => {
    expect(trellis2OutputStem('/out/model')).toBe('/out/model');
    expect(trellis2OutputStem('/out/model.glb.tmp')).toBe('/out/model.glb.tmp');
  });
});

describe('buildGenerateArgs', () => {
  it('invokes the venv python with generate.py, the image, and the default texture size', () => {
    const { command, args } = buildGenerateArgs({ imagePath: '/data/images/x.png', base: BASE });
    expect(command).toBe(trellis2VenvPython(BASE));
    expect(args).toEqual([
      trellis2GenerateScript(BASE), '/data/images/x.png',
      '--pipeline-type', TRELLIS2_BASELINE_PIPELINE_TYPE,
      '--texture-size', String(TRELLIS2_DEFAULT_TEXTURE_SIZE),
    ]);
  });

  it('passes --output as a STEM — the port appends .glb, so a full path would double it', () => {
    const { args } = buildGenerateArgs({ imagePath: 'in.png', outputPath: '/out/model.glb', base: BASE });
    expect(args.slice(0, 4)).toEqual([trellis2GenerateScript(BASE), 'in.png', '--output', '/out/model']);
  });

  it('defaults direct command building to the proven 2K atlas', () => {
    expect(TRELLIS2_DEFAULT_TEXTURE_SIZE).toBe(2048);
    expect(TRELLIS2_TEXTURE_SIZES).toContain(TRELLIS2_DEFAULT_TEXTURE_SIZE);
  });

  it('honors an explicit texture size', () => {
    const { args } = buildGenerateArgs({ imagePath: 'in.png', base: BASE, textureSize: 1024 });
    expect(args).toEqual([
      trellis2GenerateScript(BASE), 'in.png',
      '--pipeline-type', TRELLIS2_BASELINE_PIPELINE_TYPE,
      '--texture-size', '1024',
    ]);
  });

  it('uses the compatibility runner for the underlying exporter\'s 4K atlas size', () => {
    const { args } = buildGenerateArgs({ imagePath: 'in.png', base: BASE, textureSize: 4096 });
    expect(args).toEqual([
      trellis2GenerateRunnerScript(), trellis2GenerateScript(BASE), 'in.png',
      '--pipeline-type', TRELLIS2_BASELINE_PIPELINE_TYPE,
      '--texture-size', '4096',
    ]);
  });

  it('rejects a texture size outside the supported baker sizes instead of letting the render abort', () => {
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, textureSize: 8192 }))
      .toThrow(/textureSize must be one of/);
  });

  it('honors and validates the texture-generation pipeline type', () => {
    const { args } = buildGenerateArgs({
      imagePath: 'in.png',
      base: BASE,
      pipelineType: TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE,
    });
    expect(args).toContain(TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE);
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, pipelineType: '4096' }))
      .toThrow(/pipelineType must be one of/);
  });

  it('throws when no source image is given', () => {
    expect(() => buildGenerateArgs({ base: BASE })).toThrow(/imagePath is required/);
  });

  it('passes --seed and --steps when provided and omits both by default', () => {
    const { args } = buildGenerateArgs({ imagePath: 'in.png', base: BASE, seed: 1234, steps: 24 });
    expect(args.slice(-4)).toEqual(['--seed', '1234', '--steps', '24']);

    const { args: defaults } = buildGenerateArgs({ imagePath: 'in.png', base: BASE });
    expect(defaults).not.toContain('--seed');
    expect(defaults).not.toContain('--steps');
  });

  it('rejects out-of-range or non-integer steps and seed instead of letting argparse abort', () => {
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, steps: 0 }))
      .toThrow(/steps must be an integer/);
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, steps: 65 }))
      .toThrow(/steps must be an integer/);
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, steps: 12.5 }))
      .toThrow(/steps must be an integer/);
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, seed: -1 }))
      .toThrow(/seed must be an integer/);
    expect(() => buildGenerateArgs({ imagePath: 'in.png', base: BASE, seed: 2147483648 }))
      .toThrow(/seed must be an integer/);
  });
});

describe('selectTrellis2PipelineType', () => {
  it('keeps supported 24 GB hosts on the benchmarked 512 lane', () => {
    expect(selectTrellis2PipelineType(24)).toBe(TRELLIS2_BASELINE_PIPELINE_TYPE);
  });

  it('uses 1024-cascade when the host has conservative memory headroom', () => {
    expect(selectTrellis2PipelineType(TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB))
      .toBe(TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE);
    expect(TRELLIS2_PIPELINE_TYPES).toContain(TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE);
  });
});

describe('selectTrellis2TextureSize', () => {
  it('keeps supported 24 GB hosts on the proven 2K atlas', () => {
    expect(selectTrellis2TextureSize(24)).toBe(TRELLIS2_DEFAULT_TEXTURE_SIZE);
  });

  it('uses a 4K atlas when the host has conservative memory headroom', () => {
    expect(selectTrellis2TextureSize(TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB))
      .toBe(TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE);
    expect(TRELLIS2_TEXTURE_SIZES).toContain(TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE);
  });
});

describe('probeTrellis2TextureBake', () => {
  // The probe shells to the venv python with an importlib.util.find_spec one-liner.
  // Fake execFile lets us assert each outcome without a real venv.
  const fakeExec = (payload, err = null) => vi.fn((_cmd, _args, _opts, cb) => {
    cb(err, payload === null ? '' : JSON.stringify(payload), '');
  });
  const allPresent = Object.fromEntries(
    [...TRELLIS2_METAL_BAKE_MODULES, ...TRELLIS2_BAKE_QUALITY_MODULES].map((m) => [m, true]),
  );

  it('reports metal quality when every Metal bake module resolves', async () => {
    const result = await probeTrellis2TextureBake({
      base: BASE, exists: () => true, execFileImpl: fakeExec(allPresent),
    });
    expect(result.quality).toBe('metal');
    expect(result.missing).toEqual([]);
    expect(result.help).toBeUndefined();
  });

  it('reports fallback quality with actionable help when a Metal module is missing', async () => {
    // The real #2952 failure: setup.sh could not compile the Metal packages (no
    // Xcode Metal Toolchain) but swallowed each error and exited 0.
    const result = await probeTrellis2TextureBake({
      base: BASE,
      exists: () => true,
      execFileImpl: fakeExec({ ...allPresent, mtldiffrast: false, mtlbvh: false }),
    });
    expect(result.quality).toBe('fallback');
    expect(result.missing).toEqual(['mtldiffrast', 'mtlbvh']);
    expect(result.help).toBe(TRELLIS2_FALLBACK_BAKE_HELP);
  });

  it('treats a missing quality-only module as still metal-capable', () => expect(
    probeTrellis2TextureBake({
      base: BASE, exists: () => true, execFileImpl: fakeExec({ ...allPresent, flex_gemm: false }),
    }),
  ).resolves.toMatchObject({ quality: 'metal', degradedQuality: ['flex_gemm'] }));

  it('reports unknown — NOT fallback — when the probe itself fails', async () => {
    // A broken probe must never render a scary "degraded" warning about an install
    // that is probably fine (sentinel rule: could-not-determine ≠ determined-bad).
    const result = await probeTrellis2TextureBake({
      base: BASE, exists: () => true, execFileImpl: fakeExec(null, new Error('boom')),
    });
    expect(result.quality).toBe('unknown');
    expect(result.help).toBeUndefined();
  });

  it('reports unknown without spawning anything when the venv python is absent', async () => {
    const execFileImpl = fakeExec(allPresent);
    const result = await probeTrellis2TextureBake({ base: BASE, exists: () => false, execFileImpl });
    expect(result.quality).toBe('unknown');
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});

describe('probeMetalToolchain', () => {
  // Dispatch on the probed command: `xcrun metal` reports presence, `xcode-select -p`
  // distinguishes full Xcode (can fetch the toolchain) from Command Line Tools only.
  const exec = ({ metal, developerDir }) => vi.fn((cmd, _args, _opts, cb) => {
    if (cmd === 'xcrun') return metal ? cb(null, 'Apple metal version 32023', '') : cb(new Error('missing Metal Toolchain'));
    return developerDir ? cb(null, developerDir, '') : cb(new Error('no developer dir'));
  });

  it('is available when `xcrun metal --version` succeeds', () => expect(
    probeMetalToolchain({ platformImpl: () => 'darwin', execFileImpl: exec({ metal: true }) }),
  ).resolves.toEqual({ available: true }));

  it('is missing-but-installable on a host with full Xcode', async () => {
    const result = await probeMetalToolchain({
      platformImpl: () => 'darwin',
      execFileImpl: exec({ metal: false, developerDir: '/Applications/Xcode.app/Contents/Developer\n' }),
    });
    expect(result).toEqual({ available: false, installable: true, hint: TRELLIS2_METAL_TOOLCHAIN_HINT });
  });

  it('is blocked — not merely missing — when only the Command Line Tools are active', async () => {
    // `xcodebuild -downloadComponent` ships with full Xcode, so queueing the fetch
    // here would be a step guaranteed to fail; the hint must name Xcode instead.
    const result = await probeMetalToolchain({
      platformImpl: () => 'darwin',
      execFileImpl: exec({ metal: false, developerDir: '/Library/Developer/CommandLineTools\n' }),
    });
    expect(result).toMatchObject({ available: false, installable: false, blocker: 'requires-xcode' });
    expect(result.hint).toBe(TRELLIS2_REQUIRES_XCODE_HINT);
  });

  it('treats an unreadable developer dir as blocked rather than assuming Xcode', async () => {
    const result = await probeMetalToolchain({
      platformImpl: () => 'darwin',
      execFileImpl: exec({ metal: false, developerDir: null }),
    });
    expect(result).toMatchObject({ installable: false, blocker: 'requires-xcode' });
  });

  it('does not apply off macOS — null, not false, so no macOS-only warning is shown', async () => {
    const execFileImpl = vi.fn();
    expect(await probeMetalToolchain({ platformImpl: () => 'linux', execFileImpl }))
      .toEqual({ available: null });
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});

describe('parseGenerateProgress', () => {
  // The real generate.py banners (see the module's GENERATE_STAGE_SIGNATURES),
  // in the order the port prints them, and the monotonic percent each maps to.
  it.each([
    ['Loading pipeline...', 'loading', 3],
    ['Device: MPS', 'loading', 5],
    ['Generating 3D model (pipeline=512, seed=42)...', 'generating', 10],
    ['Mesh: 812,043 vertices, 1,604,201 triangles', 'meshing', 55],
    ['Generation time: 214.7s', 'meshing', 58],
    ['Baking PBR textures via KDTree (1024x1024)...', 'texturing', 65],
    ['  UV unwrapping with xatlas...', 'texturing', 72],
    ['  Simplifying mesh: 1,604,201 -> ~200,000 faces', 'texturing', 72],
  ])('maps the %o banner to a %s frame at %i%%', (line, stage, percent) => {
    expect(parseGenerateProgress(line)).toMatchObject({ stage, percent, message: line.trim() });
  });

  it('the banner percents increase monotonically in emission order', () => {
    const order = [
      'Loading pipeline...', 'Device: MPS', 'Generating 3D model (pipeline=512)...',
      'Mesh: 8 vertices, 8 triangles', 'Generation time: 1s',
      'Baking PBR textures via Metal (1024x1024)...',
    ];
    const percents = order.map((l) => parseGenerateProgress(l).percent);
    for (let i = 1; i < percents.length; i += 1) expect(percents[i]).toBeGreaterThan(percents[i - 1]);
  });

  it('recognizes a written .glb as the terminal export frame carrying the asset path', () => {
    expect(parseGenerateProgress('  Saved: /out/model.glb')).toMatchObject({
      stage: 'export',
      percent: 92,
      assetPath: '/out/model.glb',
    });
  });

  it('scales a bare per-phase tqdm bar into the sampling band [10,50] (never fills early)', () => {
    // tqdm hits 100% once per sampling phase (three phases); a raw pass-through would
    // fill the whole-render bar during phase 1. Scaled, even 100% stays inside sampling.
    expect(parseGenerateProgress('Sampling: 100%|██████████| 12/12').percent).toBe(50);
    expect(parseGenerateProgress('Sampling:   0%|          | 0/12').percent).toBe(10);
    expect(parseGenerateProgress('Sampling:  50%|█████     | 6/12')).toMatchObject({
      stage: 'generating', percent: 30,
    });
  });

  it('returns null for lines with no signal, and for blank lines', () => {
    expect(parseGenerateProgress('Input: /tmp/shoe.png (1024x1024)')).toBeNull();
    expect(parseGenerateProgress('Saved: /out/model.obj')).toBeNull(); // .obj sidecar, not the GLB
    expect(parseGenerateProgress('   ')).toBeNull();
    expect(parseGenerateProgress(undefined)).toBeNull();
  });
});

describe('runTrellis2Generate', () => {
  const installed = () => true;

  const makeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  };

  it('rejects without spawning when the model is not installed', async () => {
    const spawnImpl = vi.fn();
    const { promise } = runTrellis2Generate({ imagePath: 'a.png', base: BASE, exists: () => false, spawnImpl });
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_NOT_INSTALLED' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('wires the generate command, streams progress, and resolves with the produced asset', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const frames = [];
    const postprocessGlb = vi.fn(async () => {});
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      base: BASE,
      unifiedMemoryGb: 24,
      exists: installed,
      spawnImpl,
      postprocessGlb,
      onProgress: (f) => frames.push(f),
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      trellis2VenvPython(BASE),
      [
        trellis2GenerateScript(BASE), 'a.png',
        '--pipeline-type', TRELLIS2_BASELINE_PIPELINE_TYPE,
        '--texture-size', String(TRELLIS2_DEFAULT_TEXTURE_SIZE),
      ],
      { cwd: trellis2Root(BASE) },
    );
    child.stdout.emit('data', 'Generating 3D model (pipeline=512, seed=42)...\n');
    child.stdout.emit('data', 'Sampling:  50%|█████     | 6/12\n');
    child.stdout.emit('data', '  Saved: /out/a.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
    expect(postprocessGlb).toHaveBeenCalledWith('/out/a.glb');
    expect(frames).toEqual([
      { stage: 'generating', percent: 10, message: 'Generating 3D model (pipeline=512, seed=42)...' },
      { stage: 'generating', percent: 30, message: 'Sampling:  50%|█████     | 6/12' },
      { stage: 'export', percent: 92, assetPath: '/out/a.glb', message: 'Saved: /out/a.glb' },
    ]);
  });

  it('parses every tqdm frame in a \\r-redrawn chunk, not just the first', async () => {
    // tqdm redraws the sampling bar in place with carriage returns, so one stdout
    // chunk can carry several frames separated only by \r. Progress must reflect the
    // LAST (highest) frame, not the first — otherwise sampling under-reports.
    const child = makeChild();
    const frames = [];
    const postprocessGlb = vi.fn(async () => {});
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
      postprocessGlb,
      onProgress: (f) => frames.push(f),
    });
    child.stdout.emit('data', 'Sampling:   0%\rSampling:  50%\rSampling: 100%\r');
    child.stdout.emit('data', '  Saved: /out/a.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
    // 0/50/100 scale into the [10,50] band → 10/30/50; the last frame is 50.
    expect(frames.map((f) => f.percent)).toEqual([10, 30, 50, 92]);
  });

  it('matches a stage banner that arrives split across two stdout chunks', async () => {
    // Real-vocabulary cover for the shared carry buffer (#3578): 'Baking textures'
    // straddling a chunk boundary used to match no GENERATE_STAGE_SIGNATURES entry,
    // stalling the bar at the previous percent until the next banner landed.
    const child = makeChild();
    const frames = [];
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
      postprocessGlb: vi.fn(async () => {}),
      onProgress: (f) => frames.push(f),
    });
    child.stdout.emit('data', 'Baking te');
    child.stdout.emit('data', 'xtures at 2048px...\n  Saved: /out/a.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
    expect(frames.map((f) => f.stage)).toEqual(['texturing', 'export']);
  });

  it('selects the high-quality pipeline and 4K atlas on a high-memory host', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      unifiedMemoryGb: 128,
      exists: installed,
      spawnImpl,
      postprocessGlb: vi.fn(async () => {}),
    });
    const args = spawnImpl.mock.calls[0][1];
    expect(args).toContain(TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE);
    expect(args).toContain(String(TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE));
    expect(args.slice(0, 2)).toEqual([
      trellis2GenerateRunnerScript(),
      trellis2GenerateScript(BASE),
    ]);
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
  });

  it('fails the run when the exported GLB cannot be normalized safely', async () => {
    const child = makeChild();
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
      postprocessGlb: vi.fn(() => {
        throw new Error('bad GLB');
      }),
    });
    child.emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GLB_POSTPROCESS_FAILED' });
  });

  it('rejects on a non-zero exit', async () => {
    const child = makeChild();
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
    });
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });

  it('classifies a gated-repo / HF-auth failure as a distinct, actionable error', async () => {
    // The real #2952 on-device failure: the pipeline pulls a gated dependency model
    // and, with no HF_TOKEN, from_pretrained raises GatedRepoError → non-zero exit.
    const child = makeChild();
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
    });
    child.stderr.emit('data',
      'huggingface_hub.errors.GatedRepoError: 401 Client Error. '
      + 'Access to model facebook/dinov3-vitl16-pretrain-lvd1689m is restricted.\n');
    child.emit('close', 1);
    const error = await promise.catch((err) => err);
    const gatedRepos = getTarget('trellis2').gatedRepos;
    expect(error).toMatchObject({
      code: 'TRELLIS2_HF_AUTH_REQUIRED',
      message: expect.stringMatching(/hugging face/i),
    });
    for (const gatedRepo of gatedRepos) {
      expect(error.message).toContain(gatedRepo.label);
      expect(error.message).toContain(gatedRepo.url);
    }
  });

  it('rejects when it exits 0 but never reported a .glb', async () => {
    const child = makeChild();
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
    });
    child.emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });

  it('spawns under the caller-supplied env so the stored HF token reaches the child', async () => {
    // The pipeline pulls gated HF repos at load time. models.js resolves the token
    // env (settings-stored token included) and hands it down — assert it lands on the
    // spawn instead of relying on the server process having HF_TOKEN exported.
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const env = { PATH: '/usr/bin', HF_TOKEN: 'hf_test', HUGGINGFACE_HUB_TOKEN: 'hf_test' };
    const { promise } = runTrellis2Generate({
      imagePath: 'a.png',
      base: BASE,
      unifiedMemoryGb: 24,
      exists: installed,
      spawnImpl,
      env,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      trellis2VenvPython(BASE),
      [
        trellis2GenerateScript(BASE), 'a.png',
        '--pipeline-type', TRELLIS2_BASELINE_PIPELINE_TYPE,
        '--texture-size', String(TRELLIS2_DEFAULT_TEXTURE_SIZE),
      ],
      { cwd: trellis2Root(BASE), env },
    );
    child.emit('close', null); // settle the run so its rejection isn't left dangling
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });

  it('omits env entirely when the caller passes none, so the child inherits process.env', async () => {
    // Back-compat: an absent token must not degrade to `env: {}`, which would strip
    // PATH and a CLI-authenticated ~/.cache/huggingface/token from the child.
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const { promise } = runTrellis2Generate({ imagePath: 'a.png', base: BASE, exists: installed, spawnImpl });
    expect(spawnImpl.mock.calls[0][2]).toEqual({ cwd: trellis2Root(BASE) });
    child.emit('close', null);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });

  it('kill() SIGTERMs the running child so a deleted render terminates promptly', async () => {
    const child = makeChild();
    const { promise, kill } = runTrellis2Generate({
      imagePath: 'a.png',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
    });
    kill();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null); // SIGTERM lands as a non-zero/null exit
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });
});

describe('isTransientInstallError', () => {
  it('matches the #2952 mid-clone network drop signatures', () => {
    // The exact failure chain the user hit installing via the UI.
    const log = [
      "Cloning into 'deps/trellis2-apple'...",
      'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
      'error: 6483 bytes of body are still expected',
      'fetch-pack: unexpected disconnect while reading sideband packet',
      'fatal: early EOF',
      'fatal: fetch-pack: invalid index-pack output',
    ].join('\n');
    expect(isTransientInstallError(log)).toBe(true);
  });

  it.each([
    'error: RPC failed; curl 18 transfer closed with outstanding read data remaining',
    'fatal: unable to access ...: Could not resolve host: github.com',
    'ssl_read: Connection reset by peer',
    'pip: Read timed out.',
    'urllib3 ... IncompleteRead',
  ])('flags transient network error: %s', (line) => {
    expect(isTransientInstallError(line)).toBe(true);
  });

  it.each([
    "fatal: repository 'https://example.test/x.git/' not found",
    'error: pathspec did not match any file(s) known to git',
    "bash: setup.sh: Permission denied",
    'ModuleNotFoundError: No module named torch',
    '',
    null,
    undefined,
  ])('does NOT flag a non-transient/real failure: %s', (line) => {
    expect(isTransientInstallError(line)).toBe(false);
  });
});

describe('isHfAuthError', () => {
  it.each([
    'huggingface_hub.errors.GatedRepoError: 401 Client Error.',
    'Access to model facebook/dinov3-vitl16-pretrain-lvd1689m is restricted.',
    'You must have access to it and be authenticated to access it. Please log in.',
    'OSError: You are trying to access a gated repo.',
    'Invalid user token.',
  ])('flags an HF auth / gated-repo failure: %s', (line) => {
    expect(isHfAuthError(line)).toBe(true);
  });

  it.each([
    'RuntimeError: MPS backend out of memory',
    'IndexError: max(): Expected reduction dim 0 to have non-zero size',
    'AssertionError: BVH needs at least 8 triangles, got 0',
    '',
    null,
    undefined,
  ])('does NOT flag a non-auth failure: %s', (line) => {
    expect(isHfAuthError(line)).toBe(false);
  });
});

describe('installTrellis2', () => {
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  };

  it('runs each install step in order and emits stage + complete events', async () => {
    const children = [makeChild(), makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const events = [];
    const { promise } = installTrellis2({ base: BASE, spawnImpl, onEvent: (e) => events.push(e) });

    // step 1 (clone) — first spawn call, then close it 0 to advance to step 2
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'git', expect.arrayContaining(['clone']), {});
    children[0].emit('close', 0);
    await flush(); // let the await in the loop (through the retry wrapper) advance
    // step 2 (apple-deps) — the submodule-aware clone upstream's setup.sh cannot do.
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'git', expect.arrayContaining(['--recurse-submodules']), {});
    children[1].emit('close', 0);
    await flush();
    expect(spawnImpl).toHaveBeenNthCalledWith(3, 'bash', ['setup.sh'], { cwd: trellis2Root(BASE) });
    children[2].emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });

    expect(events.filter((e) => e.type === 'stage').map((e) => e.stage))
      .toEqual(['clone', 'apple-deps', 'setup']);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });

  // `setup.sh` swallows a failed Metal-backend build and still exits 0, so the
  // install must verify what landed and report it BEFORE the terminal `complete`
  // frame — which closes the client's EventSource (#2952).
  const runToCompletion = async (probeBake) => {
    const children = [makeChild(), makeChild(), makeChild()];
    let i = 0;
    const events = [];
    const { promise } = installTrellis2({
      base: BASE, spawnImpl: () => children[i++], onEvent: (e) => events.push(e), probeBake,
    });
    children[0].emit('close', 0); // clone
    await flush();
    children[1].emit('close', 0); // apple-deps
    await flush();
    children[2].emit('close', 0); // setup
    await promise;
    return events;
  };

  // #3041: the caller (the route) resolves the toolchain situation and passes a
  // plain boolean, so installTrellis2 keeps returning { promise, kill } synchronously.
  it('downloads the Metal Toolchain first when the caller says it is needed', async () => {
    const children = [makeChild(), makeChild(), makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const { promise } = installTrellis2({
      base: BASE,
      spawnImpl,
      installMetalToolchain: true,
      probeBake: async () => ({ quality: 'metal', missing: [] }),
    });
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'xcodebuild', ['-downloadComponent', 'MetalToolchain'], {});
    children[0].emit('close', 0);
    await flush();
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'git', expect.arrayContaining(['clone']), {});
    children[1].emit('close', 0);
    await flush();
    children[2].emit('close', 0); // apple-deps
    await flush();
    children[3].emit('close', 0); // setup
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('continues the install when the optional toolchain step fails, and still verifies', async () => {
    // Geometry is unaffected by a missing bake, so a host that cannot fetch the
    // toolchain must still end up with a working (if degraded) install.
    const children = [makeChild(), makeChild(), makeChild(), makeChild()];
    let i = 0;
    const events = [];
    const { promise } = installTrellis2({
      base: BASE,
      spawnImpl: () => children[i++],
      onEvent: (e) => events.push(e),
      installMetalToolchain: true,
      probeBake: async () => ({ quality: 'fallback', missing: ['mtldiffrast'], help: 'degraded' }),
    });
    children[0].emit('close', 1); // toolchain download failed
    await flush();
    children[1].emit('close', 0); // clone
    await flush();
    children[2].emit('close', 0); // apple-deps
    await flush();
    children[3].emit('close', 0); // setup
    await expect(promise).resolves.toEqual({ ok: true });
    expect(events.find((e) => e.stage === 'metal-toolchain' && /Optional step/.test(e.message || ''))).toBeTruthy();
    expect(events.find((e) => e.stage === 'verify')?.message).toContain('degraded');
  });

  it('retries a TRANSIENT optional-step failure before giving up on it', async () => {
    // Optional-ness must not short-circuit the retry path — a dropped connection
    // during the toolchain download deserves the same retries as any other step.
    const children = [makeChild(), makeChild(), makeChild(), makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const { promise } = installTrellis2({
      base: BASE,
      spawnImpl,
      installMetalToolchain: true,
      maxRetries: 1,
      sleep: async () => {},
      probeBake: async () => ({ quality: 'fallback', missing: ['mtldiffrast'], help: 'degraded' }),
    });
    children[0].stderr.emit('data', 'fatal: early EOF');
    children[0].emit('close', 128);
    await flush();
    // Retried the toolchain step rather than moving straight on to the clone.
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'xcodebuild', ['-downloadComponent', 'MetalToolchain'], {});
    children[1].emit('close', 128); // retry exhausted → continue as optional
    await flush();
    expect(spawnImpl).toHaveBeenNthCalledWith(3, 'git', expect.arrayContaining(['clone']), {});
    children[2].emit('close', 0);
    await flush();
    children[3].emit('close', 0); // apple-deps
    await flush();
    children[4].emit('close', 0); // setup
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('still aborts when a REQUIRED step fails, so optional-ness is not blanket', async () => {
    const children = [makeChild(), makeChild()];
    let i = 0;
    const { promise } = installTrellis2({
      base: BASE,
      spawnImpl: () => children[i++],
      maxRetries: 0,
    });
    children[0].emit('close', 1); // clone failed — not optional
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_INSTALL_FAILED', stage: 'clone' });
  });

  it('warns about a degraded Metal bake BEFORE the terminal complete frame', async () => {
    const events = await runToCompletion(async () => ({
      quality: 'fallback', missing: ['mtldiffrast'], help: TRELLIS2_FALLBACK_BAKE_HELP,
    }));
    const verifyIdx = events.findIndex((e) => e.stage === 'verify');
    const completeIdx = events.findIndex((e) => e.type === 'complete');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(completeIdx);
    expect(events[verifyIdx].message).toContain(TRELLIS2_FALLBACK_BAKE_HELP);
  });

  it('confirms a healthy Metal bake on a good install', async () => {
    const events = await runToCompletion(async () => ({ quality: 'metal', missing: [] }));
    expect(events.find((e) => e.stage === 'verify')?.message).toMatch(/Metal texture baking is available/);
  });

  it('stays silent when the bake probe could not determine anything', async () => {
    const events = await runToCompletion(async () => ({ quality: 'unknown', missing: [] }));
    expect(events.find((e) => e.stage === 'verify')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });

  it('spawns install steps under the caller-supplied env, alongside each step cwd', async () => {
    const children = [makeChild(), makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const env = { PATH: '/usr/bin', HF_TOKEN: 'hf_test' };
    const { promise } = installTrellis2({ base: BASE, spawnImpl, env });

    // The clone step has no cwd — env must still be applied, and must not invent one.
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'git', expect.arrayContaining(['clone']), { env });
    children[0].emit('close', 0);
    await flush();
    // Same for the apple-deps clone, which also runs without a cwd.
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'git', expect.arrayContaining(['--recurse-submodules']), { env });
    children[1].emit('close', 0);
    await flush();
    expect(spawnImpl).toHaveBeenNthCalledWith(3, 'bash', ['setup.sh'], { cwd: trellis2Root(BASE), env });
    children[2].emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('forwards subprocess output as log events', async () => {
    const child = makeChild();
    const events = [];
    const { promise } = installTrellis2({ base: BASE, spawnImpl: () => child, onEvent: (e) => events.push(e) });
    child.stdout.emit('data', 'Cloning into trellis2...\n');
    child.emit('error', Object.assign(new Error('boom'), {})); // abort so the promise settles
    await promise.catch(() => {});
    expect(events).toContainEqual({ type: 'log', stage: 'clone', message: 'Cloning into trellis2...' });
  });

  it('rejects with the failing stage when a step exits non-zero', async () => {
    const child = makeChild();
    const { promise } = installTrellis2({ base: BASE, spawnImpl: () => child });
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_INSTALL_FAILED', stage: 'clone' });
  });

  it('resumes at setup (no re-clone) when the repo is already on disk', async () => {
    // Re-running Install after a setup-stage failure must NOT re-clone into the
    // existing root; it must go straight to the apple-deps fix and the idempotent
    // setup.sh.
    const children = [makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const gitDir = join(trellis2Root(BASE), '.git');
    const { promise } = installTrellis2({
      base: BASE, spawnImpl, exists: (p) => p === gitDir, sleep: () => Promise.resolve(),
    });
    expect(spawnImpl).not.toHaveBeenCalledWith('git', expect.arrayContaining([TRELLIS2_REPO]), expect.anything());
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'git', expect.arrayContaining(['--recurse-submodules']), {});
    children[0].emit('close', 0);
    await flush();
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'bash', ['setup.sh'], { cwd: trellis2Root(BASE) });
    children[1].emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('retries a transient network failure in place and succeeds on the retry', async () => {
    // clone attempt 1 (transient fail) → clone attempt 2 (ok) → apple-deps → setup
    const children = [makeChild(), makeChild(), makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const events = [];
    const { promise } = installTrellis2({
      base: BASE, spawnImpl, onEvent: (e) => events.push(e), sleep: () => Promise.resolve(),
    });

    children[0].stderr.emit('data', 'error: RPC failed; curl 56 Recv failure: Connection reset by peer\n');
    children[0].emit('close', 128);
    await flush(); // drain the retry backoff + respawn

    expect(spawnImpl).toHaveBeenCalledTimes(2); // clone was retried
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'git', expect.arrayContaining(['clone']), {});
    children[1].emit('close', 0);
    await flush();
    children[2].emit('close', 0); // apple-deps
    await flush();
    children[3].emit('close', 0); // setup
    await expect(promise).resolves.toEqual({ ok: true });

    expect(events.some((e) => e.type === 'log' && /retrying/i.test(e.message))).toBe(true);
  });

  it('fails fast (no retry) on a non-transient step failure', async () => {
    const spawnImpl = vi.fn(() => makeChild());
    const { promise } = installTrellis2({ base: BASE, spawnImpl, sleep: () => Promise.resolve() });
    const child = spawnImpl.mock.results[0].value;
    child.stderr.emit('data', 'fatal: repository not found\n');
    child.emit('close', 128);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_INSTALL_FAILED', transient: false });
    expect(spawnImpl).toHaveBeenCalledTimes(1); // never retried
  });

  it('gives up after maxRetries and surfaces a transient-flagged error', async () => {
    const children = [makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const { promise } = installTrellis2({
      base: BASE, spawnImpl, maxRetries: 1, sleep: () => Promise.resolve(),
    });

    children[0].stderr.emit('data', 'fatal: early EOF\n');
    children[0].emit('close', 128);
    await flush();
    children[1].stderr.emit('data', 'fatal: early EOF\n');
    children[1].emit('close', 128);

    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_INSTALL_FAILED', transient: true, stage: 'clone' });
    expect(spawnImpl).toHaveBeenCalledTimes(2); // initial + 1 retry, then gave up
  });

  it('kill() SIGTERMs the running child and cancels before the next step', async () => {
    const children = [makeChild(), makeChild()];
    let i = 0;
    const { promise, kill } = installTrellis2({ base: BASE, spawnImpl: () => children[i++] });
    kill();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('close', 0); // step 1 finishes, but canceled flag stops step 2
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_INSTALL_CANCELED' });
    expect(i).toBe(1); // the second step never spawned
  });
});
