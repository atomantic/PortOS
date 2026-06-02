import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `portos-audiomux-test-${process.pid}-${Date.now()}`);
const FAKE_MUSIC_DIR = join(TEST_HOME, 'music');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, music: FAKE_MUSIC_DIR },
  };
});

const findFfmpegMock = vi.fn();
// Pull the real runFfmpegProcess through — it's the helper audioMux now
// delegates to. The child_process mock below still intercepts spawn, so the
// real helper drives our fake ffmpeg.
vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return {
    ...actual,
    findFfmpeg: (...a) => findFfmpegMock(...a),
  };
});

// Capture spawn so the test asserts the ffmpeg args without actually
// running ffmpeg. The mock returns a fake child-process object that fires
// 'close' immediately with the configured exit code.
const spawnCalls = [];
let mockExitCode = 0;
let mockStderr = '';
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  const fs = await import('fs/promises');
  return {
    ...actual,
    spawn: (bin, args, _opts) => {
      spawnCalls.push({ bin, args });
      const listeners = {};
      const proc = {
        stderr: { on: (event, cb) => { if (event === 'data') cb(Buffer.from(mockStderr)); } },
        on: (event, cb) => { listeners[event] = cb; },
        kill: () => {},
      };
      // The real ffmpeg writes to args[args.length - 1] then exits. Mock
      // that side effect on the success path so the subsequent rename in
      // muxMusicBed has a file to move.
      Promise.resolve().then(async () => {
        if (mockExitCode === 0) {
          const outPath = args[args.length - 1];
          await fs.writeFile(outPath, Buffer.from('muxed')).catch(() => {});
        }
        listeners.close?.(mockExitCode, null);
      });
      return proc;
    },
  };
});

const { muxMusicBed, muxVoLines, buildVoMuxArgs, selectPlacedVoLines, resolveMusicTrackPath, DEFAULT_MUSIC_GAIN } = await import('./audioMux.js');

