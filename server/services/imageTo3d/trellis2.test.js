import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  TRELLIS2_REPO,
  trellis2Root,
  trellis2VenvPython,
  trellis2GenerateScript,
  isTrellis2Installed,
  buildInstallSteps,
  trellis2OutputStem,
  buildGenerateArgs,
  parseGenerateProgress,
  runTrellis2Generate,
  installTrellis2,
  isTransientInstallError,
  isHfAuthError,
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
  it('clones the MPS port then runs its setup.sh when nothing is on disk', () => {
    const steps = buildInstallSteps(BASE, { exists: () => false });
    expect(steps.map((s) => s.stage)).toEqual(['clone', 'setup']);
    expect(steps[0]).toMatchObject({ command: 'git' });
    expect(steps[0].args).toContain(TRELLIS2_REPO);
    expect(steps[0].args).toContain(trellis2Root(BASE));
    expect(steps[1]).toMatchObject({ command: 'bash', args: ['setup.sh'], cwd: trellis2Root(BASE) });
  });

  it('skips the clone step and resumes at setup.sh when the repo is already present', () => {
    // A prior install cloned the top-level repo but failed inside setup.sh (the
    // #2952 case). Re-cloning into the non-empty root would abort, so resume must
    // begin at the idempotent setup.sh.
    const gitDir = `${trellis2Root(BASE)}/.git`;
    const steps = buildInstallSteps(BASE, { exists: (p) => p === gitDir });
    expect(steps.map((s) => s.stage)).toEqual(['setup']);
    expect(steps[0]).toMatchObject({ command: 'bash', args: ['setup.sh'], cwd: trellis2Root(BASE) });
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
  it('invokes the venv python with generate.py and the image', () => {
    const { command, args } = buildGenerateArgs({ imagePath: '/data/images/x.png', base: BASE });
    expect(command).toBe(trellis2VenvPython(BASE));
    expect(args).toEqual([trellis2GenerateScript(BASE), '/data/images/x.png']);
  });

  it('passes --output as a STEM — the port appends .glb, so a full path would double it', () => {
    const { args } = buildGenerateArgs({ imagePath: 'in.png', outputPath: '/out/model.glb', base: BASE });
    expect(args).toEqual([trellis2GenerateScript(BASE), 'in.png', '--output', '/out/model']);
  });

  it('throws when no source image is given', () => {
    expect(() => buildGenerateArgs({ base: BASE })).toThrow(/imagePath is required/);
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
    const { promise } = runTrellis2Generate({
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
    child.stdout.emit('data', 'Generating 3D model (pipeline=512, seed=42)...\n');
    child.stdout.emit('data', 'Sampling:  50%|█████     | 6/12\n');
    child.stdout.emit('data', '  Saved: /out/a.glb\n');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ assetPath: '/out/a.glb' });
    expect(frames).toEqual([
      { stage: 'generating', percent: 10, message: 'Generating 3D model (pipeline=512, seed=42)...' },
      { stage: 'generating', percent: 30, message: 'Sampling:  50%|█████     | 6/12' },
      { stage: 'export', percent: 92, assetPath: '/out/a.glb', message: 'Saved: /out/a.glb' },
    ]);
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
    await expect(promise).rejects.toMatchObject({
      code: 'TRELLIS2_HF_AUTH_REQUIRED',
      message: expect.stringMatching(/hugging face/i),
    });
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

  it('resumes at setup (no re-clone) when the repo is already on disk', async () => {
    // Re-running Install after a setup-stage failure must NOT re-clone into the
    // existing root; it must go straight to the idempotent setup.sh.
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const gitDir = `${trellis2Root(BASE)}/.git`;
    const { promise } = installTrellis2({
      base: BASE, spawnImpl, exists: (p) => p === gitDir, sleep: () => Promise.resolve(),
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenNthCalledWith(1, 'bash', ['setup.sh'], { cwd: trellis2Root(BASE) });
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });
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
