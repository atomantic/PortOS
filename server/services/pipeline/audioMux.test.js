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
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: (...a) => findFfmpegMock(...a),
}));

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

const { muxMusicBed, resolveMusicTrackPath, DEFAULT_MUSIC_GAIN } = await import('./audioMux.js');

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
