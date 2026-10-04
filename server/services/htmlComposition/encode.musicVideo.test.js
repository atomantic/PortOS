import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const { spawned } = vi.hoisted(() => ({ spawned: [] }));
vi.mock('../../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (_bin, args) => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = new EventEmitter();
      let bytes = 0;
      proc.stdin.write = (buf, cb) => { bytes += buf.length; cb?.(); return true; };
      proc.stdin.end = () => { proc.emit('close', 0); };
      proc.kill = () => {};
      spawned.push({ args, bytes: () => bytes, proc });
      return proc;
    },
  };
});
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, findFfmpeg: async () => '/usr/bin/ffmpeg', bt709TagFilter: async () => 'format=yuv420p' };
});
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: () => {} }));

const { encodeComposition } = await import('./encode.js');

const FRAME = Buffer.alloc(4 * 1024, 7).toString('base64');
const page = {
  check() {},
  async evaluate() {},
  async send(method) {
    if (method === 'Emulation.setDeviceMetricsOverride') return {};
    return { data: FRAME };
  },
};
const contract = (durationSec) => ({ fps: 12, durationSec, width: 1280, height: 720, motionBlur: 1 });

describe('encodeComposition music-video audio', () => {
  it('keeps the launch-video loop and tail fade when given a library bed', async () => {
    spawned.length = 0;
    await encodeComposition(page, contract(1), '/tmp/launch.mp4', { musicPath: '/library/bed.wav' });
    const args = spawned[0].args;
    expect(args).toContain('-stream_loop');
    expect(args.join(' ')).toContain('afade=t=out:st=0.5:d=0.5');
    expect(args).not.toContain('-ss');
  });

  it('cuts the master at the in-point with no loop and no fade', async () => {
    spawned.length = 0;
    await encodeComposition(page, contract(15), '/tmp/excerpt.mp4', { audio: { path: '/masters/song.wav', startSec: 60 } });
    const args = spawned[0].args;
    const audioAt = args.indexOf('/masters/song.wav');
    expect(args.slice(audioAt - 5, audioAt + 1)).toEqual(['-ss', '60', '-t', '15', '-i', '/masters/song.wav']);
    expect(args).not.toContain('-stream_loop');
    expect(args.join(' ')).not.toContain('afade');
    expect(args).toContain('-frames:v');
  });

  it('does not retain per-frame buffers across a long synthetic job', () => {
    // A separate node process so its temp directory and forced GC stay out of
    // this vitest run. A nested vitest shares the suite temp root and deletes
    // it out from under the other shards.
    const scratch = mkdtempSync(join(tmpdir(), 'portos-encode-mem-'));
    const script = fileURLToPath(new URL('./encode.musicVideo.memory-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--expose-gc', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 120000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch, TEMP: scratch, TMP: scratch },
    });
    rmSync(scratch, { recursive: true, force: true });
    expect(result.status, `${result.stderr || ''}\n${result.stdout || ''}`).toBe(0);
  }, 150000);
});

describe('encodeComposition song-time windows', () => {
  const recording = (fail = null) => {
    const seeks = [];
    return {
      seeks,
      page: {
        check() {},
        async evaluate(expression) {
          const t = Number(/seek\(([^)]+)\)/.exec(expression)?.[1]);
          if (Number.isFinite(t)) {
            seeks.push(t);
            if (fail && fail(t)) {
              // The real encoder exits once its stdin is abandoned; this fake one closes on the failure.
              spawned.at(-1).proc.emit('close', 1);
              throw new Error('Composition script failed: video seek failed: media/scene-a.mp4');
            }
          }
        },
        async send(method) { return method === 'Page.captureScreenshot' ? { data: FRAME } : {}; },
      },
    };
  };

  it('seeks the window on the timeline it came from: frame n is drawn at offsetSec + n / fps', async () => {
    spawned.length = 0;
    const { page: windowPage, seeks } = recording();
    await encodeComposition(windowPage, contract(0.5), '/tmp/window.mp4', { offsetSec: 61.25 });
    expect(seeks).toEqual([61.25, 61.333333, 61.416667, 61.5, 61.583333, 61.666667]);
    expect(spawned[0].args.join(' ')).toContain('-frames:v 6');
  });

  it('fails loudly, naming the frame, when a seek rejects', async () => {
    spawned.length = 0;
    const { page: failing } = recording((t) => t >= 10.25);
    await expect(encodeComposition(failing, contract(1), '/tmp/fail.mp4', { offsetSec: 10 }))
      .rejects.toThrow(/seek\(10\.25\) failed at frame 3: .*video seek failed/);
  });
});

describe('encodeComposition process termination diagnostics', () => {
  it.each([
    { code: null, signal: 'SIGKILL', abort: false, message: 'SIGKILL; external signal (no encoder stop requested)' },
    { code: null, signal: 'SIGTERM', abort: true, message: 'SIGTERM; encoder abort requested' },
    { code: 7, signal: null, abort: false, message: '7' },
    { code: null, signal: null, abort: false, message: 'unknown' },
  ])('reports $message through the render boundary', async ({ code, signal, abort, message }) => {
    const controller = new AbortController();
    const spawnProcess = () => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = new EventEmitter();
      proc.stdin.write = (_bytes, callback) => { callback(); return true; };
      proc.stdin.end = () => {
        if (abort) controller.abort();
        proc.stderr.emit('data', Buffer.from('synthetic diagnostic'));
        proc.emit('close', code, signal);
      };
      return proc;
    };
    await expect(encodeComposition(page, contract(0.25), '/tmp/termination.mp4', {
      signal: controller.signal, spawnProcess,
    })).rejects.toThrow(`ffmpeg failed (${message}): synthetic diagnostic`);
  });
});


it('preserves the exit signal and stderr when EPIPE arrives before the encoder closes', async () => {
  const spawnProcess = () => {
    const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdin = new EventEmitter();
    proc.stdin.write = (_bytes, callback) => {
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      callback(error); proc.stdin.emit('error', error);
      setImmediate(() => { proc.stderr.emit('data', 'synthetic encoder stopped'); proc.emit('close', null, 'SIGTERM'); });
    };
    return proc;
  };
  await expect(encodeComposition(page, contract(0.25), '/tmp/interrupted.mp4', { spawnProcess }))
    .rejects.toThrow(/Render interrupted:.*EPIPE.*SIGTERM.*synthetic encoder stopped/);
});
