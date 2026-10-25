import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, utimesSync, statSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinPlatform } from './testHelper.js';
import { resolveBashBinary, toBashPath } from './bashResolver.js';
import {
  findFfmpeg,
  _probeEncoderCapability as probeEncoderCapability,
  _enumerateFfmpegCandidates as enumerateFfmpegCandidates,
  resetFfmpegCache,
  __setPlatformCandidatesForTest,
  trimVideoFromFrame,
  upscaleVideo2x,
  runFfmpegProcess,
} from './ffmpeg.js';
import { padSourceForUpscale, finalizeUpscaleOutput } from '../services/videoGen/upscaleFfmpeg.js';
import { stitchVideos } from '../services/videoGen/stitchVideos.js';
import { spliceExtendSource } from '../services/videoGen/extendSplice.js';

// Synthetic executables are POSIX scripts, which Windows cannot execFile
// directly. Supply their interpreter while retaining real child execution,
// timeout handling and on-disk binary identity/cache invalidation on every OS.
vi.mock('./childProcess.js', async importOriginal => {
  const actual = await importOriginal();
  const { promisify } = await import('node:util');
  const command = (bin, args) => String(bin).includes('portos-ffmpeg-codec-test-') && existsSync(bin)
    ? [resolveBashBinary(), [toBashPath(bin), ...args.map(toBashPath)]] : [bin, args];
  const execFile = Object.assign(
    (bin, args, ...rest) => actual.execFile(...command(bin, args), ...rest),
    { [promisify.custom]: (bin, args, ...rest) => actual.execFile[promisify.custom](...command(bin, args), ...rest) },
  );
  return { ...actual, execFile, spawn: (bin, args, ...rest) => actual.spawn(...command(bin, args), ...rest) };
});

