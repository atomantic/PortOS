import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCompositionSegments } from './encode.js';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';

const contract = { fps: 24, durationSec: 60, width: 1920, height: 1080, motionBlur: 1 };
const page = (name) => ({ name, closed: 0, async close() { this.closed += 1; } });

describe('encodeCompositionSegments', () => {
  it('splits a long window into contiguous song-time segments and joins them', async () => {
    const calls = [];
    const opened = [];
    const progress = [];
    const joins = [];
    const first = page('first');
    await encodeCompositionSegments(first, contract, '/tmp/out.mp4', {
      workers: 3, offsetSec: 30,
      openPage: async () => { const p = page(`extra${opened.length}`); opened.push(p); return p; },
      videoFilterAt: (offsetSec) => `grade@${offsetSec}`,
      encode: async (p, c, path, options) => {
        calls.push({ page: p.name, frames: Math.round(c.durationSec * c.fps), path, offsetSec: options.offsetSec, continuous: options.continuous, filter: options.videoFilter });
        options.onProgress(1, { frame: Math.round(c.durationSec * c.fps) });
        return {};
      },
      locateFfmpeg: async () => 'ffmpeg',
      runFfmpeg: async ({ args }) => { joins.push(args); return { ok: true }; },
      onProgress: (fraction) => progress.push(fraction),
    });
    calls.sort((a, b) => a.offsetSec - b.offsetSec);
    expect(calls.map(({ frames, offsetSec, continuous, filter }) => ({ frames, offsetSec, continuous, filter }))).toEqual([
      { frames: 480, offsetSec: 30, continuous: false, filter: 'grade@30' },
      { frames: 480, offsetSec: 50, continuous: true, filter: 'grade@50' },
      { frames: 480, offsetSec: 70, continuous: true, filter: 'grade@70' },
    ]);
    // The caller's page draws the first segment and stays open; the extra pages close.
    expect(calls[0].page).toBe('first');
    expect(first.closed).toBe(0);
    expect(opened.map((p) => p.closed)).toEqual([1, 1]);
    expect(progress.at(-1)).toBe(1);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toEqual(expect.arrayContaining(['-f', 'concat', '-c', 'copy', '/tmp/out.mp4']));
  });

  it('renders a short window in one pass on the caller\'s page', async () => {
    const calls = [];
    await encodeCompositionSegments(page('only'), { ...contract, durationSec: 15 }, '/tmp/short.mp4', {
      workers: 4, offsetSec: 5, videoFilterAt: (offsetSec) => `grade@${offsetSec}`,
      openPage: async () => { throw new Error('no extra page for a short window'); },
      encode: async (p, c, path, options) => { calls.push([p.name, path, options.offsetSec, options.videoFilter]); return {}; },
    });
    expect(calls).toEqual([['only', '/tmp/short.mp4', 5, 'grade@5']]);
  });

  it('stops the other segments and reports the one that failed first', async () => {
    const extras = [];
    const failure = new Error('seek failed at frame 900');
    const run = encodeCompositionSegments(page('first'), contract, '/tmp/fail.mp4', {
      workers: 2,
      openPage: async () => { const p = page('extra'); extras.push(p); return p; },
      encode: (p, _c, _path, { signal }) => p.name === 'extra'
        ? Promise.reject(failure)
        : new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Render canceled')), { once: true })),
      locateFfmpeg: async () => 'ffmpeg',
      runFfmpeg: async () => { throw new Error('must not join a failed render'); },
    });
    await expect(run).rejects.toBe(failure);
    expect(extras[0].closed).toBe(1);
  });
});

const ffmpeg = await findFfmpeg();
describe.skipIf(!ffmpeg)('encodeCompositionSegments with real ffmpeg', () => {
  it('joins encoded segments into one stream with every frame and no leftovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-segments-'));
    try {
      const output = join(dir, 'joined.mp4');
      await encodeCompositionSegments(page('first'), { ...contract, durationSec: 25, width: 320, height: 180 }, output, {
        workers: 2, openPage: async () => page('extra'),
        encode: async (_p, c, path) => {
          const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${c.fps}`,
            '-frames:v', String(Math.round(c.durationSec * c.fps)), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', path]);
          if (result.status !== 0) throw new Error(result.stderr.toString());
          return {};
        },
        runFfmpeg: runFfmpegProcess,
      });
      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', output]);
      if (probe.status === 0) expect(Number(probe.stdout.toString().trim())).toBe(600);
      expect(['part0.mp4', 'part1.mp4', 'parts.txt'].some((suffix) => existsSync(`${output}.${suffix}`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
