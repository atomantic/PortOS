import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { pinPlatform, pinArch } from '../../lib/testHelper.js';
const setupMocks = vi.hoisted(() => ({ exec: vi.fn(), installLocked: vi.fn(), resolveUv: vi.fn() }));
const children = [];
const requests = new EventEmitter();
const renders = [];
let controller;
const access = vi.fn();
let failWrite = false;
vi.mock('node:fs/promises', () => ({ access: (...args) => access(...args), mkdir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(Buffer.from('test wav')), rm: vi.fn().mockResolvedValue() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: Object.assign(vi.fn(), { [promisify.custom]: setupMocks.exec }), spawn: vi.fn(() => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null); return true; });
  // Signal the actual write, after the runtime installs its failure/abort handlers.
  child.stdin.on('data', data => {
    child.request = JSON.parse(data.toString());
    requests.emit('request', child);
  });
  if (failWrite) child.stdin.write = (_data, cb) => {
    requests.emit('request', child);
    cb(new Error('EPIPE'));
  };
  children.push(child); return child;
}) }));
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessOptions: value => value }));
vi.mock('../../lib/pythonSetup.js', () => ({ installLockedRuntime: setupMocks.installLocked, resolvePatchedUv: setupMocks.resolveUv }));
vi.mock('../../lib/spawnCwd.js', () => ({ withSpawnCwdEnv: (env, cwd) => ({ ...env, PWD: cwd }) }));
vi.mock('../../lib/paths.js', () => ({ PATHS: { root: '/example' } }));
const { synthesizeAuk, getAukStatus, startAukSetup, unloadAuk } = await import('./aukRuntime.js');
let restorePlatform;
let restoreArch;
beforeEach(() => {
  restorePlatform = pinPlatform('darwin');
  restoreArch = pinArch('arm64');
  access.mockReset().mockResolvedValue(); children.length = 0; failWrite = false;
  controller = new AbortController();
  renders.length = 0;
});
afterEach(async () => {
  try {
    // A failed assertion can leave a render in readiness checks or inference.
    controller.abort();
    await Promise.allSettled(renders);
    unloadAuk();
  } finally {
    requests.removeAllListeners();
    restorePlatform();
    restoreArch();
  }
});
const render = (text, opts = {}) => {
  const result = synthesizeAuk(text, opts, controller.signal);
  renders.push(result);
  // Own rejections immediately, even if an earlier assertion skips the await.
  result.catch(() => {});
  return result;
};
const nextRequest = () => once(requests, 'request').then(([child]) => child);
const response = child => child.stdout.write(`${JSON.stringify({ ok: true, latencyMs: 1500, firstAudioMs: 1500 })}\n`);
describe('AuK resident inference lifecycle', () => {
  it('reuses a warm worker, refuses overlapping inference, and keeps actual full-audio latency', async () => {
    const firstRequest = nextRequest();
    const first = render('Hello.', { instructions: 'Warm alto', genSeconds: 4 });
    const child = await firstRequest;
    await expect(render('Overlap')).rejects.toMatchObject({ status: 409 });
    response(child);
    expect(await first).toMatchObject({ firstAudioMs: 1500, engine: 'auk' });
    const secondRequest = nextRequest();
    const second = render('Again.', {});
    expect(await secondRequest).toBe(child);
    response(child);
    await second;
    expect(children).toHaveLength(1);
  });
  it('preserves all narration text in bounded model segments within one worker request', async () => {
    const text = 'A thoughtful character walks toward the old library. '.repeat(12);
    const written = nextRequest();
    const result = render(text, { referenceAudio: '/example/reference.wav' });
    const child = await written;
    const request = child.request;
    expect(request.segments.length).toBeGreaterThan(1);
    expect(request.segments.map(segment => segment.text).join('')).toBe(text);
    expect(request.segments.every(segment => segment.seconds <= 12)).toBe(true);
    expect(request.referenceAudio).toBe('/example/reference.wav');
    response(child);
    await result;
  });
  it('kills a canceled worker and releases the busy state for a later request', async () => {
    const written = nextRequest();
    const pending = render('Hello.', {});
    await written;
    controller.abort();
    await expect(pending).rejects.toThrow('stopped');
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(await getAukStatus()).toMatchObject({ busy: false, loaded: false });
  });
  it.each([
    ['spawn error', child => child.emit('error', new Error('ENOENT')), 503],
    ['stdin stream error', child => child.stdin.emit('error', new Error('EPIPE')), 502],
  ])('discards the worker after a %s so the next request re-spawns', async (_name, fail, status) => {
    const written = nextRequest();
    const failed = render('Hello.', {});
    fail(await written);
    await expect(failed).rejects.toMatchObject({ status });
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(await getAukStatus()).toMatchObject({ busy: false, loaded: false });
    const retryRequest = nextRequest();
    const retry = render('Again.', {});
    const child = await retryRequest;
    expect(children).toHaveLength(2);
    response(child);
    await retry;
  });
  it('kills the worker and clears it when the request write fails', async () => {
    failWrite = true;
    const failed = render('Hello.', {});
    await expect(failed).rejects.toThrow('could not be sent');
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect((await getAukStatus()).loaded).toBe(false);
  });
  it('never starts a process or reports readiness for missing model artifacts', async () => {
    access.mockRejectedValue(new Error('missing'));
    expect(await getAukStatus()).toMatchObject({ ready: false, loaded: false });
    await expect(render('Hello.')).rejects.toMatchObject({ status: 503 });
    expect(children).toHaveLength(0);
  });
});

