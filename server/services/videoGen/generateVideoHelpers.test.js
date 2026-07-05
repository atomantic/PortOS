import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeVideoGenLineHandler, isWatchdogSuccess, finalizeGeneratedVideo, parseByteProgress, formatBytes, formatDownloadMessage } from './generateVideoHelpers.js';

describe('parseByteProgress', () => {
  it('parses single byte value (e.g., "2.5G")', () => {
    const result = parseByteProgress('model is 2.5G');
    expect(result.downloaded).toBeNull();
    expect(result.total).toBeCloseTo(2.5 * 1024 ** 3, -5);
  });

  it('parses downloaded/total format (e.g., "1.5G/2.0G")', () => {
    const result = parseByteProgress('1.5G/2.0G downloaded');
    expect(result.downloaded).toBeCloseTo(1.5 * 1024 ** 3, -5);
    expect(result.total).toBeCloseTo(2.0 * 1024 ** 3, -5);
  });

  it('parses MB values', () => {
    const result = parseByteProgress('500MB/1024MB');
    expect(result.downloaded).toBeCloseTo(500 * 1024 ** 2, -5);
    expect(result.total).toBeCloseTo(1024 * 1024 ** 2, -5);
  });

  it('parses M suffix (common in tqdm)', () => {
    const result = parseByteProgress('512M/1.0G');
    expect(result.downloaded).toBeCloseTo(512 * 1024 ** 2, -5);
    expect(result.total).toBeCloseTo(1.0 * 1024 ** 3, -5);
  });

  it('returns nulls when no byte values found', () => {
    const result = parseByteProgress('model.safetensors 40%');
    expect(result.downloaded).toBeNull();
    expect(result.total).toBeNull();
  });

  it('parses tqdm-style progress bars with bytes', () => {
    const result = parseByteProgress('50%|█████     | 1.00G/2.00G [00:22<00:22, 45.6MB/s]');
    expect(result.downloaded).toBeCloseTo(1.0 * 1024 ** 3, -5);
    expect(result.total).toBeCloseTo(2.0 * 1024 ** 3, -5);
  });

  it('parses GiB suffix', () => {
    const result = parseByteProgress('1.5GiB/3.0GiB');
    expect(result.downloaded).toBeCloseTo(1.5 * 1024 ** 3, -5);
    expect(result.total).toBeCloseTo(3.0 * 1024 ** 3, -5);
  });
});

describe('formatBytes (re-exported from fileUtils)', () => {
  it('formats bytes as B', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1024 ** 4 * 1.2)).toBe('1.2 TB');
  });

  it('handles null/undefined as 0 B', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
});

describe('formatDownloadMessage', () => {
  it('formats with both downloaded and total', () => {
    const byteInfo = { downloaded: 1.5 * 1024 ** 3, total: 2.5 * 1024 ** 3 };
    expect(formatDownloadMessage('raw text', byteInfo)).toBe('Downloading model · first run · 1.5 GB / 2.5 GB');
  });

  it('formats with only total', () => {
    const byteInfo = { downloaded: null, total: 2.5 * 1024 ** 3 };
    expect(formatDownloadMessage('raw text', byteInfo)).toBe('Downloading model · first run · 2.5 GB');
  });

  it('falls back to raw text when no byte info', () => {
    const byteInfo = { downloaded: null, total: null };
    expect(formatDownloadMessage('model.safetensors 40%', byteInfo)).toBe('Downloading model... model.safetensors 40%');
  });
});

// broadcastSse + videoGenEvents are the two output sinks the line handler
// writes to; capture both so we can assert the parse → frame mapping.
const sse = vi.hoisted(() => vi.fn());
const emitted = vi.hoisted(() => []);
vi.mock('../../lib/sseUtils.js', () => ({ broadcastSse: sse }));
vi.mock('./events.js', () => ({
  videoGenEvents: { emit: (type, payload) => { emitted.push({ type, payload }); } },
}));
// generateVideoHelpers also imports ffmpeg + fs at module top; stub ffmpeg so
// the import graph stays light (finalize isn't exercised in this file).
vi.mock('../../lib/ffmpeg.js', () => ({ generateThumbnail: vi.fn(), optimizeForStreaming: vi.fn() }));

