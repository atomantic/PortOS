import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { execFile } from '../../../lib/childProcess.js';
import { findFfmpeg } from '../../../lib/ffmpeg.js';
import { assembleBlenderVideo } from './assemble.js';
import { blenderCutEffects } from '../../../lib/musicVideoCutEffects.js';
import { blenderFinishFilter } from './finishFilter.js';

const ffmpeg = await findFfmpeg();
const execFileAsync = promisify(execFile);

describe.skipIf(!ffmpeg)('Blender cut assembly with real ffmpeg', () => {
  // The source brightens each frame: source-time errors and a frozen tail are visible in decoded pixels.
  it('takes a full second at an output-frame offset from a source recorded at another rate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portos-blender-conform-'));
    try {
      const source = join(directory, 'source.mkv');
      const audio = join(directory, 'song.wav');
      const output = join(directory, 'cut.mp4');
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=32x32:r=30:d=2,geq=lum='16+N*3':cb=128:cr=128", '-c:v', 'ffv1', '-y', source], { timeout: 15_000 });
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', '-y', audio], { timeout: 15_000 });
      const result = await assembleBlenderVideo({
        segments: [{ source, offsetFrames: 24, frames: 24, direct: false }], width: 32, height: 32, fps: 24,
        audio: { path: audio, startSec: 1 }, output, scratch: join(directory, 'scratch'),
      });
      expect(result).toEqual({ frames: 24, durationSec: 1 });
      const { stdout: pixels } = await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-i', output, '-map', '0:v:0', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 15_000 });
      expect(pixels.length).toBe(24 * 32 * 32);
      // Output frames 24..47 correspond to about source frames 30..59 (1..2 s), not 24..47.
      expect(pixels[0]).toBeGreaterThan(98);
      expect(pixels[0]).toBeLessThan(115);
      expect(pixels[23 * 32 * 32]).toBeGreaterThan(195);
      expect(pixels[23 * 32 * 32]).toBeGreaterThan(pixels[20 * 32 * 32] + 5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Uniquely catches a dissolve failing to blend handles across the cut, changing duration, or jumping luminosity.
  it('draws a centred dissolve from out and in handles with unchanged length, and fade-black without handles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'portos-blender-dissolve-'));
    try {
      const darkFramesDir = join(directory, 's010', 'final', 'frames');
      const brightFramesDir = join(directory, 's020', 'final', 'frames');
      await mkdir(darkFramesDir, { recursive: true });
      await mkdir(brightFramesDir, { recursive: true });
      const darkVid = join(directory, 's010.mp4');
      const brightVid = join(directory, 's020.mp4');
      const audio = join(directory, 'song.wav');
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=#202020:s=32x32:r=24:d=1', '-pix_fmt', 'yuv420p', '-y', darkVid], { timeout: 15_000 });
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=#e0e0e0:s=32x32:r=24:d=1', '-pix_fmt', 'yuv420p', '-y', brightVid], { timeout: 15_000 });
      // The outgoing picture changes after the cut: frozen video padding must not replace these handles.
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=#808080:s=32x32:r=24:d=0.25', '-start_number', '24', join(darkFramesDir, 'handle_out_%06d.png')], { timeout: 15_000 });
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=#e0e0e0:s=32x32:r=24:d=0.25', '-start_number', '18', join(brightFramesDir, 'handle_in_%06d.png')], { timeout: 15_000 });
      await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', '-y', audio], { timeout: 15_000 });

      const [effect] = blenderCutEffects([
        { id: 's010', startFrame: 0, endFrame: 24, cutEffect: { style: 'dissolve', enabled: true, overlapSec: 0.5 } },
        { id: 's020', startFrame: 24, endFrame: 48, cutEffect: null },
      ], { fps: 24 });
      expect(effect).toMatchObject({ style: 'dissolve', startFrame: 18, endFrame: 30, needOutFrames: 6, needInFrames: 6 });

      const dissolveOut = join(directory, 'dissolve.mp4');
      const result = await assembleBlenderVideo({
        segments: [
          { source: darkVid, offsetFrames: 0, frames: 18, direct: false },
          {
            source: null,
            offsetFrames: 0,
            frames: 12,
            direct: false,
            transition: {
              style: 'dissolve',
              cutFrame: 24,
              windowStartFrame: 18,
              windowEndFrame: 30,
              segStartFrame: 18,
              segEndFrame: 30,
              outgoing: { video: darkVid, videoOffset: 18, videoFrames: 6, handlePattern: join(darkFramesDir, 'handle_out_%06d.png'), handleStart: 24, handleFrames: 6 },
              incoming: { handlePattern: join(brightFramesDir, 'handle_in_%06d.png'), handleStart: 18, handleFrames: 6, video: brightVid, videoOffset: 0, videoFrames: 6 },
            },
          },
          { source: brightVid, offsetFrames: 6, frames: 18, direct: false },
        ],
        width: 32, height: 32, fps: 24, quality: 'final', audio: { path: audio, startSec: 0 }, output: dissolveOut, scratch: join(directory, 'scratch-d'),
      });
      expect(result).toEqual({ frames: 48, durationSec: 2 });
      const { stdout: pixels } = await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-i', dissolveOut, '-map', '0:v:0', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 15_000 });
      expect(pixels.length).toBe(48 * 32 * 32);
      const lumaAt = (frame) => pixels[frame * 32 * 32];
      // Outside the dissolve window, both shots keep their own flat luma.
      expect(lumaAt(0)).toBeLessThan(50);
      expect(lumaAt(17)).toBeLessThan(50);
      expect(lumaAt(30)).toBeGreaterThan(200);
      expect(lumaAt(47)).toBeGreaterThan(200);
      // Across the 12 dissolve frames [18..29], each frame rises monotonically toward the incoming shot.
      expect(lumaAt(18)).toBeGreaterThan(lumaAt(17));
      expect(lumaAt(24)).toBeGreaterThan(165);
      expect(lumaAt(24)).toBeLessThan(195);
      expect(lumaAt(29)).toBeGreaterThan(lumaAt(24));
      expect(lumaAt(29)).toBeLessThan(lumaAt(30));

      // fade-black fades through black across the cut without any handle files.
      const fadeOut = join(directory, 'fade-black.mp4');
      const filter = blenderFinishFilter({
        scenes: [
          { sceneId: 'a', startSec: 0, endSec: 1, cutEffect: { style: 'fade-black', enabled: true, overlapSec: 0.5 } },
          { sceneId: 'b', startSec: 1, endSec: 2 },
        ],
      }, { width: 32, height: 32, fps: 24, startSec: 0, endSec: 2 });
      await assembleBlenderVideo({
        segments: [
          { source: brightVid, offsetFrames: 0, frames: 24, direct: false },
          { source: brightVid, offsetFrames: 0, frames: 24, direct: false },
        ],
        width: 32, height: 32, fps: 24, quality: 'final', filter, audio: { path: audio, startSec: 0 }, output: fadeOut, scratch: join(directory, 'scratch-f'),
      });
      const { stdout: fadePixels } = await execFileAsync(ffmpeg, ['-nostdin', '-v', 'error', '-i', fadeOut, '-map', '0:v:0', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 15_000 });
      expect(fadePixels.length).toBe(48 * 32 * 32);
      const fadeLuma = (frame) => fadePixels[frame * 32 * 32];
      expect(fadeLuma(0)).toBeGreaterThan(200);
      expect(fadeLuma(23)).toBeLessThan(60);
      expect(fadeLuma(24)).toBeLessThan(60);
      expect(fadeLuma(23)).toBeLessThan(fadeLuma(18));
      expect(fadeLuma(24)).toBeLessThan(fadeLuma(29));
      expect(fadeLuma(47)).toBeGreaterThan(200);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
