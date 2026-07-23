import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

// Spawn mock — capture calls, drive stdout/stderr, capture the stdin-delivered
// prompt (grok reads it via --prompt-file /dev/stdin).
const spawnCalls = [];
const makeFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { written: '', on: vi.fn(), write: vi.fn(function (s) { child.stdin.written += s; }), end: vi.fn() };
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
};
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((bin, args) => {
      const child = makeFakeChild();
      spawnCalls.push({ bin, args, child });
      return child;
    }),
  };
});

// Test-root PATHS so the harvest move + history file land somewhere we can
// read back (mirrors imageGen/grok.test.js).
const TEST_ROOT = join(tmpdir(), `portos-grok-video-test-${process.pid}-${Date.now()}`);
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

// finalizeGeneratedVideo shells out to ffmpeg (faststart + thumbnail) — stub
// the ffmpeg layer so the shared finalizer's history/SSE/event flow still
// runs for real against fake MP4 bytes.
vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return {
    ...actual,
    optimizeForStreaming: vi.fn(async () => {}),
    generateThumbnail: vi.fn(async (_p, jobId) => `${jobId}.jpg`),
  };
});

const grok = await import('./grok.js');
const { videoGenEvents } = await import('./events.js');
const { loadHistory } = await import('./history.js');

const flush = () => new Promise((r) => setImmediate(r));
const scratchDirFor = (jobId) => join(tmpdir(), `portos-grok-video-${jobId}`);
const stagingPathFor = (jobId) => join(scratchDirFor(jobId), 'output.mp4');
const promptOf = (i = 0) => spawnCalls[i].child.stdin.written;
const closeChild = async (i = 0, code = 1) => {
  spawnCalls[i].child.exitCode = code;
  spawnCalls[i].child.emit('close', code, null);
  await flush();
};
// Minimal valid MP4 header: size box + `ftyp` at offset 4.
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
  Buffer.from('isommp42-fake-payload'),
]);

beforeEach(async () => {
  spawnCalls.length = 0;
  videoGenEvents.removeAllListeners();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_DATA_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('videoGen/grok — generateVideo', () => {
  it('spawns grok headlessly and prompts the image-first flow for text mode', async () => {
    const job = await grok.generateVideo({ prompt: 'a fox running' });
    expect(job.mode).toBe('grok');
    expect(job.filename).toMatch(/^[0-9a-f-]{36}\.mp4$/);
    expect(job.status).toBe('running');
    const { bin, args } = spawnCalls[0];
    expect(bin).toBe('grok');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    const prompt = promptOf();
    // Image-first: base image via image_gen, then image_to_video.
    expect(prompt).toContain('image_gen');
    expect(prompt).toContain('image_to_video');
    expect(prompt).toContain('a fox running');
    expect(prompt).toContain(stagingPathFor(job.jobId));
    // Default duration is the shortest supported clip.
    expect(prompt).toContain('6 seconds');
    await closeChild();
  });

  it('skips the base-image step when a source image is supplied', async () => {
    await grok.generateVideo({ prompt: 'gentle pan', sourceImagePath: '/abs/frame.png', duration: 10 });
    const prompt = promptOf();
    expect(prompt).not.toContain('image_gen');
    expect(prompt).toContain('image_to_video');
    expect(prompt).toContain('/abs/frame.png');
    expect(prompt).toContain('10 seconds');
    await closeChild();
  });

  it('falls back to 6s for an unsupported duration', async () => {
    await grok.generateVideo({ prompt: 'a fox', duration: 42 });
    expect(promptOf()).toContain('6 seconds');
    await closeChild();
  });

  it('derives the base-image aspect ratio from width/height', async () => {
    await grok.generateVideo({ prompt: 'a fox', width: 1920, height: 1080 });
    expect(promptOf()).toContain('aspect_ratio "16:9"');
    await closeChild();
  });

  it('rejects an empty prompt', async () => {
    await expect(grok.generateVideo({ prompt: '  ' })).rejects.toThrow(/Prompt is required/);
  });

  it('emits started on videoGenEvents with the job meta', async () => {
    const started = vi.fn();
    videoGenEvents.on('started', started);
    const job = await grok.generateVideo({ prompt: 'a fox' });
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ generationId: job.jobId, modelId: 'grok' }));
    await closeChild();
  });

  it('emits activity on stdout so the queue idle watchdog resets', async () => {
    const activity = vi.fn();
    videoGenEvents.on('activity', activity);
    const job = await grok.generateVideo({ prompt: 'a fox' });
    spawnCalls[0].child.stdout.emit('data', Buffer.from('rendering…\n'));
    expect(activity).toHaveBeenCalledWith({ generationId: job.jobId });
    await closeChild();
  });
});

