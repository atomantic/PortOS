import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE,
  PIXAL3D_MPS_NATTEN_VERSION,
  PIXAL3D_MPS_PYTHON_VERSION,
  PIXAL3D_MPS_PIPELINE_TYPES,
  PIXAL3D_MPS_REPO,
  PIXAL3D_MPS_REVISION,
  PIXAL3D_MPS_REQUIRED_MODULES,
  PIXAL3D_MPS_TORCH_VERSION,
  PIXAL3D_MPS_TORCHVISION_VERSION,
  buildPixal3dMpsGenerateArgs,
  buildPixal3dMpsInstallSteps,
  describePixal3dMpsInstallState,
  isPixal3dMpsInstalled,
  isPixal3dMpsOutOfMemoryError,
  isPixal3dMpsWatchdogError,
  parsePixal3dMpsProgress,
  pixal3dMpsGenerateScript,
  pixal3dMpsRoot,
  pixal3dMpsVenvPython,
  probePixal3dMpsModules,
  runPixal3dMpsGenerate,
} from './pixal3dMps.js';
import { IMAGE_TO_3D_TARGETS } from './targets.js';

const BASE = join('/tmp', 'portos-test-home');
const ROOT = join(BASE, 'pixal3d-mps');
const VENV = join(ROOT, '.venv', 'bin', 'python');
const SCRIPT = join(ROOT, 'generate_mps.py');
const existsFor = (...paths) => (path) => paths.includes(path);

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('pixal3dMps path and install plan', () => {
  it('keeps the adapter and hashed installer on a patched Torch runtime', () => {
    const read = name => readFileSync(new URL(`../../../scripts/${name}`, import.meta.url), 'utf8');
    const lock = read('requirements-pixal3d-mps.lock.txt');
    expect(lock).toContain(`torch==${PIXAL3D_MPS_TORCH_VERSION}`);
    expect(lock).toContain(`torchvision==${PIXAL3D_MPS_TORCHVISION_VERSION}`);
    expect(PIXAL3D_MPS_TORCH_VERSION.split('.').slice(0, 2).map(Number)).toEqual([2, expect.any(Number)]);
    expect(Number(PIXAL3D_MPS_TORCH_VERSION.split('.')[1])).toBeGreaterThanOrEqual(13);
    const sources = read('requirements-pixal3d-mps-sources.lock.txt');
    expect(sources).toContain(`natten==${PIXAL3D_MPS_NATTEN_VERSION}`);
    expect(read('setup-pixal3d-mps.sh')).toContain(`sys.version_info[:2] == (${PIXAL3D_MPS_PYTHON_VERSION.replace('.', ', ')})`);
    expect(IMAGE_TO_3D_TARGETS.pixal3dMps.requires.python).toBe(PIXAL3D_MPS_PYTHON_VERSION);
    for (const text of [lock, sources]) {
      for (const entry of text.split(/\n(?=[a-zA-Z])/).slice(1)) expect(entry).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    }
  });
  it('keeps the Apple port isolated from the other image-to-3D lanes', () => {
    expect(pixal3dMpsRoot(BASE)).toBe(ROOT);
    expect(pixal3dMpsVenvPython(BASE)).toBe(VENV);
    expect(pixal3dMpsGenerateScript(BASE)).toBe(SCRIPT);
  });

  it('requires both the private venv and generate_mps.py', () => {
    expect(isPixal3dMpsInstalled({ base: BASE, exists: existsFor(VENV, SCRIPT) })).toBe(true);
    expect(isPixal3dMpsInstalled({ base: BASE, exists: existsFor(VENV) })).toBe(false);
    expect(isPixal3dMpsInstalled({ base: BASE, exists: existsFor(SCRIPT) })).toBe(false);
  });

  it('pins the fork before using PortOS-owned setup for fresh install and Repair', () => {
    const steps = buildPixal3dMpsInstallSteps(BASE, { exists: () => false });
    expect(steps[0]).toEqual({
      stage: 'clone',
      command: 'git',
      args: ['clone', '--depth', '1', PIXAL3D_MPS_REPO, ROOT],
    });
    expect(steps[1]).toMatchObject({ stage: 'pin-source', command: 'git', cwd: ROOT,
      args: ['fetch', '--depth', '1', 'origin', PIXAL3D_MPS_REVISION] });
    expect(steps[2]).toMatchObject({ stage: 'checkout-source', command: 'git', cwd: ROOT,
      args: ['checkout', '--detach', PIXAL3D_MPS_REVISION] });
    expect(steps[3]).toMatchObject({ stage: 'bootstrap', command: 'bash', cwd: ROOT,
      args: [expect.stringMatching(/[\\/]scripts[\\/]setup-pixal3d-mps\.sh$/)] });
    expect(steps.some(step => step.args.includes('scripts/setup_mac.sh'))).toBe(false);
  });

  it('puts the optional Metal toolchain fetch before setup', () => {
    const steps = buildPixal3dMpsInstallSteps(BASE, {
      exists: () => false,
      installMetalToolchain: true,
    });
    expect(steps[0]).toMatchObject({
      stage: 'metal-toolchain',
      command: 'xcodebuild',
      args: ['-downloadComponent', 'MetalToolchain'],
      optional: true,
    });
    expect(steps[1].stage).toBe('clone');
    expect(steps.map(step => step.stage)).toEqual([
      'metal-toolchain', 'clone', 'pin-source', 'checkout-source', 'bootstrap',
    ]);
  });

  it('resumes a cloned checkout without issuing a second clone', () => {
    const steps = buildPixal3dMpsInstallSteps(BASE, {
      exists: existsFor(join(ROOT, '.git')),
    });
    expect(steps.map((step) => step.stage)).toEqual(['pin-source', 'checkout-source', 'bootstrap']);
  });
});