describe('AuK explicit setup', () => {
  let venvCreated;
  const commands = () => setupMocks.exec.mock.calls.map(([command, args]) => [command, ...args].join(' '));
  const settled = () => vi.waitFor(async () => expect((await getAukStatus()).state).not.toBe('running'));
  beforeEach(() => {
    venvCreated = false;
    setupMocks.exec.mockReset().mockImplementation(async (_command, args) => {
      if (args[0] === 'venv') venvCreated = true;
      return { stdout: '', stderr: '' };
    });
    setupMocks.resolveUv.mockReset().mockResolvedValue({ ok: true, uv: '/private/tools/uv' });
    setupMocks.installLocked.mockReset().mockReturnValue({ promise: Promise.resolve({ ok: true, code: 0 }), kill: vi.fn() });
    // Nothing is installed yet: no checkout, no venv until created; everything exists afterwards.
    access.mockImplementation(async path => {
      if (path.endsWith('/.git') || (path.endsWith('.venv/bin/python') && !venvCreated)) throw new Error('missing');
    });
  });
  it('installs only the hash-pinned closure and the commit-pinned checkout through the private uv', async () => {
    startAukSetup();
    await settled();
    expect(await getAukStatus()).toMatchObject({ state: 'complete', ready: true });
    expect(commands().filter(command => command.split(' ')[0] === 'uv')).toEqual([]);
    expect(commands().some(command => /^\/private\/tools\/uv venv --clear --python 3\.11 \S+\.venv$/.test(command))).toBe(true);
    const [python, profile, , options] = setupMocks.installLocked.mock.calls[0];
    expect(python).toMatch(/\.venv\/bin\/python$/);
    expect(profile).toBe('auk-mlx');
    expect(options.preferUv).toBe(true);
    expect(options.sourceInstalls).toEqual([['install', '--no-deps', '--no-build-isolation', '-e', expect.stringMatching(/\.portos\/auk$/)]]);
    // No command installs packages outside the lock: only git, the venv, weight download and conversion run.
    expect(commands().some(command => /\bpip\b|\binstall\b/.test(command))).toBe(false);
  });
  it('rebuilds an existing virtualenv instead of installing the lock over unverified leftovers', async () => {
    venvCreated = true;
    startAukSetup();
    await settled();
    expect(commands().some(command => /^\/private\/tools\/uv venv --clear --python 3\.11 /.test(command))).toBe(true);
  });
  it('fails before downloading weights when the locked install fails', async () => {
    setupMocks.installLocked.mockReturnValue({ promise: Promise.resolve({ ok: false, code: 1 }), kill: vi.fn() });
    startAukSetup();
    await settled();
    expect(await getAukStatus()).toMatchObject({ state: 'failed', stage: 'Installing MLX dependencies', error: expect.stringContaining('AuK setup failed') });
    expect(commands().some(command => command.includes('snapshot_download'))).toBe(false);
  });
  it('refuses to run any command when no patched private uv can be had', async () => {
    setupMocks.resolveUv.mockResolvedValue({ ok: false, reason: 'Could not bootstrap uv 0.13.6: the hash-verified package install step failed.' });
    startAukSetup();
    await settled();
    expect(await getAukStatus()).toMatchObject({ state: 'failed', error: expect.stringContaining('Could not bootstrap uv') });
    expect(setupMocks.exec).not.toHaveBeenCalled();
    expect(setupMocks.installLocked).not.toHaveBeenCalled();
  });
});