beforeEach(async () => {
  spawnCalls.length = 0;
  mockExitCode = 0;
  mockStderr = '';
  findFfmpegMock.mockReset();
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_MUSIC_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('resolveMusicTrackPath', () => {
  it('returns the absolute path when the file exists in PATHS.music', async () => {
    await writeFile(join(FAKE_MUSIC_DIR, 'theme.mp3'), Buffer.from('m'));
    expect(await resolveMusicTrackPath('theme.mp3')).toBe(join(FAKE_MUSIC_DIR, 'theme.mp3'));
  });

  it('returns null when the filename is missing or empty', async () => {
    expect(await resolveMusicTrackPath(null)).toBeNull();
    expect(await resolveMusicTrackPath('')).toBeNull();
    expect(await resolveMusicTrackPath('   ')).toBeNull();
  });

  it('returns null when the file is not present on disk (graceful degradation)', async () => {
    expect(await resolveMusicTrackPath('ghost.mp3')).toBeNull();
  });

  it('blocks path-traversal even if the stage record is stale', async () => {
    expect(await resolveMusicTrackPath('../etc/passwd')).toBeNull();
    expect(await resolveMusicTrackPath('subdir/foo.mp3')).toBeNull();
    expect(await resolveMusicTrackPath('foo\\bar.mp3')).toBeNull();
  });
});

describe('muxMusicBed', () => {
  it('returns ok:false when ffmpeg is not on PATH (graceful degradation)', async () => {
    findFfmpegMock.mockResolvedValue(null);
    const video = join(TEST_HOME, 'v.mp4');
    const music = join(FAKE_MUSIC_DIR, 'm.mp3');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(music, Buffer.from('mus'));
    const result = await muxMusicBed(video, { musicPath: music });
    expect(result).toEqual({ ok: false, reason: 'ffmpeg not on PATH' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('returns ok:false when the input video is missing', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const result = await muxMusicBed(join(TEST_HOME, 'nope.mp4'), { musicPath: 'whatever' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('input video missing');
    expect(spawnCalls).toHaveLength(0);
  });

  it('returns ok:false when the music file is missing', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    await writeFile(video, Buffer.from('vid'));
    const result = await muxMusicBed(video, { musicPath: join(TEST_HOME, 'ghost.mp3') });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('music track missing');
    expect(spawnCalls).toHaveLength(0);
  });

  it('builds an ffmpeg invocation that loops music, copies video, swaps audio', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    const music = join(FAKE_MUSIC_DIR, 'm.mp3');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(music, Buffer.from('mus'));

    const result = await muxMusicBed(video, { musicPath: music, musicGain: 0.3 });
    expect(result).toEqual({ ok: true });
    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0];
    expect(args).toContain('-stream_loop');
    expect(args).toContain('-shortest');
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    // The filter complex applies the user-set gain (formatted to 3 dp).
    const filterIdx = args.indexOf('-filter_complex');
    expect(filterIdx).toBeGreaterThan(-1);
    expect(args[filterIdx + 1]).toMatch(/volume=0\.300/);
    // Output path is a uniquely-suffixed `.muxing.<uuid>.mp4` — the rename
    // swaps it over the input on success.
    expect(args[args.length - 1]).toMatch(new RegExp(`^${video.replace(/[.+^${}()|[\\]\\\\]/g, '\\\\$&')}\\.muxing\\.[0-9a-f-]+\\.mp4$`));
  });

  it('uses DEFAULT_MUSIC_GAIN when caller omits musicGain', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    const music = join(FAKE_MUSIC_DIR, 'm.mp3');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(music, Buffer.from('mus'));

    await muxMusicBed(video, { musicPath: music });
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    expect(filter).toContain(`volume=${DEFAULT_MUSIC_GAIN.toFixed(3)}`);
  });

  it('returns ok:false with stderr tail on non-zero exit', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    mockExitCode = 1;
    mockStderr = 'Stream specifier matches no streams.\nlast line of stderr';
    const video = join(TEST_HOME, 'v.mp4');
    const music = join(FAKE_MUSIC_DIR, 'm.mp3');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(music, Buffer.from('mus'));

    const result = await muxMusicBed(video, { musicPath: music });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ffmpeg exit 1/);
    expect(result.reason).toContain('last line of stderr');
  });
});

describe('selectPlacedVoLines', () => {
  it('keeps only rendered + placed lines and resolves paths under PATHS.audio', () => {
    const out = selectPlacedVoLines([
      { audioFilename: 'a.wav', offsetSec: 2 },     // rendered + placed ✓
      { audioFilename: 'b.wav', offsetSec: null },  // rendered, not placed ✗
      { audioFilename: null, offsetSec: 5 },        // placed, not rendered ✗
      { audioFilename: 'c.wav', offsetSec: -1 },    // negative offset ✗
      { audioFilename: 'd.wav', offsetSec: 0 },     // offset 0 is valid ✓
    ]);
    expect(out).toEqual([
      { path: expect.stringMatching(/a\.wav$/), offsetSec: 2 },
      { path: expect.stringMatching(/d\.wav$/), offsetSec: 0 },
    ]);
  });
  it('returns [] for non-array / empty input', () => {
    expect(selectPlacedVoLines(null)).toEqual([]);
    expect(selectPlacedVoLines(undefined)).toEqual([]);
    expect(selectPlacedVoLines([])).toEqual([]);
  });
});

describe('buildVoMuxArgs', () => {
  it('delays each VO line to its offset and pads to video length (no music)', () => {
    const args = buildVoMuxArgs({
      inputVideoPath: '/v.mp4',
      voLines: [{ path: '/a.wav', offsetSec: 1.5 }, { path: '/b.wav', offsetSec: 4 }],
      outPath: '/out.mp4',
    });
    // video is input 0, the two VO wavs are inputs 1 and 2 (no music input)
    expect(args.slice(0, 6)).toEqual(['-i', '/v.mp4', '-i', '/a.wav', '-i', '/b.wav']);
    expect(args).not.toContain('-stream_loop');
    const filter = args[args.indexOf('-filter_complex') + 1];
    // offsets become adelay milliseconds, all channels
    expect(filter).toContain('[1:a]adelay=1500:all=1');
    expect(filter).toContain('[2:a]adelay=4000:all=1');
    // two lines → amix at full level, then padded so -shortest matches video
    expect(filter).toContain('amix=inputs=2:normalize=0');
    expect(filter).toContain('apad[aout]');
    // no music → no sidechain ducking
    expect(filter).not.toContain('sidechaincompress');
    expect(args).toContain('-shortest');
    expect(args[args.indexOf('-map') + 1]).toBe('0:v');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });

  it('ducks the music bed under VO via sidechain compression when music is present', () => {
    const args = buildVoMuxArgs({
      inputVideoPath: '/v.mp4',
      voLines: [{ path: '/a.wav', offsetSec: 0 }],
      musicPath: '/m.mp3',
      musicGain: 0.4,
      outPath: '/out.mp4',
    });
    // music is the looped last input (index 2 here: video=0, vo=1, music=2)
    expect(args).toContain('-stream_loop');
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('asplit=2[voscraw][vomain]');
    expect(filter).toContain('[2:a]volume=0.400');
    expect(filter).toContain('sidechaincompress=threshold=');
    expect(filter).toContain('[bed][vosc]sidechaincompress');
    expect(filter).toContain('[ducked][vomain]amix=inputs=2:normalize=0[aout]');
    // The sidechain KEY must be padded to infinity so the music bed survives
    // past the last VO line (sidechaincompress ends with its shortest input).
    expect(filter).toContain('[voscraw]apad[vosc]');
  });

  it('uses a single VO label without amix for one line', () => {
    const args = buildVoMuxArgs({
      inputVideoPath: '/v.mp4',
      voLines: [{ path: '/a.wav', offsetSec: 2 }],
      outPath: '/out.mp4',
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[vo0]apad[aout]');
    expect(filter).not.toContain('amix');
  });
});

describe('muxVoLines', () => {
  it('returns ok:false when no VO line is placed (lets caller fall back to music bed)', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    await writeFile(video, Buffer.from('vid'));
    // line missing offsetSec → not placed; non-existent path → dropped
    const result = await muxVoLines(video, { voLines: [
      { path: join(TEST_HOME, 'a.wav'), offsetSec: null },
      { path: join(TEST_HOME, 'ghost.wav'), offsetSec: 2 },
    ] });
    expect(result).toEqual({ ok: false, reason: 'no placed VO lines' });
    expect(spawnCalls).toHaveLength(0);
  });

  it('returns ok:false when the input video is missing', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const result = await muxVoLines(join(TEST_HOME, 'nope.mp4'), { voLines: [{ path: 'x', offsetSec: 0 }] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('input video missing');
    expect(spawnCalls).toHaveLength(0);
  });

  it('builds the VO mux and swaps the file in on success', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    const wav = join(TEST_HOME, 'a.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(wav, Buffer.from('wav'));

    const result = await muxVoLines(video, { voLines: [{ path: wav, offsetSec: 3 }] });
    expect(result.ok).toBe(true);
    expect(result.lineCount).toBe(1);
    expect(result.ducked).toBe(false);
    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0];
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('adelay=3000:all=1');
    // output is a uniquely-suffixed temp that gets renamed over the input
    expect(args[args.length - 1]).toMatch(/\.vomux\.[0-9a-f-]+\.mp4$/);
  });

  it('drops a missing music file to a VO-only mux rather than failing', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    const wav = join(TEST_HOME, 'a.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(wav, Buffer.from('wav'));

    const result = await muxVoLines(video, {
      voLines: [{ path: wav, offsetSec: 0 }],
      musicPath: join(TEST_HOME, 'gone.mp3'),
    });
    expect(result.ok).toBe(true);
    expect(result.ducked).toBe(false);
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    expect(filter).not.toContain('sidechaincompress');
  });

  it('ducks the music bed when both VO and a real music file are present', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'v.mp4');
    const wav = join(TEST_HOME, 'a.wav');
    const music = join(FAKE_MUSIC_DIR, 'm.mp3');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(wav, Buffer.from('wav'));
    await writeFile(music, Buffer.from('mus'));

    const result = await muxVoLines(video, { voLines: [{ path: wav, offsetSec: 1 }], musicPath: music });
    expect(result.ok).toBe(true);
    expect(result.ducked).toBe(true);
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('sidechaincompress');
  });
});
