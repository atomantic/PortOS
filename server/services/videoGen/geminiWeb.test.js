import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, writeFile, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = join(tmpdir(), `portos-gemini-video-test-${process.pid}-${Date.now()}`);

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.videos = join(TEST_ROOT, 'videos');
  actual.PATHS.data = join(TEST_ROOT, 'data');
  actual.PATHS.videoThumbnails = join(TEST_ROOT, 'thumbnails');
  actual.PATHS.uploads = join(TEST_ROOT, 'uploads');
  return { ...actual, ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })) };
});

vi.mock('../../lib/ffmpeg.js', async () => ({
  ...(await vi.importActual('../../lib/ffmpeg.js')),
  optimizeForStreaming: vi.fn(async () => {}),
  generateThumbnail: vi.fn(async (_path, jobId) => `${jobId}.jpg`),
  probeVideoGeometry: vi.fn(async () => ({ width: 1280, height: 720, fps: 24, durationSec: 10, numFrames: 240 })),
}));

// Short waits so the busy-retry tests run in milliseconds; the classifier and loop are the real ones.
vi.mock('../../lib/providerTransientRetry.js', async () => {
  const actual = await vi.importActual('../../lib/providerTransientRetry.js');
  const delaysMs = [20, 20];
  return {
    ...actual,
    TRANSIENT_RETRY_DELAYS_MS: delaysMs,
    runWithTransientRetry: (attempt, options) => actual.runWithTransientRetry(attempt, { ...options, delaysMs, tickMs: 10 }),
  };
});

const BUSY = "Gemini did not render this clip: I'm sorry, I'm experiencing unusually high traffic right now generating videos and am at full capacity. Please try again later.";
const refused = (message) => Object.assign(new Error(message), { code: 'GEMINI_WEB_REFUSED' });

const renderOnGeminiWeb = vi.fn();
vi.mock('./geminiWebDriver.js', () => ({ renderOnGeminiWeb }));

const gemini = await import('./geminiWeb.js');
const { videoGenEvents } = await import('./events.js');
const { loadHistory } = await import('./history.js');

const finished = (jobId) => new Promise((resolve) => {
  for (const type of ['completed', 'failed']) {
    videoGenEvents.on(type, (event) => { if (event.generationId === jobId) resolve({ type, ...event }); });
  }
});

let staged;
beforeEach(async () => {
  videoGenEvents.removeAllListeners();
  renderOnGeminiWeb.mockReset();
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(join(TEST_ROOT, 'data'), { recursive: true });
  await mkdir(join(TEST_ROOT, 'uploads'), { recursive: true });
  staged = join(TEST_ROOT, 'uploads', 'frame.png');
  await writeFile(staged, 'frame');
});
afterAll(() => rm(TEST_ROOT, { recursive: true, force: true }));

describe('Gemini web video lane', () => {
  it('publishes the clip Gemini delivered and records the chat it came from', async () => {
    const progress = [];
    videoGenEvents.on('progress', (event) => progress.push(event.progress));
    renderOnGeminiWeb.mockImplementation(async ({ outputPath, onPhase }) => {
      for (const phase of ['open', 'attach', 'send', 'wait', 'wait', 'fetch']) onPhase(phase);
      await writeFile(outputPath, 'clip');
      return { chatUrl: 'https://gemini.google.com/app/example' };
    });
    const done = finished('job-1');
    await gemini.generateVideo({
      jobId: 'job-1', prompt: 'she rides past', frameAspect: '9:16', sourceImagePath: staged, uploadedTempPath: staged,
      castReferences: [{ path: '/example/sheet.png', label: 'Ada' }, { path: '/example/bikes.png', label: 'Bikes' }],
    });
    expect((await done).type).toBe('completed');

    // The start frame goes first, and the prompt and aspect reach the composer as chosen.
    expect(renderOnGeminiWeb).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'she rides past', aspectChoice: 'Portrait (9:16)', files: [staged, '/example/sheet.png', '/example/bikes.png'],
    }));
    const record = (await loadHistory()).find((item) => item.id === 'job-1');
    expect(record).toMatchObject({ modelId: 'gemini:gemini-omni-1.2-flash', sentPrompt: 'she rides past',
      geminiChatUrl: 'https://gemini.google.com/app/example', durationSec: 10 });
    // The queue's meter only moves forward, and the staged copy is gone.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBeGreaterThan(0.9);
    await expect(access(staged)).rejects.toThrow();
  });

  it('fails the job with what the driver reported and removes the staged input', async () => {
    renderOnGeminiWeb.mockRejectedValue(refused('Gemini did not render this clip: you reached your limit'));
    const done = finished('job-2');
    await gemini.generateVideo({ jobId: 'job-2', prompt: 'x', sourceImagePath: staged, uploadedTempPath: staged });
    const outcome = await done;
    expect(outcome.type).toBe('failed');
    expect(outcome.error).toContain('you reached your limit');
    // A usage limit is not a busy answer: no resend.
    expect(renderOnGeminiWeb).toHaveBeenCalledTimes(1);
    await expect(access(staged)).rejects.toThrow();
  });

  it('resends after Gemini says it is at capacity and shows the wait on the job', async () => {
    const retries = [];
    videoGenEvents.on('progress', (event) => { if (event.retry) retries.push(event.retry); });
    renderOnGeminiWeb
      .mockRejectedValueOnce(refused(BUSY))
      .mockImplementationOnce(async ({ outputPath }) => {
        await writeFile(outputPath, 'clip');
        return { chatUrl: 'https://gemini.google.com/app/example' };
      });
    const done = finished('job-4');
    await gemini.generateVideo({ jobId: 'job-4', prompt: 'x' });
    expect((await done).type).toBe('completed');
    expect(renderOnGeminiWeb).toHaveBeenCalledTimes(2);
    expect(retries[0]).toMatchObject({ attempt: 1, of: 2, reason: 'busy' });
  });

  it('fails with Gemini\'s words and the Retry step once it stays busy through every retry', async () => {
    renderOnGeminiWeb.mockRejectedValue(refused(BUSY));
    const done = finished('job-5');
    await gemini.generateVideo({ jobId: 'job-5', prompt: 'x' });
    const outcome = await done;
    expect(outcome.type).toBe('failed');
    expect(renderOnGeminiWeb).toHaveBeenCalledTimes(3);
    expect(outcome.error).toContain('at full capacity');
    expect(outcome.error).toContain('still busy after 2 retries');
    expect(outcome.error).toContain('tap Retry');
  });

  it('never resends a render that timed out, since it may still finish and charge', async () => {
    renderOnGeminiWeb.mockRejectedValue(Object.assign(new Error('Gemini did not deliver a video in time. Please try again later.'), { code: 'GEMINI_WEB_TIMEOUT' }));
    const done = finished('job-6');
    await gemini.generateVideo({ jobId: 'job-6', prompt: 'x' });
    expect((await done).type).toBe('failed');
    expect(renderOnGeminiWeb).toHaveBeenCalledTimes(1);
  });

  it('cancels the wait through the driver signal', async () => {
    renderOnGeminiWeb.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Canceled')));
    }));
    const done = finished('job-3');
    await gemini.generateVideo({ jobId: 'job-3', prompt: 'x' });
    await vi.waitFor(() => expect(renderOnGeminiWeb).toHaveBeenCalled());
    expect(gemini.cancel('job-3')).toBe(true);
    expect((await done).type).toBe('failed');
  });
});