describe('pixal3dMps command builder', () => {
  it('emits the fork CLI contract and shared seed/steps flags', () => {
    const built = buildPixal3dMpsGenerateArgs({
      imagePath: '/tmp/source.png',
      outputPath: '/tmp/model.glb',
      base: BASE,
      python: VENV,
      pipelineType: '1536_cascade',
      steps: 24,
      seed: 7,
    });
    expect(built).toEqual({
      command: VENV,
      args: [
        SCRIPT,
        '/tmp/source.png',
        '--device', 'mps',
        '--pipeline-type', '1536_cascade',
        '--output', '/tmp/model.glb',
        '--seed', '7',
        '--steps', '24',
      ],
    });
  });

  it('defaults to the safe 1024 cascade and validates the pipeline enum', () => {
    expect(PIXAL3D_MPS_PIPELINE_TYPES).toEqual(['1024_cascade', '1536_cascade']);
    expect(PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE).toBe('1024_cascade');
    expect(buildPixal3dMpsGenerateArgs({ imagePath: '/tmp/source.png', base: BASE }).args)
      .toContain('1024_cascade');
    expect(() => buildPixal3dMpsGenerateArgs({
      imagePath: '/tmp/source.png', base: BASE, pipelineType: '512',
    })).toThrow(/pipelineType must be one of/);
    expect(() => buildPixal3dMpsGenerateArgs({
      imagePath: '/tmp/source.png', base: BASE, steps: 65,
    })).toThrow(/steps must be an integer/);
  });
});

