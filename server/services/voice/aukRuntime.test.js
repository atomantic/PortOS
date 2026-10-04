import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pinPlatform, pinArch } from '../../lib/testHelper.js';
const children = [];
const access = vi.fn();
let failWrite = false;
vi.mock('node:fs/promises', () => ({ access: (...args) => access(...args), mkdir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(Buffer.from('test wav')), rm: vi.fn().mockResolvedValue() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn(), spawn: vi.fn(() => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit('close', null); return true; });
  if (failWrite) child.stdin.write = (_data, cb) => cb(new Error('EPIPE'));
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
});
afterEach(() => {
  unloadAuk();
  restorePlatform();
  restoreArch();
  vi.useRealTimers();
});
const response = child => child.stdout.write(`${JSON.stringify({ ok: true, latencyMs: 1500, firstAudioMs: 1500 })}\n`);
describe('AuK resident inference lifecycle', () => {
  it('reuses a warm worker, refuses overlapping inference, and keeps actual full-audio latency', async () => {
    const first = synthesizeAuk('Hello.', { instructions: 'Warm alto', genSeconds: 4 });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await expect(synthesizeAuk('Overlap')).rejects.toMatchObject({ status: 409 });
    response(children[0]);
    expect(await first).toMatchObject({ firstAudioMs: 1500, engine: 'auk' });
    const second = synthesizeAuk('Again.', {});
    await vi.waitFor(async () => expect((await getAukStatus()).busy).toBe(true));
    response(children[0]);
    await second;
    expect(children).toHaveLength(1);
  });
  it('preserves all narration text in bounded model segments within one worker request', async () => {
    const text = 'A thoughtful character walks toward the old library. '.repeat(12);
    const render = synthesizeAuk(text, { referenceAudio: '/example/reference.wav' });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const request = JSON.parse(children[0].stdin.read().toString());
    expect(request.segments.length).toBeGreaterThan(1);
    expect(request.segments.map(segment => segment.text).join('')).toBe(text);
    expect(request.segments.every(segment => segment.seconds <= 12)).toBe(true);
    expect(request.referenceAudio).toBe('/example/reference.wav');
    response(children[0]);
    await render;
  });
  it('kills a canceled worker and releases the busy state for a later request', async () => {
    const controller = new AbortController();
    const pending = synthesizeAuk('Hello.', {}, controller.signal);
    const failure = expect(pending).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort();
    await failure;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(await getAukStatus()).toMatchObject({ busy: false, loaded: false });
  });
  it.each([
    ['spawn error', child => child.emit('error', new Error('ENOENT')), 503],
    ['stdin stream error', child => child.stdin.emit('error', new Error('EPIPE')), 502],
  ])('discards the worker after a %s so the next request re-spawns', async (_name, fail, status) => {
    const failed = synthesizeAuk('Hello.', {});
    const check = expect(failed).rejects.toMatchObject({ status });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    fail(children[0]);
    await check;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(await getAukStatus()).toMatchObject({ busy: false, loaded: false });
    const retry = synthesizeAuk('Again.', {});
    await vi.waitFor(() => expect(children).toHaveLength(2));
    response(children[1]);
    await retry;
  });
  it('kills the worker and clears it when the request write fails', async () => {
    failWrite = true;
    const failed = synthesizeAuk('Hello.', {});
    const check = expect(failed).rejects.toThrow('could not be sent');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await check;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect((await getAukStatus()).loaded).toBe(false);
  });
  it('never starts a process or reports readiness for missing model artifacts', async () => {
    access.mockRejectedValue(new Error('missing'));
    expect(await getAukStatus()).toMatchObject({ ready: false, loaded: false });
    await expect(synthesizeAuk('Hello.')).rejects.toMatchObject({ status: 503 });
    expect(children).toHaveLength(0);
  });
});
