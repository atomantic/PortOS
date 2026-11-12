import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { execFile } from '../../../lib/childProcess.js';
import { findFfmpeg } from '../../../lib/ffmpeg.js';
import { assembleBlenderVideo } from './assemble.js';

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
});
