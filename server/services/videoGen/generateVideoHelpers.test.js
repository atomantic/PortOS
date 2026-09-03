import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { makeVideoGenLineHandler, isWatchdogSuccess, finalizeGeneratedVideo, parseByteProgress, formatBytes, formatDownloadMessage, describeSignalDeath, formatRuntimeFingerprint, describeRenderConditioning, isPromptEncodingMetalWatchdog, planPromptEncodingRetry, DEFAULT_GEMMA_MAX_LENGTH, RETRY_GEMMA_MAX_LENGTH, bufferChildExit, RENDER_INPUTS_VERSION } from './generateVideoHelpers.js';

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

  // Prompt-encode phase (#4589) — the signal that decides whether a later
  // SIGABRT is worth one relaunch at a smaller Gemma budget.
  it('tracks the Gemma prompt-encode phase as three distinct states', () => {
    // Never reported: every runtime other than the LTX-2 MLX helper stays here,
    // and an unstamped field must not read as "encoding right now".
    expect(job.promptEncodePhase).toBeUndefined();
    handle('STAGE:load-pipeline');
    expect(job.promptEncodePhase).toBeUndefined();

    handle('STAGE:encode-prompt');
    expect(job.promptEncodePhase).toBe('active');

    // The end marker is a PREFIX EXTENSION of the begin marker, so a startsWith
    // comparison would read the end of the encode as another beginning and leave
    // the phase open forever.
    handle('STAGE:encode-prompt-done');
    expect(job.promptEncodePhase).toBe('done');
  });

  it('still surfaces the prompt-encode markers to the client as status frames', () => {
    handle('STAGE:encode-prompt');
    expect(eventsOfType('status')).toContainEqual({ generationId: 'job-12345678', message: 'encode-prompt', phase: 'encode-prompt' });
  });

  it('repeats the job ETA on every progress frame, and omits it when absent (#3801)', () => {
    // No estimate on the job → the key must be absent, never etaMs: 0.
    handle('STAGE:inference:step:5:30:Rendering');
    handle('60%|██████    | 6/10');
    expect(eventsOfType('progress').every((p) => !('etaMs' in p))).toBe(true);

    emitted.length = 0;
    job.etaMs = 1_800_000;
    handle('STAGE:inference:step:6:30:Rendering');
    handle('70%|███████   | 7/10');
    const progress = eventsOfType('progress');
    expect(progress).toHaveLength(2);
    expect(progress.every((p) => p.etaMs === 1_800_000)).toBe(true);
  });

  it('suppresses blank + python-noise lines without emitting', () => {
    expect(handle('')).toBe(true);
    expect(handle('   ')).toBe(true);
    expect(handle('Loading pipeline components...')).toBe(true);
    expect(sse).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('STATUS: → status SSE frame + status event, and an activity heartbeat', () => {
    expect(handle('STATUS:Generating I2V…')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'Generating I2V…', phase: 'starting' });
    expect(eventsOfType('status')).toContainEqual({ generationId: 'job-12345678', message: 'Generating I2V…', phase: 'starting' });
    expect(eventsOfType('activity')).toContainEqual({ generationId: 'job-12345678' });
  });

  it('STAGE:<s>:step:<cur>:<total>:<label> → fractional progress with label and phase', () => {
    expect(handle('STAGE:render:step:6:10:Sampling latents')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.6, message: 'Sampling latents', phase: 'render' });
    expect(eventsOfType('progress')).toContainEqual({
      generationId: 'job-12345678', progress: 0.6, step: 6, totalSteps: 10, message: 'Sampling latents', phase: 'render',
    });
  });

  it('STAGE: heartbeat does NOT become bogus progress (regression: 20s → 2000%)', () => {
    expect(handle('STAGE:download-clip:heartbeat:20s')).toBe(true);
    // Heartbeat is a status line, never a progress frame.
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'download-clip: heartbeat 20s', phase: 'download-clip' });
    expect(sseFrames().some((f) => f.type === 'progress')).toBe(false);
  });

  it('normalizes uppercase STEP tag (generate_ltx2.py emits STEP:)', () => {
    expect(handle('STAGE:render:STEP:1:4:warmup')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'progress', progress: 0.25, message: 'warmup', phase: 'render' });
  });

  it('bare STAGE: phase marker → status (no division-by-undefined progress)', () => {
    expect(handle('STAGE:load-pipeline')).toBe(true);
    expect(sseFrames()).toContainEqual({ type: 'status', message: 'load-pipeline', phase: 'load-pipeline' });
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
    expect(eventsOfType('progress')).toContainEqual({ generationId: 'job-12345678', progress: 0.6, phase: 'starting' });
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

  // #4875 — what the runner ACTUALLY applied of a requested speed profile.
  it('SPEEDPROFILE:<json> → stamps job.speedProfile and suppresses raw logging', () => {
    const applied = { id: 'fast', teacache: true, adapter: 'ltx-2.5-22b-distilled-lora-450.safetensors', degraded: [] };
    expect(handle('SPEEDPROFILE:' + JSON.stringify(applied))).toBe(true);
    expect(job.speedProfile).toEqual(applied);
    // A one-shot metadata line, not progress/status — no SSE frame.
    expect(sse).not.toHaveBeenCalled();
  });

  it('keeps the degraded lever list a render could not apply', () => {
    handle('SPEEDPROFILE:{"id":"fast","teacache":false,"degraded":["teacache"]}');
    expect(job.speedProfile.degraded).toEqual(['teacache']);
    expect(job.speedProfile.teacache).toBe(false);
  });

  it('malformed SPEEDPROFILE: line falls through to raw-logging and leaves job.speedProfile unset', () => {
    expect(handle('SPEEDPROFILE:{not json')).toBe(false);
    expect(job.speedProfile).toBeUndefined();
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

  it('carries the durable re-render inputs through to the saved record (#3696)', async () => {
    const job = { id: 'job-abcdef12', clients: [] };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      meta: {
        ...baseCtx(job).meta,
        seed: 424242,
        mode: 'text',
        renderInputsVersion: RENDER_INPUTS_VERSION,
        conditioning: [],
      },
      actualSeed: 424242,
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    expect(saved[0].seed).toBe(424242);
    expect(saved[0].renderInputsVersion).toBe(RENDER_INPUTS_VERSION);
    expect(saved[0].conditioning).toEqual([]);
    // No staging/temp path may ride along on a user-facing history record.
    expect(JSON.stringify(saved[0])).not.toMatch(/\/tmp\/|uploads/);
  });

  it('stamps wall-clock render timing so future renders are estimable (#3801)', async () => {
    const job = { id: 'job-abcdef12', clients: [], renderStartedAtMs: Date.now() - 5000 };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    expect(saved[0].renderMs).toBeGreaterThanOrEqual(5000);
    expect(Date.parse(saved[0].renderStartedAt)).toBe(job.renderStartedAtMs);
    expect(Date.parse(saved[0].renderCompletedAt)).toBeGreaterThanOrEqual(job.renderStartedAtMs);
  });

  it('persists what the runner actually applied of a speed profile (#4875)', async () => {
    const applied = { id: 'fast', teacache: false, adapter: 'ltx-2.3-22b-distilled-lora-384.safetensors', degraded: ['teacache', 'adapter'] };
    const job = { id: 'job-abcdef12', clients: [], speedProfile: applied };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      meta: { ...baseCtx(job).meta, speedProfileId: 'fast' },
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    // The REQUEST and the OUTCOME are separate fields on purpose: a degraded
    // render must not read back as a full speed claim.
    expect(saved[0].speedProfileId).toBe('fast');
    expect(saved[0].speedProfileApplied).toEqual(applied);
  });

  it('omits speedProfileApplied when the runner reported none (absent sentinel)', async () => {
    const job = { id: 'job-abcdef12', clients: [] };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    expect('speedProfileApplied' in saved[0]).toBe(false);
  });

  it('omits render timing entirely when the spawn instant was never observed (#3801)', async () => {
    const job = { id: 'job-abcdef12', clients: [] };
    let saved = null;
    await finalizeGeneratedVideo({
      ...baseCtx(job),
      mutateHistory: async (fn) => { saved = await fn([]); return saved; },
    });
    // Absent, NOT renderMs: 0 — a zero-duration sample would poison the
    // estimator's cost model.
    expect('renderMs' in saved[0]).toBe(false);
    expect('renderStartedAt' in saved[0]).toBe(false);
  });
});

describe('describeRenderConditioning (#3696)', () => {
  it('reports an empty inventory for a plain text-to-video render', () => {
    expect(describeRenderConditioning()).toEqual([]);
    expect(describeRenderConditioning({})).toEqual([]);
    expect(describeRenderConditioning({ sourceImagePath: null, keyframes: [], icReferencePaths: [] })).toEqual([]);
  });

  it('names each conditioning input that steered the render', () => {
    expect(describeRenderConditioning({ sourceImagePath: '/tmp/a.png' })).toEqual(['image']);
    expect(describeRenderConditioning({ lastImagePath: '/tmp/z.png' })).toEqual(['lastImage']);
    expect(describeRenderConditioning({ keyframes: [{ path: '/tmp/1.png' }] })).toEqual(['keyframes']);
    expect(describeRenderConditioning({ extendFromVideoPath: '/data/videos/x.mp4' })).toEqual(['extend']);
    expect(describeRenderConditioning({ audioFilePath: '/tmp/song.wav' })).toEqual(['audio']);
    expect(describeRenderConditioning({ icReferencePaths: ['/tmp/ref.mp4'] })).toEqual(['icReference']);
  });

  it('returns a stable sorted list for a multi-input render', () => {
    expect(describeRenderConditioning({
      sourceImagePath: '/tmp/a.png',
      lastImagePath: '/tmp/z.png',
      audioFilePath: '/tmp/song.wav',
    })).toEqual(['audio', 'image', 'lastImage']);
  });

  it('records kinds only — never the staging paths it was given', () => {
    const kinds = describeRenderConditioning({ sourceImagePath: '/tmp/upload-9f3.png' });
    expect(kinds.join(',')).not.toMatch(/tmp|9f3/);
  });
});

describe('formatRuntimeFingerprint', () => {
  it('renders runtime | versions | chip | os', () => {
    expect(formatRuntimeFingerprint({
      runtime: 'ltx2',
      versions: { mlx: '0.22.0', mlx_metal: '0.22.0' },
      chip: 'Apple M4 Max',
      os: 'macOS-15.4-arm64',
    })).toBe('ltx2 | mlx 0.22.0, mlx_metal 0.22.0 | Apple M4 Max | macOS-15.4-arm64');
  });

  it('omits missing segments rather than leaving empty separators', () => {
    expect(formatRuntimeFingerprint({ chip: 'Apple M4 Max', os: 'macOS-15.4-arm64' }))
      .toBe('Apple M4 Max | macOS-15.4-arm64');
  });

  it('returns empty string for a missing/non-object payload', () => {
    expect(formatRuntimeFingerprint(null)).toBe('');
    expect(formatRuntimeFingerprint(undefined)).toBe('');
    expect(formatRuntimeFingerprint('ltx2')).toBe('');
    expect(formatRuntimeFingerprint({})).toBe('');
  });
});

describe('describeSignalDeath (#3101 signal → actionable cause)', () => {
  it('returns null when the child did not die on a signal', () => {
    expect(describeSignalDeath(null)).toBeNull();
    expect(describeSignalDeath(undefined)).toBeNull();
    expect(describeSignalDeath('')).toBeNull();
  });

  it('names the macOS Metal command-buffer watchdog for SIGABRT and points at resolution/frame count', () => {
    const reason = describeSignalDeath('SIGABRT');
    expect(reason).toMatch(/SIGABRT/);
    expect(reason).toMatch(/Metal command-buffer watchdog/i);
    expect(reason).toMatch(/kIOGPUCommandBufferCallbackErrorImpactingInteractivity/);
    expect(reason).toMatch(/resolution/i);
    expect(reason).toMatch(/frame count/i);
    // Must NOT send the user hunting a model/PortOS bug (the upstream mistake).
    expect(reason).toMatch(/not a bug in the model or PortOS/i);
    expect(reason).not.toMatch(/assertion/i);
  });

  it('names a native MLX/Metal crash for SIGBUS and SIGSEGV', () => {
    for (const sig of ['SIGBUS', 'SIGSEGV']) {
      const reason = describeSignalDeath(sig);
      expect(reason).toMatch(new RegExp(sig));
      expect(reason).toMatch(/MLX\/Metal/);
      expect(reason).toMatch(/native fault/i);
    }
  });

  it('keeps the existing OOM wording for SIGKILL', () => {
    expect(describeSignalDeath('SIGKILL')).toBe('Process killed (likely out of memory — try a smaller model or resolution)');
  });

  it('falls back to the verbatim signal name for an unmapped signal', () => {
    expect(describeSignalDeath('SIGTERM')).toBe('Killed by signal SIGTERM');
    expect(describeSignalDeath('SIGPIPE')).toBe('Killed by signal SIGPIPE');
  });

  it('appends the runtime fingerprint when one is known', () => {
    const reason = describeSignalDeath('SIGABRT', {
      fingerprint: { runtime: 'ltx2', versions: { mlx: '0.22.0', mlx_metal: '0.22.0' }, chip: 'Apple M4 Max', os: 'macOS-15.4-arm64' },
    });
    expect(reason).toMatch(/\[runtime: ltx2 \| mlx 0\.22\.0, mlx_metal 0\.22\.0 \| Apple M4 Max \| macOS-15\.4-arm64\]$/);
  });

  it('omits the fingerprint suffix entirely when nothing is known (no empty brackets)', () => {
    expect(describeSignalDeath('SIGSEGV', { fingerprint: null })).not.toMatch(/runtime:/);
    expect(describeSignalDeath('SIGSEGV', { fingerprint: {} })).not.toMatch(/runtime:/);
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

// ── Gemma prompt-encode watchdog retry (#4589) ──────────────────────────────
// A real Metal abort cannot be reproduced in a unit test, so the coverage here
// is over the two decisions PortOS actually makes from the wreckage: which
// abort text counts as a prompt-encode watchdog kill, and whether the render
// may be relaunched.
describe('isPromptEncodingMetalWatchdog', () => {
  // The abort banner MLX prints on the way down, in the two shapes the watchdog
  // uses. The impacting-interactivity one is what newer Apple silicon / macOS
  // report where older combinations reported a timeout — matching only the
  // timeout wording is exactly the portability bug this classifier fixes.
  const TIMEOUT_ABORT = 'libc++abi: terminating due to uncaught exception of type std::runtime_error: [METAL] Command buffer execution failed: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)';
  const INTERACTIVITY_ABORT = 'libc++abi: terminating due to uncaught exception of type std::runtime_error: [METAL] Command buffer execution failed: (00000004:kIOGPUCommandBufferCallbackErrorImpactingInteractivity)';
  const OOM_ABORT = '[METAL] Command buffer execution failed: (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)';
  const VICTIM_ABORT = '[METAL] Command buffer execution failed: (00000006:kIOGPUCommandBufferCallbackErrorInnocentVictim)';

  it.each([
    ['the classic timeout signature', TIMEOUT_ABORT],
    ['the impacting-interactivity signature newer macOS reports instead', INTERACTIVITY_ABORT],
  ])('recognizes %s', (_label, stderr) => {
    expect(isPromptEncodingMetalWatchdog({ signal: 'SIGABRT', stderr, promptEncodePhase: 'active' })).toBe(true);
  });

  // Neither is a "this buffer ran too long" kill, so neither is fixed by a
  // shorter prompt: OOM means the machine is out of headroom, and an innocent
  // victim was killed for some OTHER process wedging the GPU.
  it.each([
    ['an out-of-memory abort', OOM_ABORT],
    ['an innocent-victim abort', VICTIM_ABORT],
  ])('excludes %s', (_label, stderr) => {
    expect(isPromptEncodingMetalWatchdog({ signal: 'SIGABRT', stderr, promptEncodePhase: 'active' })).toBe(false);
  });

  // A mixed abort is the case where the timeout is a downstream symptom of the
  // real cause, so the veto wins rather than the match.
  it('excludes an abort that carries both a timeout and an out-of-memory cause', () => {
    expect(isPromptEncodingMetalWatchdog({
      signal: 'SIGABRT',
      stderr: `${TIMEOUT_ABORT}\n${OOM_ABORT}`,
      promptEncodePhase: 'active',
    })).toBe(false);
  });

  // The three phase states must stay distinct: "never reported" is every
  // non-LTX-2 runtime and must never read as "encoding right now".
  it.each([
    ['done — the abort landed in the denoise loop, which a shorter prompt cannot fix', 'done'],
    ['null — this runner never reported an encode boundary at all', null],
    ['undefined — same, expressed as an unstamped job field', undefined],
  ])('refuses to fire when the prompt-encode phase is %s', (_label, promptEncodePhase) => {
    expect(isPromptEncodingMetalWatchdog({ signal: 'SIGABRT', stderr: TIMEOUT_ABORT, promptEncodePhase })).toBe(false);
  });

  // A watchdog kill always arrives as SIGABRT (the Metal layer raises a C++
  // exception that terminate() converts), never as a clean non-zero exit or an
  // OOM SIGKILL.
  it.each([[null], ['SIGKILL'], ['SIGTERM'], ['SIGSEGV']])('refuses to fire on signal %s', (signal) => {
    expect(isPromptEncodingMetalWatchdog({ signal, stderr: TIMEOUT_ABORT, promptEncodePhase: 'active' })).toBe(false);
  });

  it('tolerates a missing/blank stderr tail and an empty call', () => {
    expect(isPromptEncodingMetalWatchdog()).toBe(false);
    expect(isPromptEncodingMetalWatchdog({ signal: 'SIGABRT', promptEncodePhase: 'active' })).toBe(false);
    expect(isPromptEncodingMetalWatchdog({ signal: 'SIGABRT', stderr: null, promptEncodePhase: 'active' })).toBe(false);
  });
});

describe('planPromptEncodingRetry', () => {
  const WATCHDOG_ABORT = '[METAL] Command buffer execution failed: (00000004:kIOGPUCommandBufferCallbackErrorImpactingInteractivity)';
  const qualifying = {
    signal: 'SIGABRT',
    stderr: WATCHDOG_ABORT,
    promptEncodePhase: 'active',
    retriesUsed: 0,
    platform: 'darwin',
  };

  it('plans one relaunch at the reduced Gemma budget', () => {
    expect(planPromptEncodingRetry(qualifying)).toEqual({ gemmaMaxLength: RETRY_GEMMA_MAX_LENGTH });
    // The reduced budget is a real cut from what upstream would otherwise use —
    // a plan that handed back the default would relaunch into the same abort.
    expect(RETRY_GEMMA_MAX_LENGTH).toBeLessThan(DEFAULT_GEMMA_MAX_LENGTH);
  });

  it('allows exactly one — a second abort at the reduced budget is a real failure', () => {
    expect(planPromptEncodingRetry({ ...qualifying, retriesUsed: 1 })).toBeNull();
    expect(planPromptEncodingRetry({ ...qualifying, retriesUsed: 2 })).toBeNull();
  });

  // The command-buffer watchdog is a macOS construct; a Windows/CUDA render that
  // somehow produced a matching string must not be relaunched with an
  // Apple-specific mitigation.
  it.each([['win32'], ['linux']])('never fires on %s', (platform) => {
    expect(planPromptEncodingRetry({ ...qualifying, platform })).toBeNull();
  });

  it('passes the classifier verdict straight through', () => {
    expect(planPromptEncodingRetry({ ...qualifying, promptEncodePhase: 'done' })).toBeNull();
    expect(planPromptEncodingRetry({ ...qualifying, signal: 'SIGKILL' })).toBeNull();
  });
});

// The window between "spawn resolved" and "real listeners attached" is an await
// on real file I/O (the accelerator claim handoff). A child that dies in it
// emits unsubscribed — and for 'error' that is not merely lost but fatal, since
// an EventEmitter with no 'error' listener throws.
describe('bufferChildExit', () => {
  it('reports nothing for a child that is still alive', () => {
    expect(bufferChildExit(new EventEmitter())()).toBeNull();
  });

  it('holds a close emitted before the real listeners were attached', () => {
    const proc = new EventEmitter();
    const take = bufferChildExit(proc);
    proc.emit('close', 3, null);
    expect(take()).toEqual({ type: 'close', code: 3, signal: null });
  });

  it('absorbs an error that would otherwise throw out of the emitter', () => {
    const proc = new EventEmitter();
    const take = bufferChildExit(proc);
    const err = new Error('detached spawn produced no PID');
    expect(() => proc.emit('error', err)).not.toThrow();
    expect(take()).toEqual({ type: 'error', error: err });
  });

  it('keeps the FIRST terminal event — a later one must not rewrite the verdict', () => {
    const proc = new EventEmitter();
    const take = bufferChildExit(proc);
    proc.emit('error', new Error('spawn failed'));
    proc.emit('close', 0, null);
    expect(take().type).toBe('error');
  });

  it('detaches on take, so the real handlers own everything that follows', () => {
    const proc = new EventEmitter();
    const take = bufferChildExit(proc);
    expect(take()).toBeNull();
    expect(proc.listenerCount('close')).toBe(0);
    expect(proc.listenerCount('error')).toBe(0);
  });

  it('stays a sink for a child that is abandoned rather than wired', () => {
    const proc = new EventEmitter();
    bufferChildExit(proc);
    expect(() => proc.emit('error', new Error('abandoned'))).not.toThrow();
  });
});