const PYTHON_NOISE_RE = /^(Loading|Fetching|tokenizer|Some weights)/;

describe('makeVideoGenLineHandler', () => {
  let job;
  let handle;

  beforeEach(() => {
    sse.mockClear();
    emitted.length = 0;
    job = { id: 'j1', clients: [] };
    handle = makeVideoGenLineHandler({ job, jobId: 'job-12345678', pythonNoiseRe: PYTHON_NOISE_RE });
  });

  const sseFrames = () => sse.mock.calls.map((c) => c[1]);
  const eventsOfType = (t) => emitted.filter((e) => e.type === t).map((e) => e.payload);

  it('suppresses blank + python-noise lines without emitting', () => {
    expect(handle('')).toBe(true);
    expect(handle('   ')).toBe(true);
    expect(handle('Loading pipeline components...')).toBe(true);
    expect(sse).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('STATUS: → status SSE frame + status event, and an activity heartbeat', () => {
    expect(handle('STATUS:Generating I2V…')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'Generating I2V…' });
    expect(eventsOfType('status')).toContainEqual({ generationId: 'job-12345678', message: 'Generating I2V…' });
    expect(eventsOfType('activity')).toContainEqual({ generationId: 'job-12345678' });
  });

  it('STAGE:<s>:step:<cur>:<total>:<label> → fractional progress with label and phase', () => {
    expect(handle('STAGE:render:step:6:10:Sampling latents')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.6, message: 'Sampling latents', phase: 'render' });
    expect(eventsOfType('progress')).toContainEqual({
      generationId: 'job-12345678', progress: 0.6, step: 6, totalSteps: 10, message: 'Sampling latents',
    });
  });

  it('STAGE: heartbeat does NOT become bogus progress (regression: 20s → 2000%)', () => {
    expect(handle('STAGE:download-clip:heartbeat:20s')).toBe(true);
    // Heartbeat is a status line, never a progress frame.
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'download-clip: heartbeat 20s' });
    expect(sseFrames().some((f) => f.type === 'progress')).toBe(false);
  });

  it('normalizes uppercase STEP tag (generate_ltx2.py emits STEP:)', () => {
    expect(handle('STAGE:render:STEP:1:4:warmup')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.25, message: 'warmup', phase: 'render' });
  });

  it('bare STAGE: phase marker → status (no division-by-undefined progress)', () => {
    expect(handle('STAGE:load-pipeline')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'load-pipeline' });
    expect(sseFrames().some((f) => f.type === 'progress')).toBe(false);
  });

  it('DOWNLOAD: → prefixed status frame with phase', () => {
    expect(handle('DOWNLOAD:model.safetensors 40%')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'Downloading model... model.safetensors 40%', phase: 'download' });
  });

  it('DOWNLOAD: with byte values → formatted GB message', () => {
    expect(handle('DOWNLOAD:1.5G/2.0G model.safetensors')).toBe(true);
    const frame = sseFrames().find(f => f.type === 'status');
    expect(frame.message).toBe('Downloading model · first run · 1.5 GB / 2.0 GB');
    expect(frame.downloadedBytes).toBeCloseTo(1.5 * 1024 ** 3, -5);
    expect(frame.totalBytes).toBeCloseTo(2.0 * 1024 ** 3, -5);
  });

  it('tqdm bar → progress frame with phase; queue event omits the noisy message', () => {
    expect(handle('60%|██████    | 6/10 [00:30<00:20, 1.2s/it]')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.6, message: '60%|██████    | 6/10 [00:30<00:20, 1.2s/it]', phase: 'starting' });
    // The mediaJobQueue dispatcher emit must NOT carry the raw bar as message.
    expect(eventsOfType('progress')).toContainEqual({ generationId: 'job-12345678', progress: 0.6 });
  });

  it('tqdm bar with byte sizes during download → formatted GB message', () => {
    // Enter download phase first
    handle('DOWNLOAD:1/5:model.safetensors');
    sse.mockClear();
    // Now a tqdm bar with byte counts
    expect(handle('50%|█████     | 1.00G/2.00G [00:22<00:22, 45.6MB/s]')).toBe(true);
    const frame = sseFrames().find(f => f.type === 'progress');
    expect(frame.message).toBe('Downloading model · first run · 1.0 GB / 2.0 GB');
    expect(frame.phase).toBe('download');
    expect(frame.downloadedBytes).toBeCloseTo(1.0 * 1024 ** 3, -5);
    expect(frame.totalBytes).toBeCloseTo(2.0 * 1024 ** 3, -5);
  });

  it('returns false for an unrecognized line (caller raw-logs it)', () => {
    expect(handle('🐍 some unexpected diagnostic')).toBe(false);
  });

  it('RUNTIME:<json> → stamps job.runtime and suppresses raw logging', () => {
    const fp = { runtime: 'ltx2', versions: { mlx: '0.22.0' }, chip: 'Apple M5 Max', os: 'macOS-15.4-arm64' };
    expect(handle(`RUNTIME:${JSON.stringify(fp)}`)).toBe(true);
    expect(job.runtime).toEqual(fp);
    // It's a one-shot metadata line, not progress/status — no SSE frame.
    expect(sse).not.toHaveBeenCalled();
  });

  it('malformed RUNTIME: line falls through to raw-logging and leaves job.runtime unset', () => {
    expect(handle('RUNTIME:{not json')).toBe(false);
    expect(job.runtime).toBeUndefined();
  });
});

