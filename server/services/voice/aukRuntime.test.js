import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { pinPlatform, pinArch } from '../../lib/testHelper.js';
const children = [];
const requests = new EventEmitter();
const renders = [];
let controller;
const access = vi.fn();
let failWrite = false;
vi.mock('node:fs/promises', () => ({ access: (...args) => access(...args), mkdir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(Buffer.from('test wav')), rm: vi.fn().mockResolvedValue() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn(), spawn: vi.fn(() => {
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
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessOptions: value => value, whichFirst: vi.fn() }));
vi.mock('../../lib/spawnCwd.js', () => ({ withSpawnCwdEnv: (env, cwd) => ({ ...env, PWD: cwd }) }));
vi.mock('../../lib/paths.js', () => ({ PATHS: { root: '/example' } }));
const { synthesizeAuk, getAukStatus, unloadAuk } = await import('./aukRuntime.js');
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