describe('ffmpeg codec selection & required-encoder discovery (#13616)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'portos-ffmpeg-codec-test-'));
    resetFfmpegCache();
  });

  afterEach(() => {
    resetFfmpegCache();
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const createScript = (name, body) => {
    const scriptPath = join(tmpDir, name);
    writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  };

  describe('candidate enumeration and platform names', () => {
    it('enumerates POSIX platform candidates in precedence order', async () => {
      const restore = pinPlatform('darwin');
      try {
        const candidates = await enumerateFfmpegCandidates();
        expect(candidates.slice(0, 3)).toEqual([
          '/opt/homebrew/bin/ffmpeg',
          '/usr/local/bin/ffmpeg',
          '/usr/bin/ffmpeg',
        ]);
      } finally {
        restore();
      }
    });

    it('enumerates Windows platform candidates in precedence order', async () => {
      const restore = pinPlatform('win32');
      try {
        const candidates = await enumerateFfmpegCandidates();
        expect(candidates.slice(0, 2)).toEqual([
          'C:\\ffmpeg\\bin\\ffmpeg.exe',
          'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
        ]);
      } finally {
        restore();
      }
    });
  });

  describe('probeEncoderCapability', () => {
    it('returns supported:true and caches evidence when encoder is listed in stdout', async () => {
      const bin = createScript('ffmpeg-with-x264', `
if [ "$1" = "-hide_banner" ] && [ "$2" = "-encoders" ]; then
  cat <<'EOF'
Encoders:
 V..... = Video
 ------
 V..... a64multi             Multicolor charset for Commodore 64
 V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC
EOF
  exit 0
fi
exit 1
`);
      const first = await probeEncoderCapability(bin, 'libx264');
      expect(first).toEqual({ supported: true, inconclusive: false, fromCache: false });

      // Second call reads from cache
      const second = await probeEncoderCapability(bin, 'libx264');
      expect(second).toEqual({ supported: true, inconclusive: false, fromCache: true });

      // Case-insensitivity check
      const third = await probeEncoderCapability(bin, 'LIBX264');
      expect(third).toEqual({ supported: true, inconclusive: false, fromCache: true });
    });

    it('returns supported:false (conclusive) when encoder is absent from clean stdout', async () => {
      const bin = createScript('ffmpeg-without-x264', `
if [ "$1" = "-hide_banner" ] && [ "$2" = "-encoders" ]; then
  cat <<'EOF'
Encoders:
 V..... = Video
 ------
 V..... a64multi             Multicolor charset for Commodore 64
 V..... mpeg4                MPEG-4 part 2
EOF
  exit 0
fi
exit 1
`);
      const res = await probeEncoderCapability(bin, 'libx264');
      expect(res).toEqual({ supported: false, inconclusive: false, fromCache: false });

      // Cached as absent
      const second = await probeEncoderCapability(bin, 'libx264');
      expect(second).toEqual({ supported: false, inconclusive: false, fromCache: true });
    });

    it('returns inconclusive:true when probe exits non-zero and does NOT cache result', async () => {
      const bin = createScript('ffmpeg-failing', `
exit 2
`);
      const res = await probeEncoderCapability(bin, 'libx264');
      expect(res.supported).toBe(false);
      expect(res.inconclusive).toBe(true);
      expect(res.timedOut).toBe(false);
      expect(res.fromCache).toBe(false);

      // Subsequent call does NOT hit cache (fromCache is false)
      const second = await probeEncoderCapability(bin, 'libx264');
      expect(second.supported).toBe(false);
      expect(second.inconclusive).toBe(true);
      expect(second.fromCache).toBe(false);
    });

    it('returns inconclusive:true with timedOut:true on timeout and does NOT cache', async () => {
      const bin = createScript('ffmpeg-sleeping', `
exec sleep 10
`);
      const res = await probeEncoderCapability(bin, 'libx264', { timeoutMs: 100 });
      expect(res.supported).toBe(false);
      expect(res.inconclusive).toBe(true);
      expect(res.timedOut).toBe(true);
      expect(res.fromCache).toBe(false);
      expect(res.reason).toMatch(/timed out/i);
    });

    it('invalidates capability cache when binary identity changes (mtime/size update)', async () => {
      const bin = createScript('ffmpeg-updating', `
cat <<'EOF'
Encoders:
 V..... a64multi             Multicolor charset for Commodore 64
EOF
exit 0
`);
      const first = await probeEncoderCapability(bin, 'libx264');
      expect(first.supported).toBe(false);
      expect(first.fromCache).toBe(false);

      // Re-write executable with libx264 added
      writeFileSync(bin, `#!/bin/sh
cat <<'EOF'
Encoders:
 V..... libx264              libx264 H.264
EOF
exit 0
`);
      chmodSync(bin, 0o755);
      // Bump mtime to ensure identity change
      const past = new Date(Date.now() + 2000);
      utimesSync(bin, past, past);

      const second = await probeEncoderCapability(bin, 'libx264');
      expect(second.supported).toBe(true);
      expect(second.fromCache).toBe(false);
    });
  });

  describe('findFfmpeg candidate selection & codec enforcement', () => {
    it('allows copy-only and decode callers to use a minimal build without libx264', async () => {
      const minimalBin = createScript('ffmpeg-minimal', `exit 0`);
      __setPlatformCandidatesForTest([minimalBin]);

      // Without requiredEncoder: picks up the first binary
      const found = await findFfmpeg();
      expect(found).toBe(minimalBin);
    });

    it('skips a candidate without libx264 and chooses a later supported candidate', async () => {
      const dir1 = join(tmpDir, 'bin1');
      const dir2 = join(tmpDir, 'bin2');
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });

      const nox264 = join(dir1, 'ffmpeg');
      writeFileSync(nox264, `#!/bin/sh
cat <<'EOF'
Encoders:
 V..... a64multi             Multicolor charset
EOF
exit 0
`);
      chmodSync(nox264, 0o755);

      const withx264 = join(dir2, 'ffmpeg');
      writeFileSync(withx264, `#!/bin/sh
cat <<'EOF'
Encoders:
 V..... libx264              libx264 H.264
EOF
exit 0
`);
      chmodSync(withx264, 0o755);

      __setPlatformCandidatesForTest([nox264, withx264]);

      const found = await findFfmpeg({ requiredEncoder: 'libx264' });
      // nox264 was skipped because it lacked libx264; withx264 was chosen!
      expect(found).toBe(withx264);
    });

    it('yields distinct actionable error FFMPEG_CODEC_MISSING when no candidate has required codec', async () => {
      const nox264 = createScript('ffmpeg-nox264', `
cat <<'EOF'
Encoders:
 V..... a64multi             Multicolor charset
EOF
exit 0
`);
      __setPlatformCandidatesForTest([nox264]);

      await expect(findFfmpeg({ requiredEncoder: 'libx264' })).rejects.toMatchObject({
        code: 'FFMPEG_CODEC_MISSING',
        message: expect.stringContaining('libx264'),
      });
    });

    it('yields distinct actionable error FFMPEG_PROBE_TIMED_OUT when listing times out', async () => {
      const slow = createScript('ffmpeg-slow', `
exec sleep 10
`);
      __setPlatformCandidatesForTest([slow]);

      await expect(findFfmpeg({ requiredEncoder: 'libx264', timeoutMs: 100 })).rejects.toMatchObject({
        code: 'FFMPEG_PROBE_TIMED_OUT',
        message: expect.stringContaining('timed out'),
      });
    });

    it('yields FFMPEG_MISSING when no ffmpeg exists anywhere', async () => {
      __setPlatformCandidatesForTest([join(tmpDir, 'missing1'), join(tmpDir, 'missing2')]);
      const originalPath = process.env.PATH;
      process.env.PATH = tmpDir; // empty dir
      try {
        // Without requiredEncoder: returns null
        expect(await findFfmpeg()).toBeNull();
        // With requiredEncoder: throws FFMPEG_MISSING
        await expect(findFfmpeg({ requiredEncoder: 'libx264' })).rejects.toMatchObject({
          code: 'FFMPEG_MISSING',
        });
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it('adding a higher-precedence executable makes findFfmpeg pick it up immediately', async () => {
      const cand2 = createScript('cand2', `exit 0`);
      const cand1Path = join(tmpDir, 'cand1');
      // Initially cand1 does not exist
      __setPlatformCandidatesForTest([cand1Path, cand2]);

      expect(await findFfmpeg()).toBe(cand2);

      // Now install cand1 at the higher-precedence path
      writeFileSync(cand1Path, `#!/bin/sh\nexit 0\n`);
      chmodSync(cand1Path, 0o755);

      // findFfmpeg immediately discovers cand1 without restarting
      expect(await findFfmpeg()).toBe(cand1Path);
    });
  });

  describe('public export boundaries', () => {
    it('trimVideoFromFrame skips first candidate without libx264 and uses second candidate with libx264', async () => {
      const nox264 = createScript('nox264', `
cat <<'EOF'
Encoders:
 V..... a64multi
EOF
exit 0
`);
      const withx264 = createScript('withx264', `
if [ "$1" = "-hide_banner" ] && [ "$2" = "-encoders" ]; then
  cat <<'EOF'
Encoders:
 V..... libx264
EOF
  exit 0
fi
# Real execution of trim
for arg in "$@"; do last="$arg"; done
touch "$last"
exit 0
`);
      __setPlatformCandidatesForTest([nox264, withx264]);

      const vid = join(tmpDir, 'video.mp4');
      const out = join(tmpDir, 'out.mp4');
      writeFileSync(vid, 'dummy');

      const res = await trimVideoFromFrame(vid, out, { startFrame: 1, fps: 24 });
      expect(res.ok).toBe(true);
    });

    it('trimVideoFromFrame reports prerequisite error when libx264 is unavailable', async () => {
      const nox264 = createScript('nox264', `cat <<'EOF'\nEncoders:\n V..... a64multi\nEOF\nexit 0\n`);
      __setPlatformCandidatesForTest([nox264]);

      const vid = join(tmpDir, 'video.mp4');
      writeFileSync(vid, 'dummy');

      const res = await trimVideoFromFrame(vid, join(tmpDir, 'out.mp4'), { startFrame: 1, fps: 24 });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/libx264/);
    });

    it('upscaleVideo2x reports prerequisite error when libx264 is unavailable', async () => {
      const nox264 = createScript('nox264', `cat <<'EOF'\nEncoders:\n V..... a64multi\nEOF\nexit 0\n`);
      __setPlatformCandidatesForTest([nox264]);

      const vid = join(tmpDir, 'video.mp4');
      writeFileSync(vid, 'dummy');

      const res = await upscaleVideo2x(vid);
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/libx264/);
    });

    it('padSourceForUpscale and finalizeUpscaleOutput report prerequisite error when libx264 is unavailable', async () => {
      const nox264 = createScript('nox264', `cat <<'EOF'\nEncoders:\n V..... a64multi\nEOF\nexit 0\n`);
      __setPlatformCandidatesForTest([nox264]);

      const res1 = await padSourceForUpscale('/fixture/src.mp4', '/fixture/out.mp4', {
        width: 864, height: 512, padFrames: 4, fps: 25,
      });
      expect(res1.ok).toBe(false);
      expect(res1.reason).toMatch(/libx264/);

      const res2 = await finalizeUpscaleOutput('/fixture/rendered.mp4', '/fixture/final.mp4', {
        width: 1536, height: 1024, frameCount: 121, audioSourcePath: '/fixture/src.mp4',
      });
      expect(res2.ok).toBe(false);
      expect(res2.reason).toMatch(/libx264/);
    });

    it('spliceExtendSource reports reason when libx264 is unavailable', async () => {
      const nox264 = createScript('nox264', `cat <<'EOF'\nEncoders:\n V..... a64multi\nEOF\nexit 0\n`);
      __setPlatformCandidatesForTest([nox264]);

      const src = join(tmpDir, 'source.mp4');
      const out = join(tmpDir, 'output.mp4');
      writeFileSync(src, 'dummy');
      writeFileSync(out, 'dummy');

      const res = await spliceExtendSource({ sourcePath: src, outputPath: out, extendLatents: 1 });
      expect(res.applied).toBe(false);
      expect(res.reason).toMatch(/libx264/);
    });

    it('stitchVideos with trims requires libx264 and rejects when missing', async () => {
      const nox264 = createScript('nox264', `cat <<'EOF'\nEncoders:\n V..... a64multi\nEOF\nexit 0\n`);
      __setPlatformCandidatesForTest([nox264]);

      const trims = new Map([['v1', { startFrame: 5, frames: 10 }]]);
      await expect(stitchVideos(['v1', 'v2'], { trims })).rejects.toMatchObject({
        code: 'FFMPEG_CODEC_MISSING',
        message: expect.stringContaining('libx264'),
      });
    });
  });

  describe('real ffmpeg export verification', () => {
    it('successfully exports using real ffmpeg when libx264 is available on host', async () => {
      const realFfmpeg = await findFfmpeg({ requiredEncoder: 'libx264' }).catch(() => null);
      if (!realFfmpeg) return; // skip if host lacks ffmpeg with libx264

      const out = join(tmpDir, 'export-real.mp4');
      const res = await runFfmpegProcess({
        bin: realFfmpeg,
        args: [
          '-f', 'lavfi', '-i', 'color=c=blue:size=64x64:rate=10',
          '-frames:v', '5',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-y', out,
        ],
      });
      expect(res.ok).toBe(true);
      expect(statSync(out).size).toBeGreaterThan(0);
    });
  });
});
