import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeVideoGenLineHandler, isWatchdogSuccess, finalizeGeneratedVideo } from './generateVideoHelpers.js';

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

  it('STAGE:<s>:step:<cur>:<total>:<label> → fractional progress with label', () => {
    expect(handle('STAGE:render:step:6:10:Sampling latents')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.6, message: 'Sampling latents' });
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
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.25, message: 'warmup' });
  });

  it('bare STAGE: phase marker → status (no division-by-undefined progress)', () => {
    expect(handle('STAGE:load-pipeline')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'load-pipeline' });
    expect(sseFrames().some((f) => f.type === 'progress')).toBe(false);
  });

  it('DOWNLOAD: → prefixed status frame', () => {
    expect(handle('DOWNLOAD:model.safetensors 40%')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'Downloading model... model.safetensors 40%' });
  });

  it('tqdm bar → progress frame; queue event omits the noisy message', () => {
    expect(handle('60%|██████    | 6/10 [00:30<00:20, 1.2s/it]')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.6, message: '60%|██████    | 6/10 [00:30<00:20, 1.2s/it]' });
    // The mediaJobQueue dispatcher emit must NOT carry the raw bar as message.
    expect(eventsOfType('progress')).toContainEqual({ generationId: 'job-12345678', progress: 0.6 });
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
