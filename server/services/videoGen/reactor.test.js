import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, once } from 'events';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const root = join(tmpdir(), `reactor-test-${process.pid}`);
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), finalize: vi.fn(), settings: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./generateVideoHelpers.js', () => ({ finalizeGeneratedVideo: mocks.finalize }));
vi.mock('../settings.js', () => ({ getSettings: mocks.settings }));
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return { ...actual, PATHS: { ...actual.PATHS, videos: join(root, 'videos'), data: root }, ensureDir: (dir) => mkdir(dir, { recursive: true }) };
});
const reactor = await import('./reactor.js');
const { videoGenEvents } = await import('./events.js');
const settings = { videoGen: { reactor: { apiKey: 'example-key' } } };
let child;
let input;
beforeEach(async () => {
  vi.clearAllMocks();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'python'), 'placeholder');
  vi.stubEnv('REACTOR_PYTHON_PATH', join(root, 'python'));
  vi.stubEnv('REACTOR_API_KEY', '');
  mocks.settings.mockResolvedValue(settings);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ jwt: 'example-jwt' }) })));
  mocks.spawn.mockImplementation(() => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = vi.fn((body) => { input = JSON.parse(body); });
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); });
    return child;
  });
});
afterEach(async () => {
  reactor.cancelAll();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  videoGenEvents.removeAllListeners();
  await rm(root, { recursive: true, force: true });
});
const started = async (options = {}) => {
  const result = await reactor.generateVideo({ prompt: 'A camera holds on a quiet gate.', seconds: 6, ...options });
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  return result;
};

describe('Reactor SDK adapter', () => {
  it('mints the official scoped token, pipes it privately, and finalizes only a captured file', async () => {
    const job = await started({ sourceImagePath: '/example/first-frame.png', seed: 42 });
    expect(fetch).toHaveBeenCalledWith('https://api.reactor.inc/tokens', expect.objectContaining({ headers: { 'Reactor-API-Key': 'example-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ authorization_details: [{ type: 'session', resources: { models: { match: ['reactor/fast-h3'] } }, constraints: { max_sessions: 1 } }] }) }));
    expect(input).toMatchObject({ jwt: 'example-jwt', seconds: 6, seed: 42, sourceImagePath: '/example/first-frame.png' });
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain('example-jwt');
    await writeFile(input.outputPath, 'example-video');
    child.stdout.emit('data', Buffer.from('{"type":"complete","clipId":"clip-example","seconds":6}\n'));
    expect(mocks.finalize).not.toHaveBeenCalled();
    child.emit('close', 0);
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.jobId, meta: expect.objectContaining({ clipId: 'clip-example', seconds: 6 }) })));
  });

  it('rejects unsupported requests before minting or spending', async () => {
    for (const options of [{ prompt: 'x'.repeat(801) }, { seconds: 5 }, { seconds: 15 }, { continueFromClipId: 'old-session-clip' }]) {
      await expect(reactor.generateVideo({ prompt: 'A gate', ...options })).rejects.toBeTruthy();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('fails missing runtime before minting a token', async () => {
    vi.stubEnv('REACTOR_PYTHON_PATH', join(root, 'missing-python'));
    await expect(reactor.generateVideo({ prompt: 'A gate' })).rejects.toMatchObject({ code: 'REACTOR_RUNTIME_MISSING' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not finalize a completion marker without its output file', async () => {
    await started();
    const failed = once(videoGenEvents, 'failed');
    child.stdout.emit('data', Buffer.from('{"type":"complete","clipId":"clip-example","seconds":6}\n'));
    child.emit('close', 0);
    await failed;
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('cancels the child and never finalizes a canceled request', async () => {
    const job = await started();
    const failed = once(videoGenEvents, 'failed');
    expect(reactor.cancel(job.jobId)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await failed;
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('can still cancel and reap a renderer after it reports a failure', async () => {
    vi.useFakeTimers();
    const job = await started();
    child.kill.mockImplementation((signal) => { if (signal === 'SIGKILL') child.emit('close', null); });
    const failed = once(videoGenEvents, 'failed');
    child.stdout.emit('data', Buffer.from('{"type":"error","phase":"capture","errorType":"RuntimeError"}\n'));
    expect(reactor.cancel(job.jobId)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await failed;
    expect(reactor.getActiveJob()).toBeNull();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('bounds process output instead of publishing success', async () => {
    await started();
    const failed = once(videoGenEvents, 'failed');
    child.stderr.emit('data', Buffer.alloc(1024 * 1024 + 1));
    await failed;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
  it('terminates timed-out sessions and escalates when graceful termination is ignored', async () => {
    vi.useFakeTimers();
    await started();
    child.kill.mockImplementation((signal) => { if (signal === 'SIGKILL') child.emit('close', null); });
    const failed = once(videoGenEvents, 'failed');
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await failed;
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

});
