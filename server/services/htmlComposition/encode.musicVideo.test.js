import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
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
      spawned.push({ args, bytes: () => bytes });
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

  it('does not retain per-frame buffers across a long synthetic job', async () => {
    // Forced GC is what makes "not retained" observable. Re-exec once under
    // --expose-gc so a normal vitest run still executes the measurement.
    if (typeof global.gc !== 'function') {
      if (process.env.PORTOS_GC_CHILD === '1') throw new Error('forced GC was not available in the vitest worker');
      const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
      const vitestBin = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [vitestBin, 'run', 'services/htmlComposition/encode.musicVideo.test.js', '-t', 'per-frame buffers'], {
        cwd: serverRoot, encoding: 'utf8', timeout: 180000,
        env: { ...process.env, PORTOS_GC_CHILD: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --expose-gc`.trim() },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      return;
    }
    spawned.length = 0;
    const samples = [];
    await encodeComposition(page, contract(600), '/tmp/long.mp4', {
      onProgress: (_fraction, detail) => {
        if (detail.frame === 400 || detail.frame === 7200) {
          global.gc();
          samples.push(process.memoryUsage().heapUsed);
        }
      },
    });
    expect(spawned[0].bytes()).toBeGreaterThan(0);
    expect(samples).toHaveLength(2);
    // Frames 401–7200 of retained 4 KiB screenshots stay well over 12 MiB after GC.
    expect(samples[1] - samples[0]).toBeLessThan(12 * 1024 * 1024);
  }, 200000);
});
