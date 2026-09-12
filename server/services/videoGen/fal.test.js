import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = join(tmpdir(), `portos-fal-video-test-${process.pid}-${Date.now()}`);
const FAKE_VIDEOS_DIR = join(TEST_ROOT, 'data-videos');
const FAKE_DATA_DIR = join(TEST_ROOT, 'data');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.videos = FAKE_VIDEOS_DIR;
  actual.PATHS.data = FAKE_DATA_DIR;
  return {
    ...actual,
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return {
    ...actual,
    optimizeForStreaming: vi.fn(async () => {}),
    generateThumbnail: vi.fn(async (_p, jobId) => `${jobId}.jpg`),
  };
});

const getSettingsMock = vi.fn();
vi.mock('../settings.js', () => ({ getSettings: getSettingsMock }));

const fal = await import('./fal.js');
const ffmpeg = await import('../../lib/ffmpeg.js');
const { videoGenEvents } = await import('./events.js');
const { loadHistory } = await import('./history.js');

// A returned job (or its early 'complete' status stamp) is not a settled run.
// Track from 'started', before generateVideo returns, through the terminal
// event after the real finalization/history tail. Keep mocks and files alive
// until every started job has reached that boundary, even if a test throws.
const terminalEvents = new Map();
const waitForTerminal = async (jobId) => {
  await vi.waitFor(() => expect(terminalEvents.get(jobId)).toBeTruthy(), { timeout: 5000 });
  return terminalEvents.get(jobId);
};
const drainJobs = () => vi.waitFor(() => {
  expect([...terminalEvents.entries()].filter(([, event]) => !event)).toEqual([]);
}, { timeout: 5000 });

const jsonResponse = (body, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
});

beforeEach(async () => {
  videoGenEvents.removeAllListeners();
  terminalEvents.clear();
  videoGenEvents.on('started', ({ generationId }) => terminalEvents.set(generationId, null));
  for (const type of ['completed', 'failed']) {
    videoGenEvents.on(type, (event) => terminalEvents.set(event.generationId, { type, ...event }));
  }
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_DATA_DIR, { recursive: true });
  getSettingsMock.mockReset().mockResolvedValue({});
  vi.restoreAllMocks();
});