describe('pixal3dMps module probe', () => {
  const readyRuntime = {
    modules: Object.fromEntries(PIXAL3D_MPS_REQUIRED_MODULES.map(module => [module, true])),
    python: PIXAL3D_MPS_PYTHON_VERSION,
    torch: PIXAL3D_MPS_TORCH_VERSION,
    torchvision: PIXAL3D_MPS_TORCHVISION_VERSION,
  };

  it('reports missing native packages without importing them', async () => {
    const execFileImpl = vi.fn((_python, _args, _options, callback) => {
      callback(null, JSON.stringify({
        ...readyRuntime,
        modules: { ...readyRuntime.modules, o_voxel: false },
      }));
    });
    const result = await probePixal3dMpsModules({
      base: BASE,
      exists: existsFor(VENV),
      execFileImpl,
    });
    expect(result).toEqual({ unknown: false, missing: ['o_voxel'], needsUpdate: false });
    expect(execFileImpl).toHaveBeenCalledOnce();
  });

  it('offers Repair for a complete legacy install that still runs affected Torch', async () => {
    const describe = runtime => describePixal3dMpsInstallState({
      base: BASE,
      exists: existsFor(VENV),
      execFileImpl: (_python, _args, _opts, callback) => callback(null, JSON.stringify(runtime)),
    });
    const legacy = await describe({ ...readyRuntime, python: '3.10', torch: '2.12.0', torchvision: '0.27.0' });
    expect(legacy.fields.degraded).toMatchObject({ label: 'runtime update needed', repairable: true });
    expect(legacy.fields.degraded.help).toContain('Python 3.13');
    expect(await describe(readyRuntime)).toEqual({ fields: {}, warnings: [] });
  });

  it('keeps a failed probe distinct from a missing package', async () => {
    const execFileImpl = vi.fn((_python, _args, _options, callback) => callback(new Error('probe failed')));
    await expect(probePixal3dMpsModules({
      base: BASE,
      exists: existsFor(VENV),
      execFileImpl,
    })).resolves.toEqual({ unknown: true, missing: [] });
  });
});

describe('pixal3dMps progress and error classification', () => {
  it('maps the fork banners and preserves the shared GLB terminal signal', () => {
    expect(parsePixal3dMpsProgress('[Pipeline] Loading from TencentARC/Pixal3D...'))
      .toMatchObject({ stage: 'loading', percent: 2 });
    expect(parsePixal3dMpsProgress('[Generate] pipeline=1024_cascade, seed=7'))
      .toMatchObject({ stage: 'generating', percent: 10 });
    expect(parsePixal3dMpsProgress('[Done] GLB saved to /tmp/model.glb'))
      .toMatchObject({ stage: 'export', percent: 92, assetPath: '/tmp/model.glb' });
  });

  it('recognizes the fork-specific watchdog and memory failures', () => {
    expect(isPixal3dMpsWatchdogError('ERROR: The decoder produced an empty mesh')).toBe(true);
    expect(isPixal3dMpsOutOfMemoryError('MPS backend out of memory')).toBe(true);
    expect(isPixal3dMpsWatchdogError('ordinary Python failure')).toBe(false);
  });
});

describe('runPixal3dMpsGenerate', () => {
  it('refuses to spawn when the isolated runtime is absent', async () => {
    const spawnImpl = vi.fn();
    const result = runPixal3dMpsGenerate({
      base: BASE,
      imagePath: '/tmp/source.png',
      outputPath: '/tmp/model.glb',
      exists: () => false,
      spawnImpl,
    });
    await expect(result.promise).rejects.toMatchObject({ code: 'PIXAL3D_MPS_NOT_INSTALLED' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns from the fork checkout and resolves the produced GLB', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const postprocessGlb = vi.fn();
    const result = runPixal3dMpsGenerate({
      base: BASE,
      imagePath: '/tmp/source.png',
      outputPath: '/tmp/model.glb',
      steps: 12,
      seed: 42,
      exists: existsFor(VENV, SCRIPT),
      spawnImpl,
      postprocessGlb,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      VENV,
      expect.arrayContaining(['--device', 'mps', '--pipeline-type', '1024_cascade']),
      expect.objectContaining({
        cwd: ROOT,
        env: expect.objectContaining({ PYTHONUNBUFFERED: '1' }),
      }),
    );
    child.stdout.emit('data', '[Done] GLB saved to /tmp/model.glb\n');
    child.emit('close', 0);
    await expect(result.promise).resolves.toEqual({ assetPath: '/tmp/model.glb' });
    expect(postprocessGlb).toHaveBeenCalledWith('/tmp/model.glb');
  });
});
