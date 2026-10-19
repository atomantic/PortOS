import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

const TEST_ROOT = join(tmpdir(), `portos-runway-video-test-${process.pid}-${Date.now()}`);
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
    probeVideoGeometry: vi.fn(async () => ({ duration: 4 })),
  };
});

const getSettingsMock = vi.fn();
vi.mock('../settings.js', () => ({ getSettings: getSettingsMock }));

const runway = await import('./runway.js');
const { RUNWAY_API_VERSION } = await import('../runwayApi.js');
const { videoGenEvents } = await import('./events.js');
const { loadHistory } = await import('./history.js');

const terminalEvents = new Map();
const waitForTerminal = async (jobId) => {
  await vi.waitFor(() => expect(terminalEvents.get(jobId)).toBeTruthy(), { timeout: 5000 });
  return terminalEvents.get(jobId);
};

const jsonResponse = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, body: { cancel: async () => {} } });
const TASKS = 'https://api.dev.runwayml.com/v1/tasks/task-1';

let framePath;
beforeEach(async () => {
  videoGenEvents.removeAllListeners();
  terminalEvents.clear();
  videoGenEvents.on('started', ({ generationId }) => terminalEvents.set(generationId, null));
  for (const type of ['completed', 'failed']) {
    videoGenEvents.on(type, (event) => terminalEvents.set(event.generationId, { type, ...event }));
  }
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_DATA_DIR, { recursive: true });
  framePath = join(TEST_ROOT, 'frame.png');
  await sharp({ create: { width: 64, height: 36, channels: 3, background: '#336699' } }).png().toFile(framePath);
  getSettingsMock.mockReset().mockResolvedValue({});
});

afterEach(async () => {
  await vi.waitFor(() => expect([...terminalEvents.values()].filter((e) => !e)).toEqual([]), { timeout: 5000 });
  vi.unstubAllGlobals();
  videoGenEvents.removeAllListeners();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('videoGen/runway — generateVideo', () => {
  it('submits the catalog body, polls to SUCCEEDED, downloads the clip and records the estimate', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
      if (url === 'https://api.dev.runwayml.com/v1/image_to_video') return jsonResponse({ id: 'task-1' });
      if (url === TASKS) return jsonResponse({ id: 'task-1', status: 'SUCCEEDED', output: ['https://cdn.example.com/out.mp4'] });
      if (url === 'https://cdn.example.com/out.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const job = await runway.generateVideo({
      apiKey: 'key_test', modelId: 'gen4_turbo', prompt: 'waves roll in', negativePrompt: 'text',
      duration: 3.4, width: 1280, height: 720, sourceImagePath: framePath,
    });
    expect(job).toMatchObject({ mode: 'runway', status: 'running' });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });

    const submit = calls.find((c) => c.method === 'POST');
    expect(submit.headers).toMatchObject({ Authorization: 'Bearer key_test', 'X-Runway-Version': RUNWAY_API_VERSION });
    expect(submit.body).toEqual({
      model: 'gen4_turbo', promptImage: expect.stringMatching(/^data:image\/png;base64,/),
      promptText: 'waves roll in\nAvoid: text', duration: 4, ratio: '1280:720',
    });
    // A finished task is never DELETEd (that would delete it, not cancel it).
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await readFile(join(FAKE_VIDEOS_DIR, job.filename), 'utf8')).toBe('mp4');
    const [entry] = await loadHistory();
    expect(entry).toMatchObject({ modelId: 'runway:gen4_turbo', duration: 4, aspectRatio: '1280:720', estimatedCostUsd: 0.2 });
    // The negative prompt rides in the prompt, so the record lists it as an addition (#11317).
    expect(entry.sentPrompt).toBe('waves roll in\nAvoid: text');
    expect(entry.promptAdditions).toEqual([expect.objectContaining({ id: 'avoid', text: 'text' })]);
  });

  it('fails the job with Runway\'s reason when the task FAILS', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      if (opts.method === 'POST') return jsonResponse({ id: 'task-1' });
      if (url === TASKS) return jsonResponse({ id: 'task-1', status: 'FAILED', failure: 'Content moderation', failureCode: 'SAFETY.INPUT.IMAGE' });
      throw new Error(`unexpected fetch: ${url} ${opts.method}`);
    }));
    const job = await runway.generateVideo({ apiKey: 'key_test', prompt: 'a fox', sourceImagePath: framePath });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringMatching(/Content moderation \(SAFETY\.INPUT\.IMAGE\)/) });
  });

  it.each([
    ['no start frame', { prompt: 'a fox' }, /start frame/],
    ['an over-cap prompt', { prompt: 'x'.repeat(1001), sourceImagePath: 'unused.png' }, /1,001 characters/],
    ['source audio', { prompt: 'a fox', sourceImagePath: 'unused.png', audioFilePath: 'song.wav' }, /cutaways only/],
  ])('refuses %s before reading media or submitting', async (_label, params, message) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runway.generateVideo({ apiKey: 'key_test', ...params }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without a key, naming where to set it', async () => {
    const prev = process.env.RUNWAYML_API_SECRET;
    delete process.env.RUNWAYML_API_SECRET;
    await expect(runway.generateVideo({ prompt: 'a fox', sourceImagePath: framePath }))
      .rejects.toMatchObject({ code: 'RUNWAY_NOT_CONFIGURED' });
    if (prev !== undefined) process.env.RUNWAYML_API_SECRET = prev;
  });

  it('cancels a running task with one DELETE and finishes the job canceled', async () => {
    const deletes = [];
    let polled;
    const firstPoll = new Promise((resolve) => { polled = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      if (opts.method === 'POST') return jsonResponse({ id: 'task-1' });
      if (opts.method === 'DELETE') { deletes.push(url); return jsonResponse({}, true, 204); }
      if (url === TASKS) { polled(); return jsonResponse({ id: 'task-1', status: 'RUNNING', progress: 0.2 }); }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await runway.generateVideo({ apiKey: 'key_test', prompt: 'a fox', sourceImagePath: framePath });
    await firstPoll;
    expect(runway.cancel(job.jobId)).toBe(true);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(deletes).toEqual([TASKS]);
  });
});
