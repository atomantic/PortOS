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
      castReferences: [{ path: '/example/sheet.png', label: 'Renee' }, { path: '/example/bikes.png', label: 'Bikes' }],
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
    renderOnGeminiWeb.mockRejectedValue(new Error('Gemini did not render this clip: you reached your limit'));
    const done = finished('job-2');
    await gemini.generateVideo({ jobId: 'job-2', prompt: 'x', sourceImagePath: staged, uploadedTempPath: staged });
    const outcome = await done;
    expect(outcome.type).toBe('failed');
    expect(outcome.error).toContain('you reached your limit');
    await expect(access(staged)).rejects.toThrow();
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
