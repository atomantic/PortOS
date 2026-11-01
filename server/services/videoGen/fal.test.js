import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
const { unlink: realUnlink } = await vi.importActual('fs/promises');

const TEST_ROOT = join(tmpdir(), `portos-fal-video-test-${process.pid}-${Date.now()}`);
const FAKE_VIDEOS_DIR = join(TEST_ROOT, 'data-videos');
const FAKE_DATA_DIR = join(TEST_ROOT, 'data');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.videos = FAKE_VIDEOS_DIR;
  actual.PATHS.data = FAKE_DATA_DIR;
  actual.PATHS.videoThumbnails = join(TEST_ROOT, 'thumbnails');
  actual.PATHS.uploads = join(TEST_ROOT, 'uploads');
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
const { maintenance } = await import('../../lib/maintenanceAdmission.js');

// A returned job is not a settled run.
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
  unlink.mockReset().mockImplementation(realUnlink);
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
  // A curated model builds its own body (lib/falVideoModels.js) — names and
  // wire types per family — and the history records what was rendered and its
  // list-price estimate. One family end to end; the per-family matrix is
  // pinned in lib/falVideoModels.test.js.
  it.each(['gallery', 'upload'])('builds a curated model body with both %s anchor frames and records the estimate', async (input) => {
    const framesDir = input === 'upload' ? join(TEST_ROOT, 'uploads') : TEST_ROOT;
    await mkdir(framesDir, { recursive: true });
    const framePath = join(framesDir, 'frame.png');
    await writeFile(framePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const endFramePath = join(framesDir, 'end-frame.jpg');
    const endFrame = Buffer.from('ffd8ffe000104a464946000101', 'hex');
    await writeFile(endFramePath, endFrame);
    const posted = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') {
        posted.push({ url, body: JSON.parse(opts.body) });
        return jsonResponse({ request_id: 'rk', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.example.com/out.mp4' } });
      if (url === 'https://cdn.example.com/out.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: 'fal-ai/kling-video/v3/pro/image-to-video',
      prompt: 'waves roll in', negativePrompt: 'text', duration: 7.4, width: 1080, height: 1920, sourceImagePath: framePath, lastImagePath: endFramePath,
      ...(input === 'upload' ? { uploadedTempPath: framePath, uploadedTempPaths: [endFramePath] } : {}),
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video');
    expect(posted[0].body).toEqual({
      prompt: 'waves roll in', negative_prompt: 'text', start_image_url: expect.stringMatching(/^data:image\/png;base64,/),
      end_image_url: `data:image/jpeg;base64,${endFrame.toString('base64')}`,
      duration: '8', generate_audio: false,
    });
    const [entry] = await loadHistory();
    // 8s (the covering length) × $0.14/s audio off.
    expect(entry).toMatchObject({ modelId: 'fal:fal-ai/kling-video/v3/pro/image-to-video', duration: 8, generateAudio: false, estimatedCostUsd: 1.12 });
    // Kling takes the negative natively, so the record shows it apart and no "Avoid:" chip (#11317).
    expect(entry).toMatchObject({ sentPrompt: 'waves roll in', sentNegativePrompt: 'text' });
    expect(entry.promptAdditions).toBeUndefined();
    if (input === 'upload') {
      await expect(readFile(framePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(endFramePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(endFramePath)).toEqual(endFrame);
      expect(await readFile(framePath)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
    }
  });

  it.each([[true, 'disabled'], [false, 'balanced']])('H3 body for a music-video shot (%s) sends prompt_expansion_mode %s', async (musicVideo, mode) => {
    await mkdir(TEST_ROOT, { recursive: true });
    const framePath = join(TEST_ROOT, 'frame.png');
    await writeFile(framePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const posted = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts?.method === 'POST') {
        posted.push(JSON.parse(opts.body));
        return jsonResponse({ request_id: 'rk', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.example.com/out.mp4' } });
      return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
    }));
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: 'minimax/h3-max/image-to-video', prompt: 'waves roll in', duration: 5, sourceImagePath: framePath,
      ...(musicVideo ? { musicVideo: { projectId: 'p', sceneId: 's' } } : {}),
    });
    await waitForTerminal(job.jobId);
    expect(posted[0].prompt_expansion_mode).toBe(mode);
    const [entry] = await loadHistory();
    expect(entry.promptAdditions?.some((a) => a.id === 'prompt-expansion') ?? false).toBe(musicVideo);
  });

  it('refuses a start-frame-only model without a frame before submitting anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/veo3.1/fast/image-to-video', prompt: 'a fox' }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['fal-ai/veo3.1/fast/image-to-video', 'fal-ai/uncatalogued-model'])('refuses end frames for %s before reading media or submitting', async (modelId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fal.generateVideo({
      apiKey: 'test-key', modelId, prompt: 'a fox',
      sourceImagePath: join(TEST_ROOT, 'missing-start.png'), lastImagePath: join(TEST_ROOT, 'missing-end.png'),
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: expect.stringMatching(/end.frame/i) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(terminalEvents.size).toBe(0);
  });

  it('cleans owned frames after an asynchronous input failure without submitting a paid request', async () => {
    const uploads = join(TEST_ROOT, 'uploads');
    await mkdir(uploads, { recursive: true });
    const frame = join(uploads, 'start.png');
    const end = join(uploads, 'missing-end.png');
    await writeFile(frame, Buffer.from('89504e470d0a1a0a', 'hex'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: 'fal-ai/kling-video/v3/pro/image-to-video', prompt: 'a fox',
      sourceImagePath: frame, lastImagePath: end, uploadedTempPath: frame, uploadedTempPaths: [end],
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    await vi.waitFor(async () => {
      await expect(readFile(frame)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
    // An uncurated id keeps the legacy body and cannot be priced.
    expect(history[0].estimatedCostUsd).toBeNull();
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

  it('crops an off-aspect start frame to the named frame aspect before upload, leaving the file alone', async () => {
    const sharp = (await import('sharp')).default;
    const framePath = join(TEST_ROOT, 'square.png');
    const square = await sharp({ create: { width: 640, height: 640, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
    await writeFile(framePath, square);
    let sent = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        sent = JSON.parse(opts.body);
        return jsonResponse({ request_id: 'r3', status_url: 'https://queue.fal.run/fal-ai/x/requests/r3/status', response_url: 'https://queue.fal.run/fal-ai/x/requests/r3' });
      }
      if (url.endsWith('/r3/status')) return jsonResponse({ status: 'COMPLETED' });
      if (url.endsWith('/r3')) return jsonResponse({ video: { url: 'https://cdn.fal.ai/out.mp4' } });
      if (url === 'https://cdn.fal.ai/out.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'singer', sourceImagePath: framePath, frameAspect: '16:9' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    const uploaded = Buffer.from(sent.image_url.split(',')[1], 'base64');
    const { width, height } = await sharp(uploaded).metadata();
    expect({ width, height }).toEqual({ width: 640, height: 360 });
    expect((await readFile(framePath)).equals(square)).toBe(true);
    expect((await loadHistory())[0].frameConformed).toEqual({ aspect: '16:9', start: { from: '640x640', to: '640x360' } });
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

  // A post-download failure must settle the queue and SSE client after cleanup.
  it('emits failed when post-download finalization throws', async () => {
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
    // The download has landed; reject the first post-processing step.
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

// #8340 — a remote fal.ai render must not keep consuming metered compute
// after PortOS locally abandons it. These cover: recovering from a transient
// status-fetch failure without resubmitting, cancelling once retries are
// exhausted, cancelling at the local render deadline, and never sending a
// redundant cancel once fal.ai already reported a terminal status.
describe('videoGen/fal — cancel abandoned renders (#8340)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient status-fetch failure up to twice, never resubmits, and still completes', async () => {
    vi.useFakeTimers();
    const requestId = 'req-retry';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const responseUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}`;
    const cancelUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/cancel`;
    let submitCalls = 0;
    let statusCalls = 0;
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        submitCalls += 1;
        return jsonResponse({ request_id: requestId, status_url: statusUrl, cancel_url: cancelUrl, response_url: responseUrl });
      }
      if (url === statusUrl) {
        statusCalls += 1;
        if (statusCalls <= 2) return { ok: false, status: 502, json: async () => null };
        return jsonResponse({ status: 'COMPLETED' });
      }
      if (url === responseUrl) return jsonResponse({ video: { url: 'https://cdn.fal.ai/out.mp4' } });
      if (url === 'https://cdn.fal.ai/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const completed = vi.fn();
    videoGenEvents.on('completed', completed);
    const _job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'retry me' });

    // Two failed status attempts, each separated by the normal poll interval,
    // then a third attempt that reports COMPLETED.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    // Let the completion path (fetchFalResult + download + finalize) settle.
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(submitCalls).toBe(1);
    expect(statusCalls).toBe(3);
    expect(fetchMock.mock.calls.some(([url]) => url === cancelUrl)).toBe(false);
  });

  it('cancels the remote render once status retries are exhausted', async () => {
    vi.useFakeTimers();
    const requestId = 'req-exhausted';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const cancelUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/cancel`;
    let submitCalls = 0;
    let statusCalls = 0;
    let cancelCalls = 0;
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        submitCalls += 1;
        return jsonResponse({ request_id: requestId, status_url: statusUrl, cancel_url: cancelUrl, response_url: `https://queue.fal.run/fal-ai/x/requests/${requestId}` });
      }
      if (url === statusUrl) {
        statusCalls += 1;
        return { ok: false, status: 502, json: async () => null };
      }
      if (url === cancelUrl) {
        cancelCalls += 1;
        expect(opts.method).toBe('PUT');
        expect(opts.headers.Authorization).toBe('Key test-key');
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'x' });

    // Initial attempt + two retries, each separated by the poll interval.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(submitCalls).toBe(1);
    expect(statusCalls).toBe(3);
    expect(cancelCalls).toBe(1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      generationId: job.jobId,
      error: expect.stringContaining('status checks failed'),
    }));
  });

  it('cancels the remote render when the local render deadline expires while fal.ai still reports nonterminal', async () => {
    vi.useFakeTimers();
    const requestId = 'req-deadline';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const cancelUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/cancel`;
    let cancelCalls = 0;
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        return jsonResponse({ request_id: requestId, status_url: statusUrl, cancel_url: cancelUrl, response_url: `https://queue.fal.run/fal-ai/x/requests/${requestId}` });
      }
      if (url === statusUrl) return jsonResponse({ status: 'IN_PROGRESS' });
      if (url === cancelUrl) {
        cancelCalls += 1;
        expect(opts.method).toBe('PUT');
        expect(opts.headers.Authorization).toBe('Key test-key');
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'x' });

    // Drive well past the 20-minute default render deadline.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 6000);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(cancelCalls).toBe(1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      generationId: job.jobId,
      error: expect.stringContaining('did not finish within'),
    }));
  });

  it('never sends a cancellation once fal.ai already reported ERROR', async () => {
    const requestId = 'req-no-redundant-cancel';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const cancelUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/cancel`;
    const fetchMock = vi.fn(async (url) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        return jsonResponse({ request_id: requestId, status_url: statusUrl, cancel_url: cancelUrl, response_url: `https://queue.fal.run/fal-ai/x/requests/${requestId}` });
      }
      if (url === statusUrl) return jsonResponse({ status: 'ERROR', error: 'model overloaded' });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'x' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(fetchMock.mock.calls.some(([url]) => url === cancelUrl)).toBe(false);
  });

  it('is idempotent with explicit cancellation — a second cancel() does not resend the PUT', async () => {
    vi.useFakeTimers();
    const requestId = 'req-explicit-cancel';
    const statusUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/status`;
    const cancelUrl = `https://queue.fal.run/fal-ai/x/requests/${requestId}/cancel`;
    let cancelCalls = 0;
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === 'https://queue.fal.run/fal-ai/x') {
        return jsonResponse({ request_id: requestId, status_url: statusUrl, cancel_url: cancelUrl, response_url: `https://queue.fal.run/fal-ai/x/requests/${requestId}` });
      }
      if (url === statusUrl) return jsonResponse({ status: 'IN_PROGRESS' });
      if (url === cancelUrl) {
        cancelCalls += 1;
        expect(opts.method).toBe('PUT');
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'x' });
    // Let the run reach its first poll iteration (submit + one status check)
    // before cancelling, so entry.cancelUrl is populated.
    await vi.advanceTimersByTimeAsync(0);

    expect(fal.cancel(job.jobId)).toBe(true);
    expect(fal.cancel(job.jobId)).toBe(true);
    // The poll loop notices `entry.aborted` on its next iteration.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1), { timeout: 5000 });

    expect(cancelCalls).toBe(1);
  });
});

describe('videoGen/fal — recover completed renders (#8564)', () => {
  const submitUrl = 'https://queue.fal.run/fal-ai/x';
  const resultUrl = `${submitUrl}/requests/completed`;
  const videoUrl = 'https://cdn.fal.ai/example.mp4';
  let counts;
  let canceledBodies;
  function installReads({ result, video } = {}) {
    counts = { submit: 0, result: 0, video: 0 };
    canceledBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url === submitUrl) {
        counts.submit++;
        return jsonResponse({ request_id: 'completed', response_url: resultUrl });
      }
      if (url === `${resultUrl}/status`) return jsonResponse({ status: 'COMPLETED' });
      if (url === resultUrl) {
        counts.result++;
        return result ? result(counts.result, options.signal) : jsonResponse({ video: { url: videoUrl } });
      }
      if (url === videoUrl) {
        counts.video++;
        return video ? video(counts.video, options.signal) : new Response('complete-video');
      }
      throw new Error('Unexpected request');
    }));
  }
  function failedResponse(status) {
    const cancel = vi.fn(async () => {});
    canceledBodies.push(cancel);
    return { ok: false, status, body: { cancel } };
  }
  function stalledResponse(signal) {
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  }
  async function generate() {
    vi.useFakeTimers();
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/x', prompt: 'Example clip' });
    await vi.advanceTimersByTimeAsync(0);
    return job;
  }
  afterEach(() => vi.useRealTimers());

  it.each(['result HTTP', 'result transport', 'video HTTP', 'video body'])('recovers %s failure without another generation', async (failure) => {
    installReads({
      result: (attempt) => {
        if (failure === 'result HTTP' && attempt === 1) return failedResponse(503);
        if (failure === 'result transport' && attempt === 1) throw new TypeError('fetch failed');
        return jsonResponse({ video: { url: videoUrl } });
      },
      video: (attempt) => {
        if (failure === 'video HTTP' && attempt === 1) return failedResponse(429);
        if (failure === 'video body' && attempt === 1) return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
        } }));
        return new Response('complete-video');
      },
    });
    const job = await generate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(counts).toEqual({ submit: 1, result: failure.startsWith('result') ? 2 : 1, video: failure.startsWith('video') ? 2 : 1 });
    expect(await readFile(join(FAKE_VIDEOS_DIR, job.filename), 'utf8')).toBe('complete-video');
    expect((await loadHistory()).filter(item => item.id === job.jobId)).toHaveLength(1);
    for (const canceled of canceledBodies) expect(canceled).toHaveBeenCalledOnce();
  });
  it.each(['result', 'video'])('limits transient %s failures to three reads', async (phase) => {
    installReads({ [phase]: () => failedResponse(408) });
    const job = await generate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(counts[phase]).toBe(3);
    expect(counts.submit).toBe(1);
    await expect(readFile(join(FAKE_VIDEOS_DIR, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const canceled of canceledBodies) expect(canceled).toHaveBeenCalledOnce();
  });
  it.each(['result', 'video', 'schema', 'JSON'])('fails permanent %s errors without retries', async (phase) => {
    installReads(phase === 'schema' ? { result: () => jsonResponse({ video: { url: 42 } }) }
      : phase === 'JSON' ? { result: () => new Response('not JSON') }
        : { [phase]: () => failedResponse(403) });
    const job = await generate();
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(counts).toEqual({ submit: 1, result: 1, video: phase === 'video' ? 1 : 0 });
    await expect(readFile(join(FAKE_VIDEOS_DIR, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps fal\'s reason when the result read reports a failed job', async () => {
    installReads({ result: () => new Response(JSON.stringify({ detail: [{ loc: ['body', 'image_url'], msg: 'Image flagged by the content checker', type: 'content_policy_violation' }] }), { status: 422 }) });
    const job = await generate();
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringContaining('HTTP 422 — image_url: Image flagged by the content checker') });
    expect(counts).toEqual({ submit: 1, result: 1, video: 0 });
  });
  it('shares the ten-minute budget across result timeouts, backoff and a stalled video body', async () => {
    installReads({
      result: (attempt, signal) => attempt < 3 ? stalledResponse(signal) : jsonResponse({ video: { url: videoUrl } }),
      video: (_attempt, signal) => stalledResponse(signal),
    });
    const job = await generate();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(counts).toEqual({ submit: 1, result: 3, video: 1 });
    await expect(readFile(join(FAKE_VIDEOS_DIR, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['backoff', 'result body', 'video body'])('cancels during %s without another read or publishing a video', async (phase) => {
    installReads(phase === 'backoff' ? { result: () => failedResponse(503) }
      : phase === 'result body' ? { result: (_attempt, signal) => stalledResponse(signal) }
        : { video: (_attempt, signal) => stalledResponse(signal) });
    const job = await generate();
    expect(fal.cancel(job.jobId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringMatching(/cancel/i) });
    expect(counts).toEqual({ submit: 1, result: 1, video: phase === 'video body' ? 1 : 0 });
    await expect(readFile(join(FAKE_VIDEOS_DIR, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('standalone lip-sync take', () => {
  // A terminal event releases the queue's ownership of staged inputs. Hold the
  // actual unlink boundary, so the test fails even when the filesystem is fast.
  it.each(['completed', 'provider failure', 'download failure', 'canceled'])(
    'settles owned inputs before the %s terminal event and SSE frame', async (outcome) => {
      const { PATHS } = await import('../../lib/fileUtils.js');
      await mkdir(PATHS.uploads, { recursive: true });
      const staged = join(PATHS.uploads, 'voice.wav');
      const stagedFrame = join(PATHS.uploads, 'end.png');
      const outside = join(TEST_ROOT, 'original.png');
      await writeFile(staged, 'voice');
      await writeFile(stagedFrame, 'end frame');
      await writeFile(outside, 'original');
      const cleaning = Promise.withResolvers();
      const release = Promise.withResolvers();
      unlink.mockImplementation(async (path) => {
        if (path === staged) {
          cleaning.resolve();
          await release.promise;
        }
        return realUnlink(path);
      });
      vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (url === 'https://queue.fal.run/fal-ai/y') return jsonResponse({ request_id: 'staged', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
        if (url === 'https://queue.fal.run/s') return jsonResponse(outcome === 'provider failure' ? { status: 'ERROR', error: 'Provider refused input' } : { status: 'COMPLETED' });
        if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.example.com/video.mp4' } });
        if (url === 'https://cdn.example.com/video.mp4') return new Response('mp4', { status: outcome === 'download failure' ? 403 : 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }));
      const job = await fal.generateVideo({
        apiKey: 'test-key', modelId: 'fal-ai/y', sourceImagePath: outside, audioFilePath: staged,
        uploadedTempPath: staged, uploadedTempPaths: [stagedFrame, outside],
      });
      const client = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), req: { on: vi.fn() } };
      fal.attachSseClient(job.jobId, client);
      if (outcome === 'canceled') expect(fal.cancel(job.jobId)).toBe(true);
      const frames = () => client.write.mock.calls.map(([msg]) => JSON.parse(msg.replace(/^data: /, '')));
      try {
        await cleaning.promise;
        expect(terminalEvents.get(job.jobId)).toBeNull();
        expect(frames().some(frame => ['complete', 'error'].includes(frame.type))).toBe(false);
        expect(fal.getActiveJob()).toMatchObject({ generationId: job.jobId });
        expect(await readFile(staged, 'utf8')).toBe('voice');
      } finally {
        release.resolve();
        await waitForTerminal(job.jobId);
      }
      const succeeded = outcome === 'completed';
      expect(terminalEvents.get(job.jobId)).toMatchObject({ type: succeeded ? 'completed' : 'failed',
        ...(!succeeded ? { error: expect.stringMatching(outcome === 'canceled' ? /Canceled/ : outcome === 'provider failure' ? /Provider refused input/ : /403/) } : {}),
      });
      expect(frames().at(-1).type).toBe(succeeded ? 'complete' : 'error');
      expect(fal.getActiveJob()).toBeNull();
      await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(stagedFrame)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(outside, 'utf8')).toBe('original');
      expect(unlink.mock.calls.filter(([path]) => path === staged)).toHaveLength(1);
      if (succeeded) expect(await readFile(join(FAKE_VIDEOS_DIR, job.filename), 'utf8')).toBe('mp4');
      else await expect(readFile(join(FAKE_VIDEOS_DIR, job.filename))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([false, true])('reports uncertain cleanup and retains published video (notification failure: %s)', async (notificationFails) => {
    const { PATHS } = await import('../../lib/fileUtils.js');
    await mkdir(PATHS.uploads, { recursive: true });
    const staged = join(PATHS.uploads, 'locked.wav');
    const other = join(PATHS.uploads, 'other.png');
    const missing = join(PATHS.uploads, 'already-removed.png');
    const frame = join(TEST_ROOT, 'frame.png');
    await writeFile(staged, 'voice');
    await writeFile(other, 'png');
    await writeFile(frame, 'png');
    unlink.mockImplementation(path => path === staged
      ? Promise.reject(Object.assign(new Error('Synthetic cleanup refusal'), { code: 'EACCES' }))
      : realUnlink(path));
    const currentUnsettled = vi.spyOn(maintenance, 'markCurrentUnsettled').mockImplementation(() => {});
    const resourceUnsettled = vi.spyOn(maintenance, 'markResourceUnsettled').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === 'https://queue.fal.run/fal-ai/y') return jsonResponse({ request_id: 'staged', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.example.com/video.mp4' } });
      if (url === 'https://cdn.example.com/video.mp4') return new Response('committed video');
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await fal.generateVideo({
      apiKey: 'test-key', modelId: 'fal-ai/y', sourceImagePath: frame, audioFilePath: staged,
      uploadedTempPaths: [other, missing],
    });
    if (notificationFails) {
      const emit = videoGenEvents.emit.bind(videoGenEvents);
      vi.spyOn(videoGenEvents, 'emit').mockImplementation((type, ...args) => {
        if (type === 'completed') throw new Error('Synthetic notification failure');
        return emit(type, ...args);
      });
    }
    expect(await waitForTerminal(job.jobId)).toMatchObject(notificationFails
      ? { type: 'failed', error: expect.stringContaining('Synthetic notification failure') }
      : { type: 'completed' });
    expect(currentUnsettled).toHaveBeenCalledOnce();
    expect(resourceUnsettled).toHaveBeenCalledExactlyOnceWith('media', job.jobId);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('staged-input cleanup failed'));
    expect(await readFile(staged, 'utf8')).toBe('voice');
    await expect(readFile(other)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(FAKE_VIDEOS_DIR, job.filename), 'utf8')).toBe('committed video');
    expect((await loadHistory()).filter(item => item.id === job.jobId)).toHaveLength(1);
    expect(unlink.mock.calls.filter(([path]) => path === staged)).toHaveLength(1);
  });

  it('drops the staged voice clip once the take is published, but never a file outside data/uploads', async () => {
    const { PATHS } = await import('../../lib/fileUtils.js');
    await mkdir(PATHS.uploads, { recursive: true });
    const posted = [];
    const staged = join(PATHS.uploads, 'video-audio-test.mp3');
    const outside = join(TEST_ROOT, 'keep-me.webm');
    const frame = join(TEST_ROOT, 'face.png');
    await writeFile(staged, 'voice'); await writeFile(outside, 'voice'); await writeFile(frame, 'png');
    const run = async (audioFilePath, requestId) => {
      const statusUrl = `https://queue.fal.run/fal-ai/y/requests/${requestId}/status`;
      const responseUrl = `https://queue.fal.run/fal-ai/y/requests/${requestId}`;
      vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
        if (url === 'https://queue.fal.run/fal-ai/y') { posted.push(JSON.parse(opts.body)); return jsonResponse({ request_id: requestId, status_url: statusUrl, response_url: responseUrl }); }
        if (url === statusUrl) return jsonResponse({ status: 'COMPLETED' });
        if (url === responseUrl) return jsonResponse({ video: { url: `https://cdn.fal.ai/${requestId}.mp4` } });
        if (url === `https://cdn.fal.ai/${requestId}.mp4`) return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
        throw new Error(`unexpected fetch: ${url}`);
      }));
      const job = await fal.generateVideo({ apiKey: 'test-key', modelId: 'fal-ai/y', sourceImagePath: frame, audioFilePath });
      expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    };
    await run(staged, 'req-staged');
    await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    await run(outside, 'req-outside');
    expect((await readFile(outside)).toString()).toBe('voice');
    // the clip's data URI is labelled by its extension, not always WAV
    expect(JSON.stringify(posted[0])).toContain('data:audio/mpeg;base64,');
    expect(JSON.stringify(posted[1])).toContain('data:audio/webm;base64,');
  });
});

// #11381: OmniHuman v1.5 downloads its inputs and answers a data URI with
// "Failed to download the file", so its frame and audio go up to fal's CDN first.
describe('hosted inputs', () => {
  it('uploads the frame and audio for a model that downloads its inputs and sends their URLs', async () => {
    const frame = join(TEST_ROOT, 'singer.png');
    const audio = join(TEST_ROOT, 'line.wav');
    await writeFile(frame, 'png'); await writeFile(audio, 'wav');
    const model = 'fal-ai/bytedance/omnihuman/v1.5';
    const uploads = [];
    let posted = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        const { content_type: type, file_name: name } = JSON.parse(opts.body);
        uploads.push({ type, name, auth: opts.headers.Authorization });
        return jsonResponse({ upload_url: `https://upload.example.com/${name}`, file_url: `https://cdn.example.com/${name}` });
      }
      if (url.startsWith('https://upload.example.com/')) return { ok: opts.method === 'PUT', status: 200 };
      if (url === `https://queue.fal.run/${model}`) {
        posted = JSON.parse(opts.body);
        return jsonResponse({ request_id: 'req-hosted', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.fal.ai/hosted.mp4' } });
      if (url === 'https://cdn.fal.ai/hosted.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: model, prompt: 'she sings', sourceImagePath: frame, audioFilePath: audio });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(uploads.map((u) => u.type).sort()).toEqual(['audio/wav', 'image/png']);
    expect(uploads.every((u) => u.auth === 'Key test-key')).toBe(true);
    expect(posted.image_url).toMatch(/^https:\/\/cdn\.example\.com\/.+-start\.png$/);
    expect(posted.audio_url).toMatch(/^https:\/\/cdn\.example\.com\/.+-audio\.wav$/);
    expect(JSON.stringify(posted)).not.toContain('data:');
  });

  it('sends a storyboard panel as @Image1 guidance beside its references, never as a start frame', async () => {
    const [panel, cast] = [join(TEST_ROOT, 'panel.png'), join(TEST_ROOT, 'cast.png')];
    await writeFile(panel, 'png'); await writeFile(cast, 'png');
    const model = 'bytedance/seedance-2.5/reference-to-video';
    let posted = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        const { file_name: name } = JSON.parse(opts.body);
        return jsonResponse({ upload_url: `https://upload.example.com/${name}`, file_url: `https://cdn.example.com/${name}` });
      }
      if (url.startsWith('https://upload.example.com/')) return { ok: true, status: 200 };
      if (url === `https://queue.fal.run/${model}`) {
        posted = JSON.parse(opts.body);
        return jsonResponse({ request_id: 'req-guided', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.fal.ai/guided.mp4' } });
      if (url === 'https://cdn.fal.ai/guided.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: model, prompt: 'she laces her skates', duration: 5,
      guidanceImagePath: panel, referenceImagePaths: [cast] });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(posted.image_urls).toEqual([expect.stringMatching(/-reference-1\.png$/), expect.stringMatching(/-reference-2\.png$/)]);
    expect(posted.prompt).toMatch(/^she laces her skates\n@Image1 is a storyboard panel.*It is not the first frame.*\n@Image2 set the look/s);
    const [entry] = await loadHistory();
    expect(entry).toMatchObject({ mode: 'text', sentPrompt: posted.prompt, storyboardGuidance: { guidanceImageFile: 'panel.png', referenceImageFiles: ['cast.png'] } });
    expect(entry.promptAdditions.find((a) => a.id === 'storyboard-guidance').text).toBe(posted.prompt.split('\n').slice(1).join('\n'));
  });

  // #14241: a music-video sequence sends each shot's frame as Image n with its timed
  // prompt as written; H3 must not rewrite it, and the clip record says so.
  it('sends a sequence take\'s shot frames as references with H3 prompt expansion disabled', async () => {
    const frames = ['a', 'b', 'c'].map((n) => join(TEST_ROOT, `shot-${n}.png`));
    await Promise.all(frames.map((f) => writeFile(f, 'png')));
    const model = 'minimax/h3-max/reference-to-video';
    let posted = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        const { file_name: name } = JSON.parse(opts.body);
        return jsonResponse({ upload_url: `https://upload.example.com/${name}`, file_url: `https://cdn.example.com/${name}` });
      }
      if (url.startsWith('https://upload.example.com/')) return { ok: true, status: 200 };
      if (url === `https://queue.fal.run/${model}`) {
        posted = JSON.parse(opts.body);
        return jsonResponse({ request_id: 'req-seq', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (url === 'https://queue.fal.run/s') return jsonResponse({ status: 'COMPLETED' });
      if (url === 'https://queue.fal.run/r') return jsonResponse({ video: { url: 'https://cdn.fal.ai/seq.mp4' } });
      if (url === 'https://cdn.fal.ai/seq.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const prompt = '0-4s: Image 1. she climbs\n4-8s: Image 2. her hand\n8-12s: Image 3. the window';
    const job = await fal.generateVideo({ apiKey: 'test-key', modelId: model, prompt, duration: 12, referenceImagePaths: frames,
      musicVideo: { projectId: 'p1', sequence: { sceneIds: ['a', 'b', 'c'] } } });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(posted).toMatchObject({ prompt, duration: 12, prompt_expansion_mode: 'disabled' });
    expect(posted.reference_image_urls).toEqual([1, 2, 3].map((n) => expect.stringMatching(new RegExp(`-reference-${n}\\.png$`))));
    expect(posted.image_url).toBeUndefined();
    const [entry] = await loadHistory();
    expect(entry.sentPrompt).toBe(prompt);
    expect(entry.promptAdditions.find((a) => a.id === 'prompt-expansion').text).toMatch(/disabled/);
    expect(entry.storyboardGuidance).toBeUndefined();
  });
});

it('cancels during preparation before starting a render', async () => {
  const { videoGenEvents: events } = await import('./events.js');
  const failed = vi.fn();
  const completed = vi.fn();
  events.on('failed', failed);
  events.on('completed', completed);
  vi.stubGlobal('fetch', vi.fn());
  const jobId = 'preamble-cancel-videoGen-fal';
  const pending = fal.generateVideo({ prompt: 'a quiet gate', jobId, apiKey: 'test-key', modelId: 'fal-ai/veo3.1/fast' });
  expect(fal.cancel(jobId)).toBe('pending');
  await pending;
  await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({ generationId: jobId, error: 'Canceled' })));
  expect(completed).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(fal.cancel(jobId)).toBe(false);
});
