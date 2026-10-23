import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'fs/promises';
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
    probeVideoGeometry: vi.fn(async () => ({ width: 1280, height: 720, fps: 24, durationSec: 4, numFrames: 96 })),
  };
});

const getSettingsMock = vi.fn();
vi.mock('../settings.js', () => ({ getSettings: getSettingsMock }));

const runway = await import('./runway.js');
const { RUNWAY_API_VERSION } = await import('../runwayApi.js');
const { videoGenEvents } = await import('./events.js');
const { loadHistory } = await import('./history.js');
const { probeVideoGeometry } = await import('../../lib/ffmpeg.js');

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
  probeVideoGeometry.mockReset().mockResolvedValue({ width: 1280, height: 720, fps: 24, durationSec: 4, numFrames: 96 });
});

describe('Runway video-input workflows', () => {
  const stagedVideo = async () => {
    await mkdir(join(TEST_ROOT, 'uploads'), { recursive: true });
    const path = join(TEST_ROOT, 'uploads', 'source.mp4');
    await writeFile(path, Buffer.alloc(1024));
    return path;
  };
  it('cancels during preparation without uploading private inputs', async () => {
    const video = await stagedVideo();
    let releaseSettings;
    getSettingsMock.mockImplementationOnce(() => new Promise((resolve) => { releaseSettings = resolve; }));
    vi.stubGlobal('fetch', vi.fn());
    const starting = runway.generateVideo({ jobId: 'preparation-cancel', modelId: 'aleph2', runwayVideoPath: video, uploadedTempPaths: [video] });
    await vi.waitFor(() => expect(releaseSettings).toBeTypeOf('function'));
    expect(runway.cancel('preparation-cancel')).toBe('pending');
    releaseSettings({ videoGen: { runway: { apiKey: 'test-key' } } });
    const job = await starting;
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(video)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['aleph2', 'act_two', 'act_two_video'])('uploads and publishes %s with the endpoint-specific fields, preserving input ownership', async (variant) => {
    const video = await stagedVideo();
    const modelId = variant === 'act_two_video' ? 'act_two' : variant;
    const durationSec = variant === 'act_two' ? 3 : variant === 'act_two_video' ? 30 : 4;
    probeVideoGeometry.mockResolvedValue({ width: 1280, height: 720, fps: 24, durationSec, numFrames: durationSec * 24 });
    const calls = [];
    let registrations = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url, ...options });
      if (url.endsWith('/v1/uploads')) return jsonResponse({ uploadUrl: 'https://storage.example/upload', fields: { key: 'signed-object', policy: 'signed-policy' }, runwayUri: `runway://upload-${++registrations}` });
      if (url === 'https://storage.example/upload') return jsonResponse({}, true, 204);
      if (url.endsWith('/v1/video_to_video') || url.endsWith('/v1/character_performance')) return jsonResponse({ id: 'task-1' });
      if (url === TASKS) return jsonResponse({ status: 'SUCCEEDED', output: ['https://cdn.example.com/out.mp4'] });
      if (url === 'https://cdn.example.com/out.mp4') return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
      throw new Error(`Unexpected fetch ${url}`);
    }));
    const job = await runway.generateVideo({ apiKey: 'test-key', modelId, videoMode: modelId === 'aleph2' ? 'video-edit' : 'character-performance',
      prompt: modelId === 'aleph2' ? 'Make it snow' : '', runwayVideoPath: video,
      ...(variant === 'act_two_video' ? { runwayCharacterVideoPath: video } : { sourceImagePath: framePath }),
      uploadedTempPaths: [video], bodyControl: false, expressionIntensity: 5,
    });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    const storage = calls.find((c) => c.url === 'https://storage.example/upload');
    expect(storage.headers?.Authorization).toBeUndefined();
    expect([...storage.body.keys()]).toEqual(['key', 'policy', 'file']);
    expect(storage.body.get('file').size).toBe(1024);
    const submitted = calls.find((c) => c.url.endsWith(modelId === 'aleph2' ? '/v1/video_to_video' : '/v1/character_performance'));
    const body = JSON.parse(submitted.body);
    expect(body).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('audio');
    if (modelId === 'aleph2') expect(body).toMatchObject({ model: modelId, videoUri: 'runway://upload-1', promptText: 'Make it snow', keyframes: [{ at: 0, uri: expect.stringMatching(/^data:image\//) }] });
    else {
      expect(body).not.toHaveProperty('promptText');
      expect(body).toMatchObject({ model: modelId, character: { type: variant === 'act_two_video' ? 'video' : 'image' }, reference: { type: 'video', uri: 'runway://upload-1' }, bodyControl: false, expressionIntensity: 5 });
      expect(registrations).toBe(variant === 'act_two_video' ? 2 : 1);
    }
    await expect(stat(video)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(framePath)).toBeTruthy();
    expect((await loadHistory())[0]).toMatchObject({ modelId: `runway:${modelId}`, duration: durationSec, mode: modelId === 'aleph2' ? 'video-edit' : 'character-performance' });
  });

  it.each([
    [{ modelId: 'aleph2' }, /source video/],
    [{ modelId: 'act_two', runwayVideoPath: 'unused.mp4' }, /exactly one character/],
    [{ modelId: 'act_two', runwayVideoPath: 'unused.mp4', sourceImagePath: 'unused.png', prompt: 'ignored text' }, /does not accept prompts/],
    [{ modelId: 'aleph2', runwayVideoPath: 'unused.mp4', videoMode: 'text' }, /matching/],
    [{ modelId: 'act_two', runwayVideoPath: 'unused.mp4', sourceImagePath: 'unused.png', expressionIntensity: 6 }, /intensity/],
    [{ modelId: 'aleph2', runwayVideoPath: 'unused.mp4', seed: -1 }, /seed/],
  ])('rejects incompatible inputs before upload', async (params, message) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(runway.generateVideo({ apiKey: 'test-key', ...params })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['aleph2', { durationSec: 1.99, fps: 24 }], ['aleph2', { durationSec: 30.01, fps: 24 }],
    ['aleph2', { durationSec: 4, fps: 31 }], ['act_two', { durationSec: 2.99, fps: 24 }], ['act_two', { durationSec: 30.01, fps: 24 }], ['act_two', null],
  ])('rejects unreadable/out-of-range %s media and cleans staged input', async (modelId, geometry) => {
    const video = await stagedVideo();
    probeVideoGeometry.mockResolvedValue(geometry);
    vi.stubGlobal('fetch', vi.fn());
    const job = await runway.generateVideo({ apiKey: 'test-key', modelId, runwayVideoPath: video, sourceImagePath: framePath, uploadedTempPaths: [video] });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(video)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['registration', 'storage', 'malformed'])('does not submit generation after %s failure', async (failure) => {
    const video = await stagedVideo();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(url);
      if (url.endsWith('/v1/uploads')) return failure === 'registration' ? jsonResponse({}, false, 503) : jsonResponse(failure === 'malformed' ? {} : { uploadUrl: 'https://storage.example/upload', fields: {}, runwayUri: 'runway://upload-1' });
      return jsonResponse({}, false, 503);
    }));
    const job = await runway.generateVideo({ apiKey: 'test-key', modelId: 'aleph2', runwayVideoPath: video, uploadedTempPaths: [video] });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringMatching(/upload/i) });
    expect(calls).toEqual(failure === 'storage' ? ['https://api.dev.runwayml.com/v1/uploads', 'https://storage.example/upload'] : ['https://api.dev.runwayml.com/v1/uploads']);
    await expect(stat(video)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['registration', 'storage'])('cancels during %s without a paid task and cleans input', async (phase) => {
    const video = await stagedVideo();
    let uploading;
    const started = new Promise((resolve) => { uploading = resolve; });
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push(url);
      if (phase === 'storage' && url.endsWith('/v1/uploads')) return jsonResponse({ uploadUrl: 'https://storage.example/upload', fields: {}, runwayUri: 'runway://upload-1' });
      uploading();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }));
    const job = await runway.generateVideo({ apiKey: 'test-key', modelId: 'aleph2', runwayVideoPath: video, uploadedTempPaths: [video] });
    await started;
    runway.cancel(job.jobId);
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed' });
    expect(calls.some((url) => url.endsWith('/v1/video_to_video'))).toBe(false);
    await expect(stat(video)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replays local input through fresh ephemeral uploads after a failed remote task', async () => {
    const video = await stagedVideo();
    const bodies = [];
    let registrations = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (url.endsWith('/v1/uploads')) return jsonResponse({ uploadUrl: 'https://storage.example/upload', fields: {}, runwayUri: `runway://fresh-${++registrations}` });
      if (url === 'https://storage.example/upload') return jsonResponse({}, true, 204);
      if (url.endsWith('/v1/video_to_video')) { bodies.push(JSON.parse(options.body)); return jsonResponse({ id: 'task-1' }); }
      if (url === TASKS) return jsonResponse({ status: 'FAILED', failure: 'Unable to render' });
      throw new Error(`Unexpected fetch ${url}`);
    }));
    for (const durationSec of [2, 30]) {
      probeVideoGeometry.mockResolvedValue({ width: 1280, height: 720, fps: 30, durationSec });
      const job = await runway.generateVideo({ apiKey: 'test-key', modelId: 'aleph2', runwayVideoPath: video });
      expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'failed', error: expect.stringContaining('Unable to render') });
    }
    expect(bodies.map((body) => body.videoUri)).toEqual(['runway://fresh-1', 'runway://fresh-2']);
    expect(await stat(video)).toBeTruthy(); // externally owned inputs survive failure/replay
  });
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

  it('renders Gen-4.5 from text alone: posts /v1/text_to_video and records a text-mode take', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (url === 'https://api.dev.runwayml.com/v1/text_to_video') return jsonResponse({ id: 'task-1' });
      if (url === TASKS) return jsonResponse({ id: 'task-1', status: 'SUCCEEDED', output: ['https://cdn.example.com/out.mp4'] });
      if (url === 'https://cdn.example.com/out.mp4') return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('mp4')).buffer };
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const job = await runway.generateVideo({ apiKey: 'key_test', prompt: 'a fox at dawn', duration: 5, width: 720, height: 1280 });
    expect(await waitForTerminal(job.jobId)).toMatchObject({ type: 'completed' });
    expect(calls.find((c) => c.method === 'POST').body).toEqual({
      model: 'gen4.5', promptText: 'a fox at dawn', duration: 5, ratio: '720:1280',
    });
    const [entry] = await loadHistory();
    expect(entry).toMatchObject({ modelId: 'runway:gen4.5', mode: 'text', aspectRatio: '720:1280', estimatedCostUsd: 0.6 });
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
    ['no start frame on an image-only model', { modelId: 'gen4_turbo', prompt: 'a fox' }, /start frame/],
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