describe('finalizeGeneratedVideo runtime persistence', () => {
  const baseCtx = (job) => ({
    job,
    jobId: 'job-abcdef12',
    outputPath: '/tmp/out.mp4',
    filename: 'out.mp4',
    meta: { id: 'job-abcdef12', prompt: 'hi', modelId: 'ltx2_unified' },
    actualSeed: 7,
  });

  it('persists job.runtime onto the saved history record', async () => {
    const fp = { runtime: 'ltx2', versions: { mlx: '0.22.0' }, chip: 'Apple M5 Max' };
    const job = { id: 'job-abcdef12', clients: [], runtime: fp };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].runtime).toEqual(fp);
  });

  it('omits runtime when the child never emitted a fingerprint (absent sentinel)', async () => {
    const job = { id: 'job-abcdef12', clients: [] };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    expect(saved).toHaveLength(1);
    expect('runtime' in saved[0]).toBe(false);
  });
});

describe('isWatchdogSuccess', () => {
  // The non-fs short-circuits are pure; the on-disk branch is gated on a real
  // existsSync + non-empty statSync, exercised against actual temp files.
  it('false unless the watchdog actually fired', () => {
    expect(isWatchdogSuccess({ completionWatchdogFired: false, signal: 'SIGKILL', outputPath: '/tmp/x.mp4' })).toBe(false);
  });

  it('false unless the kill signal was SIGKILL', () => {
    expect(isWatchdogSuccess({ completionWatchdogFired: true, signal: 'SIGTERM', outputPath: '/tmp/x.mp4' })).toBe(false);
  });

  it('false when the output file is absent (no real render landed)', () => {
    expect(isWatchdogSuccess({ completionWatchdogFired: true, signal: 'SIGKILL', outputPath: `/tmp/definitely-missing-${process.pid}.mp4` })).toBe(false);
  });

  it('true when the watchdog fired on SIGKILL and a non-empty output exists', () => {
    const p = join(tmpdir(), `wd-success-${process.pid}.mp4`);
    writeFileSync(p, 'x');
    try {
      expect(isWatchdogSuccess({ completionWatchdogFired: true, signal: 'SIGKILL', outputPath: p })).toBe(true);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('false when the output file exists but is empty (marker without real render)', () => {
    const p = join(tmpdir(), `wd-empty-${process.pid}.mp4`);
    writeFileSync(p, '');
    try {
      expect(isWatchdogSuccess({ completionWatchdogFired: true, signal: 'SIGKILL', outputPath: p })).toBe(false);
    } finally {
      rmSync(p, { force: true });
    }
  });
});
