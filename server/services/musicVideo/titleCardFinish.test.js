import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixture = vi.hoisted(() => ({ dir: null }));
vi.mock('./compositionRender.js', () => ({
  removeCompositionScratch: vi.fn(async () => {}),
  renderTypographyOverlays: vi.fn(async ({ fps, width, height, cues }) => {
    // An alpha graphic whose slide and fade visibly change on every source frame.
    const frames = fps;
    const bytes = Buffer.alloc(width * height * 4 * frames);
    for (let n = 0; n < frames; n++) {
      for (let y = 20; y < 40; y++) for (let x = 8 + n; x < 28 + n; x++) {
        const p = ((n * height + y) * width + x) * 4;
        bytes[p] = 255; bytes[p + 1] = 255; bytes[p + 2] = 255; bytes[p + 3] = 60 + n * 8;
      }
    }
    const path = join(fixture.dir, 'card.mov');
    const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`,
      '-r', String(fps), '-i', 'pipe:0', '-c:v', 'qtrle', '-pix_fmt', 'argb', '-y', path], { input: bytes });
    expect(encoded.status).toBe(0);
    return [{ path, startSec: cues[0].startSec, durationSec: 1 }];
  }),
}));
const { applyTitleCardFinish } = await import('./titleCardFinish.js');
const { applyFrameHold } = await import('./frameHold.js');
const { renderTypographyOverlays, removeCompositionScratch } = await import('./compositionRender.js');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
beforeAll(async () => { fixture.dir = await mkdtemp(join(tmpdir(), 'steady-title-finish-')); });
afterAll(async () => { await rm(fixture.dir, { recursive: true, force: true }); });

// Uniquely proves the finished file keeps full-rate alpha animation after held footage,
// its cold-open offset, no leaked card into the ending, and bit-identical audio.
it.skipIf(!hasFfmpeg)('lays a full-rate card after the hold, between the cold open and ending', async () => {
  const path = join(fixture.dir, 'cut.mp4');
  const run = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
  run(['-f', 'lavfi', '-i', 'color=black:s=64x64:r=24:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', path]);
  const audioBefore = run(['-i', path, '-map', '0:a', '-c:a', 'copy', '-f', 'adts', '-']);
  await applyFrameHold({ path, sections: [{ sceneId: 'a', startSec: 0, endSec: 2 }], leadSec: 1 });
  const project = { titleCard: { enabled: true, title: 'Song', steady: true, startSec: 0, endSec: 1 } };
  expect(await applyTitleCardFinish({ project, path, jobId: 'finish', width: 64, height: 64, fps: 24, songSec: 2, leadSec: 1, ffmpeg: 'ffmpeg' })).toBe(true);
  const raw = run(['-i', path, '-map', '0:v', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const frames = Array.from({ length: raw.length / 4096 }, (_, i) => raw.subarray(i * 4096, (i + 1) * 4096));
  expect(frames).toHaveLength(96);
  const sum = frame => frame.reduce((a, b) => a + b, 0);
  expect(frames.slice(0, 24).every(frame => sum(frame) < 1000)).toBe(true);
  expect(frames.slice(48).every(frame => sum(frame) < 1000)).toBe(true);
  for (let i = 24; i < 47; i++) expect(Math.abs(sum(frames[i + 1]) - sum(frames[i]))).toBeGreaterThan(1000);
  expect(run(['-i', path, '-map', '0:a', '-c:a', 'copy', '-f', 'adts', '-']).equals(audioBefore)).toBe(true);
  expect(removeCompositionScratch).toHaveBeenCalledWith('steady-title-finish');
}, 30000);

it('leaves the cut untouched when the card has no song window', async () => {
  const path = join(fixture.dir, 'absent.mp4');
  renderTypographyOverlays.mockClear();
  expect(await applyTitleCardFinish({ project: { titleCard: { enabled: true, title: 'Late', startSec: 5, endSec: 6 } }, path, songSec: 2 })).toBe(false);
  expect(renderTypographyOverlays).not.toHaveBeenCalled();
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
