import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  TRELLIS2_REPO,
  trellis2Root,
  trellis2VenvPython,
  trellis2GenerateScript,
  isTrellis2Installed,
  buildInstallSteps,
  buildGenerateArgs,
  parseGenerateProgress,
  runTrellis2Generate,
} from './trellis2.js';

const BASE = '/tmp/portos-test-home';

describe('trellis2 path resolution', () => {
  it('roots the install under the injected base', () => {
    expect(trellis2Root(BASE)).toBe('/tmp/portos-test-home/trellis2');
    expect(trellis2VenvPython(BASE)).toMatch(/trellis2\/\.venv\/(bin\/python3|Scripts\/python\.exe)$/);
    expect(trellis2GenerateScript(BASE)).toBe('/tmp/portos-test-home/trellis2/generate.py');
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
  it('clones the MPS port then runs its setup.sh', () => {
    const steps = buildInstallSteps(BASE);
    expect(steps.map((s) => s.stage)).toEqual(['clone', 'setup']);
    expect(steps[0]).toMatchObject({ command: 'git' });
    expect(steps[0].args).toContain(TRELLIS2_REPO);
    expect(steps[0].args).toContain(trellis2Root(BASE));
    expect(steps[1]).toMatchObject({ command: 'bash', args: ['setup.sh'], cwd: trellis2Root(BASE) });
  });
});

describe('buildGenerateArgs', () => {
  it('invokes the venv python with generate.py and the image', () => {
    const { command, args } = buildGenerateArgs({ imagePath: '/data/images/x.png', base: BASE });
    expect(command).toBe(trellis2VenvPython(BASE));
    expect(args).toEqual([trellis2GenerateScript(BASE), '/data/images/x.png']);
  });

  it('appends --output when an output path is given', () => {
    const { args } = buildGenerateArgs({ imagePath: 'in.png', outputPath: 'out.glb', base: BASE });
    expect(args).toEqual([trellis2GenerateScript(BASE), 'in.png', '--output', 'out.glb']);
  });

  it('throws when no source image is given', () => {
    expect(() => buildGenerateArgs({ base: BASE })).toThrow(/imagePath is required/);
  });
});

describe('parseGenerateProgress', () => {
  it('extracts a percentage as a generating frame', () => {
    expect(parseGenerateProgress('sampling 42%')).toMatchObject({ stage: 'generating', percent: 42 });
  });

  it('clamps an over-100 percentage', () => {
    expect(parseGenerateProgress('999%').percent).toBe(100);
  });

  it('recognizes a written .glb as an export frame carrying the asset path', () => {
    expect(parseGenerateProgress('saved /out/model.glb')).toMatchObject({
      stage: 'export',
      assetPath: '/out/model.glb',
    });
  });

  it('returns null for lines with no signal, and for blank lines', () => {
    expect(parseGenerateProgress('loading pipeline weights')).toBeNull();
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
    return child;
  };

  it('rejects without spawning when the model is not installed', async () => {
    const spawnImpl = vi.fn();
    await expect(
      runTrellis2Generate({ imagePath: 'a.png', base: BASE, exists: () => false, spawnImpl }),
    ).rejects.toMatchObject({ code: 'TRELLIS2_NOT_INSTALLED' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('wires the generate command, streams progress, and resolves with the produced asset', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const frames = [];
    const promise = runTrellis2Generate({
      imagePath: 'a.png',
      base: BASE,
      exists: installed,
      spawnImpl,
      onProgress: (f) => frames.push(f),
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      trellis2VenvPython(BASE),
      [trellis2GenerateScript(BASE), 'a.png'],
      { cwd: trellis2Root(BASE) },
    );
    child.stdout.emit('data', 'sampling 50%\n');
    child.stdout.emit('data', 'saved /out/a.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
    expect(frames).toEqual([
      { stage: 'generating', percent: 50, message: 'sampling 50%' },
      { stage: 'export', assetPath: '/out/a.glb', message: 'saved /out/a.glb' },
    ]);
  });

  it('rejects on a non-zero exit', async () => {
    const child = makeChild();
    const promise = runTrellis2Generate({
      imagePath: 'a.png',
      outputPath: '/out/a.glb',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
    });
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });

  it('rejects when it exits 0 but never reported a .glb', async () => {
    const child = makeChild();
    const promise = runTrellis2Generate({
      imagePath: 'a.png',
      base: BASE,
      exists: installed,
      spawnImpl: () => child,
    });
    child.emit('close', 0);
    await expect(promise).rejects.toMatchObject({ code: 'TRELLIS2_GENERATE_FAILED' });
  });
});