afterEach(async () => {
  await drainJobs();
  vi.unstubAllGlobals();
  videoGenEvents.removeAllListeners();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('videoGen/fal — resolveFalApiKey', () => {
  it('prefers the settings-stored key over the FAL_KEY env var', () => {
    const prevEnv = process.env.FAL_KEY;
    process.env.FAL_KEY = 'env-key';
    expect(fal.resolveFalApiKey({ videoGen: { fal: { apiKey: ' settings-key ' } } })).toBe('settings-key');
    if (prevEnv === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prevEnv;
  });

  it('falls back to FAL_KEY when settings carry no key', () => {
    const prevEnv = process.env.FAL_KEY;
    process.env.FAL_KEY = 'env-key';
    expect(fal.resolveFalApiKey({})).toBe('env-key');
    if (prevEnv === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prevEnv;
  });

  it('returns null when neither settings nor env carry a key', () => {
    const prevEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    expect(fal.resolveFalApiKey({})).toBeNull();
    if (prevEnv !== undefined) process.env.FAL_KEY = prevEnv;
  });
});

describe('videoGen/fal — deriveAspectRatio', () => {
  it('maps width/height to the nearest fal-supported ratio', () => {
    expect(fal.deriveAspectRatio(1920, 1080)).toBe('16:9');
    expect(fal.deriveAspectRatio(1080, 1920)).toBe('9:16');
    expect(fal.deriveAspectRatio(1024, 1024)).toBe('1:1');
  });

  it('returns null for absent/invalid dimensions', () => {
    expect(fal.deriveAspectRatio(undefined, undefined)).toBeNull();
  });
});

describe('videoGen/fal — _internals.buildRequestBody', () => {
  it('includes only the fields that were actually supplied', () => {
    expect(fal._internals.buildRequestBody({ prompt: ' a fox running ' })).toEqual({ prompt: 'a fox running' });
    expect(fal._internals.buildRequestBody({
      prompt: 'pan', duration: 10, aspectRatio: '16:9', imageDataUri: 'data:image/png;base64,AA==',
    })).toEqual({
      prompt: 'pan', duration: '10', aspect_ratio: '16:9', image_url: 'data:image/png;base64,AA==',
    });
  });

  it('folds negativePrompt into the prompt as an Avoid clause, same fallback as grok', () => {
    expect(fal._internals.buildRequestBody({ prompt: 'a fox running', negativePrompt: 'blurry, low quality' }))
      .toEqual({ prompt: 'a fox running\nAvoid: blurry, low quality' });
    expect(fal._internals.buildRequestBody({ prompt: 'a fox running', negativePrompt: '  ' }))
      .toEqual({ prompt: 'a fox running' });
    expect(fal._internals.buildRequestBody({ prompt: 'a fox running' }))
      .toEqual({ prompt: 'a fox running' });
  });
});

describe('videoGen/fal — generateVideo', () => {
  it('submits, polls to completion, downloads the result, and finalizes history', async () => {
    const requestId = 'req-123';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const responseUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}`;
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body)).toEqual({ prompt: 'a fox running' });
        return jsonResponse({ request_id: requestId, status_url: statusUrl, response_url: responseUrl });
      }
      if (url === statusUrl) return jsonResponse({ status: 'COMPLETED' });
      if (url === responseUrl) return jsonResponse({ video: { url: 'https://cdn.fal.ai/out.mp4' } });
      if (url === 'https://cdn.fal.ai/out.mp4') {
        // Buffer.from(str).buffer is the pooled backing ArrayBuffer (larger
        // than the string, and may carry unrelated pool bytes) — Uint8Array.from
        // allocates a fresh, exactly-sized buffer instead.
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('fake-mp4-bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'a fox running' });
    expect(job.mode).toBe('fal');
    expect(job.status).toBe('running');
    expect(job.filename).toMatch(/^[0-9a-f-]{36}\.mp4$/);

    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    const outputPath = join(FAKE_VIDEOS_DIR, job.filename);
    const history = await loadHistory();

    const written = await readFile(outputPath);
    expect(written.toString()).toBe('fake-mp4-bytes');

    expect(history[0].id).toBe(job.jobId);
    expect(history[0].modelId).toBe('fal:fal-ai/x');
  });

  it('derives aspect_ratio from width/height when none is supplied explicitly', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        expect(JSON.parse(opts.body)).toEqual({ prompt: 'portrait clip', aspect_ratio: '9:16' });
        return jsonResponse({ request_id: 'r2', status_url: 'https://queue.fal.run/fal-ai/x/requests/r2/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r2' });
      }
      if (url === 'https://queue.fal.run/fal-ai/x/requests/r2/status') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/fal-ai/x/requests/r2') return jsonResponse({ video: { url: 'https://cdn.fal.ai/out.mp4' } });
      if (url === 'https://cdn.fal.ai/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'portrait clip', width: 1080, height: 1920,
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('resolves the API key from live settings when the caller supplies neither apiKey nor settings (the mediaJobQueue dispatch shape)', async () => {
    getSettingsMock.mockResolvedValue({ videoGen: { fal: { apiKey: 'live-key' } } });
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        expect(opts.headers.Authorization).toBe('Key live-key');
        return jsonResponse({ request_id: 'r1', status_url: 'https://queue.fal.run/fal-ai/x/requests/r1/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r1' });
      }
      if (url === 'https://queue.fal.run/fal-ai/x/requests/r1/status') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/fal-ai/x/requests/r1') return jsonResponse({ video: { url: 'https://cdn.fal.ai/out.mp4' } });
      if (url === 'https://cdn.fal.ai/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // No apiKey, no settings — exactly what mediaJobQueue's runJob spreads
    // job.params into (job params never carry the secret; see the comment in
    // generateVideo).
    const job = await fal.generateVideo({ modelId: 'fal-ai/x', prompt: 'x' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(getSettingsMock).toHaveBeenCalled();
    expect(job.status).toBe('running');
  });

  it('rejects when no API key is configured', async () => {
    const prevEnv = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    await expect(fal.generateVideo({ prompt: 'x', settings: {} })).rejects.toThrow(/No fal\.ai API key/);
    if (prevEnv !== undefined) process.env.FAL_KEY = prevEnv;
  });

  it('emits failed and does not write output when fal.ai reports ERROR', async () => {
    const requestId = 'req-err';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        return jsonResponse({ request_id: requestId, status_url: statusUrl, response_url: `https://queue.fal.run/fal-ai/x/requests/${requestId}` });
      }
      if (url === statusUrl) return jsonResponse({ status: 'ERROR', error: 'model overloaded' });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'x' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(failed).toHaveBeenCalledTimes(1);

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ generationId: job.jobId, error: expect.stringContaining('model overloaded') }));
  });

  it('drains a delayed prior finalization before teardown, identifying both failure event sources', async () => {
    // Reproduce #7089 without timing luck: the earlier job is held after its
    // complete stamp while the next job installs a one-shot ffmpeg rejection.
    const delayed = Promise.withResolvers();
    const entered = vi.fn();
    ffmpeg.optimizeForStreaming.mockImplementationOnce(async () => {
      entered();
      await delayed.promise;
      throw new Error('delayed prior finalization failed');
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ...jsonResponse({
        request_id: 'controlled-request', status: 'COMPLETED',
        video: { url: 'https://cdn.fal.ai/out.mp4' },
      }),
      arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer,
    })));

    const prior = await fal.generateVideo({ apiKey: 'test-key', prompt: 'prior clip' });
    const teardownReady = vi.fn();
    let draining;
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
      draining = drainJobs().then(teardownReady);
      const failed = vi.fn();
      videoGenEvents.on('failed', failed);
      ffmpeg.optimizeForStreaming.mockRejectedValueOnce(new Error('current finalization failed'));
      const current = await fal.generateVideo({ apiKey: 'test-key', prompt: 'current clip' });
      await waitForTerminal(current.jobId);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenLastCalledWith({
        generationId: current.jobId, error: expect.stringContaining('current finalization failed'),
      });
      expect(teardownReady).not.toHaveBeenCalled();

      delayed.resolve();
      await draining;
      // The second event is a different generation, not a duplicate emission
      // by the current job. The original #6831 test below still requires one.
      expect(failed).toHaveBeenCalledTimes(2);
      expect(failed.mock.calls.map(([event]) => event.generationId)).toEqual([current.jobId, prior.jobId]);
      expect(teardownReady).toHaveBeenCalledTimes(1);
    } finally {
      delayed.resolve();
      await draining;
    }
  });

  // Regression (#6831): finalizeGeneratedVideo stamps job.status = 'complete'
  // BEFORE its own faststart/thumbnail/history tail, and runFalVideo has
  // already released the request slot by then, so a throw from that tail
  // lands in the catch-all with the job already reading 'complete'. Without
  // `force: true` the shared finalizer's idempotency guard made that a silent
  // no-op — no 'failed' event for the media queue, no SSE error frame for the
  // client — the window videoGen/grok.js's post-exit catch (fa3796650) and
  // reactor.js's catch-all already force past.
  it('still emits failed when finalizeGeneratedVideo throws after job.status is already complete', async () => {
    const requestId = 'req-tail';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const responseUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}`;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === 'https://queue.fal.run/fal-ai/x') return jsonResponse({ request_id: requestId, status_url: statusUrl, response_url: responseUrl });
      if (url === statusUrl) return jsonResponse({ status: 'COMPLETED' });
      if (url === responseUrl) return jsonResponse({ video: { url: 'https://cdn.fal.ai/out.mp4' } });
      if (url === 'https://cdn.fal.ai/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    // The first step after the 'complete' stamp rejects — the download has
    // already landed on disk, so this is purely the post-processing window.
    ffmpeg.optimizeForStreaming.mockRejectedValueOnce(new Error('faststart remux failed'));

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'x' });
    // A client attached for the whole run: the terminal frame it receives is
    // what the UI keys off, and exactly what the guard used to swallow.
    const client = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), req: { on: vi.fn() } };
    expect(fal.attachSseClient(job.jobId, client)).toBe(true);

    await waitForTerminal(job.jobId);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith({ generationId: job.jobId, error: expect.stringContaining('faststart remux failed') });
    const frames = client.write.mock.calls.map(([msg]) => JSON.parse(msg.replace(/^data: /, '')));
    expect(frames.at(-1)).toEqual({ type: 'error', error: expect.stringContaining('faststart remux failed') });
  }, 10000);
});
