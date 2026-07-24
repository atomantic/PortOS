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
  installTrellis2,
  isTransientInstallError,
} from './trellis2.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe('installTrellis2', () => {
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  };

  it('runs each install step in order and emits stage + complete events', async () => {
    const children = [makeChild(), makeChild()];
    let i = 0;
    const spawnImpl = vi.fn(() => children[i++]);
    const events = [];
    const { promise } = installTrellis2({ base: BASE, spawnImpl, onEvent: (e) => events.push(e) });

    // step 1 (clone) — first spawn call, then close it 0 to advance to step 2
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'git', expect.arrayContaining(['clone']), {});
    children[0].emit('close', 0);
    await flush(); // let the await in the loop (through the retry wrapper) advance
    expect(spawnImpl).toHaveBeenNthCalledWith(2, 'bash', ['setup.sh'], { cwd: trellis2Root(BASE) });
    children[1].emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });

    expect(events.filter((e) => e.type === 'stage').map((e) => e.stage)).toEqual(['clone', 'setup']);
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
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

  it('retries a transient network failure in place and succeeds on the retry', async () => {
    // clone attempt 1 (transient fail) → clone attempt 2 (ok) → setup (ok)
    const children = [makeChild(), makeChild(), makeChild()];
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
    children[2].emit('close', 0); // setup
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