describe('videoGen/grok — harvest and finalize', () => {
  it('moves a staged MP4 into PATHS.videos, writes history, and emits completed', async () => {
    const completed = vi.fn();
    videoGenEvents.on('completed', completed);

    const job = await grok.generateVideo({ prompt: 'a fox running' });
    await mkdir(scratchDirFor(job.jobId), { recursive: true });
    await writeFile(stagingPathFor(job.jobId), MP4_BYTES);
    await closeChild(0, 0);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && completed.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toEqual(expect.objectContaining({
      generationId: job.jobId,
      path: `/data/videos/${job.filename}`,
      thumbnail: `${job.jobId}.jpg`,
    }));
    const written = await readFile(join(FAKE_VIDEOS_DIR, job.filename));
    expect(Buffer.compare(written, MP4_BYTES)).toBe(0);
    // Scratch dir cleaned up; history entry recorded with the grok engine tag.
    expect(existsSync(scratchDirFor(job.jobId))).toBe(false);
    const history = await loadHistory();
    expect(history[0]).toEqual(expect.objectContaining({ id: job.jobId, modelId: 'grok', mode: 'text', duration: 6 }));
  });

  it('rejects a staged file that is not MP4 (signature sniff)', async () => {
    const failed = vi.fn();
    videoGenEvents.on('failed', failed);

    const job = await grok.generateVideo({ prompt: 'a fox' });
    await mkdir(scratchDirFor(job.jobId), { recursive: true });
    await writeFile(stagingPathFor(job.jobId), 'Error: render failed');
    await closeChild(0, 0);

    const deadline = Date.now() + 13000;
    while (Date.now() < deadline && failed.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].error).toMatch(/non-MP4 file/);
    expect(existsSync(join(FAKE_VIDEOS_DIR, job.filename))).toBe(false);
    // Scratch-dir removal is fire-and-forget alongside the 'failed' event
    // (not awaited before it), so give it a moment to land on disk rather
    // than racing it.
    const scratchDir = scratchDirFor(job.jobId);
    const scratchDeadline = Date.now() + 3000;
    while (Date.now() < scratchDeadline && existsSync(scratchDir)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(scratchDir)).toBe(false);
  }, 16000);

  it('fails with the narration tail when grok exits 0 with no file', async () => {
    const failed = vi.fn();
    videoGenEvents.on('failed', failed);

    await grok.generateVideo({ prompt: 'a fox' });
    spawnCalls[0].child.stdout.emit('data', Buffer.from('I cannot animate that.\n'));
    await closeChild(0, 0);

    const deadline = Date.now() + 13000;
    while (Date.now() < deadline && failed.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].error).toMatch(/I cannot animate that/);
    // Video-flavored wording, not the image provider's.
    expect(failed.mock.calls[0][0].error).toMatch(/video/i);
  }, 16000);

  it('fails with the stderr tail on non-zero exit', async () => {
    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    await grok.generateVideo({ prompt: 'a fox' });
    spawnCalls[0].child.stderr.emit('data', Buffer.from('boom: session expired\n'));
    await closeChild(0, 1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].error).toMatch(/Exit code 1/);
    expect(failed.mock.calls[0][0].error).toMatch(/session expired/);
  });
});

describe('videoGen/grok — cancel', () => {
  it('cancel() requires a jobId; cancel(jobId) SIGTERMs; cancelAll() sweeps', async () => {
    expect(() => grok.cancel()).toThrow(/requires a jobId/);
    const a = await grok.generateVideo({ prompt: 'one' });
    const b = await grok.generateVideo({ prompt: 'two' });
    expect(grok.cancel(a.jobId)).toBe(true);
    expect(spawnCalls[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnCalls[1].child.kill).not.toHaveBeenCalled();
    expect(grok.cancelAll()).toBe(true);
    expect(spawnCalls[1].child.kill).toHaveBeenCalledWith('SIGTERM');
    await closeChild(0);
    await closeChild(1);
    expect(grok.cancel(b.jobId)).toBe(false);
    expect(grok.cancelAll()).toBe(false);
  });
});
