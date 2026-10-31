/**
 * The stepped-medium frame hold on a finished render. The graph and the
 * pass's arguments are checked with ffmpeg stubbed; a real encode (skipped
 * where ffmpeg is not installed) proves the delivered frames come in pairs,
 * a performance span is copied through, and the rate and length hold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { seen } = vi.hoisted(() => ({ seen: { args: null, real: false } }));
vi.mock('../../lib/ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findFfmpeg: async () => 'ffmpeg',
    probeVideoGeometry: async (path) => (seen.real ? actual.probeVideoGeometry(path)
      : { width: 64, height: 64, fps: 24, numFrames: 72, durationSec: 3 }),
    runFfmpegProcess: async (options) => {
      seen.args = options.args;
      if (seen.real) return actual.runFfmpegProcess(options);
      await writeFile(options.args.at(-1), 'held-video');
      return { ok: true };
    },
  };
});
const { applyFrameHold, projectFrameHold } = await import('./frameHold.js');

const dirs = [];
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), 'portos-frame-hold-')); dirs.push(dir); return dir; };
afterEach(async () => {
  seen.args = null; seen.real = false;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('projectFrameHold', () => {
  it('applies to the stepped medium only and names its performance shots', () => {
    const scenes = [{ sceneId: 'p', shotMode: 'performance' }, { sceneId: 'c', shotMode: 'cutaway' }];
    expect(projectFrameHold({ productionMedium: 'stepped', scenes })).toEqual({ performanceSceneIds: ['p'] });
    expect(projectFrameHold({ productionMedium: 'beat-graphic', scenes })).toBeNull();
    expect(projectFrameHold({ scenes })).toBeNull();
  });
});

describe('applyFrameHold', () => {
  const sections = [{ sceneId: 'a', startSec: 0, endSec: 1 }, { sceneId: 'p', startSec: 1, endSec: 2 }, { sceneId: 'b', startSec: 2, endSec: 3 }];

  it('doubles the odd frames only inside held spans and keeps rate, length and audio', async () => {
    const dir = await scratch();
    const path = join(dir, 'cut.mp4');
    await writeFile(path, 'source');
    const result = await applyFrameHold({ path, sections, performanceSceneIds: ['p'] });
    expect(result).toEqual({ held: true, exemptSceneIds: ['p'] });
    const graph = seen.args[seen.args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('trim=start_frame=0:end_frame=24,setpts=PTS-STARTPTS,select=');
    expect(graph).toContain('[0:v]trim=start_frame=24:end_frame=48,setpts=PTS-STARTPTS[p1]'); // the performance span is copied through
    expect(graph).toContain('trim=start_frame=48:end_frame=72');
    expect(graph.match(/select=/g)).toHaveLength(2);
    expect(graph).toContain('concat=n=3:v=1:a=0[outv]');
    expect(seen.args).toEqual(expect.arrayContaining(['-r', '24', '-frames:v', '72', '-c:a', 'copy']));
    expect(await readFile(path, 'utf8')).toBe('held-video');
  });

  it('leaves the file alone when every shot is a performance', async () => {
    const dir = await scratch();
    const path = join(dir, 'cut.mp4');
    await writeFile(path, 'source');
    expect(await applyFrameHold({ path, sections, performanceSceneIds: ['a', 'p', 'b'] })).toMatchObject({ held: false });
    expect(seen.args).toBeNull();
    expect(await readFile(path, 'utf8')).toBe('source');
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  it.skipIf(!hasFfmpeg)('delivers identical frame pairs in held spans, 24 fps, same length, performance copied', async () => {
    seen.real = true;
    const dir = await scratch();
    const path = join(dir, 'cut.mp4');
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24:duration=3',
      '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '1', '-c:a', 'aac', '-shortest', '-y', path]);
    expect(made.status).toBe(0);
    const gray = (file) => {
      const raw = join(dir, `${file.split('/').pop()}.raw`);
      const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v', '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', raw]);
      expect(run.status).toBe(0);
      return raw;
    };
    const before = await readFile(gray(path));
    await applyFrameHold({ path, sections, performanceSceneIds: ['p'] });
    const after = await readFile(gray(path));
    const size = 64 * 64;
    expect(after.length / size).toBe(72);
    const diff = (a, x, b, y) => { let max = 0; for (let k = 0; k < size; k++) max = Math.max(max, Math.abs(a[x * size + k] - b[y * size + k])); return max; };
    // Lossy re-encode: a held pair differs by codec noise only; distinct source frames differ by far more.
    for (const start of [0, 2, 10, 22, 48, 50, 70]) expect(diff(after, start, after, start + 1)).toBeLessThan(15);
    expect(diff(before, 0, before, 1)).toBeGreaterThan(40);
    for (let frame = 25; frame < 47; frame++) expect(diff(after, frame, after, frame + 1)).toBeGreaterThan(40);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,duration', '-of', 'csv=p=0', path]).stdout.toString();
    expect(probe).toContain('24/1');
    expect(probe).toContain('audio');
    expect(existsSync(`${path}.hold.mp4`)).toBe(false);
  });
});
