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
