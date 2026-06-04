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
// hasAudioStream is mocked so muxVoLines tests deterministically control
// whether the input video is treated as carrying a clip soundtrack — without
// shelling out to a real ffprobe against the fake video fixtures.
const hasAudioStreamMock = vi.fn();
// Pull the real runFfmpegProcess through — it's the helper audioMux now
// delegates to. The child_process mock below still intercepts spawn, so the
// real helper drives our fake ffmpeg.
vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return {
    ...actual,
    findFfmpeg: (...a) => findFfmpegMock(...a),
    hasAudioStream: (...a) => hasAudioStreamMock(...a),
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

const { muxMusicBed, muxVoLines, buildVoMuxArgs, buildCueMuxArgs, muxCueBed, muxStripAudio, selectPlacedVoLines, selectPlacedCues, resolveMusicTrackPath, DEFAULT_MUSIC_GAIN } = await import('./audioMux.js');
const { placeCuesOnTimeline } = await import('./audioCuePlacement.js');

beforeEach(async () => {
  spawnCalls.length = 0;
  mockExitCode = 0;
  mockStderr = '';
  findFfmpegMock.mockReset();
  // Default: input video has no audio stream (matches today's silent AI-gen
  // clips). Tests that exercise clip-audio preservation opt in explicitly.
  hasAudioStreamMock.mockReset();
  hasAudioStreamMock.mockResolvedValue(false);
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
  it('drops traversal/absolute filenames from stale or peer-synced state', () => {
    // VO line state can arrive from a synced peer; a traversal/absolute
    // audioFilename must be dropped rather than handed to ffmpeg (parity with
    // the selectPlacedCues guard).
    const out = selectPlacedVoLines([
      { audioFilename: '../../etc/passwd', offsetSec: 1 }, // dropped — escapes PATHS.audio
      { audioFilename: '/etc/passwd', offsetSec: 2 },      // dropped — absolute
      { audioFilename: 'safe.wav', offsetSec: 3 },         // kept
    ]);
    expect(out).toEqual([{ path: expect.stringMatching(/safe\.wav$/), offsetSec: 3 }]);
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
    // One bed (music) → VO padded then split into the mixed-back copy + one
    // sidechain key. The apad-before-split keeps the bed alive past the last
    // VO line (sidechaincompress ends with its shortest input).
    expect(filter).toContain('apad,asplit=2[vomain][vosck0]');
    expect(filter).toContain('[2:a]volume=0.400');
    expect(filter).toContain('sidechaincompress=threshold=');
    expect(filter).toContain('[bed][vosck0]sidechaincompress');
    expect(filter).toContain('[voducked0][vomain]amix=inputs=2:normalize=0[aout]');
  });

  it('mixes the clip soundtrack in as a second ducked bed alongside music', () => {
    const args = buildVoMuxArgs({
      inputVideoPath: '/v.mp4',
      voLines: [{ path: '/a.wav', offsetSec: 0 }],
      musicPath: '/m.mp3',
      clipAudio: true,
      outPath: '/out.mp4',
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    // The stitched video's own audio (0:a) is resampled and ducked under VO
    // via its own sidechain key, the same way the music bed is.
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toMatch(/\[clip\]/);
    // Two beds (music + clip) → VO split into mixed-back + two sidechain keys.
    expect(filter).toContain('apad,asplit=3[vomain][vosck0][vosck1]');
    expect(filter).toContain('[bed][vosck0]sidechaincompress');
    expect(filter).toContain('[clip][vosck1]sidechaincompress');
    expect(filter).toContain('[voducked0][voducked1][vomain]amix=inputs=3:normalize=0[aout]');
  });

  it('ducks the clip soundtrack under VO even with no music bed', () => {
    const args = buildVoMuxArgs({
      inputVideoPath: '/v.mp4',
      voLines: [{ path: '/a.wav', offsetSec: 0 }],
      clipAudio: true,
      outPath: '/out.mp4',
    });
    // No music → no looped input, but the clip soundtrack is still preserved.
    expect(args).not.toContain('-stream_loop');
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toContain('apad,asplit=2[vomain][vosck0]');
    expect(filter).toContain('[clip][vosck0]sidechaincompress');
    expect(filter).toContain('[voducked0][vomain]amix=inputs=2:normalize=0[aout]');
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

  it('preserves the clip soundtrack ducked under VO when the input has audio', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    hasAudioStreamMock.mockResolvedValue(true);
    const video = join(TEST_HOME, 'v.mp4');
    const wav = join(TEST_HOME, 'a.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(wav, Buffer.from('wav'));

    const result = await muxVoLines(video, { voLines: [{ path: wav, offsetSec: 1 }] });
    expect(result.ok).toBe(true);
    expect(result.clipAudio).toBe(true);
    // VO-only request, but the clip's own audio is mixed in and ducked.
    expect(result.ducked).toBe(false);
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toContain('[clip][vosck0]sidechaincompress');
  });

  it('skips the clip soundtrack when the input video is silent', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    hasAudioStreamMock.mockResolvedValue(false);
    const video = join(TEST_HOME, 'v.mp4');
    const wav = join(TEST_HOME, 'a.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(wav, Buffer.from('wav'));

    const result = await muxVoLines(video, { voLines: [{ path: wav, offsetSec: 1 }] });
    expect(result.ok).toBe(true);
    expect(result.clipAudio).toBe(false);
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    // A silent video must never have [0:a] referenced — that would abort ffmpeg.
    expect(filter).not.toContain('[0:a]');
    expect(filter).not.toContain('[clip]');
  });
});

describe('selectPlacedCues', () => {
  it('keeps only rendered (trackFilename) AND placed (finite startSec >= 0) cues', () => {
    const out = selectPlacedCues([
      { trackFilename: 'a.wav', startSec: 0, endSec: 30, gain: 0.7 },  // kept
      { trackFilename: 'b.wav', startSec: null },                      // dropped — not placed
      { trackFilename: null, startSec: 10 },                           // dropped — not rendered
      { trackFilename: 'c.wav', startSec: 30, endSec: 60 },            // kept
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].path).toMatch(/a\.wav$/);
    expect(out[0].startSec).toBe(0);
    expect(out[0].gain).toBe(0.7);
    expect(out[1].path).toMatch(/c\.wav$/);
  });

  it('nulls a non-positive-span endSec and a negative/invalid gain', () => {
    const out = selectPlacedCues([
      { trackFilename: 'a.wav', startSec: 10, endSec: 5, gain: -1 }, // endSec <= startSec
    ]);
    expect(out[0].endSec).toBeNull();
    expect(out[0].gain).toBeNull();
  });

  it('returns [] for non-array input', () => {
    expect(selectPlacedCues(null)).toEqual([]);
    expect(selectPlacedCues(undefined)).toEqual([]);
  });

  it('keeps a partially-rendered cue in its OWN arc slot (place full list, then filter)', () => {
    // The stitcher places the FULL ordered cue list, THEN drops un-rendered
    // cues. A lone rendered "climax" (cue 2 of 3) must stay in its middle slot,
    // not stretch across the whole episode (the bug from placing only rendered).
    const cues = [
      { id: 'a', label: 'Setup' },                          // un-rendered
      { id: 'b', label: 'Climax', trackFilename: 'b.wav' },  // rendered
      { id: 'c', label: 'Resolution' },                     // un-rendered
    ];
    const placed = selectPlacedCues(placeCuesOnTimeline(cues, 90));
    expect(placed).toHaveLength(1);
    // 90s / 3 cues → the climax owns its 30..60 middle slot, not 0..90.
    expect(placed[0].startSec).toBeCloseTo(30, 5);
    expect(placed[0].endSec).toBeCloseTo(60, 5);
    expect(placed[0].path).toMatch(/b\.wav$/);
  });
});

describe('buildCueMuxArgs', () => {
  it('lays each cue at its absolute startSec with delay + fade, then amixes (no VO)', () => {
    const args = buildCueMuxArgs({
      inputVideoPath: '/v.mp4',
      cues: [
        { path: '/c0.wav', startSec: 0, endSec: 30, gain: 0.5 },
        { path: '/c1.wav', startSec: 30, endSec: 60, gain: 0.5 },
      ],
      outPath: '/out.mp4',
    });
    // video=input0, cue0=input1, cue1=input2. Each cue is looped (-stream_loop
    // -1) so a short render fills its slot, so the args carry a loop flag before
    // each cue -i.
    expect(args.slice(0, 10)).toEqual([
      '-i', '/v.mp4',
      '-stream_loop', '-1', '-i', '/c0.wav',
      '-stream_loop', '-1', '-i', '/c1.wav',
    ]);
    const filter = args[args.indexOf('-filter_complex') + 1];
    // Each looped cue is trimmed to its placed span, then absolute-placed via
    // adelay (NOT acrossfade) + per-cue fade in/out.
    expect(filter).toContain('[1:a]atrim=0:30.000,adelay=0:all=1');
    expect(filter).toContain('[2:a]atrim=0:30.000,adelay=30000:all=1');
    expect(filter).toContain('afade=t=in:st=0.000');
    expect(filter).toContain('afade=t=in:st=30.000');
    expect(filter).toContain('afade=t=out');
    expect(filter).not.toContain('acrossfade'); // design correction: never acrossfade
    // Two cues amix into one bed, then padded so -shortest pins to video length.
    expect(filter).toContain('amix=inputs=2:normalize=0[cuebed]');
    expect(filter).toContain('[cuebed]apad[aout]');
    expect(filter).not.toContain('sidechaincompress'); // no VO → no duck
    expect(args).toContain('-shortest');
    expect(args[args.indexOf('-map') + 1]).toBe('0:v');
  });

  it('uses a single cue label without amix for one cue', () => {
    const args = buildCueMuxArgs({
      inputVideoPath: '/v.mp4',
      cues: [{ path: '/c0.wav', startSec: 5, endSec: 35, gain: 0.5 }],
      outPath: '/out.mp4',
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[cue0]apad[aout]');
    expect(filter).not.toContain('[cuebed]');
  });

  it('ducks the cue bed under VO when VO lines are present', () => {
    const args = buildCueMuxArgs({
      inputVideoPath: '/v.mp4',
      cues: [{ path: '/c0.wav', startSec: 0, endSec: 30, gain: 0.5 }],
      voLines: [{ path: '/a.wav', offsetSec: 2 }],
      outPath: '/out.mp4',
    });
    // video=input0, cue=input1 (looped), VO=input2.
    expect(args.slice(0, 8)).toEqual([
      '-i', '/v.mp4',
      '-stream_loop', '-1', '-i', '/c0.wav',
      '-i', '/a.wav',
    ]);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[2:a]adelay=2000:all=1');
    // Cue bed ducked under VO via sidechaincompress (one bed, one VO key copy).
    expect(filter).toContain('apad,asplit=2[vomain][cuesck0]');
    expect(filter).toContain('sidechaincompress=threshold=');
    expect(filter).toContain('[cueducked0][vomain]amix=inputs=2:normalize=0[aout]');
  });

  it('adds the clip soundtrack as a second ducked bed under VO when clipAudio is set', () => {
    const args = buildCueMuxArgs({
      inputVideoPath: '/v.mp4',
      cues: [{ path: '/c0.wav', startSec: 0, endSec: 30, gain: 0.5 }],
      voLines: [{ path: '/a.wav', offsetSec: 0 }],
      clipAudio: true,
      outPath: '/out.mp4',
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toContain('apad,asplit=3[vomain][cuesck0][cuesck1]');
    expect(filter).toContain('[cueducked0][cueducked1][vomain]amix=inputs=3:normalize=0[aout]');
  });

  it('preserves the clip soundtrack by mixing it under the cue bed when no VO', () => {
    // Design: 'generated' mode keeps the clip's own audio. With no VO there's
    // nothing to duck under, so the clip is mixed in alongside the cue bed.
    const args = buildCueMuxArgs({
      inputVideoPath: '/v.mp4',
      cues: [{ path: '/c0.wav', startSec: 0, endSec: 30, gain: 0.5 }],
      clipAudio: true,
      outPath: '/out.mp4',
    });
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).toContain('[cue0][clip]amix=inputs=2:normalize=0,apad[aout]');
    expect(filter).not.toContain('sidechaincompress'); // no VO → mix, not duck
  });

  it('loops+trims a cue to its placed span so a short render fills the slot', () => {
    const args = buildCueMuxArgs({
      inputVideoPath: '/v.mp4',
      cues: [{ path: '/c0.wav', startSec: 10, endSec: 70, gain: 0.5 }], // 60s span
      outPath: '/out.mp4',
    });
    // -stream_loop -1 lets the source repeat; atrim cuts it to the 60s span.
    expect(args).toContain('-stream_loop');
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('[1:a]atrim=0:60.000,adelay=10000:all=1');
  });
});

describe('muxCueBed', () => {
  beforeEach(() => {
    findFfmpegMock.mockReset();
    hasAudioStreamMock.mockReset();
    spawnCalls.length = 0;
  });

  it('returns ok:false when no cue is placed+rendered (caller keeps clip audio)', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'cv.mp4');
    await writeFile(video, Buffer.from('vid'));
    const result = await muxCueBed(video, { cues: [{ path: '/missing.wav', startSec: 0 }] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no placed/i);
  });

  it('mixes placed+rendered cues onto the video and reports the cue count', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    hasAudioStreamMock.mockResolvedValue(false);
    const video = join(TEST_HOME, 'cv2.mp4');
    const cue = join(TEST_HOME, 'cue.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(cue, Buffer.from('wav'));
    const result = await muxCueBed(video, { cues: [{ path: cue, startSec: 0, endSec: 30, gain: 0.5 }] });
    expect(result.ok).toBe(true);
    expect(result.cueCount).toBe(1);
    expect(result.ducked).toBe(false); // no VO
  });

  it('preserves clip audio (mixed under the cue bed) when the clip has a soundtrack and no VO', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    hasAudioStreamMock.mockResolvedValue(true);
    const video = join(TEST_HOME, 'cv3.mp4');
    const cue = join(TEST_HOME, 'cue3.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(cue, Buffer.from('wav'));
    const result = await muxCueBed(video, { cues: [{ path: cue, startSec: 0, endSec: 30, gain: 0.5 }] });
    expect(result.ok).toBe(true);
    expect(result.clipAudio).toBe(true);
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    // Clip audio preserved per the design (mixed in, not ducked — no VO).
    expect(filter).toContain('[0:a]aresample=48000');
    expect(filter).not.toContain('sidechaincompress');
  });

  it('never references clip audio when the clip is silent', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    hasAudioStreamMock.mockResolvedValue(false);
    const video = join(TEST_HOME, 'cv4.mp4');
    const cue = join(TEST_HOME, 'cue4.wav');
    await writeFile(video, Buffer.from('vid'));
    await writeFile(cue, Buffer.from('wav'));
    await muxCueBed(video, { cues: [{ path: cue, startSec: 0, endSec: 30, gain: 0.5 }] });
    const filter = spawnCalls[0].args[spawnCalls[0].args.indexOf('-filter_complex') + 1];
    // [0:a] against a silent clip would abort ffmpeg — must not be referenced.
    expect(filter).not.toContain('[0:a]');
  });
});

describe('muxStripAudio', () => {
  beforeEach(() => { findFfmpegMock.mockReset(); spawnCalls.length = 0; });

  it('returns ok:false when the input video is missing', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const result = await muxStripAudio(join(TEST_HOME, 'nope.mp4'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('input video missing');
  });

  it('strips the audio stream with -an and stream-copies the video', async () => {
    findFfmpegMock.mockResolvedValue('/usr/local/bin/ffmpeg');
    const video = join(TEST_HOME, 'sv.mp4');
    await writeFile(video, Buffer.from('vid'));
    const result = await muxStripAudio(video);
    expect(result).toEqual({ ok: true });
    const { args } = spawnCalls[0];
    expect(args).toContain('-an');
    expect(args[args.indexOf('-map') + 1]).toBe('0:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('copy');
    expect(args).not.toContain('-filter_complex');
  });
});
